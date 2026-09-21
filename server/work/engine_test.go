package work

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// --- test doubles ---

type sentMessage struct {
	sessionID string
	subtype   string
	content   string
}

type recordingSender struct {
	mu   sync.Mutex
	sent []sentMessage
}

func (r *recordingSender) SendSystemMessage(_ context.Context, sessionID, content, subtype string, _ *agent.MessageMeta) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, sentMessage{sessionID: sessionID, subtype: subtype, content: content})
	return nil
}

func (r *recordingSender) subtypes() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.sent))
	for i, m := range r.sent {
		out[i] = m.subtype
	}
	return out
}

// contents is for the assertions about what a message *says*: the wording of
// the child-done nudge depends on whether the closure cleared the parent's wait,
// and getting that backwards is invisible in the subtype.
func (r *recordingSender) contents() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.sent))
	for i, m := range r.sent {
		out[i] = m.content
	}
	return out
}

func (r *recordingSender) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sent)
}

type terminated struct {
	worktree  string
	sessionID string
	retired   bool
}

type recordingTerminator struct {
	mu    sync.Mutex
	calls []terminated
}

func (r *recordingTerminator) StopSession(worktree, sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, terminated{worktree: worktree, sessionID: sessionID})
}

func (r *recordingTerminator) RetireSession(worktree, sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, terminated{worktree: worktree, sessionID: sessionID, retired: true})
}

func (r *recordingTerminator) snapshot() []terminated {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]terminated(nil), r.calls...)
}

// stubTurns is the session layer as the engine sees it: which sessions have
// questions nobody has answered. Locked, because the engine reads it from the
// follow-up goroutines as well as from the caller's.
type stubTurns struct {
	mu         sync.Mutex
	unanswered map[string]int
	err        error
}

func newStubTurns() *stubTurns {
	return &stubTurns{unanswered: make(map[string]int)}
}

func (s *stubTurns) SessionTurns(string) (map[string]session.TurnState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return nil, s.err
	}
	turns := make(map[string]session.TurnState, len(s.unanswered))
	for sessionID, n := range s.unanswered {
		questions := make([]session.PendingQuestion, n)
		for i := range questions {
			questions[i] = session.PendingQuestion{RequestID: sessionID + "-q"}
		}
		turns[sessionID] = session.TurnState{Phase: session.PhaseIdle, Unanswered: questions}
	}
	return turns, nil
}

// post makes sessionID look like one whose agent asked the user something and
// carried on.
func (s *stubTurns) post(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unanswered[sessionID]++
}

func (s *stubTurns) answer(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.unanswered, sessionID)
}

type fixedSteps []string

func (f fixedSteps) GetSteps(string) ([]string, error) { return f, nil }

// engineFixture is a store, an engine wired to it, and the two things the engine
// talks to.
type engineFixture struct {
	store      *FileStore
	engine     *Engine
	sender     *recordingSender
	terminator *recordingTerminator
	turns      *stubTurns
}

func newEngineFixture(t *testing.T) *engineFixture {
	t.Helper()

	f := newRecoveryFixture(t)
	f.store.AddOnChangeListener(f.engine)
	return f
}

// newRecoveryFixture is the fixture without the change listener, which is the
// state production is in while RecoverStartup runs (see main.go). A startup test
// that listened would be testing the running server's rules instead: the stops
// recovery makes would come back as events and *wake* the parents that recovery
// is supposed to stop.
func newRecoveryFixture(t *testing.T) *engineFixture {
	t.Helper()

	store := newTestStore(t)
	engine := NewEngine(store, DefaultMaxNudges)
	sender := &recordingSender{}
	terminator := &recordingTerminator{}
	turns := newStubTurns()
	engine.SetSender(sender)
	engine.SetSessionTerminator(terminator)
	engine.SetTurnSource(turns)
	t.Cleanup(engine.Stop)

	return &engineFixture{store: store, engine: engine, sender: sender, terminator: terminator, turns: turns}
}

// startedStory creates a story, starts it on a known session and returns it.
func (f *engineFixture) startedStory(t *testing.T, sessionID string) Work {
	t.Helper()
	story := createStory(t, f.store, "S")
	startWorkWithSession(t, f.store, story.ID, sessionID)
	return getWork(t, f.store, story.ID)
}

func (f *engineFixture) commentBodies(t *testing.T, workID string) []string {
	t.Helper()
	comments, err := f.store.ListComments(workID)
	if err != nil {
		t.Fatalf("ListComments: %v", err)
	}
	bodies := make([]string, len(comments))
	for i, c := range comments {
		bodies[i] = c.Body
	}
	return bodies
}

// --- input 1: a turn ended ---

func TestEngine_NudgesAWorkThatStoppedWithoutSayingWhy(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")

	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	if got := f.sender.subtypes(); len(got) != 1 || got[0] != MessageSubtypeAutoContinue {
		t.Fatalf("sent %v, want one auto-continuation", got)
	}
	if got := getWork(t, f.store, story.ID); got.NudgeCount != 1 || got.Status != StatusActive {
		t.Errorf("status/nudges = %q/%d, want active/1", got.Status, got.NudgeCount)
	}
}

// A failed turn is nudged like a completed one: an agent whose turn errored has
// usually lost a tool call, not the thread, and the limit bounds being wrong.
func TestEngine_NudgesAFailedTurnToo(t *testing.T) {
	f := newEngineFixture(t)
	f.startedStory(t, "sess-1")

	f.engine.HandleTurnEnded("sess-1", session.OutcomeFailed)

	if f.sender.count() != 1 {
		t.Errorf("sent %d messages, want one auto-continuation", f.sender.count())
	}
}

func TestEngine_StopsAWorkAfterTheNudgeLimit(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")

	for range DefaultMaxNudges {
		f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)
	}
	if f.sender.count() != DefaultMaxNudges {
		t.Fatalf("sent %d nudges, want %d", f.sender.count(), DefaultMaxNudges)
	}
	if got := getWork(t, f.store, story.ID); got.Status != StatusActive {
		t.Fatalf("status = %q after %d nudges, want it still driven", got.Status, DefaultMaxNudges)
	}

	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	if got := getWork(t, f.store, story.ID); got.Status != StatusStopped {
		t.Errorf("status = %q, want %q once the allowance is spent", got.Status, StatusStopped)
	}
	if f.sender.count() != DefaultMaxNudges {
		t.Errorf("sent %d nudges, want no more than %d", f.sender.count(), DefaultMaxNudges)
	}
	// The stop has to say who stopped it: the agent reported nothing and the
	// user did nothing, so without a comment the work is simply found stopped.
	bodies := f.commentBodies(t, story.ID)
	if len(bodies) != 1 || !strings.Contains(bodies[0], "too many times in a row") {
		t.Errorf("comments = %v, want one explaining the nudge limit", bodies)
	}
}

// An aborted turn was taken away rather than finished — by a user interrupt, or
// by the death of the process carrying it. Carrying on is the one thing nobody
// asked for.
func TestEngine_StopsAWorkWhoseTurnWasAborted(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")

	f.engine.HandleTurnEnded("sess-1", session.OutcomeAborted)

	if got := getWork(t, f.store, story.ID); got.Status != StatusStopped {
		t.Errorf("status = %q, want %q", got.Status, StatusStopped)
	}
	if f.sender.count() != 0 {
		t.Errorf("sent %d messages, want none — an abort is the instruction not to carry on", f.sender.count())
	}
	// No comment: the user pressed Stop, or interrupted. They know.
	if bodies := f.commentBodies(t, story.ID); len(bodies) != 0 {
		t.Errorf("comments = %v, want none for a stop the user performed", bodies)
	}
}

func TestEngine_LeavesAWaitingWorkAloneWhenItsTurnEnds(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	waitOnChild(t, f.store, story.ID)

	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	if f.sender.count() != 0 {
		t.Errorf("nudged a work that said what it is waiting for (%d messages)", f.sender.count())
	}
	if got := getWork(t, f.store, story.ID); got.Wait != WaitChild || got.NudgeCount != 0 {
		t.Errorf("wait/nudges = %q/%d, want child/0", got.Wait, got.NudgeCount)
	}
}

// The second reason an ending is not an accident, and the one that is not on the
// work at all: the agent asked the user something and stopped. Nobody is nudged
// and no allowance is spent, because the answer is what carries on from here.
func TestEngine_LeavesAWorkWithUnansweredQuestionsAloneWhenItsTurnEnds(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	f.turns.post("sess-1")

	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	if f.sender.count() != 0 {
		t.Errorf("nudged a work whose agent is waiting for an answer (%d messages)", f.sender.count())
	}
	got := getWork(t, f.store, story.ID)
	if got.Status != StatusActive || got.Wait != WaitNone || got.NudgeCount != 0 {
		t.Errorf("work = %q/%q/%d, want active, no wait, no nudge spent",
			got.Status, got.Wait, got.NudgeCount)
	}
}

// The moment the last question is resolved the work is back to an ordinary one,
// and an ending of it is back to being an accident. Nothing has to be told: the
// engine reads the list when it needs the answer, so it cannot be stale.
func TestEngine_NudgesOnceTheQuestionsAreAnswered(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	f.turns.post("sess-1")
	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	f.turns.answer("sess-1")
	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	if got := f.sender.subtypes(); len(got) != 1 || got[0] != MessageSubtypeAutoContinue {
		t.Errorf("messages = %v, want one nudge", got)
	}
	if got := getWork(t, f.store, story.ID); got.NudgeCount != 1 {
		t.Errorf("nudges = %d, want 1 — only the second ending spent one", got.NudgeCount)
	}
}

// Not knowing must not be read as "no questions": a nudge that should not have
// been sent spends the allowance that ends in a stop.
func TestEngine_DoesNotNudgeWhenTheSessionLayerCannotBeRead(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	f.turns.err = errors.New("index is not json")

	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	if f.sender.count() != 0 {
		t.Errorf("nudged on an unreadable session (%d messages)", f.sender.count())
	}
	if got := getWork(t, f.store, story.ID); got.NudgeCount != 0 {
		t.Errorf("nudges = %d, want none spent on a guess", got.NudgeCount)
	}
}

// Every input starts from "is the engine driving this work". A stopped or closed
// work is one it must not move.
func TestEngine_IgnoresATurnEndingOnAWorkItDoesNotDrive(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	if err := f.store.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	if f.sender.count() != 0 {
		t.Errorf("nudged a stopped work (%d messages)", f.sender.count())
	}
}

// --- input 2: the user handed the session something to go on ---

func TestEngine_AUserMessageClearsTheWaitAndTheNudges(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	waitOnChild(t, f.store, story.ID)
	if _, err := f.store.RecordNudge(context.Background(), story.ID); err != nil {
		t.Fatalf("RecordNudge: %v", err)
	}

	f.engine.HandleUserMessage("sess-1")

	got := getWork(t, f.store, story.ID)
	if got.Status != StatusActive || got.Wait != WaitNone || got.NudgeCount != 0 {
		t.Errorf("work = %q/%q/%d, want active with nothing left over",
			got.Status, got.Wait, got.NudgeCount)
	}
}

// --- input 3: the questions the agent asked were answered ---

// An answer is not general-purpose attention: it answers the one thing the agent
// asked, and a story waiting for its subtasks is still waiting for exactly that.
// Clearing the wait would resume a story with nothing to do, then nudge it for
// having nothing to do.
func TestEngine_AnAnswerClearsTheNudgesButNotTheChildWait(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	waitOnChild(t, f.store, story.ID)
	if _, err := f.store.RecordNudge(context.Background(), story.ID); err != nil {
		t.Fatalf("RecordNudge: %v", err)
	}

	f.engine.HandleAnswer("sess-1")

	got := getWork(t, f.store, story.ID)
	if got.Wait != WaitChild {
		t.Errorf("wait = %q, want it still waiting on its subtasks — no subtask closed", got.Wait)
	}
	if got.NudgeCount != 0 {
		t.Errorf("nudges = %d, want the allowance back: the agent was handed what it asked for", got.NudgeCount)
	}
}

// A stopped work is woken by an answer as by any message, whoever gave it: the
// answer starts a turn in that session either way, and a work whose session is
// running has to be active for the engine to drive it and to see the turn out.
// The narrowing above is about the wait, not about the status.
func TestEngine_AnAnswerRevivesAStoppedWork(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	if err := f.store.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	f.engine.HandleAnswer("sess-1")

	if got := getWork(t, f.store, story.ID); got.Status != StatusActive {
		t.Errorf("status = %q, want %q", got.Status, StatusActive)
	}
}

// A closed work is not woken by anything but work_reopen, answer or not.
func TestEngine_AnAnswerLeavesAClosedWorkClosed(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	if _, err := f.store.StepDone(context.Background(), story.ID, 0); err != nil {
		t.Fatalf("StepDone: %v", err)
	}

	f.engine.HandleAnswer("sess-1")

	if got := getWork(t, f.store, story.ID); got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestEngine_AUserMessageRevivesAStoppedWork(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	if err := f.store.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	f.engine.HandleUserMessage("sess-1")

	if got := getWork(t, f.store, story.ID); got.Status != StatusActive {
		t.Errorf("status = %q, want %q — the user is talking to it again", got.Status, StatusActive)
	}
}

// A closed work is outside the agent lifecycle; only Reopen brings it back, and
// a message into its old transcript is not that.
func TestEngine_AUserMessageDoesNotReopenAClosedWork(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")
	if _, err := f.store.StepDone(context.Background(), story.ID, 0); err != nil {
		t.Fatalf("StepDone: %v", err)
	}

	f.engine.HandleUserMessage("sess-1")

	if got := getWork(t, f.store, story.ID); got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

// --- input 3: a child closed ---

func TestEngine_ChildClosureWakesAParentWaitingOnIt(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "T")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	setChildWait(t, f.store, story.ID)

	if _, err := f.store.StepDone(context.Background(), task.ID, 0); err != nil {
		t.Fatalf("StepDone on the child: %v", err)
	}

	waitFor(t, func() bool { return f.sender.count() > 0 })
	if got := f.sender.subtypes(); len(got) != 1 || got[0] != MessageSubtypeChildDone {
		t.Fatalf("sent %v, want one child-done message", got)
	}
	got := getWork(t, f.store, story.ID)
	if got.Wait != WaitNone || got.Status != StatusActive {
		t.Errorf("parent = %q/%q, want active with its wait cleared", got.Status, got.Wait)
	}
	// The parent has to be told, or a story with a second task still running has
	// no reason to ask for the wait again and is nudged for going quiet.
	if !strings.Contains(f.sender.contents()[0], "This message cleared your wait") {
		t.Error("the parent was not told its wait is gone")
	}
}

// A parent that declared no wait is told its child closed and told that nothing
// was cleared — it was not waiting, so there is nothing to ask for again.
func TestEngine_ChildClosureTellsAParentThatWasNotWaiting(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "T")
	startWorkWithSession(t, f.store, task.ID, "sess-child")

	if _, err := f.store.StepDone(context.Background(), task.ID, 0); err != nil {
		t.Fatalf("StepDone on the child: %v", err)
	}

	waitFor(t, func() bool { return f.sender.count() > 0 })
	if strings.Contains(f.sender.contents()[0], "cleared your wait") {
		t.Error("a parent that was not waiting was told its wait was cleared")
	}
}

// --- input 3, the other half: a child left active without closing ---

// A `child` wait is ended by a subtask closing and by nothing else, so a subtask
// that leaves active without closing can strand it. The engine clears the wait
// and tells the agent rather than deciding for it: only the agent knows whether
// the subtask should be restarted, replaced, or was never needed — and once the
// wait is gone the ordinary nudge allowance is the backstop.
func TestEngine_ClearsAWaitNothingCouldEnd(t *testing.T) {
	cases := []struct {
		name string
		// leave takes the last subtask out of active without closing it.
		leave func(t *testing.T, f *engineFixture, childID string)
		// The ways back differ, so the message has to differ: a stopped subtask
		// is restarted by ID, a deleted one no longer has an ID to restart.
		wants   []string
		unwants []string
	}{
		{
			name: "stopped",
			leave: func(t *testing.T, f *engineFixture, childID string) {
				if err := f.store.Stop(context.Background(), childID); err != nil {
					t.Fatalf("Stop the child: %v", err)
				}
			},
			wants:   []string{"was stopped instead of closing", "restart it with work_start"},
			unwants: []string{"was deleted"},
		},
		{
			name: "deleted",
			leave: func(t *testing.T, f *engineFixture, childID string) {
				if err := f.store.Delete(context.Background(), childID); err != nil {
					t.Fatalf("Delete the child: %v", err)
				}
			},
			wants:   []string{"was deleted", "create a replacement with work_create"},
			unwants: []string{"work_start using ID"},
		},
		{
			// A fresh start that failed puts the subtask back to `open`. It is
			// startable by id like a stopped one, but it was never running, so
			// "restart" would be describing something that did not happen.
			name: "rolled back to open",
			leave: func(t *testing.T, f *engineFixture, childID string) {
				if err := f.store.RollbackStart(context.Background(), childID, "sess-child", false); err != nil {
					t.Fatalf("RollbackStart the child: %v", err)
				}
			},
			wants:   []string{"is not running", "start it with work_start"},
			unwants: []string{"was deleted", "restart it"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newEngineFixture(t)
			story := f.startedStory(t, "sess-parent")
			task := createTask(t, f.store, story.ID, "T")
			startWorkWithSession(t, f.store, task.ID, "sess-child")
			setChildWait(t, f.store, story.ID)

			tc.leave(t, f, task.ID)

			waitFor(t, func() bool { return f.sender.count() > 0 })
			if got := f.sender.subtypes(); len(got) != 1 || got[0] != MessageSubtypeWaitStranded {
				t.Fatalf("sent %v, want one stranded-wait message", got)
			}
			got := getWork(t, f.store, story.ID)
			if got.Status != StatusActive || got.Wait != WaitNone {
				t.Errorf("parent = %q/%q, want active with its wait cleared", got.Status, got.Wait)
			}
			content := f.sender.contents()[0]
			for _, want := range append(tc.wants, "None of your tasks is running now") {
				if !strings.Contains(content, want) {
					t.Errorf("message does not mention %q", want)
				}
			}
			for _, unwanted := range tc.unwants {
				if strings.Contains(content, unwanted) {
					t.Errorf("message mentions %q, which is the other kind of disappearance", unwanted)
				}
			}
		})
	}
}

// Only the *last* one strands the wait. A subtask stopping while another still
// runs is ordinary, and the wait still has something that can end it properly.
func TestEngine_LeavesAWaitAloneWhileAnotherSubtaskRuns(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	stopped := createTask(t, f.store, story.ID, "T1")
	startWorkWithSession(t, f.store, stopped.ID, "sess-child-1")
	running := createTask(t, f.store, story.ID, "T2")
	startWorkWithSession(t, f.store, running.ID, "sess-child-2")
	setChildWait(t, f.store, story.ID)

	if err := f.store.Stop(context.Background(), stopped.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	// Asserted through a second change that *does* strand it: waiting on the
	// absence of a message would pass just as well if the engine were broken.
	if err := f.store.Stop(context.Background(), running.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	waitFor(t, func() bool { return f.sender.count() > 0 })
	if got := f.sender.count(); got != 1 {
		t.Errorf("sent %d messages, want only the one for the last subtask", got)
	}
}

// lostTheRace answers every stranded-wait clear with "somebody else ended this
// wait". That is the interleaving two subtasks leaving active at once produce —
// both follow-ups read a parent that is still waiting, and only one of them can
// be the caller that clears it — and real goroutines cannot be made to reproduce
// it on demand, which is why the store's answer is a test double here.
type lostTheRace struct{ *FileStore }

func (lostTheRace) ClearChildWaitIfStranded(context.Context, string) (bool, error) {
	return false, nil
}

// The store's answer is the whole permission to speak: a follow-up that did not
// end the wait has no news, and sending anyway is how one story gets told twice
// that its subtasks stopped.
func TestEngine_OnlyTheCallerThatClearedTheWaitSends(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "T")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	setChildWait(t, f.store, story.ID)
	loser := NewEngine(lostTheRace{f.store}, DefaultMaxNudges)
	loser.SetSender(f.sender)
	t.Cleanup(loser.Stop)

	loser.OnWorkChange(ChangeEvent{Op: OperationUpdate, Work: Work{
		ID: task.ID, ParentID: story.ID, Status: StatusStopped, Title: "T",
	}})

	loser.Stop() // Waits for the follow-up rather than for a message never sent.
	if got := f.sender.count(); got != 0 {
		t.Errorf("sent %d messages, want none: this caller did not end the wait", got)
	}
}

// A parent that declared no wait has not been stranded by anything: nothing was
// waiting, so nothing needs rescuing and nothing needs saying.
func TestEngine_LeavesAParentNotWaitingOnChildrenAlone(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "T")
	startWorkWithSession(t, f.store, task.ID, "sess-child")

	if err := f.store.Stop(context.Background(), task.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	waitFor(t, func() bool { return len(f.terminator.snapshot()) > 0 })
	if got := f.sender.count(); got != 0 {
		t.Errorf("sent %d messages, want none", got)
	}
	if got := getWork(t, f.store, story.ID); got.Wait != WaitNone {
		t.Errorf("parent wait = %q, want it left with none", got.Wait)
	}
}

// Deleting a story emits a delete for every task under it, so the parent lookup
// runs against a store the parent has already left. It must not panic, message
// anybody, or resurrect anything.
func TestEngine_DeletingAWholeStoryStrandsNobody(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "T")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	setChildWait(t, f.store, story.ID)

	if err := f.store.Delete(context.Background(), story.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	f.engine.Stop() // Waits for the follow-ups the deletes spawned.
	if got := f.sender.count(); got != 0 {
		t.Errorf("sent %d messages, want none — there is no parent left to tell", got)
	}
}

// --- a parent the engine cannot reach ---

// failingResolver is a worktree whose sender cannot be had — the shape of a
// worktree that will not load, or of an engine asked for one before the resolver
// is installed.
type failingResolver struct{}

func (failingResolver) ResolveSender(string) (MessageSender, func(), error) {
	return nil, nil, errors.New("worktree unavailable")
}

// The news is lost either way; what must not be lost is the parent. A wait left
// standing here would be waiting for a subtask that is already gone, and nothing
// would ever come back to it.
func TestEngine_StopsAWaitingParentItCannotReach(t *testing.T) {
	// The comment differs with the news, and that is the point of asserting on
	// it: telling an agent its subtask *finished* in words that say its subtasks
	// went wrong sends the user hunting for a problem that is not there.
	tests := []struct {
		name  string
		leave func(*testing.T, *engineFixture, string)
		says  string
	}{
		{"the last subtask stopped", func(t *testing.T, f *engineFixture, id string) {
			if err := f.store.Stop(context.Background(), id); err != nil {
				t.Fatalf("Stop: %v", err)
			}
		}, "none of them is running any more"},
		{"the last subtask closed", func(t *testing.T, f *engineFixture, id string) {
			if _, err := f.store.StepDone(context.Background(), id, 0); err != nil {
				t.Fatalf("StepDone: %v", err)
			}
		}, "a subtask of this work finished"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newEngineFixture(t)
			f.engine.SetSenderResolver(failingResolver{})
			story := f.startedStory(t, "sess-parent")
			task := createTask(t, f.store, story.ID, "T")
			startWorkWithSession(t, f.store, task.ID, "sess-child")
			setChildWait(t, f.store, story.ID)

			tt.leave(t, f, task.ID)

			waitFor(t, func() bool { return len(f.commentBodies(t, story.ID)) > 0 })
			got := getWork(t, f.store, story.ID)
			if got.Status != StatusStopped || got.Wait != WaitNone {
				t.Errorf("parent = %q + wait %q, want %q with no wait", got.Status, got.Wait, StatusStopped)
			}
			bodies := f.commentBodies(t, story.ID)
			if len(bodies) != 1 || !strings.Contains(bodies[0], "could not reach") {
				t.Fatalf("comments = %v, want one saying the agent could not be reached", bodies)
			}
			if !strings.Contains(bodies[0], tt.says) {
				t.Errorf("comment = %q, want it to say %q — it describes the wrong news otherwise",
					bodies[0], tt.says)
			}
		})
	}
}

// The other half of the same rule: an unreachable parent that still has a
// subtask running is left waiting. Its wait is not stranded, and that subtask's
// own exit brings the engine back here — stopping now would take a recovery
// away rather than offer one.
func TestEngine_LeavesAnUnreachableParentThatStillHasASubtask(t *testing.T) {
	f := newEngineFixture(t)
	f.engine.SetSenderResolver(failingResolver{})
	story := f.startedStory(t, "sess-parent")
	stopping := createTask(t, f.store, story.ID, "T1")
	startWorkWithSession(t, f.store, stopping.ID, "sess-1")
	running := createTask(t, f.store, story.ID, "T2")
	startWorkWithSession(t, f.store, running.ID, "sess-2")
	setChildWait(t, f.store, story.ID)

	if err := f.store.Stop(context.Background(), stopping.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	f.engine.Stop() // Waits for the follow-up the stop spawned.
	got := getWork(t, f.store, story.ID)
	if got.Status != StatusActive || got.Wait != WaitChild {
		t.Errorf("parent = %q + wait %q, want it still waiting on %q", got.Status, got.Wait, running.Title)
	}
	if bodies := f.commentBodies(t, story.ID); len(bodies) != 0 {
		t.Errorf("comments = %v, want none — nothing has happened to this parent yet", bodies)
	}
}

// failingSender resolves — the worktree is there — and then fails to deliver.
// That is a different dead end from failingResolver: the wait has already been
// cleared by the time the send is attempted, so the parent is left waiting for
// nothing with nobody told.
type failingSender struct{}

func (failingSender) SendSystemMessage(context.Context, string, string, string, *agent.MessageMeta) error {
	return errors.New("session unreachable")
}

// The branch that fires after the wait is gone. It is the one case where another
// subtask may still be running, and the comment must not claim otherwise — a
// user sent to look for subtasks that "were not left running" would find one.
func TestEngine_StopsAParentWhoseChildReportCouldNotBeSent(t *testing.T) {
	f := newEngineFixture(t)
	f.engine.SetSender(failingSender{})
	story := f.startedStory(t, "sess-parent")
	closing := createTask(t, f.store, story.ID, "T1")
	startWorkWithSession(t, f.store, closing.ID, "sess-1")
	running := createTask(t, f.store, story.ID, "T2")
	startWorkWithSession(t, f.store, running.ID, "sess-2")
	setChildWait(t, f.store, story.ID)

	if _, err := f.store.StepDone(context.Background(), closing.ID, 0); err != nil {
		t.Fatalf("StepDone: %v", err)
	}

	waitFor(t, func() bool { return len(f.commentBodies(t, story.ID)) > 0 })
	got := getWork(t, f.store, story.ID)
	if got.Status != StatusStopped || got.Wait != WaitNone {
		t.Errorf("parent = %q + wait %q, want %q with no wait — its wait was cleared and the news never landed",
			got.Status, got.Wait, StatusStopped)
	}
	bodies := f.commentBodies(t, story.ID)
	if len(bodies) != 1 || !strings.Contains(bodies[0], "could not reach") {
		t.Fatalf("comments = %v, want one saying the agent could not be reached", bodies)
	}
	if strings.Contains(bodies[0], "no other subtask") {
		t.Errorf("comment = %q, but %q is still active — it must not claim otherwise", bodies[0], running.Title)
	}
	if got := getWork(t, f.store, running.ID); got.Status != StatusActive {
		t.Errorf("%q = %q, want it left alone — stopping a parent does not stop its subtasks",
			running.Title, got.Status)
	}
}

// The same dead end on the other message: the wait was cleared because nothing
// could end it, and the agent could not be told.
func TestEngine_StopsAParentWhoseStrandedWaitNewsCouldNotBeSent(t *testing.T) {
	f := newEngineFixture(t)
	f.engine.SetSender(failingSender{})
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "T")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	setChildWait(t, f.store, story.ID)

	if err := f.store.Stop(context.Background(), task.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	waitFor(t, func() bool { return len(f.commentBodies(t, story.ID)) > 0 })
	got := getWork(t, f.store, story.ID)
	if got.Status != StatusStopped || got.Wait != WaitNone {
		t.Errorf("parent = %q + wait %q, want %q with no wait", got.Status, got.Wait, StatusStopped)
	}
	if bodies := f.commentBodies(t, story.ID); !strings.Contains(bodies[0], "none of them is running any more") {
		t.Errorf("comment = %q, want the wording for a wait nothing could end", bodies[0])
	}
}

// --- input 4: the session was deleted ---

func TestEngine_StopsAWorkWhoseSessionWasDeleted(t *testing.T) {
	for _, wait := range []WorkWait{WaitNone, WaitChild} {
		t.Run(string("wait="+wait), func(t *testing.T) {
			f := newEngineFixture(t)
			story := f.startedStory(t, "sess-1")
			if wait == WaitChild {
				task := createTask(t, f.store, story.ID, "T")
				startWorkWithSession(t, f.store, task.ID, "sess-child")
				setChildWait(t, f.store, story.ID)
			}
			// And a question outstanding, which is the other reason an ending is
			// left alone — a deleted session takes away the place its answer
			// would have arrived.
			f.turns.post("sess-1")

			f.engine.OnSessionChange(session.SessionChangeEvent{
				Op:      session.OperationDelete,
				Session: session.SessionMeta{ID: "sess-1"},
			})

			// Waited on the comment, not on the status: the stop lands first and
			// the explanation a moment later, so the status is the weaker of the
			// two conditions and waiting on it would race the write it precedes.
			waitFor(t, func() bool { return len(f.commentBodies(t, story.ID)) > 0 })

			if got := getWork(t, f.store, story.ID); got.Status != StatusStopped {
				t.Errorf("status = %q, want %q", got.Status, StatusStopped)
			}
			bodies := f.commentBodies(t, story.ID)
			if len(bodies) != 1 || !strings.Contains(bodies[0], "chat session was deleted") {
				t.Errorf("comments = %v, want one naming the deleted session", bodies)
			}
		})
	}
}

// --- input 5: startup ---

func TestEngine_RecoverStartup(t *testing.T) {
	f := newRecoveryFixture(t)

	driven := f.startedStory(t, "sess-driven")

	askedTheUser := createStory(t, f.store, "asking the user something")
	startWorkWithSession(t, f.store, askedTheUser.ID, "sess-asked")
	f.turns.post("sess-asked")

	// A `child` wait only survives a restart if a child does, and the only child
	// that survives one is a child that is itself waiting.
	waitingOnChild := createStory(t, f.store, "waiting on its children")
	startWorkWithSession(t, f.store, waitingOnChild.ID, "sess-child")
	survivingChild := createTask(t, f.store, waitingOnChild.ID, "asking the user something too")
	startWorkWithSession(t, f.store, survivingChild.ID, "sess-grandchild")
	f.turns.post("sess-grandchild")
	setChildWait(t, f.store, waitingOnChild.ID)

	f.engine.RecoverStartup(f.turns)

	// The one nothing will wake: no process survives a restart, so the turn it
	// was carrying is never going to end.
	if got := getWork(t, f.store, driven.ID); got.Status != StatusStopped {
		t.Errorf("a work being carried by a dead process = %q, want %q", got.Status, StatusStopped)
	}
	bodies := f.commentBodies(t, driven.ID)
	if len(bodies) != 1 || !strings.Contains(bodies[0], "server restarted") {
		t.Errorf("comments = %v, want one explaining the restart", bodies)
	}

	// The two whose wake-up call comes from outside the session, and therefore
	// survives the restart along with them.
	for _, kept := range []Work{askedTheUser, waitingOnChild, survivingChild} {
		if got := getWork(t, f.store, kept.ID); got.Status != StatusActive {
			t.Errorf("%q = %q, want it left active — what it waits for outlives the process",
				kept.Title, got.Status)
		}
		if bodies := f.commentBodies(t, kept.ID); len(bodies) != 0 {
			t.Errorf("%q got comments %v, want none — nothing happened to it", kept.Title, bodies)
		}
	}
}

// The failure this whole second pass exists for. Startup stops the last running
// subtask, which empties its parent's wait — and the stop reaches no listener,
// because the engine is not one yet. Without a re-examination the parent sits
// active, waiting on children, with no child that could ever close: no nudge
// (it declares a wait), no process (it died with the last run), and no attention
// dot (`waiting_children` is outside it). It is invisible and permanent.
func TestEngine_RecoverStartupStopsAWaitItsOwnStopsStranded(t *testing.T) {
	f := newRecoveryFixture(t)

	story := f.startedStory(t, "sess-story")
	task := createTask(t, f.store, story.ID, "the last subtask")
	startWorkWithSession(t, f.store, task.ID, "sess-task")
	setChildWait(t, f.store, story.ID)

	f.engine.RecoverStartup(f.turns)

	if got := getWork(t, f.store, task.ID); got.Status != StatusStopped {
		t.Fatalf("the subtask = %q, want %q", got.Status, StatusStopped)
	}
	got := getWork(t, f.store, story.ID)
	if got.Status != StatusStopped {
		t.Errorf("the story = %q + wait %q, want %q — nothing was left that could end its wait",
			got.Status, got.Wait, StatusStopped)
	}
	if got.Wait != WaitNone {
		t.Errorf("the story kept wait %q, want it cleared by the stop", got.Wait)
	}
	bodies := f.commentBodies(t, story.ID)
	if len(bodies) != 1 || !strings.Contains(bodies[0], "no agent process survives a server restart") {
		t.Errorf("comments = %v, want one saying its subtasks did not survive the restart", bodies)
	}
}

// A story whose `child` wait is stranded is stopped even though it also has a
// question outstanding, and that is the rule rather than a gap in it: nothing is
// left that could end the wait, the engine never nudges a waiting work, and an
// answer clears the nudge count rather than the wait. Stopping is what makes it
// findable — and the question survives the stop, so answering it still wakes the
// work.
func TestEngine_RecoverStartupStopsAStrandedWaitEvenWithQuestionsOutstanding(t *testing.T) {
	f := newRecoveryFixture(t)

	story := f.startedStory(t, "sess-story")
	task := createTask(t, f.store, story.ID, "the last subtask")
	startWorkWithSession(t, f.store, task.ID, "sess-task")
	setChildWait(t, f.store, story.ID)
	f.turns.post("sess-story")

	f.engine.RecoverStartup(f.turns)

	got := getWork(t, f.store, story.ID)
	if got.Status != StatusStopped || got.Wait != WaitNone {
		t.Errorf("story = %q/%q, want stopped with its wait cleared", got.Status, got.Wait)
	}
}

// No work type is both a child and a parent — the hierarchy is exactly two
// levels — and that is what lets recoverStrandedWaits make a single pass.
//
// A `child` wait only comes from SetChildWait, which requires an active child,
// so only a type that can have children can hold one; if that type can never
// itself be a child, nothing sits above a work the pass stops, and no stop in
// the pass can strand another wait. Give the hierarchy a third level and this
// fails — which is the moment that pass has to become a loop to a fixed point,
// because stopping a middle work would strand the one above it with no listener
// attached to notice.
func TestOnlyTopLevelWorkCanHaveChildren(t *testing.T) {
	for childType, parents := range validParents {
		for _, parentType := range parents {
			if len(validParents[parentType]) > 0 {
				t.Errorf("%s may be a child of %s, which may itself be a child: "+
					"recoverStrandedWaits needs to loop to a fixed point now", childType, parentType)
			}
		}
	}
}

// --- the session lease ---

// A work leaving active is what takes its session's lease away, and it holds for
// every way of leaving: the rule is hung on the transition, not on the command.
func TestEngine_TerminatesTheSessionOfWorkThatLeftActive(t *testing.T) {
	tests := []struct {
		name       string
		leave      func(*testing.T, *engineFixture, string)
		wantRetire bool
	}{
		{"stopped by the user", func(t *testing.T, f *engineFixture, id string) {
			if err := f.store.Stop(context.Background(), id); err != nil {
				t.Fatalf("Stop: %v", err)
			}
		}, false},
		{"stopped by the engine", func(t *testing.T, f *engineFixture, _ string) {
			f.engine.HandleTurnEnded("sess-1", session.OutcomeAborted)
		}, false},
		{"closed", func(t *testing.T, f *engineFixture, id string) {
			if _, err := f.store.StepDone(context.Background(), id, 0); err != nil {
				t.Fatalf("StepDone: %v", err)
			}
		}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newEngineFixture(t)
			story := f.startedStory(t, "sess-1")

			tt.leave(t, f, story.ID)

			calls := f.terminator.snapshot()
			if len(calls) != 1 {
				t.Fatalf("terminator calls = %+v, want exactly one", calls)
			}
			if calls[0].sessionID != "sess-1" || calls[0].retired != tt.wantRetire {
				t.Errorf("call = %+v, want sess-1 with retired=%v", calls[0], tt.wantRetire)
			}
		})
	}
}

func TestEngine_LeavesTheSessionOfAWorkStillBeingDriven(t *testing.T) {
	f := newEngineFixture(t)
	f.startedStory(t, "sess-1")

	f.turns.post("sess-1")
	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

	if calls := f.terminator.snapshot(); len(calls) != 0 {
		t.Errorf("terminator calls = %+v, want none — the work is still active", calls)
	}
}

// --- the command path's follow-ups ---

func TestEngine_StepAdvanceAndReopenMessages(t *testing.T) {
	f := newEngineFixture(t)
	f.engine.SetStepProvider(fixedSteps{"first", "second"})
	ops := NewOperations(f.store, nil, f.engine, fixedSteps{"first", "second"})
	story := f.startedStory(t, "sess-1")

	hasMore, totalSteps, err := ops.StepDone(context.Background(), story.ID)
	if err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if !hasMore || totalSteps != 2 {
		t.Fatalf("hasMoreSteps/totalSteps = %v/%d, want true/2", hasMore, totalSteps)
	}
	waitFor(t, func() bool { return f.sender.count() > 0 })
	if got := f.sender.subtypes(); got[0] != MessageSubtypeStepAdvance {
		t.Errorf("subtype = %q, want %q", got[0], MessageSubtypeStepAdvance)
	}

	if _, _, err := ops.StepDone(context.Background(), story.ID); err != nil {
		t.Fatalf("final StepDone: %v", err)
	}
	if err := ops.ReopenWork(context.Background(), story.ID); err != nil {
		t.Fatalf("ReopenWork: %v", err)
	}
	waitFor(t, func() bool { return f.sender.count() > 1 })
	if got := f.sender.subtypes(); got[len(got)-1] != MessageSubtypeReopen {
		t.Errorf("subtypes = %v, want the last to be %q", got, MessageSubtypeReopen)
	}
}

// A step advance is progress, so the nudges collected before it are no longer
// evidence that the agent is stuck.
func TestEngine_AStepAdvanceStartsTheNudgeAllowanceOver(t *testing.T) {
	f := newEngineFixture(t)
	f.engine.SetStepProvider(fixedSteps{"first", "second"})
	ops := NewOperations(f.store, nil, f.engine, fixedSteps{"first", "second"})
	story := f.startedStory(t, "sess-1")

	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)
	if got := getWork(t, f.store, story.ID); got.NudgeCount != 1 {
		t.Fatalf("nudges = %d, want 1", got.NudgeCount)
	}

	if _, _, err := ops.StepDone(context.Background(), story.ID); err != nil {
		t.Fatalf("StepDone: %v", err)
	}

	if got := getWork(t, f.store, story.ID); got.NudgeCount != 0 {
		t.Errorf("nudges = %d after a step advance, want the allowance back", got.NudgeCount)
	}
}

// Stop's promise is that a stopped engine writes nothing more. The inputs it
// answers on the caller's own goroutine — a settled turn ending above all,
// which arrives on a timer nobody else is holding open — have to be inside that
// promise, or the promise is about the follow-up goroutines alone.
func TestEngine_StopRefusesFurtherInputs(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-1")

	f.engine.Stop()

	f.engine.HandleTurnEnded("sess-1", session.OutcomeAborted)
	f.engine.HandleUserMessage("sess-1")

	if got := getWork(t, f.store, story.ID); got.Status != StatusActive {
		t.Errorf("status = %q, want it untouched by a stopped engine", got.Status)
	}
	if f.sender.count() != 0 {
		t.Errorf("a stopped engine sent %d messages", f.sender.count())
	}
}

// A message is not a note left on a desk: it starts a turn, and on a session
// whose process has been collected it builds a new one. Telling a stopped parent
// would put a CLI to work on a story a person has taken back.
func TestEngine_ChildClosureLeavesAStoppedParentAlone(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "T")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	if err := f.store.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	if _, err := f.store.StepDone(context.Background(), task.ID, 0); err != nil {
		t.Fatalf("StepDone on the child: %v", err)
	}

	// The child's own close is what the engine acts on, so waiting for the task
	// to be closed is waiting for the decision this test is about.
	waitFor(t, func() bool { return getWork(t, f.store, task.ID).Status == StatusClosed })
	if f.sender.count() != 0 {
		t.Errorf("sent %v to a stopped parent", f.sender.subtypes())
	}
	if got := getWork(t, f.store, story.ID); got.Status != StatusStopped {
		t.Errorf("parent = %q, want it left %q", got.Status, StatusStopped)
	}
}

// --- a subtask's question reaching its story ---

func subtaskQuestion() session.PendingQuestion {
	return session.PendingQuestion{
		RequestID: "req-1", Header: "Database", Question: "Which database?",
		Options: []session.QuestionOption{{Label: "Postgres"}, {Label: "SQLite"}},
	}
}

// TestEngine_ASubtaskQuestionReachesItsStory: a story often knows what its
// subtask is asking about, so it is shown the question and told the two ways
// forward.
func TestEngine_ASubtaskQuestionReachesItsStory(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "Wire the store")
	startWorkWithSession(t, f.store, task.ID, "sess-child")

	f.engine.HandleQuestionPosted("sess-child", subtaskQuestion())

	waitFor(t, func() bool { return f.sender.count() > 0 })
	if got := f.sender.subtypes(); len(got) != 1 || got[0] != MessageSubtypeChildQuestion {
		t.Fatalf("sent %v, want one child-question message", got)
	}
	body := f.sender.contents()[0]
	for _, want := range []string{"Which database?", "req-1", "Postgres", "question_answer", "question_post"} {
		if !strings.Contains(body, want) {
			t.Errorf("message does not contain %q; it is the story's only copy of the question", want)
		}
	}
}

// TestEngine_ASubtaskQuestionLeavesTheParentsWaitAlone is the rule that tells
// this message from child_done: a `child` wait ends when a subtask closes, and
// a subtask asking a question is not that. The subtask is still running, and a
// story that answers and ends its turn is still waiting for exactly what it was.
func TestEngine_ASubtaskQuestionLeavesTheParentsWaitAlone(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "Wire the store")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	setChildWait(t, f.store, story.ID)

	f.engine.HandleQuestionPosted("sess-child", subtaskQuestion())

	waitFor(t, func() bool { return f.sender.count() > 0 })
	got := getWork(t, f.store, story.ID)
	if got.Wait != WaitChild || got.Status != StatusActive {
		t.Errorf("parent = %q/%q, want it still waiting on its subtasks", got.Status, got.Wait)
	}
	if !strings.Contains(f.sender.contents()[0], "you still are") {
		t.Error("the story was not told its wait is untouched")
	}
}

// A stopped story has been handed back to a person and Pockode sends it
// nothing: a message would spawn a CLI and set it working on a story somebody
// took back. Nothing is retried — the question is still on the subtask, where
// the user can see it.
func TestEngine_ASubtaskQuestionIsNotDeliveredToAStoppedStory(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "Wire the store")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	if err := f.store.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	f.engine.HandleQuestionPosted("sess-child", subtaskQuestion())
	f.engine.Stop() // waits for the follow-up, so "nothing was sent" is decidable

	if got := f.sender.count(); got != 0 {
		t.Errorf("sent %d messages, want none into a stopped story", got)
	}
	if got := getWork(t, f.store, story.ID); got.Status != StatusStopped {
		t.Errorf("story = %q, want it left stopped", got.Status)
	}
}

// A question from a task with no story above it is nobody's news.
func TestEngine_AQuestionFromAStoryGoesNowhere(t *testing.T) {
	f := newEngineFixture(t)
	f.startedStory(t, "sess-1")

	f.engine.HandleQuestionPosted("sess-1", subtaskQuestion())
	f.engine.Stop()

	if got := f.sender.count(); got != 0 {
		t.Errorf("sent %d messages, want none — there is no parent to tell", got)
	}
}

// TestEngine_AnUndeliverableSubtaskQuestionChangesNothing: unlike the two
// notifications that clear a wait, this one is not owed to anybody. A story
// whose turn is held open by a permission request simply does not get it, and
// is neither stopped nor retried.
func TestEngine_AnUndeliverableSubtaskQuestionChangesNothing(t *testing.T) {
	f := newEngineFixture(t)
	f.engine.SetSender(failingSender{})
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "Wire the store")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	setChildWait(t, f.store, story.ID)

	f.engine.HandleQuestionPosted("sess-child", subtaskQuestion())
	f.engine.Stop()

	got := getWork(t, f.store, story.ID)
	if got.Status != StatusActive || got.Wait != WaitChild {
		t.Errorf("story = %q/%q, want it untouched", got.Status, got.Wait)
	}
	if bodies := f.commentBodies(t, story.ID); len(bodies) != 0 {
		t.Errorf("comments = %v, want none: nothing was lost", bodies)
	}
}

// --- input 1, continued: a subtask of this story is waiting on an answer ---

// startedSubtask gives the story a running subtask on a known session, which is
// what it takes for that subtask to have a question of its own.
func (f *engineFixture) startedSubtask(t *testing.T, storyID, title, sessionID string) Work {
	t.Helper()
	task := createTask(t, f.store, storyID, title)
	startWorkWithSession(t, f.store, task.ID, sessionID)
	return getWork(t, f.store, task.ID)
}

// Row one of the rule: the subtask is waiting and the story is not. Being shown
// a subtask's question and doing nothing about it is the one thing a
// coordinator may not do, so the story is nudged — and told what it is being
// nudged about, which the ordinary nudge cannot say.
func TestEngine_NudgesAStoryThatLeftItsSubtasksQuestionAlone(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := f.startedSubtask(t, story.ID, "Wire the store", "sess-child")
	f.turns.post("sess-child")

	f.engine.HandleTurnEnded("sess-parent", session.OutcomeCompleted)

	if f.sender.count() != 1 {
		t.Fatalf("sent %v, want one nudge about the subtask's question", f.sender.subtypes())
	}
	body := f.sender.contents()[0]
	for _, want := range []string{task.ID, "Wire the store", "sess-child-q", "session_id: sess-child", "question_answer", "question_post"} {
		if !strings.Contains(body, want) {
			t.Errorf("the nudge does not contain %q; it is what the story has to act on", want)
		}
	}
	if got := getWork(t, f.store, story.ID); got.NudgeCount != 1 {
		t.Errorf("nudges = %d, want 1 — this one spends the allowance like any other", got.NudgeCount)
	}
}

// Row two: the story is asking the user on its subtask's behalf. That is the
// answer to "I cannot decide this", so it is an ordinary ending — and the story
// must never be stopped for it, which is why this is asked before the subtasks
// are.
func TestEngine_LeavesAStoryAskingOnItsSubtasksBehalfAlone(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	f.startedSubtask(t, story.ID, "Wire the store", "sess-child")
	f.turns.post("sess-child")
	f.turns.post("sess-parent")

	for range DefaultMaxNudges + 1 {
		f.engine.HandleTurnEnded("sess-parent", session.OutcomeCompleted)
	}

	if f.sender.count() != 0 {
		t.Errorf("nudged a story that is asking the user (%v)", f.sender.subtypes())
	}
	got := getWork(t, f.store, story.ID)
	if got.Status != StatusActive || got.NudgeCount != 0 {
		t.Errorf("story = %q/%d, want active with nothing spent", got.Status, got.NudgeCount)
	}
}

// The order the two are read in, stated on its own: a `child` wait is the
// commonest state for a story that has just been shown a subtask's question,
// and it does not excuse leaving that question alone. "Nothing to do until a
// subtask closes" is untrue while a subtask is waiting on this story.
func TestEngine_NudgesAWaitingStoryForItsSubtasksQuestion(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	f.startedSubtask(t, story.ID, "Wire the store", "sess-child")
	setChildWait(t, f.store, story.ID)
	f.turns.post("sess-child")

	f.engine.HandleTurnEnded("sess-parent", session.OutcomeCompleted)

	if f.sender.count() != 1 {
		t.Fatalf("sent %v, want the waiting story nudged about the question", f.sender.subtypes())
	}
	// The nudge asks for an answer, not for the wait to be given up: nothing
	// here is a subtask closing.
	if got := getWork(t, f.store, story.ID); got.Wait != WaitChild {
		t.Errorf("wait = %q, want it left on the subtasks", got.Wait)
	}
	if !strings.Contains(f.sender.contents()[0], "if you were waiting you still are") {
		t.Error("the story was not told its wait is untouched")
	}
}

// The allowance is one allowance: a story that goes on ignoring its subtask is
// handed back to a person, like any other agent that stops acting on what it is
// told. The comment has to name what is still outstanding, because the subtask
// is still waiting and the user is the one who can answer it now.
func TestEngine_StopsAStoryThatKeepsIgnoringItsSubtasksQuestion(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	f.startedSubtask(t, story.ID, "Wire the store", "sess-child")
	f.turns.post("sess-child")

	for range DefaultMaxNudges + 1 {
		f.engine.HandleTurnEnded("sess-parent", session.OutcomeCompleted)
	}

	if got := getWork(t, f.store, story.ID); got.Status != StatusStopped {
		t.Errorf("status = %q, want %q once the allowance is spent", got.Status, StatusStopped)
	}
	bodies := f.commentBodies(t, story.ID)
	if len(bodies) != 1 || !strings.Contains(bodies[0], "still waiting for that answer") {
		t.Errorf("comments = %v, want one naming the question nobody answered", bodies)
	}
}

// The moment the question is settled the story is an ordinary one again, and its
// empty endings are ordinary accidents. Nothing is told: the list is read live,
// so it cannot go on saying "unanswered" after the answer.
func TestEngine_NudgesOrdinarilyOnceTheSubtasksQuestionIsSettled(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	f.startedSubtask(t, story.ID, "Wire the store", "sess-child")
	f.turns.post("sess-child")
	f.engine.HandleTurnEnded("sess-parent", session.OutcomeCompleted)

	f.turns.answer("sess-child")
	f.engine.HandleTurnEnded("sess-parent", session.OutcomeCompleted)

	if f.sender.count() != 2 {
		t.Fatalf("sent %d messages, want the reminder and then an ordinary nudge", f.sender.count())
	}
	if !strings.Contains(f.sender.contents()[1], "no work_wait") {
		t.Error("the second ending was not read as an ordinary empty turn")
	}
}

// Only an active subtask's question is the story's to settle. A person who
// stops a subtask has taken it back: it is not blocked on an answer any more,
// and an answer would restart it — so nudging the story about it would turn one
// stop the user asked for into pressure on the story, and possibly a second
// stop. The question is still the user's to answer where it was asked.
func TestEngine_LeavesAStoppedSubtasksQuestionToTheUser(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := f.startedSubtask(t, story.ID, "Wire the store", "sess-child")
	f.turns.post("sess-child")
	if err := f.store.Stop(context.Background(), task.ID); err != nil {
		t.Fatalf("Stop the subtask: %v", err)
	}

	f.engine.HandleTurnEnded("sess-parent", session.OutcomeCompleted)

	if got := f.sender.subtypes(); len(got) != 1 || got[0] != MessageSubtypeAutoContinue {
		t.Fatalf("sent %v, want one ordinary nudge", got)
	}
	if strings.Contains(f.sender.contents()[0], "still waiting on questions") {
		t.Error("the story was pushed to answer for a subtask a person had stopped")
	}
}
