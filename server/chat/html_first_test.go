package chat

import (
	"context"
	"slices"
	"sync"
	"testing"

	"github.com/pockode/server/session"
)

// switchBeforeMarkStore lands a session.set_html_first in the one window the
// switch can still be accepted for a message already on its way: after the
// sender fetched its process, before it marked the session started.
type switchBeforeMarkStore struct {
	*session.FileStore
	once sync.Once
}

func (s *switchBeforeMarkStore) MarkStarted(ctx context.Context, sessionID string) (session.SessionMeta, error) {
	s.once.Do(func() {
		if err := s.SetHTMLFirst(ctx, sessionID, true); err != nil {
			panic(err)
		}
	})
	return s.FileStore.MarkStarted(ctx, sessionID)
}

// The switch was accepted, so the message must reach an agent started with the
// value it switched to — not the process fetched before it.
func TestClient_SwitchBeforeFirstMessageIsHonoured(t *testing.T) {
	base, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	store := &switchBeforeMarkStore{FileStore: base}
	pm, ag := newTestManagerWithAgent(t, store)
	defer pm.Shutdown()

	if _, err := store.Create(context.Background(), "sess", session.CreateSpec{AgentType: session.AgentTypeClaude}); err != nil {
		t.Fatalf("Create session: %v", err)
	}

	if _, err := NewClient(store, pm).SendMessageExcluding(context.Background(), "sess", "hello", nil, nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}

	ag.mu.Lock()
	starts := slices.Clone(ag.htmlFirst)
	ag.mu.Unlock()
	if !slices.Equal(starts, []bool{false, true}) {
		t.Fatalf("starts html_first = %v, want the ordinary process replaced by an HTML-first one", starts)
	}
	if got := ag.session(t, 1).sentPrompts(); len(got) != 0 {
		t.Errorf("the replaced process was sent %q, want nothing", got)
	}
	if got := ag.session(t, 2).sentPrompts(); !slices.Equal(got, []string{"hello"}) {
		t.Errorf("the HTML-first process was sent %q, want the message", got)
	}
}
