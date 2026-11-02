package process

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/htmlpage"
	"github.com/pockode/server/session"
)

// The record is how a client knows which stored page a card is, so the id has
// to be on the tool_result as it is written — and only on a page tool's own
// successful result, under either engine's name for it.
func TestProcess_PageToolResultIsRecordedWithItsPage(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	lead := htmlpage.ResultLead
	calls := []struct {
		id, tool, result string
		isError          bool
		want             string
	}{
		{id: "claude", tool: "mcp__pockode__html_render", result: lead("p1") + ` "A" is shown`, want: "p1"},
		{id: "codex", tool: "pockode:html_render", result: lead("p2") + ` "B" is shown`, want: "p2"},
		// Some other tool's output that happens to read like a page result.
		{id: "bash", tool: "Bash", result: lead("p3") + " is what I printed"},
		{id: "failed", tool: "mcp__pockode__html_render", result: lead("p4"), isError: true},
	}
	for _, c := range calls {
		sess.emit(t, agent.ToolCallEvent{ToolUseID: c.id, ToolName: c.tool, ToolInput: json.RawMessage(`{}`)})
		sess.emit(t, agent.ToolResultEvent{ToolUseID: c.id, ToolResult: c.result, IsError: c.isError})
	}
	waitForHistory(t, store, "sess-1", 2*len(calls))

	records, err := store.GetHistory(context.Background(), "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, raw := range records {
		var rec agent.EventRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			t.Fatal(err)
		}
		if rec.Type == agent.EventTypeToolResult {
			got[rec.ToolUseID] = rec.HTMLPage
		}
	}
	for _, c := range calls {
		if got[c.id] != c.want {
			t.Errorf("%s: html_page = %q, want %q", c.id, got[c.id], c.want)
		}
	}
}
