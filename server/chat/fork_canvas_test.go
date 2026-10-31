package chat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/canvas"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

type canvasForkFixture struct {
	agent  *forkingAgent
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
	ag := &forkingAgent{carried: true}
	registry := agent.NewRegistry()
	registry.Register(session.AgentTypeClaude, ag)
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
	return canvasForkFixture{agent: ag, store: store, canvas: canvasStore, client: client, seqs: seqs}
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
	if next.Revision != 3 || next.DrawnFor == nil || *next.DrawnFor != (canvas.Size{Width: 390, Height: 664}) {
		t.Errorf("fork's next revision = %+v, want 3, past the source's, drawn for the size kept at the cut", next)
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

	// The agent is told too, since it may remember the page it drew.
	if _, err := f.client.SendMessageExcluding(context.Background(), meta.ID, "hi", nil, Sender{}); err != nil {
		t.Fatalf("send: %v", err)
	}
	want := "hi\n[Canvas: this session was forked, but its canvas could not be copied: the canvas is empty; draw it again with canvas_render.]"
	if got := f.agent.session(t, 1).sentPrompts(); len(got) != 1 || got[0] != want {
		t.Errorf("prompts = %q, want %q", got, want)
	}
}

// A delivery that fails leaves the note for the next one (docs/canvas-ui.md
// §13.6).
func TestFork_CanvasNoteSurvivesAFailedDelivery(t *testing.T) {
	f := newCanvasForkFixture(t, canvasRevisionHistory(), "one", "two", "three")
	meta, err := f.client.ForkAtCanvasRevision(context.Background(), "source", 2, "")
	if err != nil {
		t.Fatalf("ForkAtCanvasRevision: %v", err)
	}

	f.agent.mu.Lock()
	f.agent.failSends = 1
	f.agent.mu.Unlock()
	if _, err := f.client.SendMessageExcluding(context.Background(), meta.ID, "lost", nil, Sender{}); err == nil {
		t.Fatal("the refused send succeeded")
	}
	if _, err := f.client.SendMessageExcluding(context.Background(), meta.ID, "retry", nil, Sender{}); err != nil {
		t.Fatalf("send: %v", err)
	}
	got := f.agent.session(t, 1).sentPrompts()
	if len(got) != 1 || !strings.HasPrefix(got[0], "retry\n[Canvas: this session was forked at revision 2") {
		t.Errorf("prompts = %q, want the retry to carry the note", got)
	}
}

// canvasRevisionHistory is a turn that drew revisions 1 and 2, then said
// something, then a second turn that drew 3.
func canvasRevisionHistory() []json.RawMessage {
	return rawRecords(
		`{"type":"message","content":"draw","canvas_size":{"width":390,"height":664}}`,
		`{"type":"tool_call","tool_use_id":"a","tool_name":"mcp__pockode__canvas_render"}`,
		`{"type":"tool_result","tool_use_id":"a","tool_result":"Canvas revision 1 · drawn for 390×664.","canvas_revision":1}`,
		`{"type":"tool_call","tool_use_id":"b","tool_name":"mcp__pockode__canvas_update"}`,
		`{"type":"tool_result","tool_use_id":"b","tool_result":"Canvas revision 2 · drawn for 390×664.","canvas_revision":2}`,
		`{"type":"text","content":"there"}`,
		`{"type":"done"}`,
		`{"type":"message","content":"again"}`,
		`{"type":"tool_call","tool_use_id":"c","tool_name":"mcp__pockode__canvas_render"}`,
		`{"type":"tool_result","tool_use_id":"c","tool_result":"Canvas revision 3 · drawn for 390×664.","canvas_revision":3}`,
	)
}

// A fork from a page keeps the record that drew it and drops everything after,
// the rest of its own turn included, and opens on that page
// (docs/canvas-ui.md §13.6, From a revision).
func TestForkAtCanvasRevision_CutsAtTheRecordThatDrewIt(t *testing.T) {
	f := newCanvasForkFixture(t, canvasRevisionHistory(), "one", "two", "three")

	meta, err := f.client.ForkAtCanvasRevision(context.Background(), "source", 1, "")
	if err != nil {
		t.Fatalf("ForkAtCanvasRevision: %v", err)
	}
	history := forkedHistory(t, f.store, meta.ID)
	if len(history) != 3 || history[2].CanvasRevision != 1 {
		t.Fatalf("fork's history = %+v, want the first three records, ending on revision 1's result", history)
	}
	if len(f.agent.opts.History) != 3 {
		t.Errorf("the agent was handed %d records, want the same 3", len(f.agent.opts.History))
	}
	if st, _ := f.canvas.Current(meta.ID); st.Revision != 1 || st.HTML != "one" {
		t.Errorf("fork's canvas = %+v, want revision 1", st)
	}
	if next, _ := f.canvas.Apply(meta.ID, func(canvas.Base) (canvas.Draft, error) {
		return canvas.Draft{HTML: "own", Change: canvas.Change{Kind: canvas.ChangeRender}}, nil
	}); next.Revision != 4 {
		t.Errorf("fork's next revision = %d, want 4, past the source's", next.Revision)
	}
}

// The first input delivered in a fork says which page is on the canvas, once;
// the content the record keeps does not (docs/canvas-ui.md §13.6).
func TestForkAtCanvasRevision_FirstDeliveryCarriesTheNote(t *testing.T) {
	f := newCanvasForkFixture(t, canvasRevisionHistory(), "one", "two", "three")
	meta, err := f.client.ForkAtCanvasRevision(context.Background(), "source", 2, "")
	if err != nil {
		t.Fatalf("ForkAtCanvasRevision: %v", err)
	}

	ctx := context.Background()
	size := canvas.Size{Width: 390, Height: 664}
	if _, err := f.client.SendMessageExcluding(ctx, meta.ID, "hello", nil, Sender{CanvasSize: &size}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if _, err := f.client.SendMessageExcluding(ctx, meta.ID, "and again", nil, Sender{}); err != nil {
		t.Fatalf("send: %v", err)
	}

	want := []string{
		"hello\n[Canvas size: 390×664]\n[Canvas: this session was forked at revision 2, which is on the canvas now; any page you remember drawing after it is not.]",
		"and again",
	}
	got := f.agent.session(t, 1).sentPrompts()
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("prompts = %q, want %q", got, want)
	}
	for _, rec := range forkedHistory(t, f.store, meta.ID) {
		if rec.Type == agent.EventTypeMessage && strings.Contains(rec.Content, "[Canvas") {
			t.Errorf("record content = %q, want only what the user typed", rec.Content)
		}
	}
}

// A fork from a page that cannot be cut at is refused before anything is
// made, with the same reason chat.canvas_history lists.
func TestForkAtCanvasRevision_Refusals(t *testing.T) {
	ctx := context.Background()
	f := newCanvasForkFixture(t, rawRecords(
		`{"type":"message","content":"draw"}`,
		// Revision 1's result was never recorded.
		`{"type":"tool_call","tool_use_id":"b","tool_name":"mcp__pockode__canvas_render"}`,
		`{"type":"tool_call","tool_use_id":"c","tool_name":"mcp__pockode__canvas_render"}`,
		// Parallel calls returned out of order: 3 before 2.
		`{"type":"tool_result","tool_use_id":"c","tool_result":"Canvas revision 3 · …","canvas_revision":3}`,
		`{"type":"tool_result","tool_use_id":"b","tool_result":"Canvas revision 2 · …","canvas_revision":2}`,
		`{"type":"tool_call","tool_use_id":"t","tool_name":"Task"}`,
		`{"type":"tool_call","tool_use_id":"d","tool_name":"mcp__pockode__canvas_render","parent_tool_use_id":"t"}`,
		`{"type":"tool_result","tool_use_id":"d","tool_result":"Canvas revision 4 · …","canvas_revision":4,"parent_tool_use_id":"t"}`,
	), "one", "two", "three", "four")

	tests := []struct {
		revision int
		reason   canvas.ForkBlocked
		message  string
	}{
		{1, canvas.ForkNoRecord, "revision 1 has no recorded result in this session's history, so there is no point to fork at"},
		{2, canvas.ForkSuperseded, "revision 2 was replaced by revision 3 before its call returned; fork from revision 3"},
		{4, canvas.ForkSubagent, "revision 4 was drawn by a subagent; a fork cannot be cut inside a subagent's run"},
	}
	for _, tt := range tests {
		_, err := f.client.ForkAtCanvasRevision(ctx, "source", tt.revision, "")
		if !errors.Is(err, canvas.ErrForkBlocked) || err.Error() != tt.message {
			t.Errorf("revision %d: error = %v, want %q", tt.revision, err, tt.message)
		}
	}
	if _, err := f.client.ForkAtCanvasRevision(ctx, "source", 5, ""); !errors.Is(err, canvas.ErrNoRevision) {
		t.Errorf("revision 5: error = %v, want ErrNoRevision", err)
	}

	listed, err := f.client.CanvasHistory(ctx, "source")
	if err != nil {
		t.Fatalf("CanvasHistory: %v", err)
	}
	got := map[int]canvas.ForkBlocked{}
	for _, e := range listed {
		got[e.Revision] = e.ForkBlocked
	}
	want := map[int]canvas.ForkBlocked{1: canvas.ForkNoRecord, 2: canvas.ForkSuperseded, 3: "", 4: canvas.ForkSubagent}
	for r, reason := range want {
		if got[r] != reason {
			t.Errorf("revision %d listed fork_blocked = %q, want %q", r, got[r], reason)
		}
	}

	sessions, err := f.store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Errorf("%d sessions after refused forks, want only the source", len(sessions))
	}
}

func TestForkAtCanvasRevision_NotACanvasSession(t *testing.T) {
	f := newForkFixture(t, &forkingAgent{carried: true}, nil)
	if _, err := f.client.ForkAtCanvasRevision(context.Background(), "source", 1, ""); !errors.Is(err, ErrNotCanvasSession) {
		t.Errorf("error = %v, want ErrNotCanvasSession", err)
	}
}
