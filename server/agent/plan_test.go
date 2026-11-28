package agent

import (
	"encoding/json"
	"reflect"
	"testing"
)

// A plan is history the agent wrote, and the turn that produced it was already
// proven to have reached the model, so it must neither start a session nor end
// a background wait.
func TestPlan_AnswersTheStatePredicates(t *testing.T) {
	plan := EventTypePlan
	if _, ok := (PlanEvent{}).Encode().(Record); !ok {
		t.Error("a plan is not recorded, so a replayed transcript has no plan to read")
	}
	if plan.AwaitsUserInput() {
		t.Error("nobody answers a plan")
	}
	if !plan.IndicatesAgentActivity() {
		t.Error("a plan only arrives while a turn is under way")
	}
	if plan.ActivatesSession() {
		t.Error("a plan must not read as the CLI producing content: it would end a background wait")
	}
}

func TestPlanEvent_Record(t *testing.T) {
	tests := []struct {
		name  string
		event PlanEvent
		want  string
	}{
		{
			name: "claude",
			event: PlanEvent{
				Steps:     []PlanStep{{ID: "3", Text: "Write the tests", ActiveText: "Writing the tests", Status: PlanStepInProgress}},
				ToolUseID: "toolu_1",
			},
			want: `{"type":"plan","tool_use_id":"toolu_1","steps":[{"id":"3","text":"Write the tests","active_text":"Writing the tests","status":"in_progress"}]}`,
		},
		{
			name: "codex child thread",
			event: PlanEvent{
				Steps:           []PlanStep{{Text: "Read", Status: PlanStepPending}},
				Explanation:     "Reading first",
				PlanID:          "turn-1:plan:2",
				ParentToolUseID: "call_spawn",
			},
			want: `{"type":"plan","parent_tool_use_id":"call_spawn","steps":[{"text":"Read","status":"pending"}],"explanation":"Reading first","plan_id":"turn-1:plan:2"}`,
		},
		{
			// A plan with nothing left in it is still a plan update.
			name:  "empty",
			event: PlanEvent{ToolUseID: "toolu_2"},
			want:  `{"type":"plan","tool_use_id":"toolu_2"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := json.Marshal(tt.event.ToRecord())
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want {
				t.Errorf("record = %s\nwant     %s", got, tt.want)
			}
		})
	}
}

func TestLatestPlanSeed(t *testing.T) {
	fold := `{"type":"plan","tool_use_id":"toolu_2","steps":[{"id":"1","text":"A","status":"completed"},{"id":"2","text":"B","status":"pending"}],"seq":4}`
	tests := []struct {
		name    string
		records []string
		want    []PlanStep
	}{
		{
			name: "the newest main-thread fold snapshot",
			records: []string{
				`{"type":"plan","tool_use_id":"toolu_1","steps":[{"id":"1","text":"A","status":"pending"}]}`,
				fold,
				`{"type":"plan","plan_id":"t:plan:1","parent_tool_use_id":"call_spawn","steps":[{"text":"child","status":"pending"}]}`,
				`{"type":"text","content":"the plan is done"}`,
			},
			want: []PlanStep{{ID: "1", Text: "A", Status: PlanStepCompleted}, {ID: "2", Text: "B", Status: PlanStepPending}},
		},
		{
			// TodoWrite has no ids: there is no fold to seed.
			name:    "a TodoWrite list",
			records: []string{fold, `{"type":"plan","tool_use_id":"toolu_3","steps":[{"text":"A","status":"pending"}]}`},
			want:    nil,
		},
		{
			name:    "no plan",
			records: []string{`{"type":"text","content":"plan"}`, `{"type":"tool_call","tool_name":"Read"}`},
			want:    nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			records := make([]json.RawMessage, len(tt.records))
			for i, r := range tt.records {
				records[i] = json.RawMessage(r)
			}
			if got := LatestPlanSeed(records); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("seed = %+v, want %+v", got, tt.want)
			}
		})
	}
}
