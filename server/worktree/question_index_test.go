package worktree

import (
	"context"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

func pending(ids ...string) []session.PendingQuestion {
	out := make([]session.PendingQuestion, len(ids))
	for i, id := range ids {
		out[i] = session.PendingQuestion{RequestID: id, Header: id, Question: "?", AskedAt: time.Now()}
	}
	return out
}

// sessionFor is the single-session read the index no longer offers: every test
// below but one asks about a question open in exactly one place, and this keeps
// them saying so.
func sessionFor(idx *questionIndex, requestID string) (string, bool) {
	sessions := idx.sessionsFor(requestID)
	if len(sessions) != 1 {
		return "", false
	}
	return sessions[0], true
}

func changed(sessionID string, unanswered []session.PendingQuestion) session.SessionChangeEvent {
	return session.SessionChangeEvent{
		Op: session.OperationUpdate,
		Session: session.SessionMeta{
			ID:   sessionID,
			Turn: session.TurnState{Phase: session.PhaseIdle, Unanswered: unanswered},
		},
	}
}

// TestQuestionIndex_ProjectsWhateverTheSessionSays is the property the whole
// design rests on: the index is rebuilt from the list it is told about, never
// patched. There is no add and no remove to forget, so a question that left the
// list leaves the index in the same change.
func TestQuestionIndex_ProjectsWhateverTheSessionSays(t *testing.T) {
	idx := newQuestionIndex()

	idx.OnSessionChange(changed("sess-1", pending("req-1", "req-2")))
	for _, id := range []string{"req-1", "req-2"} {
		if got, found := sessionFor(idx, id); !found || got != "sess-1" {
			t.Errorf("sessionFor(%q) = %q/%v, want sess-1", id, got, found)
		}
	}

	// One answered, one still open, one newly posted — all in one change.
	idx.OnSessionChange(changed("sess-1", pending("req-2", "req-3")))
	if _, found := sessionFor(idx, "req-1"); found {
		t.Error("req-1 is still indexed after it left the session's list")
	}
	if got, _ := sessionFor(idx, "req-3"); got != "sess-1" {
		t.Errorf("sessionFor(req-3) = %q, want sess-1", got)
	}

	idx.OnSessionChange(changed("sess-1", nil))
	if _, found := sessionFor(idx, "req-2"); found {
		t.Error("req-2 is still indexed after the session's list emptied")
	}
}

func TestQuestionIndex_SeveralSessions(t *testing.T) {
	idx := newQuestionIndex()
	idx.OnSessionChange(changed("sess-1", pending("req-1")))
	idx.OnSessionChange(changed("sess-2", pending("req-2")))

	if got, _ := sessionFor(idx, "req-1"); got != "sess-1" {
		t.Errorf("sessionFor(req-1) = %q, want sess-1", got)
	}
	if got, _ := sessionFor(idx, "req-2"); got != "sess-2" {
		t.Errorf("sessionFor(req-2) = %q, want sess-2", got)
	}

	// One session emptying must not touch the other's entries.
	idx.OnSessionChange(changed("sess-1", nil))
	if got, _ := sessionFor(idx, "req-2"); got != "sess-2" {
		t.Errorf("sessionFor(req-2) = %q, want sess-2 still", got)
	}
}

// A deleted session takes its questions with it: nothing is coming back to
// answer them, and nothing could reach the store they were in.
func TestQuestionIndex_DeletedSessionIsForgotten(t *testing.T) {
	idx := newQuestionIndex()
	idx.OnSessionChange(changed("sess-1", pending("req-1")))

	idx.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationDelete,
		Session: session.SessionMeta{ID: "sess-1"},
	})
	if _, found := sessionFor(idx, "req-1"); found {
		t.Error("req-1 is still indexed after its session was deleted")
	}
}

// TestRebuildQuestionIndex_ReadsWhatIsOnDisk is the startup half. Unlike a
// blocker, a posted question does not expire when the server stops, so a restart
// has to find every one of them again — including those in worktrees nobody has
// opened.
func TestRebuildQuestionIndex_ReadsWhatIsOnDisk(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}

	m := &Manager{registry: registry, dataDir: dataDir, worktrees: make(map[string]*Worktree), questions: newQuestionIndex()}
	createSessionIn(t, m, "", "main-session")
	createSessionIn(t, m, "feature-x", "feature-session")
	postInto(t, m, "", "main-session", "req-main")
	postInto(t, m, "feature-x", "feature-session", "req-feature")

	// A fresh manager over the same data directory is what a restart is.
	restarted := &Manager{registry: registry, dataDir: dataDir, worktrees: make(map[string]*Worktree), questions: newQuestionIndex()}
	restarted.rebuildQuestionIndex()

	for requestID, want := range map[string]QuestionLocation{
		"req-main":    {SessionID: "main-session", Worktree: ""},
		"req-feature": {SessionID: "feature-session", Worktree: "feature-x"},
	} {
		got := restarted.LocateQuestions(requestID)
		if len(got) != 1 || got[0] != want {
			t.Errorf("LocateQuestions(%q) = %+v, want [%+v]", requestID, got, want)
		}
	}

	if got := restarted.LocateQuestions("req-nobody"); len(got) != 0 {
		t.Errorf("LocateQuestions found %+v for a question nobody asked", got)
	}
}

// postInto writes one pending question straight into a worktree's session store,
// which is what the server has on disk after an agent posted one.
func postInto(t *testing.T, m *Manager, worktree, sessionID, requestID string) {
	t.Helper()
	store, err := session.NewFileStore(m.dataDirFor(worktree))
	if err != nil {
		t.Fatalf("session store for worktree %q: %v", worktree, err)
	}
	q := session.PendingQuestion{RequestID: requestID, Header: "h", Question: "?", AskedAt: time.Now()}
	if _, err := store.ApplyTurn(context.Background(), sessionID, session.TurnInput{
		Signal: session.SignalQuestionPosted, Question: &q, At: time.Now(),
	}); err != nil {
		t.Fatalf("ApplyTurn: %v", err)
	}
}

// TestQuestionIndex_AForkLeavesOneQuestionInTwoSessions is why the index maps to
// a set. A fork copies the questions it inherits with their ids unchanged, so
// both sessions are waiting on the same id and nothing can pick between them —
// question_answer makes the caller say which.
func TestQuestionIndex_AForkLeavesOneQuestionInTwoSessions(t *testing.T) {
	idx := newQuestionIndex()
	idx.OnSessionChange(changed("sess-source", pending("req-1")))
	idx.OnSessionChange(changed("sess-fork", pending("req-1")))

	got := idx.sessionsFor("req-1")
	if len(got) != 2 || got[0] != "sess-fork" || got[1] != "sess-source" {
		t.Fatalf("sessionsFor(req-1) = %v, want both sessions in id order", got)
	}

	// Answering it in one leaves the other still asking, which is the whole
	// reason both are kept.
	idx.OnSessionChange(changed("sess-fork", nil))
	if got := idx.sessionsFor("req-1"); len(got) != 1 || got[0] != "sess-source" {
		t.Errorf("sessionsFor(req-1) = %v, want only the source still asking", got)
	}
}
