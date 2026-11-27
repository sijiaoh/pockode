package codex

import (
	"reflect"
	"testing"

	"github.com/pockode/server/agent"
)

func onlyPlans(t *testing.T, events []agent.AgentEvent) []agent.PlanEvent {
	t.Helper()
	var plans []agent.PlanEvent
	for _, ev := range events {
		plan, ok := ev.(agent.PlanEvent)
		if !ok {
			t.Fatalf("event = %#v, want only plans", ev)
		}
		plans = append(plans, plan)
	}
	return plans
}

// Each turn/plan/updated is the whole plan as it stands (the shape codex-cli's
// TurnPlanUpdatedNotification schema gives), numbered within its turn.
func TestPlanUpdated_MainThread(t *testing.T) {
	sess := newSubagentTestSession()
	defer sess.cancel()

	sess.notify("turn/plan/updated", `{"threadId":"main","turnId":"turn-main","explanation":"Reading first","plan":[
		{"step":"Read the code","status":"completed"},{"step":"Write tests","status":"inProgress"},{"step":"Ship","status":"pending"}]}`)
	sess.notify("turn/plan/updated", `{"threadId":"main","turnId":"turn-main","explanation":null,"plan":[]}`)

	plans := onlyPlans(t, drainEvents(sess.events))
	want := []agent.PlanEvent{
		{
			Steps: []agent.PlanStep{
				{Text: "Read the code", Status: agent.PlanStepCompleted},
				{Text: "Write tests", Status: agent.PlanStepInProgress},
				{Text: "Ship", Status: agent.PlanStepPending},
			},
			Explanation:       "Reading first",
			PlanID:            "turn-main:plan:1",
			ProviderMessageID: "turn-main",
		},
		{PlanID: "turn-main:plan:2", ProviderMessageID: "turn-main"},
	}
	if !reflect.DeepEqual(plans, want) {
		t.Errorf("plans = %+v\nwant    %+v", plans, want)
	}
}

// A child thread's plan is its subagent's, filed under the spawn, and numbered
// in the child's own turn.
func TestPlanUpdated_SubagentThread(t *testing.T) {
	sess := newSubagentTestSession()
	defer sess.cancel()

	sess.notify("turn/plan/updated", `{"threadId":"child","turnId":"turn-child","plan":[{"step":"Look","status":"pending"}]}`)
	// A thread whose spawn this process never saw has no owner to name, and
	// must not read as the session's own plan.
	sess.notify("turn/plan/updated", `{"threadId":"stranger","turnId":"turn-x","plan":[{"step":"?","status":"pending"}]}`)

	plans := onlyPlans(t, drainEvents(sess.events))
	want := []agent.PlanEvent{{
		Steps:           []agent.PlanStep{{Text: "Look", Status: agent.PlanStepPending}},
		PlanID:          "turn-child:plan:1",
		ParentToolUseID: "call_spawn",
	}}
	if !reflect.DeepEqual(plans, want) {
		t.Errorf("plans = %+v\nwant    %+v", plans, want)
	}
}

// The count restarts with each turn, so a plan id names one record.
func TestPlanUpdated_NumberedPerTurn(t *testing.T) {
	sess := newSubagentTestSession()
	defer sess.cancel()

	plan := `{"step":"A","status":"pending"}`
	sess.notify("turn/plan/updated", `{"threadId":"main","turnId":"turn-main","plan":[`+plan+`]}`)
	sess.notify("turn/completed", `{"threadId":"main","turn":{"id":"turn-main","items":[],"status":"completed"}}`)
	sess.notify("turn/started", `{"threadId":"main","turn":{"id":"turn-2","items":[],"status":"inProgress"}}`)
	sess.notify("turn/plan/updated", `{"threadId":"main","turnId":"turn-2","plan":[`+plan+`]}`)

	var ids []string
	for _, ev := range drainEvents(sess.events) {
		if plan, ok := ev.(agent.PlanEvent); ok {
			ids = append(ids, plan.PlanID)
		}
	}
	if want := []string{"turn-main:plan:1", "turn-2:plan:1"}; !reflect.DeepEqual(ids, want) {
		t.Errorf("plan ids = %v, want %v", ids, want)
	}
	if len(sess.planUpdates) != 1 {
		t.Errorf("planUpdates = %v, want only the running turn's count", sess.planUpdates)
	}
}
