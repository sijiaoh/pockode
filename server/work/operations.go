package work

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/pockode/server/agent"
)

// Notifier delivers the agent-facing follow-up messages that accompany a work
// transition. Satisfied by the Engine.
type Notifier interface {
	NotifyReopen(w Work)
	NotifyStepDone(w Work)
}

// StepCounter reports how many steps a work's role defines. Satisfied by the
// agent role store adapter; the work package uses it to avoid importing
// agentrole.
type StepCounter interface {
	GetSteps(agentRoleID string) ([]string, error)
}

// SessionDeleter removes the sessions of a work that is being deleted, together
// with their processes. Satisfied by the worktree Manager.
//
// Deleting a work deletes the sessions underneath it: a session whose work is
// gone has no way back into the UI — the work detail page is how it is reached —
// and a process still running for it would be working on something nobody can
// read the result of. It is a separate collaborator from SessionTerminator
// because the two differ in what survives: terminating keeps the session id and
// its transcript for a Reopen, deleting keeps nothing.
type SessionDeleter interface {
	DeleteSessions(ctx context.Context, worktree string, sessionIDs []string)
}

// QuestionWithdrawer takes back every question a session is still waiting on an
// answer to, saying why. Satisfied by the worktree Manager.
//
// A posted question outlives the turn that asked it and the process that asked
// it, which is the point of it — but not the piece of work it was asked about.
// An agent that asks "which database?" on step 2 and is moved to step 3 is not
// going to use the answer, and a question nobody wants answered is one the user
// is asked for nothing. So the two boundaries the work layer owns — a step
// ending and a work closing — withdraw what is beneath them.
type QuestionWithdrawer interface {
	WithdrawQuestions(worktree, sessionID string, reason agent.CancelReason)
}

// Operations is the whole command surface of a work item: the six things a
// person or an agent can ask for, each with its store transition and its
// agent-facing side effects.
//
// Both transports go through it — the WebSocket handler (user actions) and the
// MCP Executor (AI actions) — so a user-triggered command and an AI-triggered
// one are the same command and cannot drift apart. That is not a tidiness
// argument: the two entry points had separate implementations of stop and of
// the waits, and each bug found in one had to be found again in the other.
//
// What is deliberately *not* here is process termination. A work leaving active
// is what takes its session's lease away, and that is hung on the transition
// itself (Engine.enforceSessionLease) so that the rule holds for the engine's
// own stops as much as for a user's.
type Operations struct {
	store     Store
	starter   WorkStartHandler
	notifier  Notifier
	steps     StepCounter
	sessions  SessionDeleter
	questions QuestionWithdrawer
}

// NewOperations builds an Operations. A nil notifier is tolerated (the reopen
// and step-advance nudges are then skipped) for narrow tests where no session is
// live; a nil steps counter makes every work stepless, which closes it on the
// first step_done.
func NewOperations(store Store, starter WorkStartHandler, notifier Notifier, steps StepCounter) *Operations {
	return &Operations{store: store, starter: starter, notifier: notifier, steps: steps}
}

// SetSessionDeleter installs what a delete cascades to. Left unset, a delete
// removes the work items and nothing else, which is what the narrow tests in
// this package want; the server always sets it.
func (o *Operations) SetSessionDeleter(d SessionDeleter) {
	o.sessions = d
}

// SetQuestionWithdrawer installs what a completed step takes back. Left unset,
// a step advance leaves the questions of the step before it outstanding, which
// is what the narrow tests in this package want; the server always sets it.
func (o *Operations) SetQuestionWithdrawer(w QuestionWithdrawer) {
	o.questions = w
}

// DeleteWork removes a work item, its tasks, and the agent sessions they were
// using.
//
// The cascade is here rather than in either transport because both entry points
// must do the same thing: a story deleted from the UI and one deleted by an
// agent's work_delete leave the same nothing behind. The session ids are read
// before the delete, because afterwards there is nothing left to read them off.
func (o *Operations) DeleteWork(ctx context.Context, id string) error {
	worktree, sessionIDs := o.subtreeSessions(id)

	// Detached from the caller's context for the reason StartWork gives, and
	// more sharply: the work record goes first, so a disconnected client or an
	// expired request timeout cancelling the cascade halfway would leave
	// sessions nothing can ever reach again.
	deleteCtx := context.WithoutCancel(ctx)
	if err := o.store.Delete(deleteCtx, id); err != nil {
		return err
	}

	if o.sessions != nil {
		o.sessions.DeleteSessions(deleteCtx, worktree, sessionIDs)
	}
	return nil
}

// subtreeSessions reports the worktree the deleted work lives in and every
// session id it and its tasks hold. They all share the target's worktree —
// tasks inherit it at create time — so one worktree covers all of them.
func (o *Operations) subtreeSessions(id string) (worktree string, sessionIDs []string) {
	target, found, err := o.store.Get(id)
	if err != nil || !found {
		return "", nil
	}
	works, err := o.store.List()
	if err != nil {
		slog.Warn("failed to list works for session cleanup", "workId", id, "error", err)
		return target.Worktree, nil
	}

	subtree := subtreeIDs(works, id)
	for _, w := range works {
		if subtree[w.ID] && w.SessionID != "" {
			sessionIDs = append(sessionIDs, w.SessionID)
		}
	}
	return target.Worktree, sessionIDs
}

// StartWork claims a work item and launches its agent session. It transitions
// the work to active with a session ID, then creates the session and sends the
// kickoff (or restart) message via the WorkStartHandler. On handler failure the
// claim is rolled back so the work never gets stuck active with a dangling
// session. The returned Work is the claimed item.
func (o *Operations) StartWork(ctx context.Context, id string) (Work, error) {
	// Precondition: a startable work must have an agent role. Checked before the
	// claim; a stale read here is harmless (worst case a rare spurious reject),
	// unlike the status/session decision which Claim makes under the store lock.
	current, found, err := o.store.Get(id)
	if err != nil {
		return Work{}, err
	}
	if !found {
		return Work{}, ErrWorkNotFound
	}
	if current.AgentRoleID == "" {
		return Work{}, fmt.Errorf("%w: work %s has no agent_role_id", ErrInvalidWork, id)
	}

	// Detach from the caller's context: an HTTP request timeout or a disconnected
	// client/AI CLI must not cancel session creation midway, which would orphan a
	// half-created session. The claim and kickoff run to completion regardless.
	startCtx := context.WithoutCancel(ctx)
	w, restart, err := o.store.Claim(startCtx, id)
	if err != nil {
		return Work{}, err
	}
	if err := o.starter.HandleWorkStart(startCtx, w); err != nil {
		if rbErr := o.store.RollbackStart(startCtx, id, w.SessionID, restart); rbErr != nil {
			slog.Error("failed to rollback work start", "workId", id, "restart", restart, "error", rbErr)
		}
		return Work{}, err
	}
	return w, nil
}

// StopWork hands a work item back to a person. The process behind it ends with
// the transition, which is what "the engine does not touch it" means for the
// machine as well as for the model.
func (o *Operations) StopWork(ctx context.Context, id string) error {
	return o.store.Stop(ctx, id)
}

// ReopenWork transitions a closed work item back to active and delivers the
// reopen nudge to its agent session.
func (o *Operations) ReopenWork(ctx context.Context, id string) error {
	if err := o.store.Reopen(ctx, id); err != nil {
		return err
	}
	if o.notifier != nil {
		if w, found, err := o.store.Get(id); err == nil && found {
			o.notifier.NotifyReopen(w)
		}
	}
	return nil
}

// StepDone marks the current step complete: the work advances to the next step,
// or closes if that was the last one.
//
// It reports whether more steps remain and how many the work's role defines, so
// the caller can tell the agent which of the two happened and where it is. The
// count is returned rather than looked up again by the caller because it is the
// number this call actually used — a role edited in between would otherwise make
// the answer describe a different work than the one that moved.
func (o *Operations) StepDone(ctx context.Context, id string) (hasMoreSteps bool, totalSteps int, err error) {
	// One read for both preconditions, so the step count and the "would this
	// close the work" decision cannot be taken from two different versions of
	// the same item.
	w, found, err := o.store.Get(id)
	if err != nil {
		return false, 0, err
	}
	if !found {
		return false, 0, ErrWorkNotFound
	}

	totalSteps, err = o.stepCount(w)
	if err != nil {
		return false, 0, err
	}

	if err := o.refuseIfChildrenActive(w, totalSteps); err != nil {
		return false, totalSteps, err
	}

	hasMoreSteps, err = o.store.StepDone(ctx, id, totalSteps)
	if err != nil {
		return false, totalSteps, err
	}

	// Only on an advance. The other outcome closed the work, and closing already
	// withdraws them with a reason that says more — nobody is coming back to this
	// chat at all, rather than "that step is over" (Engine.enforceSessionLease →
	// SessionTerminator.RetireSession). Doing both would write two withdrawals
	// for one question and lose the race over which reason the user reads.
	if hasMoreSteps && o.questions != nil && w.SessionID != "" {
		o.questions.WithdrawQuestions(w.Worktree, w.SessionID, agent.ReasonStepDone)
	}

	if !hasMoreSteps || o.notifier == nil {
		return hasMoreSteps, totalSteps, nil
	}

	// Re-read: the step index the next-step prompt is built from is the advanced
	// one, and only the store knows what it advanced to.
	if advanced, found, getErr := o.store.Get(id); getErr == nil && found {
		o.notifier.NotifyStepDone(advanced)
	}
	return hasMoreSteps, totalSteps, nil
}

// refuseIfChildrenActive rejects the step_done that would close a work while
// subtasks of it are still running.
//
// Only the closing one. A story's steps are its own workflow and advancing
// through them alongside running subtasks is ordinary — what is not is
// finishing: the children would be left with a parent nobody is going to report
// to, and closing the story retires the session they report through.
//
// The children are named rather than counted. An agent told only that "there
// are subtasks" has to guess which, and the guess is what produces a second
// wrong call; the error also names the way out, story_wait. It names only that
// one: stopping a subtask is a person's decision and no agent tool does it, so
// offering it would send the agent after a call it cannot make. Nothing is
// cascaded for the same reason — stopping someone else's work is a decision,
// not a side effect of finishing your own.
//
// A stale read is harmless in the same way StartWork's precondition is: a child
// that goes active in the gap is a rare spurious close, and one that closes in
// the gap is a rare spurious refusal the agent can simply retry.
func (o *Operations) refuseIfChildrenActive(w Work, totalSteps int) error {
	if w.CurrentStep+1 < totalSteps {
		return nil // Not the last step: this call advances, it does not close.
	}

	works, err := o.store.List()
	if err != nil {
		return err
	}
	var titles []string
	for _, task := range TasksOf(works, w.ID) {
		if task.Status == StatusActive {
			titles = append(titles, strconv.Quote(task.Title))
		}
	}
	if len(titles) == 0 {
		return nil
	}
	return fmt.Errorf("%w: this story still has %d active subtask(s): %s. Call story_wait to pause until they close. The step was not completed",
		ErrInvalidWork, len(titles), strings.Join(titles, ", "))
}

// Wait parks a work on its children: the engine stops nudging it, and a subtask
// closing is what wakes it again.
//
// It can be refused, and that is the whole difference between it and the
// questions an agent posts when it needs a person: a person can always be asked,
// but a subtask has to exist and be running before it can close. A wait on
// subtasks that are not running is a wait nothing will ever end — the engine
// stops nudging by design, so the work sits `active` forever and
// `waiting_children` is deliberately outside the attention dot
// (docs/lifecycle-ui.md §4), which means nobody is told either.
func (o *Operations) Wait(ctx context.Context, id string) error {
	// The store decides, under its own lock, because deciding and setting must
	// not come apart (Store.SetChildWait).
	set, err := o.store.SetChildWait(ctx, id)
	if err != nil {
		return err
	}
	if !set {
		return o.waitRefusal(id)
	}
	return nil
}

// waitRefusal explains a story_wait the store would not set, and it is the mirror
// of refuseIfChildrenActive: the two gates are exactly complementary, so a
// story_wait is accepted precisely when the step_done that would close the work
// is refused. That is what makes the way out each error names reachable — "call
// story_wait instead" would be a lie if the wait could be refused for the same
// work.
//
// Same three properties as that refusal (docs/lifecycle-ui.md §7): it names what
// is in the way whenever there is anything to name, it names the ways out, and
// it says the wait was not set. What it names is the subtasks that could be
// *started*, because "no subtask is running" and "you have not started them" are
// the same sentence to an agent that has just created three of them.
//
// It always returns an error: the refusal has already happened and this only
// describes it. A child going active between the store's decision and this read
// therefore makes the wording momentarily generous, never the outcome wrong —
// and the agent's retry is then accepted.
func (o *Operations) waitRefusal(id string) error {
	works, err := o.store.List()
	if err != nil {
		return err
	}

	// story_wait takes an id, and an id can name a task. A task has no tasks
	// of its own, so every way out below would send it to create a third level
	// that ValidateStory refuses; it gets the two ways out that are real.
	for _, w := range works {
		if w.ID == id && w.Type() == WorkTypeTask {
			return fmt.Errorf("%w: %s is a task, and only a story has tasks to wait for — so nothing would ever end this wait. Call question_post if you need something from the user, or step_done if there is nothing left to do. The wait was not set",
				ErrInvalidWork, id)
		}
	}

	// Nothing here was active when the store refused, so "not closed" is the
	// same set as "could be started".
	var startable []string
	tasks := TasksOf(works, id)
	total := len(tasks)
	for _, task := range tasks {
		if task.Status != StatusClosed {
			startable = append(startable, fmt.Sprintf("%s (%s)", strconv.Quote(task.Title), task.Status))
		}
	}

	var situation, wayOut string
	switch {
	case total == 0:
		situation = "this work has no subtasks"
		wayOut = "Create them with task_create and start them with task_start"
	case len(startable) == 0:
		situation = fmt.Sprintf("all %d subtask(s) of this work are already closed", total)
		wayOut = "Create more with task_create and start them with task_start"
	default:
		// The number counts what the list names, not every subtask: introducing
		// a list of one with the total ("none of 6: \"Reducer\"") reads as a
		// list that was cut short.
		situation = fmt.Sprintf("none of this work's subtasks is running, though %d of them can be started: %s",
			len(startable), strings.Join(startable, ", "))
		wayOut = "Start them with task_start"
	}
	// The rule comes first so that the situation — which in the third case ends
	// in a list — is closed by the dash rather than by another comma clause,
	// which would read as one more item. Same shape as refuseIfChildrenActive
	// for the same reason: what is in the way, then the ways out, then the
	// statement of no effect, last and unmissable.
	return fmt.Errorf("%w: only a subtask closing ends a wait on subtasks, and %s — so nothing would ever end this one. %s, or call question_post if you need something from the user, or step_done if there is nothing left to do. The wait was not set",
		ErrInvalidWork, situation, wayOut)
}

// stepCount reports how many steps the work's role defines. A work whose role
// has none is stepless, and its first step_done closes it.
func (o *Operations) stepCount(w Work) (int, error) {
	if o.steps == nil {
		return 0, nil
	}
	steps, err := o.steps.GetSteps(w.AgentRoleID)
	if err != nil {
		return 0, fmt.Errorf("failed to get agent role: %w", err)
	}
	return len(steps), nil
}
