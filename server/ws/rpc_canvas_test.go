package ws

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/canvas"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func (e *testEnv) createCanvasSession() rpc.SessionListItem {
	e.t.Helper()
	resp := e.call("session.create", rpc.SessionCreateParams{Canvas: true})
	if resp.Error != nil {
		e.t.Fatalf("session.create failed: %s", resp.Error.Message)
	}
	var row rpc.SessionListItem
	if err := json.Unmarshal(resp.Result, &row); err != nil {
		e.t.Fatalf("failed to unmarshal result: %v", err)
	}
	return row
}

func (e *testEnv) drawCanvas(sessionID, html string) canvas.Snapshot {
	e.t.Helper()
	snap, err := e.getMainWorktree().CanvasStore.Apply(sessionID, func(canvas.Base) (canvas.Draft, error) {
		return canvas.Draft{HTML: html, Change: canvas.Change{Kind: canvas.ChangeRender}}, nil
	})
	if err != nil {
		e.t.Fatalf("Apply: %v", err)
	}
	return snap
}

func TestSessionCreate_Canvas(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	row := env.createCanvasSession()
	if !row.Canvas {
		t.Error("the row of a canvas session does not say so")
	}
	meta, _, _ := env.getMainWorktree().SessionStore.Get(row.ID)
	if !meta.Canvas {
		t.Error("the session was not stored as a canvas session")
	}

	plain, plainMeta := env.createSession()
	if plain.Canvas || plainMeta.Canvas {
		t.Error("a session created without params is a canvas session")
	}
}

// The current canvas reaches a client through the chat subscription — in the
// subscribe result, then as chat.canvas_state — and never only through the
// transcript (docs/canvas-ui.md §13.2).
func TestChatSubscribe_PushesTheCanvas(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row := env.createCanvasSession()

	if got := env.subscribeChatMessages(row.ID).Canvas; got == nil || got.Revision != 0 || got.HTML != "" {
		t.Fatalf("canvas before anything was drawn = %+v, want revision 0", got)
	}

	env.drawCanvas(row.ID, "<p>one</p>")
	notif := env.awaitNotification("chat.canvas_state")
	var params struct {
		ID     string       `json:"id"`
		Canvas canvas.State `json:"canvas"`
		Seq    *int         `json:"seq"`
	}
	if err := json.Unmarshal(notif.Params, &params); err != nil {
		t.Fatal(err)
	}
	if params.ID == "" || params.Canvas.Revision != 1 || params.Canvas.HTML != "<p>one</p>" || params.Canvas.Change == nil {
		t.Errorf("chat.canvas_state = %s", notif.Params)
	}
	if params.Seq != nil {
		t.Error("chat.canvas_state carries a seq: it is state, not a record")
	}

	env.drawCanvas(row.ID, "<p>two</p>")
	if got := env.subscribeChatMessages(row.ID).Canvas; got == nil || got.Revision != 2 || got.HTML != "<p>two</p>" {
		t.Errorf("canvas on resubscribing = %+v, want revision 2", got)
	}

	plain, _ := env.createSession()
	if got := env.subscribeChatMessages(plain.ID).Canvas; got != nil {
		t.Errorf("an ordinary session's subscription carries a canvas: %+v", got)
	}
}

func TestChatCanvasHistoryAndSnapshot(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row := env.createCanvasSession()
	env.drawCanvas(row.ID, "one")
	env.drawCanvas(row.ID, "two")

	resp := env.call("chat.canvas_history", rpc.ChatCanvasHistoryParams{SessionID: row.ID})
	if resp.Error != nil {
		t.Fatalf("chat.canvas_history: %s", resp.Error.Message)
	}
	var history rpc.ChatCanvasHistoryResult
	if err := json.Unmarshal(resp.Result, &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Snapshots) != 2 || history.Snapshots[0].Revision != 2 {
		t.Errorf("history = %+v, want two revisions newest first", history.Snapshots)
	}

	resp = env.call("chat.canvas_snapshot", rpc.ChatCanvasSnapshotParams{SessionID: row.ID, Revision: 1})
	if resp.Error != nil {
		t.Fatalf("chat.canvas_snapshot: %s", resp.Error.Message)
	}
	var snap canvas.Snapshot
	if err := json.Unmarshal(resp.Result, &snap); err != nil {
		t.Fatal(err)
	}
	if snap.Revision != 1 || snap.HTML != "one" {
		t.Errorf("snapshot = %+v", snap)
	}

	resp = env.call("chat.canvas_snapshot", rpc.ChatCanvasSnapshotParams{SessionID: row.ID, Revision: 3})
	if resp.Error == nil || resp.Error.Message != "the canvas has no such revision: revision 3, the canvas is at 2" {
		t.Errorf("a revision not drawn yet: %+v", resp.Error)
	}

	plain, _ := env.createSession()
	for method, params := range map[string]any{
		"chat.canvas_history":  rpc.ChatCanvasHistoryParams{SessionID: plain.ID},
		"chat.canvas_snapshot": rpc.ChatCanvasSnapshotParams{SessionID: plain.ID, Revision: 1},
	} {
		resp = env.call(method, params)
		if resp.Error == nil || resp.Error.Message != "this session is not a canvas session" {
			t.Errorf("%s of an ordinary session: %+v", method, resp.Error)
		}
	}
}

func canvasSize(w, h float64) *rpc.CanvasSizeParams {
	return &rpc.CanvasSizeParams{Width: w, Height: h}
}

var errPeek = errors.New("peek")

// reportedSize is the size the session's next revision would be drawn for.
func (e *testEnv) reportedSize(sessionID string) *canvas.Size {
	e.t.Helper()
	var got *canvas.Size
	_, err := e.getMainWorktree().CanvasStore.Apply(sessionID, func(b canvas.Base) (canvas.Draft, error) {
		got = b.ReportedSize
		return canvas.Draft{}, errPeek
	})
	if !errors.Is(err, errPeek) {
		e.t.Fatalf("Apply: %v", err)
	}
	return got
}

func (e *testEnv) historyLen(sessionID string) int {
	e.t.Helper()
	records, err := e.getMainWorktree().SessionStore.GetHistory(bgCtx, sessionID)
	if err != nil {
		e.t.Fatalf("GetHistory: %v", err)
	}
	return len(records)
}

// Every refusal of chat.canvas_action is InvalidParams with the contract's
// words, and leaves the agent untold (docs/canvas-ui.md §6.4).
func TestChatCanvasAction_Refusals(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	row := env.createCanvasSession()
	env.drawCanvas(row.ID, "<button data-pk-send=\"go\">Go</button>")
	plain, _ := env.createSession()

	big := `"` + strings.Repeat("x", 64*1024) + `"`
	tests := []struct {
		name   string
		params rpc.CanvasActionParams
		want   string
	}{
		{"ordinary session", rpc.CanvasActionParams{SessionID: plain.ID, Action: "go", Revision: 1},
			"this session is not a canvas session"},
		{"empty action", rpc.CanvasActionParams{SessionID: row.ID, Revision: 1},
			"action must be 1–128 characters with no control characters"},
		{"long action", rpc.CanvasActionParams{SessionID: row.ID, Action: strings.Repeat("あ", 129), Revision: 1},
			"action must be 1–128 characters with no control characters"},
		{"control character", rpc.CanvasActionParams{SessionID: row.ID, Action: "go\n", Revision: 1},
			"action must be 1–128 characters with no control characters"},
		{"data too large", rpc.CanvasActionParams{SessionID: row.ID, Action: "go", Data: json.RawMessage(big), Revision: 1},
			fmt.Sprintf("data is %d bytes, over the 64KB limit", len(big))},
		{"revision 0", rpc.CanvasActionParams{SessionID: row.ID, Action: "go", Revision: 0},
			"revision must be 1 or higher: an action comes from a page that was drawn, and revision 0 was not"},
		{"revision ahead", rpc.CanvasActionParams{SessionID: row.ID, Action: "go", Revision: 2},
			"revision 2 does not exist yet: the canvas is at 1"},
		{"revision ahead and size out of bounds", rpc.CanvasActionParams{SessionID: row.ID, Action: "go", Revision: 2, CanvasSize: canvasSize(0, 0)},
			"revision 2 does not exist yet: the canvas is at 1"},
		{"fractional size", rpc.CanvasActionParams{SessionID: row.ID, Action: "go", Revision: 1, CanvasSize: canvasSize(390.5, 664)},
			"canvas_size must be whole CSS pixels between 1 and 10000"},
		{"size too large", rpc.CanvasActionParams{SessionID: row.ID, Action: "go", Revision: 1, CanvasSize: canvasSize(390, 10001)},
			"canvas_size must be whole CSS pixels between 1 and 10000"},
		{"zero size", rpc.CanvasActionParams{SessionID: row.ID, Action: "go", Revision: 1, CanvasSize: canvasSize(0, 664)},
			"canvas_size must be whole CSS pixels between 1 and 10000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := env.call("chat.canvas_action", tt.params)
			if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams || resp.Error.Message != tt.want {
				t.Errorf("error = %+v, want InvalidParams %q", resp.Error, tt.want)
			}
		})
	}
	// A refused action leaves no trace: not on the agent's stdin, not in the
	// transcript, and not in the size the next revision is drawn for.
	if got := mock.sentMessages(); len(got) != 0 {
		t.Errorf("the agent was sent %q", got)
	}
	if got := env.historyLen(row.ID); got != 0 {
		t.Errorf("history records = %d, want none", got)
	}
	if got := env.reportedSize(row.ID); got != nil {
		t.Errorf("reported size = %+v, want none", got)
	}
}

// The bounds are inclusive: each limit itself is accepted.
func TestChatCanvasAction_AcceptsTheLimits(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	// The reply echoes the data back, past the test client's default limit.
	env.conn.SetReadLimit(-1)
	row := env.createCanvasSession()
	env.drawCanvas(row.ID, "<p>one</p>")

	data := `"` + strings.Repeat("x", 64*1024-2) + `"`
	for _, params := range []rpc.CanvasActionParams{
		{SessionID: row.ID, Action: strings.Repeat("あ", 128), Revision: 1, CanvasSize: canvasSize(1, 1)},
		{SessionID: row.ID, Action: "go", Data: json.RawMessage(data), Revision: 1, CanvasSize: canvasSize(10000, 10000)},
	} {
		if resp := env.call("chat.canvas_action", params); resp.Error != nil {
			t.Errorf("chat.canvas_action(%.20q…) refused: %s", params.Action, resp.Error.Message)
		}
	}
}

// While a permission request is open the action is refused with the words a
// typed message gets, and the size it carried is not reported
// (docs/canvas-ui.md §6.4, §10.3).
func TestChatCanvasAction_RefusedWhileAPermissionIsOpen(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row := env.createCanvasSession()
	env.drawCanvas(row.ID, "<p>one</p>")
	env.subscribeChatMessages(row.ID)
	env.sendMessage(row.ID, "run ls")
	// The mock answers every message with a done of its own; a request raised
	// before it would be withdrawn by that ending.
	env.awaitNotification("chat.done")
	raisePrompt(t, env, row.ID, "req-1", agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"})

	resp := env.call("chat.canvas_action", rpc.CanvasActionParams{
		SessionID: row.ID, Action: "go", Revision: 1, CanvasSize: canvasSize(390, 664),
	})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams || resp.Error.Message != chat.ErrTurnAwaitingAnswer.Error() {
		t.Errorf("error = %+v, want InvalidParams %q", resp.Error, chat.ErrTurnAwaitingAnswer)
	}
	if got := env.reportedSize(row.ID); got != nil {
		t.Errorf("reported size = %+v, want none", got)
	}
}

// An accepted canvas action is the user's message: the agent reads the action
// text and the size, and the sender learns what it sent — it is left out of
// the broadcast (docs/canvas-ui.md §6.4).
func TestChatCanvasAction_Delivered(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	row := env.createCanvasSession()
	env.drawCanvas(row.ID, "<p>one</p>")
	env.drawCanvas(row.ID, "<p>two</p>")

	resp := env.call("chat.canvas_action", rpc.CanvasActionParams{
		SessionID: row.ID, Action: "create", Data: json.RawMessage(`{ "title": "Fix login" }`),
		Revision: 1, CanvasSize: canvasSize(390, 664),
	})
	if resp.Error != nil {
		t.Fatalf("chat.canvas_action: %s", resp.Error.Message)
	}
	var result rpc.MessageResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatal(err)
	}
	const text = "Canvas action \"create\" from revision 1:\n{\"title\":\"Fix login\"}"
	if !result.Seq.Valid() || result.MessageID == "" || result.Content != text {
		t.Errorf("result = %+v", result)
	}
	if a := result.CanvasAction; a == nil || a.Action != "create" || a.Revision != 1 || string(a.Data) != `{"title":"Fix login"}` {
		t.Errorf("canvas_action echoed = %+v", a)
	}
	if got := mock.sentMessagesFor(row.ID); len(got) != 1 || got[0] != text+"\n[Canvas size: 390×664]" {
		t.Errorf("the agent read %q", got)
	}
}

// A typed message's size reaches the agent in a canvas session and is ignored
// anywhere else, but is refused out of bounds in either (docs/canvas-ui.md
// §6.4).
func TestChatMessage_CanvasSize(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	row := env.createCanvasSession()
	plain, _ := env.createSession()

	for _, s := range []struct {
		id   string
		want string
	}{
		{row.ID, "hello\n[Canvas size: 390×664]"},
		{plain.ID, "hello"},
	} {
		resp := env.call("chat.message", rpc.MessageParams{SessionID: s.id, Content: "hello", CanvasSize: canvasSize(390, 664)})
		if resp.Error != nil {
			t.Fatalf("chat.message: %s", resp.Error.Message)
		}
		if got := mock.sentMessagesFor(s.id); len(got) != 1 || got[0] != s.want {
			t.Errorf("the agent read %q, want %q", got, s.want)
		}
	}

	resp := env.call("chat.message", rpc.MessageParams{SessionID: plain.ID, Content: "hello", CanvasSize: canvasSize(-1, 664)})
	if resp.Error == nil || resp.Error.Message != "canvas_size must be whole CSS pixels between 1 and 10000" {
		t.Errorf("error = %+v, want the size refused", resp.Error)
	}
}

// The subscribe result carries the record of every pending permission request,
// even one a long turn has pushed off the page, so the canvas's permission
// panel never depends on what the transcript loaded (docs/canvas-ui.md §10.4).
func TestChatSubscribe_PendingPermissionRequests(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row := env.createCanvasSession()

	if got := env.subscribeChatMessages(row.ID).PermissionRequests; got != nil {
		t.Fatalf("permission_requests before any = %s", got)
	}
	env.sendMessage(row.ID, "run ls")
	// The mock answers every message with a done of its own; a request raised
	// before it would be withdrawn by that ending.
	env.awaitNotification("chat.done")
	raisePrompt(t, env, row.ID, "req-1",
		agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash", ToolInput: []byte(`{"command":"ls"}`), ToolUseID: "toolu_1"})
	// The turn is blocked before the record is written; the notification is
	// what says it is.
	env.awaitNotification("chat.permission_request")
	for range 3 {
		if _, err := env.getMainWorktree().SessionStore.AppendToHistory(bgCtx, row.ID,
			agent.NewEventRecord(agent.TextEvent{Content: "later"})); err != nil {
			t.Fatal(err)
		}
	}

	result := env.subscribeChatMessagesWithLimit(row.ID, 1)
	if len(result.PermissionRequests) != 1 {
		t.Fatalf("permission_requests = %s, want the one pending", result.PermissionRequests)
	}
	var rec struct {
		agent.EventRecord
		Seq int `json:"seq"`
	}
	if err := json.Unmarshal(result.PermissionRequests[0], &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Type != agent.EventTypePermissionRequest || rec.RequestID != "req-1" || rec.ToolUseID != "toolu_1" {
		t.Errorf("permission request record = %s", result.PermissionRequests[0])
	}
	history, _ := env.getMainWorktree().SessionStore.GetHistory(bgCtx, row.ID)
	if rec.Seq < 1 || rec.Seq > len(history) || !strings.Contains(string(history[rec.Seq-1]), `"request_id":"req-1"`) {
		t.Errorf("seq %d does not name the request's record", rec.Seq)
	}

	// Answered, it is pending no longer.
	if resp := env.call("chat.permission_response", rpc.PermissionResponseParams{
		SessionID: row.ID, RequestID: "req-1", Choice: "allow",
	}); resp.Error != nil {
		t.Fatalf("chat.permission_response: %s", resp.Error.Message)
	}
	if got := env.subscribeChatMessages(row.ID).PermissionRequests; got != nil {
		t.Errorf("permission_requests after the answer = %s", got)
	}
}
