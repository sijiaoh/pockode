package chat

import (
	"context"
	"errors"
	"testing"

	"github.com/pockode/server/session"
)

// Until its first message the kind is a draft: switching it closes a process
// spawned for the old kind (one left by a refused send), and the first message
// is delivered to a process spawned for the new one.
func TestClient_SetCanvasBeforeStart(t *testing.T) {
	f := newMidTurnFixture(t)
	ctx := context.Background()
	meta, _, _ := f.store.Get("sess")
	stale, _, err := f.pm.GetOrCreateProcess(ctx, meta)
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}

	if err := f.client.SetCanvas(ctx, "sess", true); err != nil {
		t.Fatalf("SetCanvas: %v", err)
	}
	if f.pm.GetProcess("sess") == stale {
		t.Fatal("the process spawned for chat survived the switch to canvas")
	}

	if _, err := f.client.SendMessageExcluding(ctx, "sess", "draw", nil, Sender{}); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}
	if proc := f.pm.GetProcess("sess"); proc == nil || !proc.Canvas() {
		t.Fatal("the first message did not go to a process spawned for canvas")
	}
	if got := f.agent.session(t, 1).sentPrompts(); len(got) != 0 {
		t.Errorf("the chat process was sent %q", got)
	}
	if got := f.agent.session(t, 2).sentPrompts(); len(got) != 1 {
		t.Errorf("the canvas process was sent %q, want the one message", got)
	}
	if meta, _, _ := f.store.Get("sess"); !meta.Started || !meta.Canvas {
		t.Errorf("meta = started %v canvas %v, want both", meta.Started, meta.Canvas)
	}
}

// Once the first message has been delivered the kind is fixed, and a refused
// switch closes nothing: the process holds what the agent was told.
func TestClient_SetCanvasAfterStartIsRefused(t *testing.T) {
	f := newMidTurnFixture(t)
	ctx := context.Background()
	f.startTurn(t)
	proc := f.pm.GetProcess("sess")

	if err := f.client.SetCanvas(ctx, "sess", true); !errors.Is(err, session.ErrSessionStarted) {
		t.Fatalf("SetCanvas = %v, want ErrSessionStarted", err)
	}
	if f.pm.GetProcess("sess") != proc {
		t.Error("a refused switch closed the session's process")
	}
	if meta, _, _ := f.store.Get("sess"); meta.Canvas {
		t.Error("a refused switch changed the kind")
	}
}

// The race the ordering exists for: a switch's write lands after a send took
// its process (spawned for chat) and before the switch closed it. The send
// sees the new kind at its mark and replaces the process itself, and the
// switch's close, arriving late, leaves the fresh process alone.
func TestClient_SendReplacesAProcessASwitchMadeStale(t *testing.T) {
	f := newMidTurnFixture(t)
	ctx := context.Background()
	meta, _, _ := f.store.Get("sess")
	if _, _, err := f.pm.GetOrCreateProcess(ctx, meta); err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	// The switch's write, without its close.
	if err := f.store.SetCanvas(ctx, "sess", true); err != nil {
		t.Fatalf("SetCanvas: %v", err)
	}

	if _, err := f.client.SendMessageExcluding(ctx, "sess", "draw", nil, Sender{}); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}
	fresh := f.pm.GetProcess("sess")
	if fresh == nil || !fresh.Canvas() {
		t.Fatal("the message did not go to a process spawned for canvas")
	}
	if got := f.agent.session(t, 1).sentPrompts(); len(got) != 0 {
		t.Errorf("the stale chat process was sent %q", got)
	}

	// The switch's close.
	f.pm.CloseIfCanvasDiffers("sess", true)
	if f.pm.GetProcess("sess") != fresh {
		t.Error("the switch's late close killed the process the send just took")
	}
}
