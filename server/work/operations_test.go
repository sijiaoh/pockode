package work

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
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
	advanced []Work
}

func (n *recordingNotifier) NotifyReopen(w Work)   { n.reopened = append(n.reopened, w) }
func (n *recordingNotifier) NotifyStepDone(w Work) { n.advanced = append(n.advanced, w) }

func TestOperations_StartWork_ClaimsAndReturnsWork(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	starter := &recordingStarter{}
	ops := NewOperations(store, starter, nil, nil)

	w, err := ops.StartWork(context.Background(), story.ID)
	if err != nil {
		t.Fatalf("StartWork: %v", err)
	}
	if w.Status != StatusActive {
		t.Errorf("status = %q, want active", w.Status)
	}
	if w.SessionID == "" {
		t.Error("session_id should be set after start")
	}
	if starter.calls != 1 {
		t.Errorf("HandleWorkStart called %d times, want 1", starter.calls)
	}
}

// On restart (a stopped work going back to active) the existing session must be
// reused so the agent's chat history is preserved.
func TestOperations_StartWork_RestartReusesSession(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	ops := NewOperations(store, &recordingStarter{}, nil, nil)

	first, err := ops.StartWork(context.Background(), story.ID)
	if err != nil {
		t.Fatalf("first StartWork: %v", err)
	}
	if err := store.Stop(context.Background(), story.ID); err != nil {
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
	ops := NewOperations(store, &recordingStarter{err: errors.New("kickoff failed")}, nil, nil)

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
	ops := NewOperations(store, &recordingStarter{}, nil, nil)

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
	ops := NewOperations(store, starter, nil, nil)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	w, err := ops.StartWork(ctx, story.ID)
	if err != nil {
		t.Fatalf("StartWork with cancelled ctx: %v", err)
	}
	if w.Status != StatusActive {
		t.Errorf("status = %q, want active despite cancelled caller ctx", w.Status)
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
	ops := NewOperations(store, &recordingStarter{}, notifier, nil)

	if err := ops.ReopenWork(context.Background(), story.ID); err != nil {
		t.Fatalf("ReopenWork: %v", err)
	}
	got, _, _ := store.Get(story.ID)
	if got.Status != StatusActive {
		t.Errorf("status = %q, want active after reopen", got.Status)
	}
	if len(notifier.reopened) != 1 {
		t.Fatalf("NotifyReopen called %d times, want 1", len(notifier.reopened))
	}
}

// A work whose role has been deleted has an unknown number of steps, not zero.
// Reading it as zero would close the work on its first step_done — the agent
// reporting one step's progress would finish the whole thing.
func TestOperations_StepDone_RefusesAnUnknownStepCount(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWork(t, store, story.ID)
	ops := NewOperations(store, nil, nil, failingSteps{})

	if _, _, err := ops.StepDone(context.Background(), story.ID); err == nil {
		t.Fatal("StepDone succeeded with no step count; it must report the failure")
	}
	if got := getWork(t, store, story.ID); got.Status != StatusActive {
		t.Errorf("status = %q, want the work left alone at %q", got.Status, StatusActive)
	}
}

type failingSteps struct{}

func (failingSteps) GetSteps(string) ([]string, error) {
	return nil, errors.New("agent role not found")
}

// A story does not finish while its subtasks are still running: they would be
// left with a parent nobody is going to report to, and closing the story retires
// the session they report through. The refusal names them, because an agent told
// only that some exist has to guess which (docs/lifecycle-ui.md §7).
func TestOperations_StepDone_RefusesToCloseWhileChildrenAreActive(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWork(t, store, story.ID)
	child := createTask(t, store, story.ID, "Reducer")
	startWork(t, store, child.ID)
	ops := NewOperations(store, nil, nil, fixedSteps{"only"})

	_, _, err := ops.StepDone(context.Background(), story.ID)
	if !errors.Is(err, ErrInvalidWork) {
		t.Fatalf("err = %v, want an ErrInvalidWork refusal", err)
	}
	for _, want := range []string{`"Reducer"`, "story_wait", "The step was not completed"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal %q does not mention %q", err, want)
		}
	}
	// Stopping a subtask is a person's call and no agent tool does it, so the
	// refusal must not send the agent after it.
	if strings.Contains(strings.ToLower(err.Error()), "stop") {
		t.Errorf("refusal %q suggests stopping, which no agent tool can do", err)
	}
	if got := getWork(t, store, story.ID); got.Status != StatusActive || got.CurrentStep != 0 {
		t.Errorf("status/step = %q/%d; a refused step_done moves nothing", got.Status, got.CurrentStep)
	}
	if got := getWork(t, store, child.ID); got.Status != StatusActive {
		t.Errorf("child status = %q; the refusal must not stop anyone's work for them", got.Status)
	}
}

// The mirror of the refusal above, and the two are exactly complementary: a
// story_wait is accepted precisely when the closing step_done is refused. If it
// were not, one of the two errors would be naming a way out that is itself shut.
func TestOperations_Wait_AcceptedWhileASubtaskRuns(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWork(t, store, story.ID)
	child := createTask(t, store, story.ID, "Reducer")
	startWork(t, store, child.ID)
	ops := NewOperations(store, nil, nil, nil)

	if err := ops.Wait(context.Background(), story.ID); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if got := getWork(t, store, story.ID); got.Wait != WaitChild {
		t.Errorf("wait = %q, want child", got.Wait)
	}
}

// A wait on subtasks is ended by exactly one event — a subtask closing — so with
// none running it is a wait nothing would ever end: the engine stops nudging by
// design and `waiting_children` is outside the attention dot, so the work would
// sit active forever with nobody told. Each shape names a different way out,
// which is the whole reason they are not one message.
func TestOperations_Wait_RefusesWhenNothingCouldEndIt(t *testing.T) {
	cases := []struct {
		name    string
		setup   func(t *testing.T, store *FileStore, storyID string)
		wants   []string
		unwants []string
	}{
		{
			name:  "no subtasks at all",
			setup: func(*testing.T, *FileStore, string) {},
			wants: []string{"no subtasks", "task_create"},
		},
		{
			name: "every subtask already closed",
			setup: func(t *testing.T, store *FileStore, storyID string) {
				doneWork(t, store, createTask(t, store, storyID, "Reducer").ID)
			},
			wants: []string{"already closed", "task_create"},
		},
		{
			// The closed one is what makes this case worth its own setup: the
			// number introducing the list has to count the list, not every
			// subtask, or a list of two under "none of 3" reads as truncated.
			name: "subtasks exist but none is running",
			setup: func(t *testing.T, store *FileStore, storyID string) {
				stopped := createTask(t, store, storyID, "Reducer")
				startWork(t, store, stopped.ID)
				if err := store.Stop(context.Background(), stopped.ID); err != nil {
					t.Fatalf("Stop: %v", err)
				}
				createTask(t, store, storyID, "Lease table")
				doneWork(t, store, createTask(t, store, storyID, "Settling").ID)
			},
			// Named with their statuses: "none is running" and "you never
			// started them" are the same sentence to the agent that made them.
			wants:   []string{`2 of them can be started`, `"Reducer" (stopped)`, `"Lease table" (open)`, "task_start"},
			unwants: []string{"Settling", "3"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			story := createStory(t, store, "Build")
			startWork(t, store, story.ID)
			tc.setup(t, store, story.ID)
			ops := NewOperations(store, nil, nil, nil)

			err := ops.Wait(context.Background(), story.ID)
			if !errors.Is(err, ErrInvalidWork) {
				t.Fatalf("err = %v, want an ErrInvalidWork refusal", err)
			}
			// The three properties of docs/lifecycle-ui.md §7, plus what is in
			// the way: the other ways out and the plain statement of no effect.
			wants := append(tc.wants, "question_post", "step_done", "The wait was not set")
			for _, want := range wants {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("refusal %q does not mention %q", err, want)
				}
			}
			for _, unwanted := range tc.unwants {
				if strings.Contains(err.Error(), unwanted) {
					t.Errorf("refusal %q mentions %q, which it must not", err, unwanted)
				}
			}
			if got := getWork(t, store, story.ID); got.Wait != WaitNone {
				t.Errorf("wait = %q; a refused story_wait sets nothing", got.Wait)
			}
		})
	}
}

// story_wait takes an id, and a task's is as easy to pass as a story's. The
// refusal must not offer a task the story's ways out: "create them with
// task_create" would send it to make a third level, which the store refuses.
func TestOperations_Wait_OnATaskOffersNoTasksOfItsOwn(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	task := createTask(t, store, story.ID, "Reducer")
	startWork(t, store, story.ID)
	startWork(t, store, task.ID)
	ops := NewOperations(store, nil, nil, nil)

	err := ops.Wait(context.Background(), task.ID)
	if !errors.Is(err, ErrInvalidWork) {
		t.Fatalf("err = %v, want an ErrInvalidWork refusal", err)
	}
	for _, want := range []string{"is a task", "question_post", "step_done", "The wait was not set"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal %q does not mention %q", err, want)
		}
	}
	for _, unwanted := range []string{"task_create", "task_start"} {
		if strings.Contains(err.Error(), unwanted) {
			t.Errorf("refusal %q offers a task %s, which would make a third level", err, unwanted)
		}
	}
	if got := getWork(t, store, task.ID); got.Wait != WaitNone {
		t.Errorf("wait = %q; a refused story_wait sets nothing", got.Wait)
	}
}

// Only the closing one is refused. A story's steps are its own workflow, and
// walking through them while subtasks run is what a story with subtasks does.
func TestOperations_StepDone_AdvancesAStepWhileChildrenAreActive(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWork(t, store, story.ID)
	child := createTask(t, store, story.ID, "Reducer")
	startWork(t, store, child.ID)
	ops := NewOperations(store, nil, nil, fixedSteps{"first", "second"})

	hasMore, _, err := ops.StepDone(context.Background(), story.ID)
	if err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if !hasMore {
		t.Error("hasMoreSteps = false on the first of two steps")
	}
	if got := getWork(t, store, story.ID); got.CurrentStep != 1 {
		t.Errorf("current step = %d, want 1", got.CurrentStep)
	}
}

// A child that is not active is not a blocker: the story closes.
func TestOperations_StepDone_ClosesWhenNoChildIsActive(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWork(t, store, story.ID)
	child := createTask(t, store, story.ID, "Reducer")
	doneWork(t, store, child.ID)
	ops := NewOperations(store, nil, nil, fixedSteps{"only"})

	if _, _, err := ops.StepDone(context.Background(), story.ID); err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if got := getWork(t, store, story.ID); got.Status != StatusClosed {
		t.Errorf("status = %q, want closed", got.Status)
	}
}

// recordingWithdrawer is what a completed step takes back.
type recordingWithdrawer struct {
	calls []withdrawal
}

type withdrawal struct {
	worktree  string
	sessionID string
	reason    agent.CancelReason
}

func (r *recordingWithdrawer) WithdrawQuestions(worktree, sessionID string, reason agent.CancelReason) {
	r.calls = append(r.calls, withdrawal{worktree: worktree, sessionID: sessionID, reason: reason})
}

// A question asked during a step is about that step. Once the step is done the
// agent has moved past what it was asking, so the answer would arrive for work
// it has already finished — and the user would be asked for nothing.
func TestOperations_StepDone_WithdrawsTheStepsQuestions(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWorkWithSession(t, store, story.ID, "sess-1")
	questions := &recordingWithdrawer{}
	ops := NewOperations(store, nil, nil, fixedSteps{"first", "second"})
	ops.SetQuestionWithdrawer(questions)

	if _, _, err := ops.StepDone(context.Background(), story.ID); err != nil {
		t.Fatalf("StepDone: %v", err)
	}

	if len(questions.calls) != 1 {
		t.Fatalf("withdrawals = %+v, want exactly one", questions.calls)
	}
	got := questions.calls[0]
	if got.sessionID != "sess-1" || got.reason != agent.ReasonStepDone {
		t.Errorf("withdrawal = %+v, want sess-1 withdrawn as step_done", got)
	}
}

// The step that *closes* the work does not, and that is not an oversight: the
// close retires the session, and retiring withdraws them with the reason that
// says more — nobody is coming back to this chat at all. Two withdrawals for one
// question would race over which reason the user reads.
func TestOperations_StepDone_LeavesTheClosingStepToTheRetirement(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWorkWithSession(t, store, story.ID, "sess-1")
	questions := &recordingWithdrawer{}
	ops := NewOperations(store, nil, nil, fixedSteps{"only"})
	ops.SetQuestionWithdrawer(questions)

	if _, _, err := ops.StepDone(context.Background(), story.ID); err != nil {
		t.Fatalf("StepDone: %v", err)
	}

	if got := getWork(t, store, story.ID); got.Status != StatusClosed {
		t.Fatalf("status = %q, want closed", got.Status)
	}
	if len(questions.calls) != 0 {
		t.Errorf("withdrawals = %+v, want none — closing is what withdraws them", questions.calls)
	}
}

// A refused step_done moves nothing, questions included: the step is not over.
func TestOperations_StepDone_WithdrawsNothingWhenItIsRefused(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWorkWithSession(t, store, story.ID, "sess-1")
	child := createTask(t, store, story.ID, "Reducer")
	startWork(t, store, child.ID)
	questions := &recordingWithdrawer{}
	ops := NewOperations(store, nil, nil, fixedSteps{"only"})
	ops.SetQuestionWithdrawer(questions)

	if _, _, err := ops.StepDone(context.Background(), story.ID); !errors.Is(err, ErrInvalidWork) {
		t.Fatalf("err = %v, want the refusal", err)
	}
	if len(questions.calls) != 0 {
		t.Errorf("withdrawals = %+v, want none", questions.calls)
	}
}

// Stopping is the other end of the same question. A stopped work is handed back
// to a person, and the questions are exactly what that person is being handed —
// they survive the stop and survive the restart after it, which is why nothing
// here withdraws anything.
func TestOperations_StopWork_WithdrawsNothing(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWorkWithSession(t, store, story.ID, "sess-1")
	questions := &recordingWithdrawer{}
	ops := NewOperations(store, nil, nil, nil)
	ops.SetQuestionWithdrawer(questions)

	if err := ops.StopWork(context.Background(), story.ID); err != nil {
		t.Fatalf("StopWork: %v", err)
	}

	if len(questions.calls) != 0 {
		t.Errorf("withdrawals = %+v, want none — the questions are what the user is handed", questions.calls)
	}
}

// recordingDeleter is what a delete cascades to.
type recordingDeleter struct {
	worktree   string
	sessionIDs []string
	calls      int
}

func (r *recordingDeleter) DeleteSessions(_ context.Context, worktree string, sessionIDs []string) {
	r.calls++
	r.worktree = worktree
	r.sessionIDs = sessionIDs
}

// Deleting a work deletes the sessions under it — the whole subtree's, since a
// session whose work is gone cannot be reached from anywhere. It is part of the
// command rather than of one transport, because work_delete over MCP has to
// leave exactly the same nothing behind as the delete button does.
func TestOperations_DeleteWork_CascadesToTheSubtreesSessions(t *testing.T) {
	store := newTestStore(t)
	story := createStory(t, store, "Build")
	startWorkWithSession(t, store, story.ID, "sess-story")
	child := createTask(t, store, story.ID, "Reducer")
	startWorkWithSession(t, store, child.ID, "sess-child")
	other := createStory(t, store, "Unrelated")
	startWorkWithSession(t, store, other.ID, "sess-other")

	deleter := &recordingDeleter{}
	ops := NewOperations(store, nil, nil, nil)
	ops.SetSessionDeleter(deleter)

	if err := ops.DeleteWork(context.Background(), story.ID); err != nil {
		t.Fatalf("DeleteWork: %v", err)
	}

	if deleter.calls != 1 {
		t.Fatalf("DeleteSessions called %d times, want 1", deleter.calls)
	}
	got := map[string]bool{}
	for _, id := range deleter.sessionIDs {
		got[id] = true
	}
	if !got["sess-story"] || !got["sess-child"] {
		t.Errorf("deleted sessions = %v, want the story's and its child's", deleter.sessionIDs)
	}
	if got["sess-other"] {
		t.Error("the delete reached a session outside the subtree")
	}
	if _, found, _ := store.Get(child.ID); found {
		t.Error("the child work outlived its story")
	}
}

// A delete that the store refuses cascades to nothing: the sessions are still
// the live work's.
func TestOperations_DeleteWork_LeavesSessionsAloneWhenTheDeleteFails(t *testing.T) {
	store := newTestStore(t)
	deleter := &recordingDeleter{}
	ops := NewOperations(store, nil, nil, nil)
	ops.SetSessionDeleter(deleter)

	if err := ops.DeleteWork(context.Background(), "no-such-work"); !errors.Is(err, ErrWorkNotFound) {
		t.Fatalf("err = %v, want %v", err, ErrWorkNotFound)
	}
	if deleter.calls != 0 {
		t.Errorf("DeleteSessions called %d times for a delete that did not happen", deleter.calls)
	}
}
