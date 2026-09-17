package process

import (
	"context"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// The manager is what connects an agent's usage reports to the session that
// owns them. Usage does not travel on the event channel, so nothing else in the
// pipeline would catch this being wired to the wrong session — or to none.
func TestManagerRecordsUsageAgainstItsSession(t *testing.T) {
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ctx := context.Background()
	for _, id := range []string{"sess-1", "sess-2"} {
		if _, err := store.Create(ctx, id, session.CreateSpec{AgentType: session.AgentTypeClaude}); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}

	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	for _, id := range []string{"sess-1", "sess-2"} {
		if _, _, err := m.GetOrCreateProcess(ctx, session.SessionMeta{ID: id, AgentType: session.AgentTypeClaude}); err != nil {
			t.Fatalf("GetOrCreateProcess %s: %v", id, err)
		}
	}

	report := func(sessionID string, report session.UsageReport) {
		t.Helper()
		mock.usageCallback(t, sessionID)(report)
	}

	report("sess-1", session.UsageReport{
		Added:         session.TokenUsage{InputTokens: 10, OutputTokens: 20},
		ContextTokens: 1000,
		ContextWindow: 200000,
	})
	report("sess-1", session.UsageReport{Added: session.TokenUsage{OutputTokens: 5}})
	report("sess-2", session.UsageReport{Added: session.TokenUsage{InputTokens: 7}})

	first, _, err := store.Get("sess-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	want := session.TokenUsage{InputTokens: 10, OutputTokens: 25}
	if first.Usage.TokenUsage != want {
		t.Errorf("sess-1 usage = %+v, want %+v", first.Usage.TokenUsage, want)
	}
	if first.Usage.ContextTokens != 1000 || first.Usage.ContextWindow != 200000 {
		t.Errorf("sess-1 context = %d/%d, want 1000/200000", first.Usage.ContextTokens, first.Usage.ContextWindow)
	}

	second, _, err := store.Get("sess-2")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := (session.TokenUsage{InputTokens: 7}); second.Usage.TokenUsage != got {
		t.Errorf("sess-2 usage = %+v, want %+v", second.Usage.TokenUsage, got)
	}
}

// A turn can still be metered after the session is gone. Losing the report is
// the right outcome; failing loudly about a session nobody can look at is not.
func TestManagerDropsUsageForDeletedSession(t *testing.T) {
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "gone", AgentType: session.AgentTypeClaude}); err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}

	// The session was never in the store, which is what a deleted one looks like
	// to a report that arrives afterwards.
	mock.usageCallback(t, "gone")(session.UsageReport{Added: session.TokenUsage{OutputTokens: 1}})
}

// Every agent must be handed a way to report usage; an agent started without
// one silently stops counting for that session.
func TestManagerAlwaysInstallsUsageCallback(t *testing.T) {
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude}); err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	if mock.usageCallback(t, "sess-1") == nil {
		t.Error("agent started with no usage callback")
	}
}
