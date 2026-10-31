package chat

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/canvas"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

type canvasForkFixture struct {
	store  session.Store
	canvas *canvas.Store
	client *Client
	seqs   []session.HistorySeq
}

// newCanvasForkFixture is a canvas session "source" holding history, whose
// canvas has drawn revisions pages, in order.
func newCanvasForkFixture(t *testing.T, history []json.RawMessage, pages ...string) canvasForkFixture {
	t.Helper()

	dataDir := t.TempDir()
	store, err := session.NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	registry := agent.NewRegistry()
	registry.Register(session.AgentTypeClaude, &forkingAgent{carried: true})
	pm := process.NewManager(registry, "", t.TempDir(), t.TempDir(), "", store, session.LeaseBudgets{Idle: time.Minute})
	t.Cleanup(pm.Shutdown)

	ctx := context.Background()
	if _, err := store.Create(ctx, "source", session.CreateSpec{AgentType: session.AgentTypeClaude, Canvas: true}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	var seqs []session.HistorySeq
	for _, rec := range history {
		seq, err := store.AppendToHistory(ctx, "source", rec)
		if err != nil {
			t.Fatalf("AppendToHistory: %v", err)
		}
		seqs = append(seqs, seq)
	}

	canvasStore := canvas.NewStore(dataDir)
	for _, html := range pages {
		if _, err := canvasStore.Apply("source", func(canvas.Base) (canvas.Draft, error) {
			return canvas.Draft{HTML: html, Change: canvas.Change{Kind: canvas.ChangeRender}}, nil
		}); err != nil {
			t.Fatalf("Apply: %v", err)
		}
	}

	client := NewClient(store, pm)
	client.SetCanvasStore(canvasStore)
	return canvasForkFixture{store: store, canvas: canvasStore, client: client, seqs: seqs}
}

func rawRecords(lines ...string) []json.RawMessage {
	out := make([]json.RawMessage, len(lines))
	for i, l := range lines {
		out[i] = json.RawMessage(l)
	}
	return out
}

// A fork of a canvas session is a canvas session whose canvas is the one at
// the cut: the highest revision a kept result drew, with the size the last
// kept message reported (docs/canvas-ui.md §13.6).
func TestFork_CanvasIsTheOneAtTheCut(t *testing.T) {
	f := newCanvasForkFixture(t, rawRecords(
		`{"type":"message","content":"draw","canvas_size":{"width":390,"height":664}}`,
		`{"type":"tool_call","tool_use_id":"a","tool_name":"mcp__pockode__canvas_render"}`,
		`{"type":"tool_result","tool_use_id":"a","tool_result":"Canvas revision 1 · drawn for 390×664.","canvas_revision":1}`,
		`{"type":"done"}`,
		`{"type":"message","content":"again","canvas_size":{"width":800,"height":360}}`,
		`{"type":"tool_call","tool_use_id":"b","tool_name":"mcp__pockode__canvas_render"}`,
		`{"type":"tool_result","tool_use_id":"b","tool_result":"Canvas revision 2 · drawn for 800×360.","canvas_revision":2}`,
	), "first page", "second page")

	// Anchored on the second message the user sent: the fork returns to before
	// they sent it, so it keeps revision 1 and the first size.
	meta, err := f.client.Fork(context.Background(), "source", f.seqs[4], "")
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if !meta.Canvas {
		t.Error("the fork of a canvas session is not a canvas session")
	}

	st, err := f.canvas.Current(meta.ID)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	if st.Revision != 1 || st.HTML != "first page" {
		t.Errorf("fork's canvas = %+v, want revision 1", st)
	}
	next, err := f.canvas.Apply(meta.ID, func(canvas.Base) (canvas.Draft, error) {
		return canvas.Draft{HTML: "fork's own", Change: canvas.Change{Kind: canvas.ChangeRender}}, nil
	})
	if err != nil {
		t.Fatalf("Apply on the fork: %v", err)
	}
	if next.Revision != 2 || next.DrawnFor == nil || *next.DrawnFor != (canvas.Size{Width: 390, Height: 664}) {
		t.Errorf("fork's next revision = %+v, want 2 drawn for the size kept at the cut", next)
	}

	if src, _ := f.canvas.Current("source"); src.Revision != 2 || src.HTML != "second page" {
		t.Errorf("source's canvas = %+v, want it untouched", src)
	}
	for _, rec := range forkedHistory(t, f.store, meta.ID) {
		if rec.Type == agent.EventTypeWarning {
			t.Errorf("unexpected warning: %q", rec.Message)
		}
	}
}

// A canvas that cannot be copied does not cost the user the fork: it starts
// with no canvas, and says so.
func TestFork_CanvasCopyFailureWarns(t *testing.T) {
	// The history says revision 1 was drawn, but the canvas holds nothing.
	f := newCanvasForkFixture(t, rawRecords(
		`{"type":"message","content":"draw"}`,
		`{"type":"tool_result","tool_use_id":"a","tool_result":"Canvas revision 1 · drawn","canvas_revision":1}`,
		`{"type":"done"}`,
	))

	meta, err := f.client.Fork(context.Background(), "source", f.seqs[2], "")
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if st, err := f.canvas.Current(meta.ID); err != nil || st.Revision != 0 {
		t.Errorf("fork's canvas = %+v, %v; want nothing drawn", st, err)
	}

	history := forkedHistory(t, f.store, meta.ID)
	last := history[len(history)-1]
	if last.Type != agent.EventTypeWarning || last.Code != "fork_canvas_unavailable" {
		t.Errorf("last record = %+v, want the canvas warning", last)
	}
}
