package work

import (
	"context"
	"errors"
	"testing"
)

// recordingStarter captures the context it was called with (for the detach
// test) and can be set to fail (for the rollback test).
type recordingStarter struct {
	err    error
	calls  int
	gotCtx context.Context
}

func (r *recordingStarter) HandleWorkStart(ctx context.Context, _ Work) error {
	r.calls++
	r.gotCtx = ctx
	return r.err
}

type recordingNotifier struct {
	reopened []Work
}

func (n *recordingNotifier) NotifyReopen(w Work) { n.reopened = append(n.reopened, w) }

func TestOperations_StartWork_ClaimsAndReturnsWork(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	starter := &recordingStarter{}
	ops := NewOperations(store, starter, nil)

	w, err := ops.StartWork(context.Background(), story.ID)
	if err != nil {
		t.Fatalf("StartWork: %v", err)
	}
	if w.Status != StatusInProgress {
		t.Errorf("status = %q, want in_progress", w.Status)
	}
	if w.SessionID == "" {
		t.Error("session_id should be set after start")
	}
	if starter.calls != 1 {
		t.Errorf("HandleWorkStart called %d times, want 1", starter.calls)
	}
}

// On restart (a stopped/needs_input work going back to in_progress) the existing
// session must be reused so the agent's chat history is preserved.
func TestOperations_StartWork_RestartReusesSession(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	ops := NewOperations(store, &recordingStarter{}, nil)

	first, err := ops.StartWork(context.Background(), story.ID)
	if err != nil {
		t.Fatalf("first StartWork: %v", err)
	}
	if err := store.MarkNeedsInput(context.Background(), story.ID); err != nil {
		t.Fatal(err)
	}

	restarted, err := ops.StartWork(context.Background(), story.ID)
	if err != nil {
		t.Fatalf("restart StartWork: %v", err)
	}
	if restarted.SessionID != first.SessionID {
		t.Errorf("restart session = %q, want reuse of %q", restarted.SessionID, first.SessionID)
	}
}

func TestOperations_StartWork_RollsBackOnHandlerFailure(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	ops := NewOperations(store, &recordingStarter{err: errors.New("kickoff failed")}, nil)

	if _, err := ops.StartWork(context.Background(), story.ID); err == nil {
		t.Fatal("expected error when handler fails")
	}

	got, _, _ := store.Get(story.ID)
	if got.Status != StatusOpen {
		t.Errorf("status = %q, want open (rolled back)", got.Status)
	}
	if got.SessionID != "" {
		t.Errorf("session_id = %q, want cleared after rollback", got.SessionID)
	}
}

func TestOperations_StartWork_MissingRole(t *testing.T) {
	store := newTestStore(t)
	w := createStory(t, store, "No role")
	empty := ""
	if err := store.Update(context.Background(), w.ID, UpdateFields{AgentRoleID: &empty}); err != nil {
		t.Fatal(err)
	}
	ops := NewOperations(store, &recordingStarter{}, nil)

	if _, err := ops.StartWork(context.Background(), w.ID); err == nil {
		t.Fatal("expected error for work without agent_role_id")
	}
	got, _, _ := store.Get(w.ID)
	if got.Status != StatusOpen {
		t.Errorf("status = %q, want open (never claimed)", got.Status)
	}
}

// A cancelled caller context must not abort the start: the claim and kickoff
// run to completion so a request timeout cannot orphan a half-created session.
func TestOperations_StartWork_DetachesCallerContext(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	starter := &recordingStarter{}
	ops := NewOperations(store, starter, nil)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	w, err := ops.StartWork(ctx, story.ID)
	if err != nil {
		t.Fatalf("StartWork with cancelled ctx: %v", err)
	}
	if w.Status != StatusInProgress {
		t.Errorf("status = %q, want in_progress despite cancelled caller ctx", w.Status)
	}
	if starter.gotCtx.Err() != nil {
		t.Error("handler received a cancelled context; start should run detached")
	}
}

func TestOperations_ReopenWork_NotifiesAfterReopen(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	if _, err := store.Start(context.Background(), story.ID, "s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.StepDone(context.Background(), story.ID, 0); err != nil { // no steps → closes
		t.Fatal(err)
	}
	notifier := &recordingNotifier{}
	ops := NewOperations(store, &recordingStarter{}, notifier)

	if err := ops.ReopenWork(context.Background(), story.ID); err != nil {
		t.Fatalf("ReopenWork: %v", err)
	}
	got, _, _ := store.Get(story.ID)
	if got.Status != StatusInProgress {
		t.Errorf("status = %q, want in_progress after reopen", got.Status)
	}
	if len(notifier.reopened) != 1 {
		t.Fatalf("NotifyReopen called %d times, want 1", len(notifier.reopened))
	}
}
