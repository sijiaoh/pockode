package claude

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/pockode/server/agent"
)

// The plan tools of claude 2.1.330. Which set a model is offered is the CLI's
// decision (docs/turn-progress-ui.md §4.6); Pockode reads whichever runs.
const (
	toolTodoWrite  = "TodoWrite"
	toolTaskCreate = "TaskCreate"
	toolTaskUpdate = "TaskUpdate"
	toolTaskList   = "TaskList"
)

// What a Task tool's result text says, in claude 2.1.330. The text is the CLI's
// account of what it did, after it repaired the call's input, so it is read
// in preference to the input wherever it says the same thing.
var (
	// taskCreatedPattern is `Task #<id> created successfully: <subject>`; the
	// CLI itself parses its results with the part before the colon.
	taskCreatedPattern = regexp.MustCompile(`^Task #(\S+) created successfully: (.*)`)
	// taskUpdatedPattern opens every TaskUpdate result that changed something.
	// A refused one — an unknown id, a delete that failed, a completion a hook
	// blocked — is not flagged is_error; its text is the error instead, so the
	// text is what says whether the update happened.
	taskUpdatedPattern = regexp.MustCompile(`^Updated task #(\S+)`)
)

// taskKeptByAppNote is what the CLI appends to a TaskCreate's text in a host
// that sets task statuses itself; it is not part of the subject.
const taskKeptByAppNote = " The app marks these items in progress"

// planSeed is the seed a launch can use. The CLI keys its task list by its own
// session id and numbers each list from 1, so only a launch that resumes that
// same session finds its tasks again. A fork, a fresh session and a recovery
// that gave up the old id get a list of their own, where the seed would be
// another list's tasks and its ids would collide with the new ones. (The CLI
// can restore a transcript's tasks into a new list, but only when a host or a
// flag asks it to, and Pockode does neither.)
func planSeed(ctx context.Context, opts agent.StartOptions, launch claudeLaunch) []agent.PlanStep {
	if !launch.resume || launch.fork || opts.PlanSeed == nil {
		return nil
	}
	return opts.PlanSeed(ctx)
}

// planTracker turns the session's plan calls into plan records: each of the
// main agent's TodoWrites as it stands, and the incremental Task tools folded
// into one list, in creation order.
//
// The two are scoped differently by the CLI (claude 2.1.330). A TodoWrite list
// is the calling agent's own, so a subagent's is history in its Process and
// never the main plan. The task list is the session's: a subagent's TaskCreate
// and TaskUpdate write the same list the main agent reads back with TaskList,
// so they are folded too, and their records name the top-level subagent call
// they ran inside — the main-thread call the change happened under, which is
// where the client looks for the main plan.
//
// It is state, and it stays in the adapter: what leaves is a snapshot of it,
// one PlanEvent per change. Owned by the goroutine reading the CLI's output.
type planTracker struct {
	log *slog.Logger
	// calls holds the input of each plan call until its result arrives: a
	// result carries little of its call, and the subject, the activeForm and
	// TodoWrite's list are only in the input.
	calls map[string]plannedCall
	// spawns maps each subagent call to the call it was made inside, empty for
	// the main agent's own, so a nested subagent's change can be named by the
	// top-level call. Kept for the process's life: one entry per subagent.
	spawns map[string]string
	// tasks is the fold of the Task tools.
	tasks []agent.PlanStep
	// seeded is the ids the fold was seeded with, until a TaskList or a
	// TaskCreate settles whether they are this task list's; see applyCreate.
	seeded map[string]bool
}

type plannedCall struct {
	name  string
	input json.RawMessage
	// under is the top-level call a subagent's plan call ran inside, empty
	// for the main agent's own.
	under string
}

// newPlanTracker starts the fold from the plan the session's previous process
// last reported (agent.StartOptions.PlanSeed): the CLI keeps its task list
// across a restart, so the first TaskUpdate after one names earlier tasks.
func newPlanTracker(log *slog.Logger, seed []agent.PlanStep) *planTracker {
	seeded := map[string]bool{}
	for _, step := range seed {
		seeded[step.ID] = true
	}
	return &planTracker{
		log:    log,
		calls:  map[string]plannedCall{},
		spawns: map[string]string{},
		tasks:  slices.Clone(seed),
		seeded: seeded,
	}
}

// observe reads the events parsed out of one frame and returns them with a
// plan record after each result that changed the plan.
func (p *planTracker) observe(frame cliEvent, events []agent.AgentEvent) []agent.AgentEvent {
	// tool_use_result is one per frame and names no tool_use_id, so it is a
	// result's own only when the frame holds that one result.
	var structured json.RawMessage
	results := 0
	for _, ev := range events {
		if _, ok := ev.(agent.ToolResultEvent); ok {
			results++
		}
	}
	if results == 1 {
		structured = frame.ToolUseResult
	}

	var out []agent.AgentEvent
	for _, ev := range events {
		out = append(out, ev)
		switch e := ev.(type) {
		case agent.ToolCallEvent:
			p.observeCall(e)
		case agent.ToolResultEvent:
			if plan, ok := p.settle(e, structured); ok {
				out = append(out, plan)
			}
		}
	}
	return out
}

func (p *planTracker) observeCall(call agent.ToolCallEvent) {
	if isSubagentTool(call.ToolName) {
		p.spawns[call.ToolUseID] = call.ParentToolUseID
		return
	}
	switch call.ToolName {
	case toolTodoWrite:
		if call.ParentToolUseID != "" {
			return
		}
	case toolTaskCreate, toolTaskUpdate, toolTaskList:
	default:
		return
	}
	held := plannedCall{name: call.ToolName, input: call.ToolInput}
	if call.ParentToolUseID != "" {
		held.under = p.topLevel(call.ParentToolUseID)
	}
	p.calls[call.ToolUseID] = held
}

// topLevel is the main-thread call that the subagent call id runs inside,
// walking up through nested spawns; id itself when it is one, or when its own
// spawn was not seen. In that last case the record names a nested call, which
// the main plan does not read, and the plan line catches up with the next
// record: a spawn is only unseen when its frame was lost.
func (p *planTracker) topLevel(id string) string {
	// Bounded by the map's size, so that no shape of input can loop forever.
	for range len(p.spawns) {
		parent, ok := p.spawns[id]
		if !ok || parent == "" {
			return id
		}
		id = parent
	}
	return id
}

// settle applies one plan call's result, and reports the plan record it
// produced, if the plan changed.
func (p *planTracker) settle(result agent.ToolResultEvent, structured json.RawMessage) (agent.PlanEvent, bool) {
	call, ok := p.calls[result.ToolUseID]
	if !ok {
		return agent.PlanEvent{}, false
	}
	delete(p.calls, result.ToolUseID)
	// A denied or failed call changed nothing.
	if result.IsError {
		return agent.PlanEvent{}, false
	}

	if call.name == toolTodoWrite {
		steps, ok := p.todoSteps(call.input)
		if !ok {
			return agent.PlanEvent{}, false
		}
		return p.record(call, result, steps), true
	}

	before := slices.Clone(p.tasks)
	switch call.name {
	case toolTaskCreate:
		p.applyCreate(call.input, result.ToolResult, structured)
	case toolTaskUpdate:
		p.applyUpdate(call.input, result.ToolResult)
	case toolTaskList:
		p.applyList(structured)
	}
	if slices.Equal(before, p.tasks) {
		return agent.PlanEvent{}, false
	}
	return p.record(call, result, slices.Clone(p.tasks)), true
}

func (p *planTracker) record(call plannedCall, result agent.ToolResultEvent, steps []agent.PlanStep) agent.PlanEvent {
	id := result.ToolUseID
	if call.under != "" {
		id = call.under
	}
	return agent.PlanEvent{
		Steps:             steps,
		ToolUseID:         id,
		ProviderMessageID: result.ProviderMessageID,
	}
}

func (p *planTracker) todoSteps(input json.RawMessage) ([]agent.PlanStep, bool) {
	var in struct {
		Todos []struct {
			Content    string               `json:"content"`
			ActiveForm string               `json:"activeForm"`
			Status     agent.PlanStepStatus `json:"status"`
		} `json:"todos"`
	}
	if err := json.Unmarshal(input, &in); err != nil {
		p.log.Warn("could not read a TodoWrite's list; its plan is not recorded", "error", err)
		return nil, false
	}
	steps := make([]agent.PlanStep, 0, len(in.Todos))
	for _, todo := range in.Todos {
		steps = append(steps, agent.PlanStep{Text: todo.Content, ActiveText: todo.ActiveForm, Status: todo.Status})
	}
	return steps, true
}

func (p *planTracker) applyCreate(input json.RawMessage, text string, structured json.RawMessage) {
	var id, subject string
	var out struct {
		Task struct {
			ID      string `json:"id"`
			Subject string `json:"subject"`
		} `json:"task"`
	}
	if len(structured) > 0 && json.Unmarshal(structured, &out) == nil && out.Task.ID != "" {
		id, subject = out.Task.ID, out.Task.Subject
	} else if m := taskCreatedPattern.FindStringSubmatch(text); m != nil {
		id = m[1]
		subject, _, _ = strings.Cut(m[2], taskKeptByAppNote)
	}
	if id == "" {
		p.log.Debug("a TaskCreate result named no task; the next TaskList repairs the plan")
		return
	}
	if p.seedIsStale(id) {
		p.log.Debug("a TaskCreate shows the seeded plan is another task list's; dropping it", "taskId", id)
		p.tasks = slices.DeleteFunc(p.tasks, func(t agent.PlanStep) bool { return p.seeded[t.ID] })
		p.seeded = nil
	}
	// Ids are never reused within one list, so this would be the same result
	// read twice.
	if p.find(id) >= 0 {
		return
	}
	p.tasks = append(p.tasks, agent.PlanStep{ID: id, Text: subject, ActiveText: createActiveForm(input), Status: agent.PlanStepPending})
}

// seedIsStale reports whether a newly created task's id shows that the seeded
// tasks belong to another task list. The CLI numbers each list from 1 and
// never reuses an id, even a deleted one's, so a task created in the list the
// seed came from is numbered above every seeded one. A seed can be another
// list's on a launch that resumes the session: one whose newest plan record
// was written before the CLI started a new list for it, such as a fork's
// copied history.
func (p *planTracker) seedIsStale(id string) bool {
	if len(p.seeded) == 0 {
		return false
	}
	if p.seeded[id] {
		return true
	}
	created, err := strconv.Atoi(id)
	if err != nil {
		return false
	}
	for seeded := range p.seeded {
		if n, err := strconv.Atoi(seeded); err == nil && created <= n {
			return true
		}
	}
	return false
}

// createActiveForm reads a TaskCreate's activeForm the way the CLI repairs it
// before running the call (claude 2.1.330): `active_form` stands in for it,
// and the whole input can come wrapped in a `task` object.
func createActiveForm(input json.RawMessage) string {
	var in struct {
		taskInputForms
		Task json.RawMessage `json:"task"`
	}
	if json.Unmarshal(input, &in) != nil {
		return ""
	}
	if form := in.activeForm(); form != "" {
		return form
	}
	var wrapped taskInputForms
	if len(in.Task) > 0 && json.Unmarshal(in.Task, &wrapped) == nil {
		return wrapped.activeForm()
	}
	return ""
}

// taskInputForms is a Task tool input's activeForm under both of the names the
// CLI accepts for it; the canonical one wins, and a blank alias is no value.
type taskInputForms struct {
	ActiveForm      *string `json:"activeForm"`
	ActiveFormAlias string  `json:"active_form"`
}

func (f taskInputForms) activeForm() string {
	if f.ActiveForm != nil {
		return *f.ActiveForm
	}
	if strings.TrimSpace(f.ActiveFormAlias) != "" {
		return f.ActiveFormAlias
	}
	return ""
}

func (p *planTracker) applyUpdate(input json.RawMessage, text string) {
	// The id from the text, which the CLI writes after repairing an input
	// that named it `id` or `task_id`.
	m := taskUpdatedPattern.FindStringSubmatch(text)
	if m == nil {
		return
	}
	var in struct {
		taskInputForms
		Status  *string `json:"status"`
		Subject *string `json:"subject"`
	}
	if err := json.Unmarshal(input, &in); err != nil {
		p.log.Warn("could not read a TaskUpdate's input; the next TaskList repairs the plan", "error", err)
		return
	}
	i := p.find(m[1])
	if i < 0 {
		// Created in a frame the fold could not attribute, or before a seed
		// older than the CLI's own list.
		p.log.Debug("a TaskUpdate named a task the plan does not hold; the next TaskList repairs it", "taskId", m[1])
		return
	}
	if in.Status != nil && *in.Status == "deleted" {
		p.tasks = slices.Delete(p.tasks, i, i+1)
		return
	}
	task := &p.tasks[i]
	if in.Status != nil {
		task.Status = agent.PlanStepStatus(*in.Status)
	}
	if in.Subject != nil {
		task.Text = *in.Subject
	}
	if in.ActiveForm != nil || strings.TrimSpace(in.ActiveFormAlias) != "" {
		task.ActiveText = in.activeForm()
	}
}

// applyList replaces the fold with the CLI's own list, which corrects anything
// the fold missed. Read only from tool_use_result: the text has no form stable
// enough to parse, so with a shared frame the fold is left as it was.
func (p *planTracker) applyList(structured json.RawMessage) {
	if len(structured) == 0 {
		return
	}
	var out struct {
		Tasks *[]struct {
			ID      string               `json:"id"`
			Subject string               `json:"subject"`
			Status  agent.PlanStepStatus `json:"status"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(structured, &out); err != nil || out.Tasks == nil {
		p.log.Warn("could not read a TaskList result; the plan is left as it was", "error", err)
		return
	}
	tasks := make([]agent.PlanStep, 0, len(*out.Tasks))
	for _, t := range *out.Tasks {
		// The list carries no activeForm, so a task the fold already had
		// keeps its own.
		active := ""
		if i := p.find(t.ID); i >= 0 {
			active = p.tasks[i].ActiveText
		}
		tasks = append(tasks, agent.PlanStep{ID: t.ID, Text: t.Subject, ActiveText: active, Status: t.Status})
	}
	p.tasks = tasks
	p.seeded = nil
}

func (p *planTracker) find(id string) int {
	return slices.IndexFunc(p.tasks, func(t agent.PlanStep) bool { return t.ID == id })
}
