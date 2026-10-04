package codex

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pockode/server/agent"
)

// ignoredNotifications are notification methods Pockode deliberately drops,
// listed so the default branch keeps meaning "method we have never seen".
//
// Why a list and not a blanket "forward what we do not recognise": app-server
// defines 81 notifications, most of them per-turn bookkeeping or duplicates of
// data rendered elsewhere, and the CLI keeps adding more — anything forwarded by
// default ends up as transcript noise.
//
// Only the methods actually observed on codex-cli 0.153.0, plus the ones whose
// names say plainly what they are, are worth naming here; the rest fall to the
// default branch, which logs once at debug and is how a notification worth
// handling gets noticed.
var ignoredNotifications = map[string]bool{
	// Thread and turn bookkeeping. turn/started and turn/completed are handled;
	// these say nothing a rendered transcript needs.
	"thread/started":               true, // the reply to thread/start already carried it
	"thread/status/changed":        true,
	"thread/compacted":             true,
	"thread/name/updated":          true,
	"thread/goal/updated":          true,
	"serverRequest/resolved":       true, // echo of an approval we just answered
	"hook/started":                 true,
	"hook/completed":               true,
	"deprecationNotice":            true, // aimed at CLI users, not at this session
	"remoteControl/status/changed": true,
	"account/updated":              true,
	"account/rateLimits/updated":   true, // usage state, and no cost figure in it

	// Incremental copies of content that also arrives whole, on the
	// item/completed of the same item.
	"item/agentMessage/delta": true,
	// Dead on this version: the schema says outright that the server no longer
	// emits it.
	"item/fileChange/outputDelta": true,
	// A revision of a patch already shown, not an increment of one: it carries
	// the whole `changes` array over again. Dropping it would show a superseded
	// patch in the approval prompt if it ever arrived, so this is listed on the
	// strength of a measurement rather than of its name: an apply_patch run
	// end to end on codex-cli 0.153.0 never sent it, and item/started carried
	// the final patch, byte for byte what item/completed then repeated. Nothing
	// Pockode offers can revise a patch either — that is the editable approval
	// surface of a desktop client, which this is not. Wire it up to
	// rememberToolInput on the day one of those stops being true.
	"item/fileChange/patchUpdated": true,

	// A new part of a reasoning summary beginning. The deltas carry their part
	// index too, which is what handleReasoningDelta reads, so this says nothing
	// they do not.
	"item/reasoning/summaryPartAdded": true,

	// Real information with no surface in Pockode yet — plans and the turn's
	// accumulated diff. The whole form of each is dropped as well, in
	// handleItemCompleted's switch, so these are not increments of anything
	// rendered.
	"item/plan/delta":               true,
	"turn/plan/updated":             true,
	"turn/diff/updated":             true,
	"turn/moderationMetadata":       true,
	"model/rerouted":                true,
	"model/safetyBuffering/updated": true,
}

// handleNotification dispatches one server notification.
func (s *appSession) handleNotification(msg rpcMessage) {
	switch msg.Method {
	case "turn/started", "turn/completed", "thread/tokenUsage/updated":
		// A subagent runs in a thread of its own, and app-server reports that
		// thread's turns and usage on this same connection (measured on
		// codex-cli 0.159.3, where multi_agent is on by default). Its turn
		// ending is not this session's — taken for one it would end the turn
		// while the parent is still waiting on the subagent. Its usage is a
		// running total of its own thread, which read as this thread's would
		// wreck the deltas the accumulator takes and report the subagent's
		// prompt as this thread's context; the subagent's tokens therefore go
		// uncounted, which a per-thread accumulator would fix.
		if thread := notificationThread(msg.Params); !s.isOwnThread(thread) {
			if msg.Method == "turn/completed" {
				s.settleSubagent(thread, msg.Params)
				s.forgetReasoning(func(t string) bool { return t == thread })
			}
			return
		}
	}

	switch msg.Method {
	case "turn/started":
		s.handleTurnStarted(msg.Params)

	case "turn/completed":
		s.handleTurnCompleted(msg.Params)

	case "item/started":
		s.handleItemStarted(msg.Params)

	case "item/completed":
		s.handleItemCompleted(msg.Params)

	case "item/commandExecution/outputDelta":
		s.handleCommandOutputDelta(msg.Params)

	case "item/mcpToolCall/progress":
		s.handleMCPToolProgress(msg.Params)

	case "item/reasoning/summaryTextDelta":
		s.handleReasoningDelta(msg.Params, false)

	case "item/reasoning/textDelta":
		s.handleReasoningDelta(msg.Params, true)

	case "thread/tokenUsage/updated":
		// Usage accounting, not a transcript entry: it updates the session's
		// totals through the observer and produces no event.
		s.usage.observe(msg.Params)

	case "mcpServer/startupStatus/updated":
		s.handleMCPServerStatus(msg.Params)

	case "error":
		s.handleErrorNotification(msg.Params)

	case "warning", "guardianWarning", "configWarning":
		s.handleWarningNotification(msg.Method, msg.Params)

	default:
		if ignoredNotifications[msg.Method] {
			return
		}
		s.log.Debug("unhandled codex notification", "method", msg.Method)
	}
}

// handleTurnStarted records the turn that turn/interrupt would have to name.
func (s *appSession) handleTurnStarted(params json.RawMessage) {
	var notif struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := json.Unmarshal(params, &notif); err != nil || notif.Turn.ID == "" {
		// The waiting stop is deliberately left waiting: the user asked to stop
		// and nothing has run since, so the next turn that does name itself is
		// still the one they meant. SendMessage retires it if they move on.
		s.log.Warn("failed to read the turn id out of turn/started", "error", err)
		return
	}
	// A refusal reported between turns is not this turn's.
	s.turnAuthFailed = false
	threadID, interrupt := s.adoptTurn(notif.Turn.ID)
	if interrupt {
		// A stop that arrived before this turn had an id to name. See
		// SendInterrupt.
		s.log.Info("carrying out the stop this turn was already asked for", "turnId", notif.Turn.ID)
		if err := s.interruptTurn(threadID, notif.Turn.ID); err != nil {
			s.log.Error("could not interrupt the turn a stop was waiting for", "error", err, "turnId", notif.Turn.ID)
		}
	}
}

// turnError is how a failed turn explains itself.
type turnError struct {
	Message           string          `json:"message"`
	AdditionalDetails string          `json:"additionalDetails"`
	CodexErrorInfo    json.RawMessage `json:"codexErrorInfo"`
}

// handleTurnCompleted ends the turn. Exactly one event comes out of it, which is
// the contract agent.Session.Events describes.
func (s *appSession) handleTurnCompleted(params json.RawMessage) {
	var notif struct {
		Turn struct {
			ID     string     `json:"id"`
			Status string     `json:"status"`
			Error  *turnError `json:"error"`
		} `json:"turn"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		// Deliberately no early return: a turn ending in a frame we cannot read
		// is still a turn that ended, and leaving it pending would hang the
		// session on an event that is never coming.
		s.log.Warn("failed to parse turn/completed", "error", err)
	}

	s.clearTurn()
	s.forgetToolInputs()
	s.forgetReasoning(s.isOwnThread)
	authFailed := s.turnAuthFailed
	s.turnAuthFailed = false
	if notif.Turn.Error != nil {
		switch readAuthVerdict(notif.Turn.Error.CodexErrorInfo) {
		case authRefused:
			authFailed = true
		case authAccepted:
			authFailed = false
		}
	}

	switch notif.Turn.Status {
	case "interrupted":
		// A stop somebody asked for, which is what InterruptedEvent means:
		// the work engine stops the work item instead of continuing it.
		s.emitEvent(agent.InterruptedEvent{})
	case "failed":
		message := "codex reported an error without a message"
		if notif.Turn.Error != nil {
			s.log.Info("codex turn failed",
				"message", redactSecrets(notif.Turn.Error.Message),
				"details", redactSecrets(notif.Turn.Error.AdditionalDetails),
				"info", string(notif.Turn.Error.CodexErrorInfo))
			message = firstNonEmpty(redactSecrets(notif.Turn.Error.Message), message)
		}
		event := agent.ErrorEvent{Error: message}
		if authFailed {
			event.AuthFailure = codexAuthFailure()
		}
		s.emitEvent(event)
	default:
		s.emitEvent(agent.DoneEvent{})
	}
}

// notificationThread reads the thread a notification is about, empty when it
// names none.
func notificationThread(params json.RawMessage) string {
	var notif struct {
		ThreadID string `json:"threadId"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		// Reported by the handler that reads the rest of the frame; here it
		// just names no thread.
		return ""
	}
	return notif.ThreadID
}

// isOwnThread reports whether a notification naming threadID is about this
// session's own thread rather than a subagent's. A notification naming none,
// or one arriving before the thread is known, is taken as the session's: only
// a thread that is demonstrably another one is set apart.
func (s *appSession) isOwnThread(threadID string) bool {
	own := s.currentThreadID()
	return threadID == "" || own == "" || threadID == own
}

// settleSubagent closes the row of a subagent whose turn has ended: the spawn
// is drawn as a Task call (see rememberSubagent), and this is its result. The
// child's own last words are the report, which is what the parent reads back
// from its wait — the same thing a Claude Task's result carries.
//
// Taken from the child's turn/completed rather than the subAgentActivity
// "completed" item the parent's thread gets: only the former says how the turn
// ended. A child given more work later (sendInput, followupTask) runs another
// turn under the same spawn and settles it again; the report is still its
// latest words, so a turn that said nothing does not wipe out the last one.
//
// A child whose spawn was never seen — one a previous process started — has no
// row to settle, and only a failure is said for it, as a warning: without one
// the user would see its work stop and nothing say why. An interrupted one is
// somebody's doing, which explains itself, and a completed one reports through
// its own text.
func (s *appSession) settleSubagent(threadID string, params json.RawMessage) {
	var notif struct {
		Turn struct {
			Status string     `json:"status"`
			Error  *turnError `json:"error"`
		} `json:"turn"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse a subagent's turn/completed", "threadId", threadID, "error", err)
		return
	}
	s.log.Debug("subagent turn ended", "threadId", threadID, "status", notif.Turn.Status)
	failure := "no message"
	if notif.Turn.Error != nil {
		failure = firstNonEmpty(redactSecrets(notif.Turn.Error.Message), failure)
	}

	spawn, seen := s.subagentCalls[threadID]
	if !seen {
		if notif.Turn.Status == "failed" {
			s.emitEvent(agent.WarningEvent{
				Message: "A subagent failed: " + failure,
				Code:    "subagent_failed",
			})
		}
		return
	}

	// The spawn's own parent, so that a nested spawn's result is marked as its
	// subagent's record like the call it settles.
	result := agent.ToolResultEvent{
		ToolUseID:       spawn.CallID,
		ToolResult:      s.subagentReports[threadID],
		ParentToolUseID: spawn.ParentToolUseID,
	}
	switch notif.Turn.Status {
	case "completed":
	case "interrupted":
		result.IsError = true
		result.ToolResult = "The subagent was interrupted before it finished."
	default:
		result.IsError = true
		result.ToolResult = "The subagent failed: " + failure
	}
	s.emitEvent(result)
}

// rememberSubagent records which call spawned a subagent's thread, read off
// the subAgentActivity item that reports the spawn, and draws that spawn as a
// Task call — the row the child's records are filed under (see
// agent.EventRecord.ParentToolUseID) and that settleSubagent closes. The item
// arrives on the spawning thread before anything from the new one, and its id
// is the id of the model's spawn call — the one thing that ties the two threads
// together. Read from both item/started and item/completed, which carry the
// same item: either is enough, so a version that sends only one still nests,
// and the call is emitted for whichever comes first.
//
// The item names the agent and nothing else — no prompt, no task description
// (measured on codex-cli 0.159.3; the child's prompt is not echoed on its
// thread either) — so the call's input is the agent's path as Codex gave it,
// and naming the row after it is the frontend's business.
//
// The same codex-cli reports a spawn in a second shape, depending on the model
// (measured with gpt-5.6-luna): a collabAgentToolCall whose tool is spawnAgent,
// carrying the prompt, and naming the new thread in receiverThreadIds only once
// it has completed. The child's items follow that completion, so reading it
// there is in time; the call's input is then the prompt.
func (s *appSession) rememberSubagent(item threadItem) {
	threadID, input, ok := spawnOf(item)
	if !ok {
		return
	}
	if _, seen := s.subagentCalls[threadID]; seen {
		return
	}
	if s.subagentCalls == nil {
		s.subagentCalls = map[string]subagentSpawn{}
	}
	s.subagentCalls[threadID] = subagentSpawn{CallID: item.ID, ParentToolUseID: item.ParentToolUseID}

	s.emitEvent(agent.ToolCallEvent{
		ToolUseID:         item.ID,
		ToolName:          subagentToolName,
		ToolInput:         input,
		ParentToolUseID:   item.ParentToolUseID,
		ProviderMessageID: item.TurnID,
	})
}

// spawnOf reads the thread a spawn started, and the input its row is drawn
// from, off either shape of spawn item; ok is false for an item that started
// no thread (yet).
func spawnOf(item threadItem) (threadID string, input json.RawMessage, ok bool) {
	switch item.Type {
	case "subAgentActivity":
		var ev struct {
			Kind          string `json:"kind"`
			AgentThreadID string `json:"agentThreadId"`
			AgentPath     string `json:"agentPath"`
		}
		if err := json.Unmarshal(item.Raw, &ev); err != nil || ev.Kind != "started" || ev.AgentThreadID == "" {
			return "", nil, false
		}
		input, _ = json.Marshal(map[string]string{"agent_path": ev.AgentPath})
		return ev.AgentThreadID, input, true
	case "collabAgentToolCall":
		var ev struct {
			Tool              string   `json:"tool"`
			ReceiverThreadIDs []string `json:"receiverThreadIds"`
			Prompt            string   `json:"prompt"`
		}
		// One spawn starts one thread; a call naming none has not started it
		// yet (item/started) or failed to.
		if err := json.Unmarshal(item.Raw, &ev); err != nil || ev.Tool != "spawnAgent" || len(ev.ReceiverThreadIDs) != 1 {
			return "", nil, false
		}
		input, _ = json.Marshal(map[string]string{"prompt": ev.Prompt})
		return ev.ReceiverThreadIDs[0], input, true
	}
	return "", nil, false
}

// subagentToolName is one of the names Claude's subagent call goes by, which
// is what makes the frontend draw a spawn as a subagent row (isTaskTool in
// web/src/lib/toolSummary.ts accepts it).
const subagentToolName = "Task"

// subagentSpawn is the call that started a subagent's thread, and the call
// that call was itself made inside — empty unless the spawning thread was a
// subagent's too.
type subagentSpawn struct {
	CallID          string
	ParentToolUseID string
}

// rememberSubagentReport keeps a child's latest words for settleSubagent: the
// last thing a subagent says is its answer. Kept as the items pass
// rather than read off turn/completed, whose items are only a summary view.
func (s *appSession) rememberSubagentReport(threadID, text string) {
	if s.subagentReports == nil {
		s.subagentReports = map[string]string{}
	}
	s.subagentReports[threadID] = text
}

// threadItem is the part of a thread item every branch below reads. The rest is
// left in Raw, because which fields exist depends on Type.
type threadItem struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Raw  json.RawMessage

	// TurnID comes from the notification around the item rather than from the
	// item itself, and it is what the events of this item are stamped with so
	// that a fork can be anchored on the turn they came out of.
	//
	// Taken from the notification rather than read back off the session, even
	// though the session tracks the running turn for turn/interrupt: which turn
	// an item belonged to is a fact that arrived with it, and a record has to
	// keep saying it after the session has moved on to the next turn.
	//
	// Empty for a subagent's item: its turn belongs to the subagent's thread,
	// and a fork anchored on it would name a turn this thread never had.
	TurnID string

	// FromSubagent marks an item of a subagent's thread rather than this
	// session's, and ParentToolUseID names the call that spawned that thread
	// when the spawn was seen. See agent.EventRecord.ParentToolUseID.
	FromSubagent    bool   `json:"-"`
	ParentToolUseID string `json:"-"`
	// ThreadID is the thread the notification named, read off it like TurnID.
	ThreadID string `json:"-"`
	// AtMs is the engine's clock reading the notification carried: startedAtMs
	// on item/started, completedAtMs on item/completed. Zero when it carried
	// none.
	AtMs int64 `json:"-"`
}

// parseItemNotification reads an item notification and places it: an item of
// a subagent's thread is stamped with the call that spawned it.
func (s *appSession) parseItemNotification(params json.RawMessage) (threadItem, bool) {
	var notif struct {
		Item json.RawMessage `json:"item"`
		// Required on both item/started and item/completed, per the protocol
		// schema codex-cli 0.153.0 generates.
		TurnID        string `json:"turnId"`
		ThreadID      string `json:"threadId"`
		StartedAtMs   int64  `json:"startedAtMs"`
		CompletedAtMs int64  `json:"completedAtMs"`
	}
	if err := json.Unmarshal(params, &notif); err != nil || len(notif.Item) == 0 {
		return threadItem{}, false
	}
	var item threadItem
	if err := json.Unmarshal(notif.Item, &item); err != nil {
		return threadItem{}, false
	}
	item.Raw = notif.Item
	item.TurnID = notif.TurnID
	item.ThreadID = notif.ThreadID
	item.AtMs = max(notif.StartedAtMs, notif.CompletedAtMs)
	if !s.isOwnThread(notif.ThreadID) {
		item.FromSubagent = true
		item.ParentToolUseID = s.subagentCalls[notif.ThreadID].CallID
		item.TurnID = ""
	}
	return item, true
}

// handleItemStarted turns the beginning of a tool-shaped item into a tool call,
// and the echo of a message into the signal that Codex has read it.
//
// A reasoning item's start is remembered for its duration and, on the main
// thread, signals that the agent is thinking. The remaining items with no
// counterpart in Pockode's transcript (the agent's own messages, plans, web
// searches) are left to item/completed or dropped there.
func (s *appSession) handleItemStarted(params json.RawMessage) {
	item, ok := s.parseItemNotification(params)
	if !ok {
		s.log.Warn("failed to parse item/started")
		return
	}

	switch item.Type {
	case "userMessage":
		// A subagent's prompt is not a message the user sent this session, so
		// it is nobody's read point here.
		if !item.FromSubagent {
			s.handleUserMessageItem(item)
		}
		return
	case "subAgentActivity", "collabAgentToolCall":
		s.rememberSubagent(item)
	case "reasoning":
		s.handleReasoningStarted(item)
	}
	s.modelReached(item)

	toolName, toolInput, ok := s.toolCallOf(item)
	if !ok {
		return
	}

	// Remembered because the approval request that may follow names only the
	// item id; see appSession.toolInputs.
	s.rememberToolInput(item.ID, toolInput)

	s.emitEvent(agent.ToolCallEvent{
		ToolUseID:         item.ID,
		ToolName:          toolName,
		ToolInput:         toolInput,
		ParentToolUseID:   item.ParentToolUseID,
		ProviderMessageID: item.TurnID,
	})
}

// handleUserMessageItem turns Codex echoing a message back into the read point
// for it.
//
// The echo is Codex's own account of the moment the message entered the
// conversation, and it lands between two items rather than inside one, so the
// boundary it marks is exact: everything after it answers this message. It is
// the only signal of the kind either CLI offers (measured 2026-09-23 on
// codex-cli 0.153.0 and claude-code 2.1.263).
//
// The message that opened the turn is echoed the same way and is passed over:
// nothing has been said in the turn yet, so a signal for it would mark a
// boundary where the message record already is. See claimTurnOpener.
//
// Taken from item/started rather than item/completed, which carries the same
// item milliseconds later: one of the two has to be ignored, and the earlier one
// is the read point.
func (s *appSession) handleUserMessageItem(item threadItem) {
	if s.claimTurnOpener(item.TurnID) {
		return
	}

	var ev struct {
		// ClientID is the id Pockode sent this message with, echoed back. Null
		// for a message sent without one, and for anything that reached the
		// thread from outside Pockode.
		ClientID string `json:"clientId"`
	}
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		// Degraded rather than dropped: which message was read is worth less
		// than the fact that one was, and the position of the record still says
		// where the boundary is. See agent.MessageIngestedEvent.
		s.log.Warn("failed to parse userMessage item", "error", err)
	}

	s.emitEvent(agent.MessageIngestedEvent{MessageID: ev.ClientID})
}

// toolCallOf renders an item as a tool call, or reports that it is not one.
//
// The tool names are Pockode's, not Codex's: "Bash", "Edit" and "Read" are what
// the frontend renders a command, a patch and a file the agent looked at as,
// for either agent.
func (s *appSession) toolCallOf(item threadItem) (toolName string, toolInput json.RawMessage, ok bool) {
	switch item.Type {
	case "commandExecution":
		var ev struct {
			Command string `json:"command"`
			Cwd     string `json:"cwd"`
			// CommandActions is Codex's own parse of the command: what each
			// piped part of it does (read, listFiles, search, unknown) and to
			// which path or query. Carried through as data rather than rendered
			// here — it is a better source for a row's title than guessing from
			// the command string, and where the title is drawn is the
			// frontend's business.
			CommandActions json.RawMessage `json:"commandActions"`
		}
		if err := json.Unmarshal(item.Raw, &ev); err != nil {
			return "", nil, false
		}
		input := map[string]interface{}{
			"command": ev.Command,
			"cwd":     ev.Cwd,
		}
		if len(ev.CommandActions) > 0 && string(ev.CommandActions) != "null" {
			input["command_actions"] = ev.CommandActions
		}
		encoded, _ := json.Marshal(input)
		return "Bash", encoded, true

	case "fileChange":
		var ev struct {
			Changes json.RawMessage `json:"changes"`
		}
		if err := json.Unmarshal(item.Raw, &ev); err != nil {
			return "", nil, false
		}
		return "Edit", buildEditInput(ev.Changes), true

	case "mcpToolCall":
		var ev struct {
			Server    string          `json:"server"`
			Tool      string          `json:"tool"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(item.Raw, &ev); err != nil {
			return "", nil, false
		}
		// `arguments` is typed as any JSON, so a tool called with none is
		// reported either by leaving the field out or by sending null. Both have
		// to come out as an object: the frontend renders this as the call's
		// arguments, and "null" is not a set of them.
		input := ev.Arguments
		if len(input) == 0 || string(input) == "null" {
			input = json.RawMessage("{}")
		}
		// server:tool, because the name is the only place it can be shown.
		return ev.Server + ":" + ev.Tool, input, true

	case "imageView":
		raw, ok := imageViewPath(item)
		if !ok {
			return "", nil, false
		}
		// The path Codex named, made openable where it can be — and shown as it
		// arrived where it cannot, since that is then the only description of
		// the file there is. Resolved the same way here as in the result, so
		// the call and the file below it name one file. See view_image.go.
		input, _ := json.Marshal(map[string]string{"file_path": firstNonEmpty(s.imageViewLocalPath(raw), raw)})
		return "Read", input, true
	}

	return "", nil, false
}

// handleItemCompleted turns a finished item into the text or tool result it
// produced.
func (s *appSession) handleItemCompleted(params json.RawMessage) {
	item, ok := s.parseItemNotification(params)
	if !ok {
		s.log.Warn("failed to parse item/completed")
		return
	}

	s.forgetToolInput(item.ID)
	s.modelReached(item)

	switch item.Type {
	case "subAgentActivity", "collabAgentToolCall":
		s.rememberSubagent(item)

	case "agentMessage":
		var ev struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(item.Raw, &ev); err != nil {
			s.log.Warn("failed to parse agentMessage item", "error", err)
			return
		}
		// Only a child whose spawn was seen has a row for the report to settle.
		if ev.Text != "" && item.ParentToolUseID != "" {
			s.rememberSubagentReport(item.ThreadID, ev.Text)
		}
		if ev.Text != "" {
			s.emitEvent(agent.TextEvent{
				Content:           ev.Text,
				ParentToolUseID:   item.ParentToolUseID,
				ProviderMessageID: item.TurnID,
			})
		}

	case "commandExecution":
		var ev struct {
			AggregatedOutput string `json:"aggregatedOutput"`
			ExitCode         *int   `json:"exitCode"`
			DurationMs       int64  `json:"durationMs"`
			Status           string `json:"status"`
		}
		if err := json.Unmarshal(item.Raw, &ev); err != nil {
			s.log.Warn("failed to parse commandExecution item", "error", err)
			return
		}
		// Status rather than the exit code, which is what the MCP channel had to
		// use: Codex has already folded the exit code into it — a command that
		// exited 2 reports status "failed" (measured on codex-cli 0.153.0) — and
		// status also covers the failures that never produced an exit code at
		// all, a declined approval among them.
		failed := ev.Status != itemStatusCompleted
		result := ev.AggregatedOutput
		if result == "" && failed {
			// A silent failure is still a failure: without this the user sees an
			// empty result and no hint that the command did not succeed.
			result = describeFailedCommand(ev.Status, ev.ExitCode)
		}
		// The exit code and the duration travel as figures beside the result
		// rather than only inside describeFailedCommand's sentence: Codex
		// reports them as data, and a number folded into prose cannot be
		// rendered as anything else later.
		s.emitEvent(agent.ToolResultEvent{
			ToolUseID:         item.ID,
			ToolResult:        result,
			ExitCode:          ev.ExitCode,
			DurationMs:        ev.DurationMs,
			IsError:           failed,
			ParentToolUseID:   item.ParentToolUseID,
			ProviderMessageID: item.TurnID,
		})

	case "fileChange":
		var ev struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(item.Raw, &ev); err != nil {
			s.log.Warn("failed to parse fileChange item", "error", err)
			return
		}
		failed := ev.Status != itemStatusCompleted
		// A patch reports no output of its own, so a successful one says nothing
		// and the call's own input is what the user reads. Only a failure needs
		// words, and the status is all there is to build them from.
		var result string
		if failed {
			result = describeFailedPatch(ev.Status)
		}
		s.emitEvent(agent.ToolResultEvent{
			ToolUseID:         item.ID,
			ToolResult:        result,
			IsError:           failed,
			ParentToolUseID:   item.ParentToolUseID,
			ProviderMessageID: item.TurnID,
		})

	case "mcpToolCall":
		s.emitEvent(mcpToolResult(item))

	case "imageView":
		s.handleImageViewCompleted(item)

	case "reasoning":
		s.handleReasoningCompleted(item)
	}
}

// handleCommandOutputDelta forwards the next chunk of a running command's
// output.
//
// Safe to drop under load, and deliberately so: the whole output arrives again
// on item/completed, so a lost delta costs a moment of liveness and nothing
// else. That is also why it is not persisted — see agent.ToolActivityEvent.
func (s *appSession) handleCommandOutputDelta(params json.RawMessage) {
	var notif struct {
		ItemID string `json:"itemId"`
		Delta  string `json:"delta"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse a command output delta", "error", err)
		return
	}
	if notif.ItemID == "" || notif.Delta == "" {
		return
	}
	s.emitEvent(agent.ToolActivityEvent{ToolUseID: notif.ItemID, OutputDelta: notif.Delta})
}

// handleMCPToolProgress forwards an MCP tool's own one-line account of what it
// is doing.
func (s *appSession) handleMCPToolProgress(params json.RawMessage) {
	var notif struct {
		ItemID  string `json:"itemId"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse an MCP tool progress message", "error", err)
		return
	}
	if notif.ItemID == "" || notif.Message == "" {
		return
	}
	s.emitEvent(agent.ToolActivityEvent{ToolUseID: notif.ItemID, Activity: notif.Message})
}

const (
	itemStatusCompleted = "completed"
	itemStatusDeclined  = "declined"
)

func describeFailedCommand(status string, exitCode *int) string {
	if status == itemStatusDeclined {
		return deniedByUser
	}
	if exitCode != nil {
		return fmt.Sprintf("(no output, exit code %d)", *exitCode)
	}
	return "(the command did not run)"
}

func describeFailedPatch(status string) string {
	if status == itemStatusDeclined {
		return deniedByUser
	}
	return "The patch could not be applied."
}

// mcpToolResult renders a finished MCP tool call. Codex reports the failure in
// `error` and the content in `result`, which follows MCP's own shape.
func mcpToolResult(item threadItem) agent.ToolResultEvent {
	var ev struct {
		Status     string `json:"status"`
		DurationMs int64  `json:"durationMs"`
		Error      *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result *struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		return agent.ToolResultEvent{
			ToolUseID:         item.ID,
			IsError:           true,
			ToolResult:        "Pockode could not read this tool call's result.",
			ParentToolUseID:   item.ParentToolUseID,
			ProviderMessageID: item.TurnID,
		}
	}

	var result string
	if ev.Error != nil {
		result = ev.Error.Message
	} else if ev.Result != nil {
		var parts []string
		for _, c := range ev.Result.Content {
			if c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		result = strings.Join(parts, "\n")
	}

	return agent.ToolResultEvent{
		ToolUseID:         item.ID,
		ToolResult:        result,
		DurationMs:        ev.DurationMs,
		IsError:           ev.Status != itemStatusCompleted,
		ParentToolUseID:   item.ParentToolUseID,
		ProviderMessageID: item.TurnID,
	}
}

// handleMCPServerStatus reports an MCP server that failed to start.
//
// A server that fails silently removes its tools from the session — for the
// pockode server that means no work_* tools at all. The MCP channel only ever
// reported this as one summary at the end of startup; here it arrives per
// server, as it happens.
func (s *appSession) handleMCPServerStatus(params json.RawMessage) {
	var notif struct {
		Name   string `json:"name"`
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse mcpServer/startupStatus/updated", "error", err)
		return
	}
	if notif.Status != "failed" {
		return
	}
	s.log.Warn("codex MCP server failed to start", "server", notif.Name, "error", notif.Error)
	s.emitEvent(agent.WarningEvent{
		Message: fmt.Sprintf("MCP server %q failed to start, its tools are unavailable: %s", notif.Name, notif.Error),
		Code:    "mcp_startup_failed",
	})
}

// notFromTheModel are the item types that can appear without the model's
// stream having got through, so they prove nothing about credentials. Where: the
// ThreadItem union of codex-cli 0.153.0's app-server schema. Compaction calls
// the API too, and can itself be refused.
var notFromTheModel = map[string]bool{
	"userMessage":       true,
	"contextCompaction": true,
	"hookPrompt":        true,
	"enteredReviewMode": true,
	"exitedReviewMode":  true,
}

// modelReached reads an item of the running turn: one the model produced says
// the turn got past authentication, so a refusal earlier in it is not what it
// ends on. A subagent's item is of its own thread's turn, not this one.
func (s *appSession) modelReached(item threadItem) {
	if !item.FromSubagent && !notFromTheModel[item.Type] {
		s.turnAuthFailed = false
	}
}

// handleErrorNotification reports a turn error that the turn survives.
//
// A failure the turn does not survive is reported by turn/completed instead,
// which also covers the failures that produce no error notification at all —
// emitting here too would show the user the same failure twice. willRetry is the
// one case turn/completed will not report, because the turn goes on: it is what
// explains a turn that has stalled on stream retries.
func (s *appSession) handleErrorNotification(params json.RawMessage) {
	var notif struct {
		TurnID    string    `json:"turnId"`
		Error     turnError `json:"error"`
		WillRetry bool      `json:"willRetry"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse error notification", "error", err)
		return
	}
	message := redactSecrets(notif.Error.Message)
	s.log.Info("codex reported a turn error",
		"message", message, "willRetry", notif.WillRetry,
		"info", string(notif.Error.CodexErrorInfo))

	// Remembered for the turn's ending, whose own error info does not say it
	// (see readAuthVerdict) — the latest word wins, so a refusal the turn got
	// past before failing for something else does not mark it. Only for the
	// turn running now: a late report of an earlier one must not carry over.
	var authFailure *agent.AuthFailure
	if _, running := s.currentTurn(); running != "" && (notif.TurnID == "" || notif.TurnID == running) {
		switch readAuthVerdict(notif.Error.CodexErrorInfo) {
		case authRefused:
			s.turnAuthFailed = true
			authFailure = codexAuthFailure()
		case authAccepted:
			s.turnAuthFailed = false
		}
	}

	if !notif.WillRetry || message == "" {
		return
	}
	// "stream_error" is the MCP channel's name for the same thing, kept so that
	// a transcript recorded before the move and one recorded after it carry the
	// same code for the same event. Nothing branches on the value — it goes
	// straight to the banner — so the only thing it can cost is a reader's
	// double take at a name no app-server notification has.
	//
	// A refused retry carries the auth mark, which is what lets the user sign in
	// while the turn is still retrying — about twenty seconds on codex-cli
	// 0.153.0 — rather than after it gives up.
	s.emitEvent(agent.WarningEvent{Message: message, Code: "stream_error", AuthFailure: authFailure})
}

// handleWarningNotification surfaces a non-fatal warning: the turn keeps going,
// and saying so is what explains a guardrail that changed what ran, or a
// misconfiguration that makes every command ask for approval.
func (s *appSession) handleWarningNotification(method string, params json.RawMessage) {
	var notif struct {
		Message string `json:"message"`
		// configWarning words the same thing differently.
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse codex warning notification", "method", method, "error", err)
		return
	}
	// Provider error text reaches here too — the fallback from WebSockets
	// quotes the 401 it got — so it is redacted like a turn error.
	message := redactSecrets(firstNonEmpty(notif.Message, notif.Summary))
	if message == "" {
		s.log.Debug("ignoring codex warning without a message", "method", method)
		return
	}
	s.emitEvent(agent.WarningEvent{Message: message, Code: warningCode(method)})
}

// warningCode names the warning's kind for the frontend, in the snake_case the
// other codes here use.
func warningCode(method string) string {
	switch method {
	case "guardianWarning":
		return "guardian_warning"
	case "configWarning":
		return "config_warning"
	default:
		return "warning"
	}
}

// --- In-flight tool inputs ---

func (s *appSession) rememberToolInput(itemID string, input json.RawMessage) {
	if itemID == "" {
		return
	}
	s.toolInputsMu.Lock()
	defer s.toolInputsMu.Unlock()
	s.toolInputs[itemID] = input
}

func (s *appSession) toolInput(itemID string) (json.RawMessage, bool) {
	s.toolInputsMu.Lock()
	defer s.toolInputsMu.Unlock()
	input, ok := s.toolInputs[itemID]
	return input, ok
}

func (s *appSession) forgetToolInput(itemID string) {
	s.toolInputsMu.Lock()
	defer s.toolInputsMu.Unlock()
	delete(s.toolInputs, itemID)
}

// forgetToolInputs drops what the ending turn left behind. An item that is
// never completed — the turn was interrupted while it ran — would otherwise sit
// in the map for the life of the process.
func (s *appSession) forgetToolInputs() {
	s.toolInputsMu.Lock()
	defer s.toolInputsMu.Unlock()
	clear(s.toolInputs)
}

// --- Codex payload helpers ---

// buildEditInput builds the ToolInput JSON for an Edit tool call or approval.
//
// `changes` is passed through as Codex sent it, an array of {path, kind, diff};
// web/src/lib/codexChanges.ts renders it. file_path is added when exactly one
// file is involved, because that is what the collapsed tool row shows.
func buildEditInput(changes json.RawMessage) json.RawMessage {
	inputMap := map[string]interface{}{
		"changes": changes,
	}
	if fp := extractFilePath(changes); fp != "" {
		inputMap["file_path"] = fp
	}
	data, _ := json.Marshal(inputMap)
	return data
}

// extractFilePath returns the single path a patch touches, empty when it touches
// none or several.
func extractFilePath(changes json.RawMessage) string {
	var parsed []struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(changes, &parsed); err != nil {
		return ""
	}
	if len(parsed) == 1 {
		return parsed[0].Path
	}
	return ""
}
