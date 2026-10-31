package process

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/canvas"
	"github.com/pockode/server/session"
)

// A canvas call's result is recorded — and broadcast — with the revision it
// drew, which is the only link from a snapshot to its call
// (docs/canvas-ui.md §13.4). Other results, a failed canvas call, and a result
// that only looks like a canvas one get nothing.
func TestProcess_CanvasResultCarriesItsRevision(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	rec := &messageRecorder{}
	m.SetMessageListener(rec)

	m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	drawn := canvas.ResultText(canvas.Snapshot{Revision: 8}, nil)
	events := []agent.AgentEvent{
		agent.ToolCallEvent{ToolUseID: "claude", ToolName: "mcp__pockode__canvas_render"},
		agent.ToolCallEvent{ToolUseID: "codex", ToolName: "pockode:canvas_update"},
		agent.ToolCallEvent{ToolUseID: "failed", ToolName: "mcp__pockode__canvas_update"},
		agent.ToolCallEvent{ToolUseID: "other", ToolName: "Bash"},
		agent.ToolResultEvent{ToolUseID: "claude", ToolResult: drawn},
		agent.ToolResultEvent{ToolUseID: "codex", ToolResult: canvas.ResultText(canvas.Snapshot{Revision: 9}, []string{"w"})},
		agent.ToolResultEvent{ToolUseID: "failed", ToolResult: drawn, IsError: true},
		agent.ToolResultEvent{ToolUseID: "other", ToolResult: drawn},
	}
	for _, e := range events {
		sess.emit(t, e)
	}
	// One more record, so every result before it has been broadcast too.
	sess.emit(t, agent.TextEvent{Content: "done"})
	waitForHistory(t, store, "sess-1", len(events)+1)

	want := map[string]int{"claude": 8, "codex": 9, "failed": 0, "other": 0}

	raw, err := store.GetHistory(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	for _, line := range raw {
		var r agent.EventRecord
		if err := json.Unmarshal(line, &r); err != nil {
			t.Fatal(err)
		}
		if r.Type != agent.EventTypeToolResult {
			continue
		}
		if r.CanvasRevision != want[r.ToolUseID] {
			t.Errorf("recorded %s: canvas_revision = %d, want %d", r.ToolUseID, r.CanvasRevision, want[r.ToolUseID])
		}
	}

	broadcast := 0
	for _, msg := range rec.snapshot() {
		r, ok := msg.Event.(agent.ToolResultEvent)
		if !ok {
			continue
		}
		broadcast++
		if r.CanvasRevision != want[r.ToolUseID] {
			t.Errorf("broadcast %s: canvas_revision = %d, want %d", r.ToolUseID, r.CanvasRevision, want[r.ToolUseID])
		}
	}
	if broadcast != len(want) {
		t.Errorf("%d results broadcast, want %d", broadcast, len(want))
	}
}

// A canvas call a turn ending cut off never gets its result; a later result
// under the same id — ids an agent may hand out again in another turn — is not
// a canvas one.
func TestCanvasCalls_ForgetCallsAtTurnEnd(t *testing.T) {
	var c canvasCalls
	drawn := canvas.ResultText(canvas.Snapshot{Revision: 4}, nil)

	for _, ending := range []agent.AgentEvent{agent.DoneEvent{}, agent.InterruptedEvent{}, agent.ErrorEvent{}} {
		c.stamp(agent.ToolCallEvent{ToolUseID: "id", ToolName: "mcp__pockode__canvas_render"})
		c.stamp(ending)
		got := c.stamp(agent.ToolResultEvent{ToolUseID: "id", ToolResult: drawn})
		if r := got.(agent.ToolResultEvent); r.CanvasRevision != 0 {
			t.Errorf("after %T: canvas_revision = %d, want none", ending, r.CanvasRevision)
		}
	}
}
