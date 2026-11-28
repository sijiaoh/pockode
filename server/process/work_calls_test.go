package process

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

type fakeWorks map[string]work.Work

func (f fakeWorks) Get(id string) (work.Work, bool, error) {
	w, ok := f[id]
	return w, ok, nil
}

func call(id, tool, input string) agent.ToolCallEvent {
	return agent.ToolCallEvent{ToolUseID: id, ToolName: tool, ToolInput: json.RawMessage(input)}
}

func refOn(t *testing.T, event agent.AgentEvent) *agent.WorkRef {
	t.Helper()
	result, ok := event.(agent.ToolResultEvent)
	if !ok {
		t.Fatalf("stamp returned %T, want a ToolResultEvent", event)
	}
	return result.WorkRef
}

// The stamp says what the work was when the call was made: a rename or a
// delete before the result arrives leaves it naming the work as it was then.
func TestWorkCalls_NameTheWorkAsItWasWhenCalled(t *testing.T) {
	works := fakeWorks{
		"t1": {ID: "t1", StoryID: "s1", Title: "Design the row"},
		"t2": {ID: "t2", StoryID: "s1", Title: "Doomed"},
	}
	var c workCalls
	c.stamp(call("start", "mcp__pockode__task_start", `{"id":"t1"}`), works)
	c.stamp(call("delete", "pockode:work_delete", `{"id":"t2"}`), works)
	works["t1"] = work.Work{ID: "t1", StoryID: "s1", Title: "Renamed"}
	delete(works, "t2")

	if got := refOn(t, c.stamp(agent.ToolResultEvent{ToolUseID: "start", ToolResult: "Started"}, works)); *got != (agent.WorkRef{ID: "t1", Type: "task", Title: "Design the row"}) {
		t.Errorf("start: work_ref = %+v", got)
	}
	if got := refOn(t, c.stamp(agent.ToolResultEvent{ToolUseID: "delete", ToolResult: "Deleted work t2"}, works)); got == nil || got.Title != "Doomed" {
		t.Errorf("delete: work_ref = %+v, want the deleted work's title", got)
	}
}

func TestWorkCalls_ACreationIsNamedByItsResult(t *testing.T) {
	created := work.Work{ID: "s9", Title: "New story"}
	works := fakeWorks{}
	var c workCalls
	c.stamp(call("create", "mcp__pockode__story_create", `{"title":"New story"}`), works)
	works["s9"] = created

	got := refOn(t, c.stamp(agent.ToolResultEvent{ToolUseID: "create", ToolResult: work.CreateResult(created)}, works))
	if got == nil || *got != (agent.WorkRef{ID: "s9", Type: "story", Title: "New story"}) {
		t.Errorf("work_ref = %+v", got)
	}
}

func TestWorkCalls_LeaveEverythingElseUnstamped(t *testing.T) {
	works := fakeWorks{"t1": {ID: "t1", StoryID: "s1", Title: "T"}}
	var c workCalls
	cases := []struct {
		call   agent.ToolCallEvent
		result agent.ToolResultEvent
	}{
		{call("failed", "mcp__pockode__task_start", `{"id":"t1"}`), agent.ToolResultEvent{ToolUseID: "failed", ToolResult: "boom", IsError: true}},
		{call("missing", "mcp__pockode__task_start", `{"id":"nope"}`), agent.ToolResultEvent{ToolUseID: "missing", ToolResult: "ok"}},
		{call("comment", "mcp__pockode__work_comment_update", `{"id":"t1"}`), agent.ToolResultEvent{ToolUseID: "comment", ToolResult: "ok"}},
		{call("other", "mcp__other__task_start", `{"id":"t1"}`), agent.ToolResultEvent{ToolUseID: "other", ToolResult: "ok"}},
		{call("bash", "Bash", `{"id":"t1"}`), agent.ToolResultEvent{ToolUseID: "bash", ToolResult: work.CreateResult(works["t1"])}},
		// A creation whose result names a work the store does not hold.
		{call("ghost", "mcp__pockode__task_create", `{}`), agent.ToolResultEvent{ToolUseID: "ghost", ToolResult: `Created task "X" (ID: gone)`}},
	}
	for _, tc := range cases {
		c.stamp(tc.call, works)
		if got := refOn(t, c.stamp(tc.result, works)); got != nil {
			t.Errorf("%s: work_ref = %+v, want none", tc.call.ToolUseID, got)
		}
	}
	if len(c.pending) != 0 {
		t.Errorf("pending = %v, want every settled call forgotten", c.pending)
	}
}

// The stamp is on the record as it is written, as html_page is.
func TestProcess_WorkToolResultIsRecordedWithItsWork(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	m.SetWorkLookup(fakeWorks{"t1": {ID: "t1", StoryID: "s1", Title: "Design the row"}})
	defer m.Shutdown()

	m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")
	sess.emit(t, call("start", "mcp__pockode__task_start", `{"id":"t1"}`))
	sess.emit(t, agent.ToolResultEvent{ToolUseID: "start", ToolResult: "Started"})
	waitForHistory(t, store, "sess-1", 2)

	records, err := store.GetHistory(context.Background(), "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := agent.DecodeRecord(records[1])
	if err != nil {
		t.Fatal(err)
	}
	rec, ok := decoded.(agent.ToolResultRecord)
	if !ok {
		t.Fatalf("records[1] = %T, want a tool result", decoded)
	}
	if rec.WorkRef == nil || *rec.WorkRef != (agent.WorkRef{ID: "t1", Type: "task", Title: "Design the row"}) {
		t.Errorf("work_ref = %+v", rec.WorkRef)
	}
}
