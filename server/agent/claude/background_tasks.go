package claude

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sort"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/contents"
)

// backgroundTaskTracker holds the live background tasks of one CLI process.
//
// Why it exists: after starting a background task the CLI ends the turn with an
// ordinary result frame and later resumes output on its own, without the host
// sending anything. The two result frames are byte-identical in every field, so
// the only way to tell "the turn is really over" from "waiting on background
// work" is this level signal.
//
// Where: `system` / `background_tasks_changed`, whose payload is every live task
// after the change (REPLACE semantics). The level is per-process — the CLI emits
// nothing at startup — so a tracker created with the process starts empty, which
// is exactly right.
//
// This is live state, not history: it is never written into an event record,
// because a snapshot of it turns into a lie the moment a task finishes.
type backgroundTaskTracker struct {
	liveMu sync.Mutex
	live   []string

	// tasksMu guards the join from Claude's task lifecycle back to the tool call
	// that started it; see startTask.
	tasksMu sync.Mutex
	// tasks is what is known about each live task, by task_id. It exists because
	// task_updated names only a task_id, so without it that frame joins to
	// nothing.
	tasks map[string]taskCall
	// backgroundedCalls are the tool_use_ids whose result is only a placeholder,
	// looked up while that result is being parsed so it can be recorded as one.
	backgroundedCalls map[string]bool
	// callParents names the subagent call each call still without a result was
	// made inside, so a task started for it knows whose work it is (see
	// taskCall.parent). Forgotten at the call's own result, which task_started
	// precedes.
	callParents map[string]string
	// resuming are the backgrounded subagents whose task ended while work they
	// had backgrounded themselves was still running, by tool_use_id; see
	// taskOutcome. What is kept is what the resumed task's outcome is recorded
	// with and task_started does not say again.
	resuming map[string]taskCall
}

type backgroundTask struct {
	TaskID   string `json:"task_id"`
	TaskType string `json:"task_type"`
	// Ambient marks tasks that are not activity (housekeeping, live-update
	// watchers). The CLI tells hosts to exclude them from activity indicators,
	// so they must not hold a turn open either.
	Ambient bool `json:"ambient"`
}

type backgroundTasksChanged struct {
	Tasks []backgroundTask `json:"tasks"`
}

// observe replaces the tracked set with the payload of a
// background_tasks_changed frame.
func (t *backgroundTaskTracker) observe(log *slog.Logger, line []byte) {
	// A payload this code cannot read empties the set rather than leaving the
	// previous one in place: an empty set only costs the swallowing (the turn
	// ends the way it did before this existed, noisily but recoverably), while a
	// stale non-empty one holds the turn open forever with nothing left to clear
	// it. Same reason a malformed control request is declined instead of dropped
	// — unknown input takes the recoverable branch.
	var payload backgroundTasksChanged
	if err := json.Unmarshal(line, &payload); err != nil {
		log.Warn("failed to parse background task list from CLI, treating it as empty", "error", err)
		payload = backgroundTasksChanged{}
	}

	live := make([]string, 0, len(payload.Tasks))
	for _, task := range payload.Tasks {
		if task.Ambient {
			continue
		}
		live = append(live, task.TaskID)
	}

	t.liveMu.Lock()
	t.live = live
	t.liveMu.Unlock()

	log.Debug("background tasks changed", "live", live)
}

// liveCount reports how many non-ambient background tasks are still running.
func (t *backgroundTaskTracker) liveCount() int {
	t.liveMu.Lock()
	defer t.liveMu.Unlock()
	return len(t.live)
}

// liveIDs lists the non-ambient background tasks still running, as the CLI last
// reported them. Safe to read outside the lock: observe replaces the slice and
// never writes into one it has handed out.
func (t *backgroundTaskTracker) liveIDs() []string {
	t.liveMu.Lock()
	defer t.liveMu.Unlock()
	return t.live
}

// loss describes what this process is about to take down with it, for the next
// process to explain.
//
// The two halves come from two different streams, deliberately. The CLI's own
// schema says the background task level (background_tasks_changed) has no
// defined order against the task lifecycle frames and must not be joined to
// them, so the level is the only honest answer to "how many were running" and
// the lifecycle's own map of backgrounded calls is the only honest answer to
// "which calls they belonged to". Each is used for what only it knows, and
// neither is derived from the other.
func (t *backgroundTaskTracker) loss() backgroundLossRecord {
	return backgroundLossRecord{LostTasks: t.liveCount(), LostCalls: t.backgroundedCallIDs()}
}

// backgroundedCallIDs lists the calls whose background work has not reported an
// outcome yet — task_notification is what removes one — sorted so that what
// gets recorded does not depend on map order.
func (t *backgroundTaskTracker) backgroundedCallIDs() []string {
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()

	if len(t.backgroundedCalls) == 0 {
		return nil
	}
	ids := make([]string, 0, len(t.backgroundedCalls))
	for id := range t.backgroundedCalls {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// hasLive reports whether any non-ambient background task is still running.
func (t *backgroundTaskTracker) hasLive() bool {
	return t.liveCount() > 0
}

// --- The task lifecycle, and the join back to the tool call ---

// The `system` subtypes Claude runs a task's life on. The edges carry a
// tool_use_id and task_updated does not, which is the whole reason the tracker
// keeps a task_id map.
const (
	taskStarted      = "task_started"
	taskProgress     = "task_progress"
	taskUpdated      = "task_updated"
	taskNotification = "task_notification"
)

// isTaskFrame reports whether a system subtype belongs to that lifecycle.
func isTaskFrame(subtype string) bool {
	switch subtype {
	case taskStarted, taskProgress, taskUpdated, taskNotification:
		return true
	default:
		return false
	}
}

// taskFrame is the union of the four frames' payloads. One struct because the
// fields that overlap mean the same thing on each of them, and the ones that do
// not are simply absent.
type taskFrame struct {
	TaskID string `json:"task_id"`
	// ToolUseID is optional on every edge and absent from task_updated
	// altogether: a task with none is scheduled or housekeeping work that no
	// tool call asked for, and it has no row in the transcript to belong to.
	ToolUseID string `json:"tool_use_id"`
	// Summary is the one-line status on task_progress and the outcome on
	// task_notification. Description is what the task was started to do, and is
	// what task_progress actually carried on claude 2.1.263 — see activityText.
	Summary     string `json:"summary"`
	Description string `json:"description"`
	// Status is task_notification's verdict: completed, failed or stopped.
	Status string `json:"status"`
	// OutputFile is where the CLI wrote the task's output, on the machine the
	// CLI runs on.
	OutputFile     string `json:"output_file"`
	IsBackgrounded bool   `json:"is_backgrounded"`
	// Ambient and SkipTranscript mark work the CLI tells hosts to keep out of
	// what the user sees.
	Ambient        bool       `json:"ambient"`
	SkipTranscript bool       `json:"skip_transcript"`
	Patch          *taskPatch `json:"patch"`
	// TaskType and SubagentType are task_started's: what kind of work this is
	// (local_agent for a subagent, measured on claude 2.1.330) and, for a
	// subagent, which agent.
	TaskType     string `json:"task_type"`
	SubagentType string `json:"subagent_type"`
	// LastToolName is the tool a subagent called most recently, on
	// task_progress.
	LastToolName string `json:"last_tool_name"`
	// Usage is task_progress's and task_notification's running totals.
	// Optional in the schema.
	Usage *taskUsage `json:"usage"`
}

// taskUsage is a task's running totals. Measured on claude 2.1.330, a
// subagent's task_progress carries them all as they stand at each of its tool
// calls, and its task_notification carries the final ones — the same figures
// its call's result reports as totalToolUseCount, totalTokens and
// totalDurationMs.
type taskUsage struct {
	TotalTokens *int64 `json:"total_tokens"`
	ToolUses    *int64 `json:"tool_uses"`
	// DurationMs is read only on task_notification, where it is the CLI's own
	// measure of how long the task ran. A live one would only restate the
	// client's own clock, less often.
	DurationMs int64 `json:"duration_ms"`
}

func (u *taskUsage) counts() agent.SubagentCounts {
	if u == nil {
		return agent.SubagentCounts{}
	}
	return agent.SubagentCounts{ToolUses: u.ToolUses, TotalTokens: u.TotalTokens}
}

// taskTypeLocalAgent is the task_type of a subagent's task.
const taskTypeLocalAgent = "local_agent"

// taskPatch is task_updated's payload. Only the one field is read: a status and
// an end time say the task is over, and task_notification says the same thing
// with the outcome attached and a tool_use_id to hang it on (measured on claude
// 2.1.263: the notification follows the update in every observed run).
type taskPatch struct {
	IsBackgrounded *bool `json:"is_backgrounded"`
}

// activityText is the CLI's own one-line account of what a task is doing.
//
// Summary first, because that is what the schema documents as the progress
// line; description is the fallback because it is what task_progress actually
// carried on claude 2.1.263 ("Running <description>"), and a progress frame with
// neither says nothing worth forwarding.
func (f taskFrame) activityText() string {
	if f.Summary != "" {
		return f.Summary
	}
	return f.Description
}

// taskCall is what the tracker remembers about one live task.
type taskCall struct {
	toolUseID string
	// backgrounded says the work outlives the call, so the call's own result is
	// a placeholder and the outcome arrives later.
	backgrounded bool
	// excluded marks ambient or skip_transcript work: read to keep the join
	// consistent, never forwarded.
	excluded bool
	// subagent says the task is a subagent's, so its usage counts a subagent's
	// work. Only then is it forwarded: the same usage on any other task would
	// be drawn as an agent's tool uses and tokens.
	subagent bool
	// agentType is the subagent's type, from task_started; agentID its id,
	// from its call's placeholder (see noteAgentID). Both are what the outcome
	// of backgrounded work is recorded with, since task_notification names
	// neither.
	agentType string
	agentID   string
	// parent is the subagent call this task's call was made inside, empty for
	// the main agent's.
	parent string
}

// startTask records what task_started said, so the frames that follow can be
// joined to the call that caused them.
func (t *backgroundTaskTracker) startTask(frame taskFrame) {
	if frame.TaskID == "" {
		return
	}

	call := taskCall{
		toolUseID:    frame.ToolUseID,
		backgrounded: frame.IsBackgrounded,
		excluded:     frame.Ambient || frame.SkipTranscript,
		subagent:     frame.TaskType == taskTypeLocalAgent || frame.SubagentType != "",
		agentType:    frame.SubagentType,
	}

	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	call.parent = t.callParents[call.toolUseID]
	if earlier, ok := t.resuming[call.toolUseID]; ok {
		delete(t.resuming, call.toolUseID)
		call.agentID = earlier.agentID
		if call.agentType == "" {
			call.agentType = earlier.agentType
		}
	}
	if t.tasks == nil {
		t.tasks = make(map[string]taskCall)
	}
	t.tasks[frame.TaskID] = call

	if call.backgrounded && !call.excluded && call.toolUseID != "" {
		if t.backgroundedCalls == nil {
			t.backgroundedCalls = make(map[string]bool)
		}
		t.backgroundedCalls[call.toolUseID] = true
	}
}

// noteCall records the subagent call a call was made inside, for a task that
// may yet be started for it.
func (t *backgroundTaskTracker) noteCall(toolUseID, parent string) {
	if toolUseID == "" || parent == "" {
		return
	}
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	if t.callParents == nil {
		t.callParents = make(map[string]string)
	}
	t.callParents[toolUseID] = parent
}

// forgetCall drops what noteCall kept, once the call has its result.
func (t *backgroundTaskTracker) forgetCall(toolUseID string) {
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	delete(t.callParents, toolUseID)
}

// holdsBackgroundWork reports whether a live task other than taskID was
// backgrounded from inside the subagent call toolUseID.
func (t *backgroundTaskTracker) holdsBackgroundWork(toolUseID, taskID string) bool {
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	for id, task := range t.tasks {
		if id != taskID && task.parent == toolUseID && task.backgrounded && !task.excluded {
			return true
		}
	}
	return false
}

// resumeLater keeps a backgrounded subagent's call waiting for its outcome
// after its task has ended: it is still owed one (backgroundedCalls, which a
// process dying reports as lost), and what its next task's outcome is
// recorded with is kept for it.
func (t *backgroundTaskTracker) resumeLater(call taskCall) {
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	if t.backgroundedCalls == nil {
		t.backgroundedCalls = make(map[string]bool)
	}
	t.backgroundedCalls[call.toolUseID] = true
	if t.resuming == nil {
		t.resuming = make(map[string]taskCall)
	}
	t.resuming[call.toolUseID] = call
}

// releaseStopped gives up waiting on a held subagent (resumeLater) whose last
// live background child — childTaskID — was stopped: a Stop stops background
// tasks, not a subagent whose own task has already ended, so nothing is left to
// wake it. Reports the subagent's call, and whether there was one to release.
func (t *backgroundTaskTracker) releaseStopped(parent, childTaskID string) (taskCall, bool) {
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	held, ok := t.resuming[parent]
	if !ok {
		return taskCall{}, false
	}
	for id, task := range t.tasks {
		if id != childTaskID && task.parent == parent && task.backgrounded && !task.excluded {
			return taskCall{}, false
		}
	}
	delete(t.resuming, parent)
	delete(t.backgroundedCalls, parent)
	return held, true
}

// markBackgrounded records a call that became background work after it started,
// which is the one thing task_updated can say that nothing else does.
func (t *backgroundTaskTracker) markBackgrounded(taskID string) {
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()

	call, ok := t.tasks[taskID]
	if !ok || call.excluded || call.toolUseID == "" || call.backgrounded {
		return
	}
	call.backgrounded = true
	t.tasks[taskID] = call
	if t.backgroundedCalls == nil {
		t.backgroundedCalls = make(map[string]bool)
	}
	t.backgroundedCalls[call.toolUseID] = true
}

// noteAgentID records the subagent id a backgrounded call's placeholder named,
// so the outcome that arrives later can be recorded with it.
func (t *backgroundTaskTracker) noteAgentID(toolUseID, agentID string) {
	if toolUseID == "" || agentID == "" {
		return
	}
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	for id, call := range t.tasks {
		if call.toolUseID == toolUseID {
			call.agentID = agentID
			t.tasks[id] = call
			return
		}
	}
}

// resolveTask answers which call a task frame belongs to.
//
// The frame's own tool_use_id wins when it has one; otherwise the task map is
// consulted. ok is false for work that has no call behind it and for work the
// CLI asked hosts to hide — both mean "drop this frame", which is the only
// honest answer: a progress line with no call to attach it to says something is
// happening without saying what asked for it.
func (t *backgroundTaskTracker) resolveTask(frame taskFrame) (call taskCall, ok bool) {
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()

	known, found := t.tasks[frame.TaskID]
	if found && known.excluded {
		return taskCall{}, false
	}
	if frame.Ambient || frame.SkipTranscript {
		return taskCall{}, false
	}

	if frame.ToolUseID != "" {
		known.toolUseID = frame.ToolUseID
	}
	if known.toolUseID == "" {
		return taskCall{}, false
	}
	return known, true
}

// finishTask forgets a task that has reported its outcome, so the maps stay
// bounded by the work actually in flight.
//
// It takes only the task id, and the caller runs it for every notification
// rather than only for the ones that produce a record: a task whose frames are
// dropped — ambient work, work no tool call asked for — is still over, and an
// entry kept for it would never be removed by anything else.
func (t *backgroundTaskTracker) finishTask(taskID string) {
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()

	if call, ok := t.tasks[taskID]; ok {
		delete(t.backgroundedCalls, call.toolUseID)
	}
	delete(t.tasks, taskID)
}

// callIsBackgrounded reports whether this call's own result is a placeholder for
// work that is still running. Read while a tool_result is being parsed, which is
// why task_started must arrive first — measured on claude 2.1.263: task_started
// precedes the user frame carrying the placeholder in every observed run.
func (t *backgroundTaskTracker) callIsBackgrounded(toolUseID string) bool {
	if toolUseID == "" {
		return false
	}
	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	return t.backgroundedCalls[toolUseID]
}

// The tools whose input names a background task by the CLI's own task_id and
// nothing else, so on their own they cannot be joined to the call whose task
// they are about — the transcript's join key is the tool_use_id. TaskOutput
// reads a task's output; TaskStop stops one. KillShell and KillBash are
// TaskStop's earlier names, which history still holds and claude 2.1.330
// still accepts as aliases; they name the task by shell_id.
var taskReferringTools = map[string]bool{
	"TaskOutput": true,
	"TaskStop":   true,
	"KillShell":  true,
	"KillBash":   true,
}

// originOfCall answers which earlier call a tool call is about, for the calls
// whose input identifies their target by something other than a tool_use_id
// (taskReferringTools).
//
// Answering it here is the point: task_started carried both ids, this process
// kept them together, and nothing downstream ever sees the pair. A client would
// have to read the id back out of the CLI's English placeholder sentence or out
// of an output file's path — both are string-mining, and both break when the
// CLI rewords or relocates.
//
// What the client does with the answer differs by tool — a fetch is drawn on
// its origin's row, a stop keeps a row of its own that points there — and is
// the client's decision; this only says which call it is.
//
// "" means the question has no answer, which is ordinary rather than
// exceptional: an entry lives only as long as its task (finishTask drops it on
// the outcome) and never outlives the process, so a fetch against a task that
// already settled — or that a previous process started — resolves to nothing.
func (t *backgroundTaskTracker) originOfCall(name string, input json.RawMessage) string {
	if !taskReferringTools[name] {
		return ""
	}
	var call struct {
		TaskID  string `json:"task_id"`
		ShellID string `json:"shell_id"`
	}
	// A malformed or absent id is the same answer as an unknown one: no join.
	// Nothing here is worth failing the tool call over.
	if err := json.Unmarshal(input, &call); err != nil {
		return ""
	}
	// task_id first, as the CLI reads them: shell_id is the deprecated field.
	taskID := call.TaskID
	if taskID == "" {
		taskID = call.ShellID
	}
	if taskID == "" {
		return ""
	}

	t.tasksMu.Lock()
	defer t.tasksMu.Unlock()
	// Excluded tasks are read for consistency with resolveTask and answered the
	// same way: the CLI asked hosts to keep that work out of the transcript, so
	// there is no row to point at.
	known, ok := t.tasks[taskID]
	if !ok || known.excluded {
		return ""
	}
	return known.toolUseID
}

// parseTaskEvent reads one frame of Claude's task lifecycle.
//
// None of the four is a transcript entry. Two only tell this tracker something;
// task_progress becomes a live progress line on the call it belongs to; and
// task_notification becomes the real outcome of work that outlived the call that
// started it. Forwarded as SystemEvents — which is what parseSystemEvent would
// do with them if they were let through — they would be exactly the noise its
// allowlist exists to keep out.
func parseTaskEvent(log *slog.Logger, line []byte, subtype string, tasks *backgroundTaskTracker) []agent.AgentEvent {
	var frame taskFrame
	if err := json.Unmarshal(line, &frame); err != nil {
		log.Warn("failed to parse task frame from CLI", "error", err, "subtype", subtype)
		return nil
	}

	switch subtype {
	case taskStarted:
		// No event of its own: the tool call this belongs to is already in the
		// transcript, and what this frame adds is the knowledge needed to read
		// the frames that follow.
		tasks.startTask(frame)
		return nil

	case taskProgress:
		call, ok := tasks.resolveTask(frame)
		if !ok {
			log.Debug("dropping task progress with no tool call behind it", "taskId", frame.TaskID)
			return nil
		}
		activity := agent.ToolActivityEvent{ToolUseID: call.toolUseID, Activity: frame.activityText()}
		if call.subagent {
			progress := agent.SubagentProgress{SubagentCounts: frame.Usage.counts(), LastToolName: frame.LastToolName}
			if progress != (agent.SubagentProgress{}) {
				activity.Subagent = &progress
			}
		}
		if activity.Activity == "" && activity.Subagent == nil {
			return nil
		}
		return []agent.AgentEvent{activity}

	case taskUpdated:
		if frame.Patch != nil && frame.Patch.IsBackgrounded != nil && *frame.Patch.IsBackgrounded {
			tasks.markBackgrounded(frame.TaskID)
		}
		return nil

	case taskNotification:
		return taskOutcome(log, frame, tasks)
	}

	return nil
}

// taskOutcome turns task_notification into the real result of backgrounded work.
//
// Only backgrounded work: a task that ran inside its call reports its outcome
// through the call's own tool_result, which arrives after this frame (measured
// on claude 2.1.263 with a subagent Task), so emitting here as well would write
// the same outcome into the transcript twice.
func taskOutcome(log *slog.Logger, frame taskFrame, tasks *backgroundTaskTracker) []agent.AgentEvent {
	// Deferred rather than run here, so the resolve below still finds the task —
	// and registered before that resolve, so a task whose frames are dropped
	// (ambient work, work no tool call asked for) is forgotten just the same.
	defer tasks.finishTask(frame.TaskID)

	call, ok := tasks.resolveTask(frame)
	if !ok {
		log.Debug("dropping task notification with no tool call behind it", "taskId", frame.TaskID)
		return nil
	}

	if !call.backgrounded {
		return nil
	}

	// A backgrounded subagent that backgrounded work of its own and ended its
	// turn is not done: the CLI reports its task completed, and then wakes it
	// when that work finishes, under a new task for the same call (measured on
	// claude 2.1.330 — the first notification came 5.9s in, saying the command
	// was still running; the real report 43s in). Recorded as the outcome, the
	// first notification settled the row while the subagent was still at work,
	// and the turn's end showed no agent alive. Nothing is lost by holding it:
	// what it says is the subagent's last text, already in the transcript.
	if call.subagent && frame.Status == taskStatusCompleted && tasks.holdsBackgroundWork(call.toolUseID, frame.TaskID) {
		log.Debug("subagent ended its turn with background work of its own, waiting for it to resume",
			"taskId", frame.TaskID, "toolUseId", call.toolUseID)
		// After finishTask, which forgets the call along with the task; the
		// deferred one then finds nothing left to forget.
		tasks.finishTask(frame.TaskID)
		tasks.resumeLater(call)
		return nil
	}

	events := []agent.AgentEvent{backgroundOutcome(frame, call)}
	// The held subagent's outcome follows its child's, which is the order the
	// two ended in.
	if frame.Status == taskStatusStopped && call.parent != "" {
		if held, ok := tasks.releaseStopped(call.parent, frame.TaskID); ok {
			events = append(events, backgroundOutcome(taskFrame{Status: taskStatusStopped}, held))
		}
	}
	return events
}

// backgroundOutcome is the record of how backgrounded work ended, as frame
// reports it.
func backgroundOutcome(frame taskFrame, call taskCall) agent.ToolResultEvent {
	text := frame.Summary
	if text == "" {
		text = describeTaskOutcome(frame.Status)
	}

	result := agent.ToolResultEvent{
		ToolUseID: call.toolUseID,
		// The agent never read this: it read the placeholder. The subtype is
		// what says so, and what lets the transcript word the difference.
		Subtype: agent.ToolResultBackgroundResult,
		IsError: frame.Status != taskStatusCompleted,
	}
	if frame.Usage != nil && frame.Usage.DurationMs > 0 {
		result.DurationMs = frame.Usage.DurationMs
	}
	if call.subagent {
		result.Subagent = subagentReport(agent.SubagentReport{
			AgentID:        call.agentID,
			AgentType:      call.agentType,
			SubagentCounts: frame.Usage.counts(),
		})
	}

	if frame.OutputFile == "" {
		result.ToolResult = text
		return result
	}

	// The log is named, not delivered: it can be arbitrarily large, and the user
	// asked to see the outcome rather than to have the log pushed at them. The
	// path is the CLI's machine's, which is what FileBlock.Path describes.
	var blocks []agent.ContentBlock
	if text != "" {
		blocks = append(blocks, agent.ContentBlock{Type: agent.ContentBlockText, Text: text})
	}
	blocks = append(blocks, agent.ContentBlock{
		Type: agent.ContentBlockFile,
		File: &agent.FileBlock{
			Name: filepath.Base(frame.OutputFile),
			Path: frame.OutputFile,
			// What the CLI writes there is the task's own output; nothing is
			// read, so nothing is sniffed either.
			MIME:    "text/plain",
			Omitted: contents.OmitNotFetched,
		},
	})
	result.Contents = blocks
	return result
}

// The verdicts task_notification reports.
const (
	taskStatusCompleted = "completed"
	taskStatusFailed    = "failed"
	taskStatusStopped   = "stopped"
)

// describeTaskOutcome is the adapter's own words for a task that reported no
// summary, so a finished background task is never a blank row.
func describeTaskOutcome(status string) string {
	switch status {
	case taskStatusCompleted:
		return "The background task finished."
	case taskStatusFailed:
		return "The background task failed."
	case taskStatusStopped:
		return "The background task was stopped before it finished."
	case "":
		// A verdict the CLI's own schema marks required. Said plainly rather
		// than quoted into a sentence about an empty string.
		return "The background task ended without saying how."
	default:
		return fmt.Sprintf("The background task ended with status %q.", status)
	}
}
