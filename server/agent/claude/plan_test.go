package claude

import (
	"context"
	"log/slog"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
)

// Frames in the shape claude 2.1.330 writes them, cut down to what the
// adapter reads.

func planCall(id, name, input string) string {
	return `{"type":"assistant","uuid":"a-` + id + `","message":{"model":"claude","content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}}`
}

func subagentPlanCall(id, name, input string) string {
	return `{"type":"assistant","parent_tool_use_id":"toolu_agent","message":{"model":"claude","content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}}`
}

// planResult is a frame holding one result, with the tool's structured result
// beside it when there is one.
func planResult(id, text, toolUseResult string) string {
	extra := ""
	if toolUseResult != "" {
		extra = `,"tool_use_result":` + toolUseResult
	}
	return `{"type":"user","uuid":"u-` + id + `","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id + `","content":"` + text + `"}]}` + extra + `}`
}

func subagentPlanResult(id, text string) string {
	return `{"type":"user","parent_tool_use_id":"toolu_agent","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id + `","content":"` + text + `"}]}}`
}

func deniedResult(id string) string {
	return `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id + `","content":"denied","is_error":true}]}}`
}

// sharedResults is one frame holding several results: tool_use_result is then
// nobody's in particular.
func sharedResults(toolUseResult string, results ...[2]string) string {
	var blocks []string
	for _, r := range results {
		blocks = append(blocks, `{"type":"tool_result","tool_use_id":"`+r[0]+`","content":"`+r[1]+`"}`)
	}
	return `{"type":"user","message":{"role":"user","content":[` + strings.Join(blocks, ",") + `]},"tool_use_result":` + toolUseResult + `}`
}

func plansIn(events []agent.AgentEvent) []agent.PlanEvent {
	var plans []agent.PlanEvent
	for _, ev := range events {
		if plan, ok := ev.(agent.PlanEvent); ok {
			plans = append(plans, plan)
		}
	}
	return plans
}

func runPlans(t *testing.T, seed []agent.PlanStep, lines ...string) []agent.PlanEvent {
	t.Helper()
	events, _ := runStreamOutputWithPlans(t, strings.Join(lines, "\n")+"\n", newPlanTracker(slog.Default(), seed))
	return plansIn(events)
}

func lastSteps(t *testing.T, plans []agent.PlanEvent) []agent.PlanStep {
	t.Helper()
	if len(plans) == 0 {
		t.Fatal("no plan recorded")
	}
	return plans[len(plans)-1].Steps
}

func TestPlan_TodoWrite(t *testing.T) {
	input := `{"todos":[{"content":"Read the code","activeForm":"Reading the code","status":"completed"},{"content":"Write tests","activeForm":"Writing tests","status":"in_progress"}]}`
	events, _ := runStreamOutputWithPlans(t, strings.Join([]string{
		planCall("toolu_1", "TodoWrite", input),
		planResult("toolu_1", "Todos have been modified successfully.", ""),
	}, "\n")+"\n", newPlanTracker(slog.Default(), nil))

	// The record follows the result it came from.
	if len(events) != 3 {
		t.Fatalf("events = %#v, want call, result, plan", events)
	}
	if _, ok := events[1].(agent.ToolResultEvent); !ok {
		t.Fatalf("events[1] = %#v, want the result", events[1])
	}
	plan, ok := events[2].(agent.PlanEvent)
	if !ok {
		t.Fatalf("events[2] = %#v, want the plan", events[2])
	}
	want := agent.PlanEvent{
		Steps: []agent.PlanStep{
			{Text: "Read the code", ActiveText: "Reading the code", Status: agent.PlanStepCompleted},
			{Text: "Write tests", ActiveText: "Writing tests", Status: agent.PlanStepInProgress},
		},
		ToolUseID:         "toolu_1",
		ProviderMessageID: "u-toolu_1",
	}
	if !reflect.DeepEqual(plan, want) {
		t.Errorf("plan = %+v\nwant   %+v", plan, want)
	}
}

func TestPlan_NothingRecordedFor(t *testing.T) {
	todo := `{"todos":[{"content":"A","activeForm":"Doing A","status":"pending"}]}`
	tests := []struct {
		name  string
		lines []string
	}{
		{"a denied call", []string{planCall("toolu_1", "TodoWrite", todo), deniedResult("toolu_1")}},
		// A TodoWrite list is the calling agent's own.
		{"a subagent's TodoWrite", []string{
			planCall("toolu_agent", "Agent", `{"description":"d","prompt":"p"}`),
			subagentPlanCall("toolu_1", "TodoWrite", todo),
			subagentPlanResult("toolu_1", "Todos have been modified successfully."),
		}},
		{"a call that is not a plan tool", []string{planCall("toolu_1", "Read", `{"file_path":"/x"}`), planResult("toolu_1", "Task #1 created successfully: A", "")}},
		{"a TaskGet", []string{planCall("toolu_1", "TaskGet", `{"taskId":"1"}`), planResult("toolu_1", "Task #1: A", "")}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if plans := runPlans(t, nil, tt.lines...); len(plans) != 0 {
				t.Errorf("plans = %+v, want none", plans)
			}
		})
	}
}

func TestPlan_TaskToolsAreFolded(t *testing.T) {
	plans := runPlans(t, nil,
		planCall("toolu_1", "TaskCreate", `{"subject":"Read the code","description":"d","activeForm":"Reading the code"}`),
		planResult("toolu_1", "Task #1 created successfully: Read the code", `{"task":{"id":"1","subject":"Read the code"}}`),
		planCall("toolu_2", "TaskCreate", `{"subject":"Write tests","description":"d"}`),
		planResult("toolu_2", "Task #2 created successfully: Write tests", `{"task":{"id":"2","subject":"Write tests"}}`),
		planCall("toolu_3", "TaskUpdate", `{"taskId":"1","status":"in_progress"}`),
		planResult("toolu_3", "Updated task #1 status", `{"success":true,"taskId":"1","updatedFields":["status"]}`),
	)
	if len(plans) != 3 {
		t.Fatalf("plans = %+v, want one per change", plans)
	}
	// Each record is a snapshot of the whole fold, naming the call it follows.
	if plans[1].ToolUseID != "toolu_2" || len(plans[1].Steps) != 2 {
		t.Errorf("second plan = %+v, want both tasks after toolu_2", plans[1])
	}
	want := []agent.PlanStep{
		{ID: "1", Text: "Read the code", ActiveText: "Reading the code", Status: agent.PlanStepInProgress},
		{ID: "2", Text: "Write tests", Status: agent.PlanStepPending},
	}
	if got := lastSteps(t, plans); !reflect.DeepEqual(got, want) {
		t.Errorf("steps = %+v\nwant    %+v", got, want)
	}
}

// Parallel TaskCreates often come back in one frame, where tool_use_result
// belongs to no result in particular; each id is read from its own text.
func TestPlan_TaskCreatesInOneFrame(t *testing.T) {
	plans := runPlans(t, nil,
		`{"type":"assistant","message":{"model":"claude","content":[`+
			`{"type":"tool_use","id":"toolu_1","name":"TaskCreate","input":{"subject":"A","description":"a"}},`+
			`{"type":"tool_use","id":"toolu_2","name":"TaskCreate","input":{"subject":"B","description":"b"}}]}}`,
		sharedResults(`{"task":{"id":"9","subject":"wrong"}}`,
			[2]string{"toolu_1", "Task #4 created successfully: A"},
			[2]string{"toolu_2", "Task #5 created successfully: B"}),
	)
	want := []agent.PlanStep{
		{ID: "4", Text: "A", Status: agent.PlanStepPending},
		{ID: "5", Text: "B", Status: agent.PlanStepPending},
	}
	if got := lastSteps(t, plans); !reflect.DeepEqual(got, want) {
		t.Errorf("steps = %+v\nwant    %+v", got, want)
	}
}

func TestPlan_TaskUpdate(t *testing.T) {
	seed := []agent.PlanStep{
		{ID: "1", Text: "A", ActiveText: "Doing A", Status: agent.PlanStepInProgress},
		{ID: "2", Text: "B", Status: agent.PlanStepPending},
	}
	tests := []struct {
		name   string
		input  string
		result string
		want   []agent.PlanStep // nil: no record
	}{
		{
			name:   "fields it names",
			input:  `{"taskId":"2","subject":"B2","activeForm":"Doing B2","status":"in_progress"}`,
			result: "Updated task #2 subject, activeForm, status",
			want:   []agent.PlanStep{seed[0], {ID: "2", Text: "B2", ActiveText: "Doing B2", Status: agent.PlanStepInProgress}},
		},
		{
			name:   "deleted",
			input:  `{"taskId":"1","status":"deleted"}`,
			result: "Updated task #1 deleted",
			want:   []agent.PlanStep{seed[1]},
		},
		// The CLI refuses these in the result text, not with is_error.
		{name: "an unknown task", input: `{"taskId":"7","status":"completed"}`, result: "Task not found"},
		{name: "a completion a hook blocked", input: `{"taskId":"1","status":"completed"}`, result: "Run the tests before completing this task"},
		{name: "a failed delete", input: `{"taskId":"1","status":"deleted"}`, result: "Failed to delete task"},
		// The CLI repairs these aliases before running the call, and the
		// result's text names the task it updated.
		{
			name:   "aliased fields",
			input:  `{"id":"2","active_form":"Doing B","status":"completed"}`,
			result: "Updated task #2 activeForm, status",
			want:   []agent.PlanStep{seed[0], {ID: "2", Text: "B", ActiveText: "Doing B", Status: agent.PlanStepCompleted}},
		},
		{name: "the fold does not hold it", input: `{"taskId":"7","status":"completed"}`, result: "Updated task #7 status"},
		// Owner and description are not part of a plan.
		{name: "no change to the plan", input: `{"taskId":"1","owner":"me"}`, result: "Updated task #1 owner"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plans := runPlans(t, seed,
				planCall("toolu_1", "TaskUpdate", tt.input),
				planResult("toolu_1", tt.result, ""),
			)
			if tt.want == nil {
				if len(plans) != 0 {
					t.Errorf("plans = %+v, want none", plans)
				}
				return
			}
			if got := lastSteps(t, plans); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("steps = %+v\nwant    %+v", got, tt.want)
			}
		})
	}
}

// A TaskList is the CLI's own list and replaces the fold; it carries no
// activeForm, so a task the fold already had keeps its own.
func TestPlan_TaskListReplacesTheFold(t *testing.T) {
	seed := []agent.PlanStep{
		{ID: "1", Text: "A", ActiveText: "Doing A", Status: agent.PlanStepPending},
		{ID: "2", Text: "stale", Status: agent.PlanStepPending},
	}
	list := `{"tasks":[{"id":"1","subject":"A","status":"in_progress","blockedBy":[]},{"id":"3","subject":"C","status":"pending","owner":"x","blockedBy":["1"]}]}`
	plans := runPlans(t, seed,
		planCall("toolu_1", "TaskList", `{}`),
		planResult("toolu_1", "#1 [in_progress] A", list),
	)
	want := []agent.PlanStep{
		{ID: "1", Text: "A", ActiveText: "Doing A", Status: agent.PlanStepInProgress},
		{ID: "3", Text: "C", Status: agent.PlanStepPending},
	}
	if got := lastSteps(t, plans); !reflect.DeepEqual(got, want) {
		t.Errorf("steps = %+v\nwant    %+v", got, want)
	}

	// The same list again changes nothing, and in a shared frame it cannot be
	// read at all.
	again := runPlans(t, want, planCall("toolu_1", "TaskList", `{}`), planResult("toolu_1", "#1", list))
	if len(again) != 0 {
		t.Errorf("an unchanged list recorded %+v", again)
	}
	shared := runPlans(t, seed,
		planCall("toolu_1", "TaskList", `{}`),
		planCall("toolu_2", "Read", `{"file_path":"/x"}`),
		sharedResults(list, [2]string{"toolu_1", "#1"}, [2]string{"toolu_2", "x"}),
	)
	if len(shared) != 0 {
		t.Errorf("a list in a shared frame recorded %+v", shared)
	}
}

// A new process's first update carries the tasks its predecessor reported.
func TestPlan_SeedCarriesEarlierTasks(t *testing.T) {
	seed := []agent.PlanStep{{ID: "1", Text: "A", Status: agent.PlanStepPending}}
	plans := runPlans(t, seed,
		planCall("toolu_1", "TaskUpdate", `{"taskId":"1","status":"completed"}`),
		planResult("toolu_1", "Updated task #1 status", ""),
	)
	want := []agent.PlanStep{{ID: "1", Text: "A", Status: agent.PlanStepCompleted}}
	if got := lastSteps(t, plans); !reflect.DeepEqual(got, want) {
		t.Errorf("steps = %+v, want %+v", got, want)
	}
	if seed[0].Status != agent.PlanStepPending {
		t.Error("the fold wrote through to the seed it was handed")
	}
}

// In a shared frame the subject is read from the result's text, which is the
// CLI's own after it repaired the input (here `title` for `subject`).
func TestPlan_TaskCreateAliasesInOneFrame(t *testing.T) {
	plans := runPlans(t, nil,
		`{"type":"assistant","message":{"model":"claude","content":[`+
			`{"type":"tool_use","id":"toolu_1","name":"TaskCreate","input":{"title":"A","description":"a","active_form":"Doing A"}},`+
			`{"type":"tool_use","id":"toolu_2","name":"TaskCreate","input":{"task":{"subject":"B","description":"b","activeForm":"Doing B"}}}]}}`,
		sharedResults(`{"task":{"id":"9","subject":"wrong"}}`,
			[2]string{"toolu_1", "Task #1 created successfully: A"},
			[2]string{"toolu_2", "Task #2 created successfully: B The app marks these items in progress and checks them off by itself."}),
	)
	want := []agent.PlanStep{
		{ID: "1", Text: "A", ActiveText: "Doing A", Status: agent.PlanStepPending},
		{ID: "2", Text: "B", ActiveText: "Doing B", Status: agent.PlanStepPending},
	}
	if got := lastSteps(t, plans); !reflect.DeepEqual(got, want) {
		t.Errorf("steps = %+v\nwant    %+v", got, want)
	}
}

// The CLI numbers each task list from 1 and never reuses an id, so a create
// numbered at or below a seeded task shows the seed is another list's: the
// seeded tasks go, and only they.
func TestPlan_TaskCreateTellsWhetherTheSeedIsThisList(t *testing.T) {
	old := []agent.PlanStep{
		{ID: "3", Text: "old C", Status: agent.PlanStepCompleted},
		{ID: "4", Text: "old D", Status: agent.PlanStepPending},
	}
	create := func(id, subject string) []string {
		return []string{
			planCall("toolu_"+id, "TaskCreate", `{"subject":"`+subject+`","description":"d"}`),
			planResult("toolu_"+id, "Task #"+id+" created successfully: "+subject, `{"task":{"id":"`+id+`","subject":"`+subject+`"}}`),
		}
	}
	tests := []struct {
		name  string
		lines []string
		want  []agent.PlanStep
	}{
		{
			name:  "a new list",
			lines: slices.Concat(create("1", "New"), create("2", "Next"), create("3", "Third")),
			want: []agent.PlanStep{
				{ID: "1", Text: "New", Status: agent.PlanStepPending},
				{ID: "2", Text: "Next", Status: agent.PlanStepPending},
				{ID: "3", Text: "Third", Status: agent.PlanStepPending},
			},
		},
		{
			name:  "a held id",
			lines: create("4", "New"),
			want:  []agent.PlanStep{{ID: "4", Text: "New", Status: agent.PlanStepPending}},
		},
		{
			name:  "the same list",
			lines: create("5", "More"),
			want:  append(slices.Clone(old), agent.PlanStep{ID: "5", Text: "More", Status: agent.PlanStepPending}),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := lastSteps(t, runPlans(t, old, tt.lines...)); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("steps = %+v\nwant    %+v", got, tt.want)
			}
		})
	}
}

// A subagent writes the session's task list, not one of its own, so its Task
// calls are folded into the main plan, and the record names the top-level
// call they ran inside — through a nested spawn too.
func TestPlan_SubagentTaskCallsFoldIntoTheMainPlan(t *testing.T) {
	nested := func(line string) string {
		return strings.Replace(line, `"parent_tool_use_id":"toolu_agent"`, `"parent_tool_use_id":"toolu_inner"`, 1)
	}
	plans := runPlans(t, []agent.PlanStep{{ID: "1", Text: "A", Status: agent.PlanStepPending}},
		planCall("toolu_agent", "Agent", `{"description":"d","prompt":"p"}`),
		subagentPlanCall("toolu_1", "TaskUpdate", `{"taskId":"1","status":"completed"}`),
		subagentPlanResult("toolu_1", "Updated task #1 status"),
		subagentPlanCall("toolu_inner", "Agent", `{"description":"d","prompt":"p"}`),
		nested(subagentPlanCall("toolu_2", "TaskCreate", `{"subject":"B","description":"b"}`)),
		nested(subagentPlanResult("toolu_2", "Task #2 created successfully: B")),
	)
	if len(plans) != 2 {
		t.Fatalf("plans = %+v, want one per change", plans)
	}
	for _, plan := range plans {
		if plan.ToolUseID != "toolu_agent" || plan.ParentToolUseID != "" || plan.ProviderMessageID != "" {
			t.Errorf("plan = %+v, want it named by the top-level call and filed nowhere else", plan)
		}
	}
	want := []agent.PlanStep{
		{ID: "1", Text: "A", Status: agent.PlanStepCompleted},
		{ID: "2", Text: "B", Status: agent.PlanStepPending},
	}
	if got := lastSteps(t, plans); !reflect.DeepEqual(got, want) {
		t.Errorf("steps = %+v\nwant    %+v", got, want)
	}
}

// Only a launch that resumes the CLI's own session finds its task list again.
func TestPlanSeed_OnlyForAResume(t *testing.T) {
	opts := agent.StartOptions{PlanSeed: func(context.Context) []agent.PlanStep {
		return []agent.PlanStep{{ID: "1", Text: "A", Status: agent.PlanStepPending}}
	}}
	tests := []struct {
		name   string
		launch claudeLaunch
		want   bool
	}{
		{"resume", claudeLaunch{sessionID: "s", resume: true}, true},
		{"fork", claudeLaunch{sessionID: "s", resume: true, fork: true}, false},
		{"fresh", claudeLaunch{sessionID: "s"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := planSeed(context.Background(), opts, tt.launch) != nil; got != tt.want {
				t.Errorf("seeded = %v, want %v", got, tt.want)
			}
		})
	}
}

// A plan call whose result was lost to an oversized line is answered as
// failed, and the tracker lets go of its input.
func TestPlan_LostResultReleasesTheCall(t *testing.T) {
	plans := newPlanTracker(slog.Default(), nil)
	runStreamOutputWithPlans(t, planCall("toolu_1", "TodoWrite", `{"todos":[]}`)+"\n"+oversizedToolResult("toolu_1")+"\n", plans)
	if len(plans.calls) != 0 {
		t.Errorf("held calls = %v, want none", plans.calls)
	}
}
