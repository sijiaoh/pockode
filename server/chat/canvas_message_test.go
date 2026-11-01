package chat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/canvas"
)

var errPeek = errors.New("peek")

// reportedSize is the size the canvas's next revision would be drawn for.
func (f *midTurnFixture) reportedSize(t *testing.T) *canvas.Size {
	t.Helper()
	var got *canvas.Size
	_, err := f.canvas.Apply("sess", func(b canvas.Base) (canvas.Draft, error) {
		got = b.ReportedSize
		return canvas.Draft{}, errPeek
	})
	if !errors.Is(err, errPeek) {
		t.Fatalf("Apply: %v", err)
	}
	return got
}

// newCanvasMidTurnFixture is newMidTurnFixture with the session switched to
// canvas before anything was sent to it.
func newCanvasMidTurnFixture(t *testing.T) *midTurnFixture {
	t.Helper()
	f := newMidTurnFixture(t)
	if err := f.client.SetCanvas(context.Background(), "sess", true); err != nil {
		t.Fatalf("SetCanvas: %v", err)
	}
	return f
}

func (f *midTurnFixture) lastRecord(t *testing.T) agent.EventRecord {
	t.Helper()
	records, err := f.store.GetHistory(context.Background(), "sess")
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	var rec agent.EventRecord
	if err := json.Unmarshal(records[len(records)-1], &rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

// A canvas action is the user's message: the agent reads the action text with
// the size line under it, and the record keeps the action text alone beside
// its structured copy and the size (docs/canvas-ui.md §6.2, §6.3).
func TestClient_CanvasActionReachesTheAgentAsAMessage(t *testing.T) {
	f := newCanvasMidTurnFixture(t)
	sess := f.startTurn(t)

	size := canvas.Size{Width: 390, Height: 664}
	action := canvas.Action{Action: "create", Data: json.RawMessage(`{"title":"Fix login"}`), Revision: 7}
	sent, content, err := f.client.SendCanvasAction(context.Background(), "sess", action, Sender{CanvasSize: &size})
	if err != nil {
		t.Fatalf("SendCanvasAction: %v", err)
	}

	const text = "Canvas action \"create\" from revision 7:\n{\"title\":\"Fix login\"}"
	if content != text {
		t.Errorf("content = %q, want %q", content, text)
	}
	if got := sess.sentPrompts(); got[len(got)-1] != text+"\n[Canvas size: 390×664]" {
		t.Errorf("the agent read %q", got[len(got)-1])
	}

	f.waitForRecords(t, 2)
	records, _ := f.store.GetHistory(context.Background(), "sess")
	var rec agent.EventRecord
	if err := json.Unmarshal(records[sent.Seq.Index()], &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Content != text {
		t.Errorf("record content = %q, want the action text without the size line", rec.Content)
	}
	if rec.CanvasAction == nil || rec.CanvasAction.Action != "create" || rec.CanvasAction.Revision != 7 ||
		string(rec.CanvasAction.Data) != `{"title":"Fix login"}` {
		t.Errorf("record canvas_action = %+v", rec.CanvasAction)
	}
	if rec.CanvasSize == nil || *rec.CanvasSize != size {
		t.Errorf("record canvas_size = %+v, want %+v", rec.CanvasSize, size)
	}
	var broadcast *agent.EventRecord
	for i := range f.broadcasts {
		if f.broadcasts[i].MessageID == sent.MessageID && f.broadcasts[i].Type == agent.EventTypeMessage {
			broadcast = &f.broadcasts[i]
		}
	}
	if broadcast == nil || broadcast.CanvasAction == nil || broadcast.CanvasSize == nil {
		t.Errorf("broadcast record = %+v, want it to carry canvas_action and canvas_size", broadcast)
	}
	if got := f.reportedSize(t); got == nil || *got != size {
		t.Errorf("reported size = %+v, want %+v", got, size)
	}
}

// A typed message carries the size the same way, and its content stays what
// the user typed, so a fork's dropped prompt comes back without a size line.
func TestClient_TypedMessageCarriesTheCanvasSize(t *testing.T) {
	f := newCanvasMidTurnFixture(t)
	size := canvas.Size{Width: 820, Height: 1100}

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "make it blue", nil, Sender{CanvasSize: &size}); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}
	if got := f.agent.session(t, 1).sentPrompts(); got[0] != "make it blue\n[Canvas size: 820×1100]" {
		t.Errorf("the agent read %q", got[0])
	}
	rec := f.lastRecord(t)
	if rec.Content != "make it blue" || rec.CanvasSize == nil || *rec.CanvasSize != size || rec.CanvasAction != nil {
		t.Errorf("record = %+v", rec)
	}
	if got := f.reportedSize(t); got == nil || *got != size {
		t.Errorf("reported size = %+v, want %+v", got, size)
	}
}

// A size sent with a message that starts a chat session is dropped: the kind
// is the one fixed at the send's mark, whatever the caller thought it was.
func TestClient_ChatSessionDropsTheCanvasSize(t *testing.T) {
	f := newMidTurnFixture(t)
	size := canvas.Size{Width: 820, Height: 1100}

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "hello", nil, Sender{CanvasSize: &size}); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}
	if got := f.agent.session(t, 1).sentPrompts(); got[0] != "hello" {
		t.Errorf("the agent read %q", got[0])
	}
	if rec := f.lastRecord(t); rec.CanvasSize != nil {
		t.Errorf("record canvas_size = %+v, want none", rec.CanvasSize)
	}
	if got := f.reportedSize(t); got != nil {
		t.Errorf("reported size = %+v, want none", got)
	}
}

// A message refused because a permission request is open reached no agent,
// so the size it carried is not the canvas's (docs/canvas-ui.md §6.4).
func TestClient_RefusedMessageReportsNoSize(t *testing.T) {
	f := newCanvasMidTurnFixture(t)
	sess := f.startTurn(t)
	sess.events <- agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"}
	f.waitForRecords(t, 2)

	size := canvas.Size{Width: 390, Height: 664}
	_, _, err := f.client.SendCanvasAction(context.Background(), "sess",
		canvas.Action{Action: "approve", Data: json.RawMessage("{}"), Revision: 1}, Sender{CanvasSize: &size})
	if !errors.Is(err, ErrTurnAwaitingAnswer) {
		t.Fatalf("error = %v, want ErrTurnAwaitingAnswer", err)
	}
	if got := f.reportedSize(t); got != nil {
		t.Errorf("reported size = %+v, want none", got)
	}
}
