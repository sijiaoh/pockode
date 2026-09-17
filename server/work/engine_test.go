package work

import (
	"context"
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

type fixedSteps []string

func (f fixedSteps) GetSteps(string) ([]string, error) { return f, nil }

// engineFixture is a store, an engine wired to it, and the two things the engine
// talks to.
type engineFixture struct {
	store      *FileStore
	engine     *Engine
	sender     *recordingSender
	terminator *recordingTerminator
}

func newEngineFixture(t *testing.T) *engineFixture {
	t.Helper()

	store := newTestStore(t)
	engine := NewEngine(store, DefaultMaxNudges)
	sender := &recordingSender{}
	terminator := &recordingTerminator{}
	engine.SetSender(sender)
	engine.SetSessionTerminator(terminator)
	store.AddOnChangeListener(engine)
	t.Cleanup(engine.Stop)

	return &engineFixture{store: store, engine: engine, sender: sender, terminator: terminator}
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
	for _, wait := range []WorkWait{WaitUser, WaitChild} {
		t.Run(string(wait), func(t *testing.T) {
			f := newEngineFixture(t)
			story := f.startedStory(t, "sess-1")
			if err := f.store.SetWait(context.Background(), story.ID, wait, "because"); err != nil {
				t.Fatalf("SetWait: %v", err)
			}

			f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted)

			if f.sender.count() != 0 {
				t.Errorf("nudged a work that said what it is waiting for (%d messages)", f.sender.count())
			}
			if got := getWork(t, f.store, story.ID); got.Wait != wait || got.NudgeCount != 0 {
				t.Errorf("wait/nudges = %q/%d, want %q/0", got.Wait, got.NudgeCount, wait)
			}
		})
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
	if err := f.store.SetWait(context.Background(), story.ID, WaitUser, "which database?"); err != nil {
		t.Fatalf("SetWait: %v", err)
	}
	f.engine.HandleTurnEnded("sess-1", session.OutcomeCompleted) // no nudge; it is waiting
	if _, err := f.store.RecordNudge(context.Background(), story.ID); err != nil {
		t.Fatalf("RecordNudge: %v", err)
	}

	f.engine.HandleUserMessage("sess-1")

	got := getWork(t, f.store, story.ID)
	if got.Status != StatusActive || got.Wait != WaitNone || got.WaitReason != "" || got.NudgeCount != 0 {
		t.Errorf("work = %q/%q/%q/%d, want active with nothing left over",
			got.Status, got.Wait, got.WaitReason, got.NudgeCount)
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
	if err := f.store.SetWait(context.Background(), story.ID, WaitChild, "waiting on T"); err != nil {
		t.Fatalf("SetWait: %v", err)
	}

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

// A parent waiting on the *user* has not been handed what it was waiting for, so
// its wait stands — the child's news reaches its transcript either way.
func TestEngine_ChildClosureLeavesAParentWaitingOnTheUser(t *testing.T) {
	f := newEngineFixture(t)
	story := f.startedStory(t, "sess-parent")
	task := createTask(t, f.store, story.ID, "T")
	startWorkWithSession(t, f.store, task.ID, "sess-child")
	if err := f.store.SetWait(context.Background(), story.ID, WaitUser, "which database?"); err != nil {
		t.Fatalf("SetWait: %v", err)
	}

	if _, err := f.store.StepDone(context.Background(), task.ID, 0); err != nil {
		t.Fatalf("StepDone on the child: %v", err)
	}

	waitFor(t, func() bool { return f.sender.count() > 0 })
	if got := getWork(t, f.store, story.ID); got.Wait != WaitUser {
		t.Errorf("parent wait = %q, want it still waiting on the user", got.Wait)
	}
	// And is not told otherwise: a parent that believed its wait was cleared
	// would call work_wait and overwrite a wait on a person with one on its
	// subtasks, so the user would stop being shown as the one being waited for.
	if strings.Contains(f.sender.contents()[0], "cleared your wait") {
		t.Error("a parent still waiting on the user was told its wait was cleared")
	}
}

// --- input 4: the session was deleted ---

func TestEngine_StopsAWorkWhoseSessionWasDeleted(t *testing.T) {
	for _, wait := range []WorkWait{WaitNone, WaitUser, WaitChild} {
		t.Run(string("wait="+wait), func(t *testing.T) {
			f := newEngineFixture(t)
			story := f.startedStory(t, "sess-1")
			if wait != WaitNone {
				if err := f.store.SetWait(context.Background(), story.ID, wait, "because"); err != nil {
					t.Fatalf("SetWait: %v", err)
				}
			}

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
	f := newEngineFixture(t)

	driven := f.startedStory(t, "sess-driven")

	waitingOnUser := createStory(t, f.store, "waiting on the user")
	startWorkWithSession(t, f.store, waitingOnUser.ID, "sess-user")
	if err := f.store.SetWait(context.Background(), waitingOnUser.ID, WaitUser, "which database?"); err != nil {
		t.Fatalf("SetWait: %v", err)
	}

	waitingOnChild := createStory(t, f.store, "waiting on its children")
	startWorkWithSession(t, f.store, waitingOnChild.ID, "sess-child")
	if err := f.store.SetWait(context.Background(), waitingOnChild.ID, WaitChild, ""); err != nil {
		t.Fatalf("SetWait: %v", err)
	}

	f.engine.RecoverStartup()

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
	for _, kept := range []Work{waitingOnUser, waitingOnChild} {
		if got := getWork(t, f.store, kept.ID); got.Status != StatusActive {
			t.Errorf("%q = %q, want it left active — what it waits for outlives the process",
				kept.Title, got.Status)
		}
		if bodies := f.commentBodies(t, kept.ID); len(bodies) != 0 {
			t.Errorf("%q got comments %v, want none — nothing happened to it", kept.Title, bodies)
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
	story := f.startedStory(t, "sess-1")

	if err := f.store.SetWait(context.Background(), story.ID, WaitUser, "which database?"); err != nil {
		t.Fatalf("SetWait: %v", err)
	}
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
