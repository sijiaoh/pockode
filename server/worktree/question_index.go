package worktree

import (
	"log/slog"
	"slices"
	"sync"

	"github.com/pockode/server/session"
)

// questionIndex answers "which sessions is this request id waiting in", across
// every worktree in the project.
//
// It is a *projection*, never a second source of truth. The unanswered list of
// a session is state, and it lives in exactly one place — that session's turn
// (session.TurnState.Unanswered). This is a map rebuilt from those lists
// whenever one changes, so the two cannot disagree for longer than the change
// that moved them: there is no add and no remove to forget to call, only the
// list a session change already carries.
//
// It exists because a request id arrives without a session. A question can be
// acted on by something that only has the id — a card's request id, an agent
// answering another agent's question — and sessions are stored per worktree, so
// finding the store that owns one otherwise means reading every worktree's
// index off disk. The worktree name is deliberately *not* kept here: it is
// derivable from the session (Manager.ResolveSessionWorktree), and a copy would
// be a second fact to keep right.
//
// One request id can be open in *several* sessions at once, which is why the
// index maps to a set rather than to one session. A fork copies the questions
// it inherits with their ids unchanged (agent.UnansweredQuestions), so the
// moment a session with an unanswered question is forked there are two places
// that id is waiting, and nothing decides which of them is the real one —
// answering one leaves the other still asking. Keeping only the latest would
// make that second question unreachable by id, silently.
type questionIndex struct {
	mu sync.Mutex
	// sessionsOf maps request id to every session waiting on it.
	sessionsOf map[string]map[string]struct{}
	// asked maps session id to the requests last seen open in it, which is what
	// lets a session's entries be replaced wholesale rather than diffed.
	asked map[string][]string
}

func newQuestionIndex() *questionIndex {
	return &questionIndex{
		sessionsOf: make(map[string]map[string]struct{}),
		asked:      make(map[string][]string),
	}
}

// observe replaces everything the index knows about one session with the
// questions it is waiting on now.
func (i *questionIndex) observe(sessionID string, unanswered []session.PendingQuestion) {
	if sessionID == "" {
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.forgetLocked(sessionID)
	if len(unanswered) == 0 {
		return
	}
	ids := make([]string, 0, len(unanswered))
	for _, q := range unanswered {
		sessions, ok := i.sessionsOf[q.RequestID]
		if !ok {
			sessions = make(map[string]struct{}, 1)
			i.sessionsOf[q.RequestID] = sessions
		}
		sessions[sessionID] = struct{}{}
		ids = append(ids, q.RequestID)
	}
	i.asked[sessionID] = ids
}

func (i *questionIndex) forget(sessionID string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.forgetLocked(sessionID)
}

func (i *questionIndex) forgetLocked(sessionID string) {
	for _, id := range i.asked[sessionID] {
		sessions := i.sessionsOf[id]
		delete(sessions, sessionID)
		if len(sessions) == 0 {
			delete(i.sessionsOf, id)
		}
	}
	delete(i.asked, sessionID)
}

// sessionsFor lists every session with this request id still open, ordered by
// id so that a refusal listing them reads the same way twice.
func (i *questionIndex) sessionsFor(requestID string) []string {
	i.mu.Lock()
	defer i.mu.Unlock()
	out := make([]string, 0, len(i.sessionsOf[requestID]))
	for sessionID := range i.sessionsOf[requestID] {
		out = append(out, sessionID)
	}
	slices.Sort(out)
	return out
}

// OnSessionChange implements session.OnChangeListener.
//
// Handled inline rather than queued, unlike the watchers: the store holds its
// lock across this call and an implementation must neither block nor call back
// into the store, and this does neither — it takes its own mutex and writes two
// maps. Queueing would buy nothing and cost the property that matters here,
// which is that the index is never behind the state it projects.
func (i *questionIndex) OnSessionChange(event session.SessionChangeEvent) {
	if event.Op == session.OperationDelete {
		i.forget(event.Session.ID)
		return
	}
	i.observe(event.Session.ID, event.Session.Turn.Unanswered)
}

// QuestionLocation is where a request id is waiting: the session that asked it
// and the worktree that session lives in ("" being the main one).
type QuestionLocation struct {
	SessionID string
	Worktree  string
}

// LocateQuestions finds every session and worktree a request id is still
// waiting in. It answers only for questions that are *unanswered*: one that has
// been answered, declined or withdrawn is not in the index, which is the same
// answer as one that never existed — what became of it is the transcript's to
// say (chat.Client explains it when refusing).
//
// Usually one, and more than one only after a fork (see questionIndex). Callers
// have to say what they do with several rather than be handed the first:
// question_cancel asks whether the caller is among them, question_answer
// refuses and lists them, because nothing here can know which of two sessions
// the answer was meant for.
func (m *Manager) LocateQuestions(requestID string) []QuestionLocation {
	sessionIDs := m.questions.sessionsFor(requestID)
	out := make([]QuestionLocation, 0, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		name, err := m.ResolveSessionWorktree(sessionID)
		if err != nil {
			// The index says the session has this question and the worktrees say
			// there is no such session: one of them was read mid-deletion. Left
			// out, which is what it is about to be.
			slog.Warn("a pending question names a session no worktree has",
				"requestId", requestID, "sessionId", sessionID, "error", err)
			continue
		}
		out = append(out, QuestionLocation{SessionID: sessionID, Worktree: name})
	}
	return out
}

// rebuildQuestionIndex fills the index from what is on disk, which is where a
// restart gets it from: unanswered questions are persisted with their sessions,
// and unlike a blocker none of them expired just because the server stopped.
//
// It reads each worktree's session index rather than building the worktrees
// (Manager.SessionTurns), so a project with thirty worktrees costs thirty file
// reads at startup and no watchers.
func (m *Manager) rebuildQuestionIndex() {
	total := 0
	for _, info := range m.registry.List() {
		turns, err := m.SessionTurns(info.Name)
		if err != nil {
			// One unreadable worktree must not stop the others being indexed.
			slog.Warn("could not read sessions while indexing pending questions",
				"worktree", info.Name, "error", err)
			continue
		}
		for sessionID, turn := range turns {
			if len(turn.Unanswered) == 0 {
				continue
			}
			m.questions.observe(sessionID, turn.Unanswered)
			total += len(turn.Unanswered)
		}
	}
	if total > 0 {
		slog.Info("indexed questions still waiting for an answer", "questions", total)
	}
}
