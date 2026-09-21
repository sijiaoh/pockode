package work

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// MessageSender sends system-driven automatic messages to agent sessions.
// Satisfied by *chat.Client.
type MessageSender interface {
	SendSystemMessage(ctx context.Context, sessionID, content, subtype string, meta *agent.MessageMeta) error
}

// SenderResolver resolves the MessageSender for a given worktree so that a
// work's automatic follow-up messages reach the worktree the work actually runs
// in. It returns a release func the caller MUST invoke once the send completes
// (worktrees are reference-counted). Satisfied by the worktree Manager.
type SenderResolver interface {
	ResolveSender(worktree string) (sender MessageSender, release func(), err error)
}

// staticResolver routes every worktree to a single sender. Used by SetSender
// for tests and callers that don't need per-worktree routing.
type staticResolver struct{ sender MessageSender }

func (s staticResolver) ResolveSender(string) (MessageSender, func(), error) {
	return s.sender, func() {}, nil
}

// StepProvider provides step information for agent roles.
// The work package uses this interface to avoid importing agentrole.
type StepProvider interface {
	GetSteps(agentRoleID string) ([]string, error)
}

// SessionTerminator ends the agent process behind a work's session. Satisfied by
// the worktree Manager.
//
// It exists because a work leaving active is the one thing that takes a
// session's lease away: the lease table asks "what is this turn waiting for",
// and nothing it can see knows that the work above it has been handed back to a
// person, or finished. What is terminated is the process; the session id and its
// transcript stay, which is what makes Reopen and Restart resume rather than
// start over.
type SessionTerminator interface {
	// StopSession ends the process now. The user asked for the work to stop, and
	// a turn still running is precisely what they asked to be rid of.
	StopSession(worktree, sessionID string)
	// RetireSession lets the current turn finish and then ends the process.
	// Anything raised inside that grace — a question, a permission request — is
	// cancelled with a reason saying the work has closed, because nobody is
	// coming back to it.
	RetireSession(worktree, sessionID string)
}

// DefaultMaxNudges is how many times in a row the engine will tell an agent to
// carry on before handing the work to a person instead.
//
// A nudge is a guess that the agent stopped mid-task; three of them in a row
// with nothing to show is evidence the guess is wrong, and an agent that has
// nothing left to do will answer every further nudge with another empty turn.
const DefaultMaxNudges = 3

// Engine drives work items. It is the only thing that moves a work item without
// being told to by a person or by an agent, and it has exactly eight inputs:
//
//   - HandleTurnEnded — a turn of the work's session settled.
//   - HandleUserMessage — the user handed the session something to go on.
//   - HandleUserAnswer — the user answered questions the agent had posted.
//   - HandleAgentAnswer — another agent answered a question this session's
//     agent had posted.
//   - HandleQuestionPosted — this session's agent posted a question, which the
//     story above it may be able to answer.
//   - OnWorkChange (a child leaving active) — a subtask finished, or stopped
//     being something its parent's wait could be waiting for.
//   - OnSessionChange (a deletion) — the work's session was deleted.
//   - RecoverStartup — the server started with work left over from a previous run.
//
// There are no other triggers and no special cases beside them. What the old
// AutoResumer and StatusSyncer did with process state changes is gone: a process
// state is not a work state, and every rule that read one turned out to be a
// rule about a turn ending, which is what this reads instead (session.TurnSettler).
type Engine struct {
	store        Store
	resolver     atomic.Pointer[SenderResolver]
	stepProvider atomic.Pointer[StepProvider]
	terminator   atomic.Pointer[SessionTerminator]
	turns        atomic.Pointer[TurnSource]
	ctx          context.Context
	cancel       context.CancelFunc
	maxNudges    int

	// Tracks every follow-up goroutine so Stop can wait for the writes they make.
	// spawnMu orders registration against cancellation: without it a follow-up
	// scheduled just as Stop runs could add to wg after Stop began waiting.
	spawnMu sync.Mutex
	wg      sync.WaitGroup
}

func NewEngine(store Store, maxNudges int) *Engine {
	ctx, cancel := context.WithCancel(context.Background())
	return &Engine{
		store:     store,
		ctx:       ctx,
		cancel:    cancel,
		maxNudges: maxNudges,
	}
}

// Stop refuses every further input and waits for the ones in flight to return,
// so that a stopped engine is no longer writing to the work store or sending
// messages into agent sessions. Both kinds count: the follow-ups it runs on
// goroutines of its own, and the inputs it answers on the caller's (see enter).
func (e *Engine) Stop() {
	e.spawnMu.Lock()
	e.cancel()
	e.spawnMu.Unlock()

	e.wg.Wait()
}

// enter registers work about to be done on the caller's own goroutine, so that
// Stop waits for it and a stopped engine refuses to start it. It reports whether
// the caller may proceed; if it does, the caller must call leave.
//
// The inputs that need it are the ones nobody else is holding open: a settled
// turn ending arrives on a timer of the session layer's, and the engine's answer
// to it writes the work store and sends a message. Without this, Stop returns
// while that is still in flight — and "a stopped engine is no longer writing" is
// the whole of what Stop is for.
func (e *Engine) enter() bool {
	e.spawnMu.Lock()
	defer e.spawnMu.Unlock()
	if e.ctx.Err() != nil {
		return false
	}
	e.wg.Add(1)
	return true
}

func (e *Engine) leave() {
	e.wg.Done()
}

// goFollowUp runs a follow-up on a goroutine of its own, tracked by Stop.
func (e *Engine) goFollowUp(fn func()) {
	if !e.enter() {
		return
	}
	go func() {
		defer e.leave()
		fn()
	}()
}

// SetSenderResolver installs the per-worktree sender resolver. Production wires
// the worktree Manager here so each work's automatic messages route to its own
// worktree's chat client.
func (e *Engine) SetSenderResolver(resolver SenderResolver) {
	e.resolver.Store(&resolver)
}

// SetSender installs a single sender used for every worktree. Convenience for
// tests and callers that don't need per-worktree routing.
func (e *Engine) SetSender(sender MessageSender) {
	e.SetSenderResolver(staticResolver{sender: sender})
}

// SetStepProvider sets the provider for agent role step information.
func (e *Engine) SetStepProvider(sp StepProvider) {
	e.stepProvider.Store(&sp)
}

// SetSessionTerminator installs what ends the processes of work that has left
// active. Without one the work still transitions; only the process outlives it.
func (e *Engine) SetSessionTerminator(t SessionTerminator) {
	e.terminator.Store(&t)
}

// SetTurnSource installs where the engine reads a session's unanswered
// questions. Without one every session reads as having none, which is what the
// narrow tests in this package want and what a server that cannot see the
// session layer honestly knows.
func (e *Engine) SetTurnSource(t TurnSource) {
	e.turns.Store(&t)
}

func (e *Engine) getResolver() SenderResolver {
	if p := e.resolver.Load(); p != nil {
		return *p
	}
	return nil
}

func (e *Engine) getStepProvider() StepProvider {
	if p := e.stepProvider.Load(); p != nil {
		return *p
	}
	return nil
}

func (e *Engine) getTerminator() SessionTerminator {
	if p := e.terminator.Load(); p != nil {
		return *p
	}
	return nil
}

func (e *Engine) getTurnSource() TurnSource {
	if p := e.turns.Load(); p != nil {
		return *p
	}
	return nil
}

// awaitingAnswers reports whether this work's session has posted questions
// nobody has answered.
//
// It is the one thing a session knows that the work record does not, and the
// only thing the engine asks the session layer for. Read live, at the moment the
// decision is taken, rather than carried on the turn ending: an ending is held
// back for the settle delay, and a question answered inside it must not still
// look outstanding — nor must one posted inside it look absent.
func (e *Engine) awaitingAnswers(w Work) bool {
	if w.SessionID == "" {
		return false
	}
	source := e.getTurnSource()
	if source == nil {
		// No source is not the same as a source that failed, and the two answer
		// oppositely on purpose. A missing source is a deliberate configuration —
		// the narrow tests in this package — and reading it as "everything has
		// questions" would switch nudging off entirely. A source that *failed* is
		// a session that exists and cannot be read, below.
		return false
	}
	turns, err := source.SessionTurns(w.Worktree)
	if err != nil {
		// Not knowing is not a reason to nudge: a nudge that should not have
		// been sent spends the allowance that ends in a stop. The honest answer
		// to an unreadable session is "leave it alone", and the work is still
		// reachable — a person can restart it, and an answer still wakes it.
		slog.Warn("could not read a session's questions when its turn ended",
			"workId", w.ID, "sessionId", w.SessionID, "worktree", w.Worktree, "error", err)
		return true
	}
	return len(turns[w.SessionID].Unanswered) > 0
}

// resolveSender resolves the sender for the given worktree. Returns ok=false
// when no resolver is installed or resolution fails. When ok is true the caller
// MUST invoke the returned release once the send completes.
func (e *Engine) resolveSender(worktree string) (sender MessageSender, release func(), ok bool) {
	resolver := e.getResolver()
	if resolver == nil {
		return nil, nil, false
	}
	sender, release, err := resolver.ResolveSender(worktree)
	if err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to resolve message sender", "worktree", worktree, "error", err)
		}
		return nil, nil, false
	}
	if sender == nil {
		if release != nil {
			release()
		}
		return nil, nil, false
	}
	if release == nil {
		release = func() {}
	}
	return sender, release, true
}

// stepCount is the number of steps the work's role defines, or 0 when that is
// unknown. Unknown and stepless are deliberately the same answer: both mean
// "no step context to report", and a missing provider must not block a message.
func (e *Engine) stepCount(w Work) int {
	sp := e.getStepProvider()
	if sp == nil {
		return 0
	}
	steps, err := sp.GetSteps(w.AgentRoleID)
	if err != nil {
		slog.Warn("failed to get steps for message meta", "agentRoleId", w.AgentRoleID, "error", err)
		return 0
	}
	return len(steps)
}

// --- Input 1: a turn ended ---

// nudgeLimitComment explains a stop the user did not ask for and the agent did
// not report. Without it the work is simply found stopped after a run of empty
// turns, with nothing saying that Pockode gave up rather than the agent.
const nudgeLimitComment = "Stopped automatically: the agent ended its turn without moving this work along " +
	"(no step_done, no wait, no question) too many times in a row, so Pockode stopped nudging it. " +
	"Restart the work to continue, or say what it should do next."

// HandleTurnEnded is the engine's main input: a turn of this session has ended
// and stayed ended (session.TurnSettler decided the second half).
//
// Three outcomes, one rule each:
//
//   - aborted — the turn was taken away rather than finished, by a user
//     interrupt or by the death of the process carrying it. Carrying on is the
//     one thing nobody asked for, so the work stops.
//   - completed or failed, with something outstanding — a wait on subtasks, or a
//     question nobody has answered. Leave it alone; whatever it is waiting for
//     wakes it when it arrives.
//   - completed or failed, with nothing outstanding — the agent stopped without
//     saying it was done. Nudge it, and stop the work once the allowance runs
//     out.
//
// The two things that "leave it alone" reads are kept apart because they are
// kept in different places and for good reason. A wait is on the work, declared
// by the agent about the work. An unanswered question is on the *session*: the
// agent posted it and carried on, Pockode is holding it, and the answer arrives
// as an ordinary message. They are orthogonal — a story can be waiting on its
// subtasks and have a question outstanding at once — and either one alone is
// enough to make this ending unsurprising.
//
// A failed turn is nudged like a completed one on purpose: an agent whose turn
// errored has usually lost a tool call, not the thread, and the nudge limit is
// what bounds the cost of being wrong about that.
//
// A stale ending — one whose session came back inside the settle delay — never
// reaches here: the settler drops an ending as soon as a new turn starts
// (session.TurnSettler.Observe). The one gap that leaves is a work claimed by a
// restart whose kickoff message has not gone out yet, which would be stopped by
// the abort of the run before it. It is left alone rather than guarded against:
// the gap is at most the settle delay, and a work with a turn to abort had a
// process, which means its worktree is loaded and stays loaded for the idle
// release delay — so the kickoff is milliseconds away, not seconds. Guarding it
// would need the ending's age weighed against a "when was this work last
// started", and the only field that could carry that also moves when somebody
// edits the title — which would swallow real stops instead.
func (e *Engine) HandleTurnEnded(sessionID string, outcome session.TurnOutcome) {
	if !e.enter() {
		return
	}
	defer e.leave()

	w := e.findActiveWork(sessionID)
	if w == nil {
		return
	}

	if outcome == session.OutcomeAborted {
		e.stop(w.ID, "turn aborted", "")
		return
	}

	if w.Wait != WaitNone {
		slog.Debug("turn ended on a work that is waiting, leaving it alone",
			"workId", w.ID, "wait", w.Wait)
		return
	}

	// Asked after the wait, because it is the one that costs a read of the
	// session layer and the two answers are the same "leave it alone".
	if e.awaitingAnswers(*w) {
		slog.Debug("turn ended on a work whose questions are unanswered, leaving it alone",
			"workId", w.ID, "sessionId", sessionID)
		return
	}

	count, err := e.store.RecordNudge(e.ctx, w.ID)
	if err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to count a nudge", "workId", w.ID, "error", err)
		}
		return
	}
	if count > e.maxNudges {
		slog.Info("nudge limit reached, stopping work", "workId", w.ID, "sessionId", sessionID)
		e.stop(w.ID, "nudge limit reached", nudgeLimitComment)
		return
	}

	e.sendAutoContinuation(*w, count)
}

func (e *Engine) sendAutoContinuation(w Work, nudge int) {
	sender, release, ok := e.resolveSender(w.Worktree)
	if !ok {
		return
	}
	defer release()

	var msg string
	totalSteps := 0
	if sp := e.getStepProvider(); sp != nil {
		if steps, err := sp.GetSteps(w.AgentRoleID); err == nil && len(steps) > 0 {
			msg = BuildAutoContinuationMessageWithSteps(w, steps, w.CurrentStep)
			totalSteps = len(steps)
		}
	}
	if msg == "" {
		msg = BuildAutoContinuationMessage(w)
	}
	meta := NewMessageMeta(w, w.CurrentStep+1, totalSteps)

	if err := sender.SendSystemMessage(e.ctx, w.SessionID, msg, MessageSubtypeAutoContinue, meta); err != nil {
		if e.ctx.Err() != nil {
			return // shutting down, don't log
		}
		slog.Warn("failed to send auto-continuation message", "sessionId", w.SessionID, "error", err)
		return
	}
	slog.Info("auto-continuation sent", "sessionId", w.SessionID, "workId", w.ID, "nudge", nudge)
}

// --- Input 2: the user handed the session something to go on ---

// HandleUserMessage records that the user handed this session something to go
// on: a typed message, a permission answer. The work behind it goes back to
// active with its wait and its nudge count cleared — a person is the one thing
// every wait is defined to be woken by, and their attention is what the
// allowance was counting down to in the first place.
//
// A message that *answers posted questions* is the one exception, and it has its
// own input (HandleUserAnswer).
//
// Interrupt is deliberately not this event, even though a user pressed it: it
// takes the turn away rather than handing the session something, and the abort
// it produces stops the work. Deleting the session is not this event either —
// it removes the place an answer would go, and the store's own deletion tells
// the engine so.
//
// The system-driven senders (kickoff, restart, step advance, reopen, child
// closure) put a message into a session too, but they are not a person looking
// at the work, and each already clears what it means to clear.
func (e *Engine) HandleUserMessage(sessionID string) {
	if !e.enter() {
		return
	}
	defer e.leave()

	w, found := e.findWork(sessionID)
	if !found || ValidateProgress(w.Status) != nil {
		return
	}
	if w.Status == StatusActive && w.Wait == WaitNone && w.NudgeCount == 0 {
		return // Nothing to clear; the common case for a live conversation.
	}

	if err := e.store.Activate(e.ctx, w.ID); err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to activate work on user message",
				"workId", w.ID, "from", w.Status, "error", err)
		}
		return
	}
	slog.Info("work activated by a user message",
		"workId", w.ID, "from", w.Status, "wait", w.Wait, "sessionId", sessionID)
}

// --- Input 3: the user answered questions the agent had posted ---

// HandleUserAnswer records that the user answered — or refused to answer —
// questions this session's agent posted. It is a message like any other, and it
// does one less thing than HandleUserMessage on purpose: the nudge allowance
// starts over, and a wait on subtasks is left exactly where it was.
//
// The reason is that an answer is not general-purpose attention. The agent asked
// one specific thing and went on working; a story that afterwards declared it
// was waiting for its subtasks to close is still waiting for exactly that, and
// no subtask closed. Clearing the wait would resume a story with nothing to do
// and then nudge it for having nothing to do. Typing a message *without*
// answering anything is different and still clears the wait — that is a person
// redirecting the work, which is the one thing a `child` wait yields to besides
// a subtask closing.
//
// A stopped work is woken, as by any message: the answer is a person acting on
// it, and nothing about the answer says it should stay handed back. That is why
// this goes through Activate rather than ClearNudges when the work is not
// active — the narrowing is about the wait, not about the status.
func (e *Engine) HandleUserAnswer(sessionID string) {
	if !e.enter() {
		return
	}
	defer e.leave()

	w, found := e.findWork(sessionID)
	if !found || ValidateProgress(w.Status) != nil {
		return
	}
	if w.Status != StatusActive {
		if err := e.store.Activate(e.ctx, w.ID); err != nil {
			if e.ctx.Err() == nil {
				slog.Warn("failed to activate work on an answer",
					"workId", w.ID, "from", w.Status, "error", err)
			}
			return
		}
		slog.Info("work activated by an answer", "workId", w.ID, "from", w.Status, "sessionId", sessionID)
		return
	}

	if w.NudgeCount == 0 {
		return
	}
	if err := e.store.ClearNudges(e.ctx, w.ID); err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to clear the nudge count on an answer", "workId", w.ID, "error", err)
		}
		return
	}
	slog.Info("nudge allowance reset by an answer", "workId", w.ID, "sessionId", sessionID)
}

// --- Input 4: another agent answered ---

// HandleAgentAnswer records that an agent — not the user — answered a question
// this session's agent had posted (the question_answer tool).
//
// It does the smaller half of HandleUserAnswer: the nudge allowance starts
// over, and nothing else moves. A `child` wait is left alone for the reason
// given there, and the *status* is left alone for one this path adds: only a
// person hands a work back, so only a person takes it off the shelf again. An
// agent's answer waking a stopped work would be an agent starting work
// somebody stopped, which is why question_answer refuses to deliver into one
// at all — this is the second half of that rule, stated where the status is
// owned.
func (e *Engine) HandleAgentAnswer(sessionID string) {
	if !e.enter() {
		return
	}
	defer e.leave()

	w := e.findActiveWork(sessionID)
	if w == nil || w.NudgeCount == 0 {
		return
	}
	if err := e.store.ClearNudges(e.ctx, w.ID); err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to clear the nudge count on an agent's answer", "workId", w.ID, "error", err)
		}
		return
	}
	slog.Info("nudge allowance reset by an agent's answer", "workId", w.ID, "sessionId", sessionID)
}

// --- Input 5: an agent posted a question ---

// HandleQuestionPosted passes a subtask's question up to the story above it.
//
// A story knows things its subtasks do not — what it decided, what a sibling
// already settled, what the user told it an hour ago — so a subtask asking
// "which database?" is often a question the story can simply answer, and the
// user never has to be interrupted at all. The story decides: it answers with
// question_answer, or asks the user itself with question_post.
//
// What this deliberately does *not* do is clear the parent's `child` wait. That
// wait is ended by a subtask closing and nothing else; a subtask asking a
// question is not one closing, and the subtask carries on either way. So a
// story that answers and ends its turn is still waiting for exactly what it was
// waiting for, and is not nudged for it. That is the mirror image of
// notifyParentOfChild, which does clear it, because there the thing the wait
// was for has happened.
func (e *Engine) HandleQuestionPosted(sessionID string, q session.PendingQuestion) {
	if !e.enter() {
		return
	}
	defer e.leave()

	child, found := e.findWork(sessionID)
	if !found || child.ParentID == "" {
		return
	}
	e.goFollowUp(func() { e.notifyParentOfChildQuestion(child, q) })
}

// notifyParentOfChildQuestion delivers one subtask question to its story.
//
// Nothing is retried and nothing is stopped when it cannot be delivered — a
// stopped or closed parent, a parent whose turn is held open by a permission
// request — and that is the difference from the two notifications below it.
// Those two carry news a waiting parent is *owed*: the wait is cleared by them,
// so an undelivered one leaves a work waiting for something that already
// happened. This one clears nothing. The question stays on the subtask, where
// the user can see it and answer it, and the parent's wait is exactly as it
// was. The way back is the person's: restarting or reopening the story tells it
// to go and look at its subtasks' unanswered questions (work_get).
func (e *Engine) notifyParentOfChildQuestion(child Work, q session.PendingQuestion) {
	parent, found, err := e.store.Get(child.ParentID)
	if err != nil {
		slog.Warn("failed to get parent work for a child's question", "parentId", child.ParentID, "error", err)
		return
	}
	if !found || parent.SessionID == "" {
		return
	}
	if parent.Status != StatusActive {
		slog.Debug("a subtask asked a question under a parent the engine is not driving",
			"parentId", parent.ID, "parentStatus", parent.Status, "childId", child.ID)
		return
	}

	sender, release, ok := e.resolveSender(parent.Worktree)
	if !ok {
		slog.Warn("could not reach a story with its subtask's question",
			"parentId", parent.ID, "childId", child.ID, "requestId", q.RequestID)
		return
	}
	defer release()

	msg := BuildChildQuestionMessage(parent, child.Title, child.ID, q)
	meta := NewMessageMeta(parent, parent.CurrentStep+1, e.stepCount(parent))
	meta.Child = &agent.ChildInfo{ID: child.ID, Title: child.Title}
	if err := sender.SendSystemMessage(e.ctx, parent.SessionID, msg, MessageSubtypeChildQuestion, meta); err != nil {
		if e.ctx.Err() != nil {
			return
		}
		// Warn and stop there: the user can still answer this question, and the
		// parent has lost nothing it was holding.
		slog.Warn("failed to pass a subtask's question to its story",
			"parentId", parent.ID, "childId", child.ID, "requestId", q.RequestID, "error", err)
		return
	}
	slog.Info("subtask question passed to its story",
		"parentId", parent.ID, "childId", child.ID, "requestId", q.RequestID)
}

// --- Input 6: a child work left active ---

// OnWorkChange implements OnChangeListener. Two things are read off a work
// changing: a child leaving active, which its parent may have to be told about,
// and a work leaving active, which takes its session's lease away.
func (e *Engine) OnWorkChange(event ChangeEvent) {
	// A work is born open with no session and nothing to report, so a create is
	// news to nobody.
	if event.Op == OperationCreate {
		return
	}
	child := event.Work
	if event.Op == OperationUpdate {
		e.enforceSessionLease(child)
	}
	// A missing resolver is deliberately *not* checked here. It used to be, and
	// it silently dropped every event that arrived before the resolver was
	// installed — which is to say it turned "I cannot reach this parent" into
	// "this parent was never owed anything". Each follow-up below now answers
	// that for itself, and none of them may leave a `child` wait standing (see
	// failedToReach). A `user` wait is untouched either way — a person is
	// reachable whether or not this process can find a worktree.
	if child.ParentID == "" {
		return
	}

	// What the parent is owed depends on how the child left, and a child that is
	// still active owes it nothing — which is why there is no case for it.
	//
	// Every branch below tests a *condition* rather than a transition, so an
	// ordinary edit to a subtask that stopped some time ago re-checks a parent
	// that may be stuck. That is deliberate: it is one more chance to notice,
	// and on a parent that is fine it costs a store read.
	switch {
	case event.Op == OperationDelete:
		e.goFollowUp(func() { e.notifyParentOfStrandedWait(child, childDeleted) })
	case child.Status == StatusClosed:
		// A closing child has a report to deliver, so its parent is told whether
		// or not other subtasks are still running.
		e.goFollowUp(func() { e.notifyParentOfChild(child) })
	case child.Status == StatusStopped:
		e.goFollowUp(func() { e.notifyParentOfStrandedWait(child, childStopped) })
	case child.Status == StatusOpen:
		e.goFollowUp(func() { e.notifyParentOfStrandedWait(child, childNotStarted) })
	}
}

// childExit is how a child stopped being something a parent's wait could be
// waiting for: deleted, stopped short of closing, or never started (a claim
// rolled back). The three are kept apart rather than flattened into "gone",
// because the way back differs and the parent is the one choosing it: a stopped
// or unstarted child is started by id, a deleted one has no id left and has to
// be replaced.
type childExit string

const (
	childDeleted    childExit = "deleted"
	childStopped    childExit = "stopped"
	childNotStarted childExit = "not_started"
)

// enforceSessionLease is the whole of "a work that has left active has no
// lease". It is hung on the change event rather than on each command so that
// every way a work leaves active — a user's Stop, an abort, the nudge limit, a
// deleted session, a step that closed it — ends the process the same way.
func (e *Engine) enforceSessionLease(w Work) {
	terminator := e.getTerminator()
	if terminator == nil || w.SessionID == "" {
		return
	}
	switch w.Status {
	case StatusStopped:
		terminator.StopSession(w.Worktree, w.SessionID)
	case StatusClosed:
		terminator.RetireSession(w.Worktree, w.SessionID)
	}
}

// notifyParentOfChild tells a parent that one of its children closed, and wakes
// it if it was waiting for exactly that.
//
// Only an active parent is told, and that is stricter than it used to be. A
// message is not a note left on a desk: it starts a turn, and starting a turn on
// a session whose process has been collected builds a new one. Sending to a
// *stopped* parent therefore spawns a CLI and lets it work on a story a person
// has taken back — which is the one thing `stopped` exists to prevent. Nothing
// is lost by waiting: the child's report is a comment on the work, the closure
// is in the work store, and the restart prompt tells the agent to review its
// tasks before doing anything.
func (e *Engine) notifyParentOfChild(child Work) {
	parent, found, err := e.store.Get(child.ParentID)
	if err != nil {
		slog.Warn("failed to get parent work for child closure", "parentId", child.ParentID, "error", err)
		return
	}
	if !found || parent.SessionID == "" {
		return
	}
	if parent.Status != StatusActive {
		slog.Debug("child closed under a parent the engine is not driving",
			"parentId", parent.ID, "parentStatus", parent.Status, "childId", child.ID)
		return
	}

	// Resolved before the transition so a resolve failure does not leave a
	// waiting parent resumed but un-nudged. Routed to the parent's own worktree:
	// children share it, but the parent is authoritative for its session.
	sender, release, ok := e.resolveSender(parent.Worktree)
	if !ok {
		e.failedToReach(parent.ID, "could not deliver a closing child's report", childReportUndelivered)
		return
	}
	defer release()

	// A parent waiting on its children has been handed what it was waiting for.
	// A parent that declared no wait has nothing to be cleared — it was already
	// being driven — and the child's news arrives in the transcript either way.
	waitCleared := parent.Wait == WaitChild
	if waitCleared {
		if err := e.store.Activate(e.ctx, parent.ID); err != nil {
			if e.ctx.Err() != nil {
				return
			}
			slog.Warn("failed to resume a parent waiting on its children", "parentId", parent.ID, "error", err)
			return
		}
	}

	// The message says whether the wait is gone, so the parent knows whether it
	// has to ask for one again; the same decision governs both, which is why it
	// is taken once here.
	msg := BuildChildCompletionMessage(parent, child.Title, child.ID, waitCleared)
	// Addressed to the parent's session, so the meta describes the parent; the
	// child rides along in its own field.
	meta := NewMessageMeta(parent, parent.CurrentStep+1, e.stepCount(parent))
	meta.Child = &agent.ChildInfo{ID: child.ID, Title: child.Title}
	if err := sender.SendSystemMessage(e.ctx, parent.SessionID, msg, MessageSubtypeChildDone, meta); err != nil {
		if e.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send child completion message to parent", "parentId", parent.ID, "childId", child.ID, "error", err)
		if waitCleared {
			// The wait is already gone, so this parent is no longer waiting for
			// anything — but nothing told it so, and nothing else will.
			e.stop(parent.ID, "could not deliver a closing child's report", childReportUndelivered)
		}
		return
	}
	slog.Info("child completion message sent to parent", "parentId", parent.ID, "childId", child.ID, "parentStatus", parent.Status)
}

// notifyParentOfStrandedWait wakes a parent whose wait on its subtasks has
// nothing left that could end it.
//
// A `child` wait is cleared by exactly one event — a subtask closing — so a
// parent waiting with no subtask running is waiting for something that is never
// going to happen. The engine does not nudge a waiting work (that is what a wait
// means), its process is collected by the idle lease minutes later, and
// `waiting_children` is deliberately outside the attention dot
// (docs/lifecycle-ui.md §4). Nothing else would ever look at it again.
//
// So the wait is cleared and the agent is told, and the engine does not decide
// what should happen instead: only the agent knows whether the subtask should be
// restarted, replaced, or was never needed. Once the wait is gone the ordinary
// nudge allowance applies again, which is the backstop if the agent does nothing
// with the news.
//
// Deciding and clearing are one store call. A check followed by a write would
// send this news twice when two subtasks leave at once, and would send it at all
// when a person starts another subtask in between.
//
// Waking is deliberately *not* stopping the parent — *while the server is
// running*. Stopping would take away the one recovery that costs nobody
// anything — the agent restarting the subtask itself — and would make a user who
// stopped one subtask restart two things. That reasoning holds exactly as long
// as there is an agent to wake: at startup there is not, and RecoverStartup
// stops the same shape of parent for that reason, not because this one is wrong.
// The same fork appears below, where the news cannot be delivered.
func (e *Engine) notifyParentOfStrandedWait(child Work, exit childExit) {
	parent, found, err := e.store.Get(child.ParentID)
	if err != nil {
		slog.Warn("failed to get parent work for a child leaving active", "parentId", child.ParentID, "error", err)
		return
	}
	// Not found is the ordinary case of a deleted story: the cascade emits the
	// children too, and by then the parent is gone with them.
	if !found || parent.SessionID == "" {
		return
	}
	if parent.Status != StatusActive || parent.Wait != WaitChild {
		return
	}

	// Resolved before the transition for the reason notifyParentOfChild gives:
	// a resolve failure must not leave the parent resumed but un-nudged — and
	// here it would be resumed with nothing having told it why. failedToReach
	// then asks the same question this function was about to, and hands the
	// parent to the user if the answer is still "nothing is left".
	sender, release, ok := e.resolveSender(parent.Worktree)
	if !ok {
		e.failedToReach(parent.ID, "could not tell a parent its wait had nothing left to end it", strandedNewsUndelivered)
		return
	}
	defer release()

	// The store takes the whole decision — is this wait stranded, and am I the
	// one ending it — under its own lock, and the answer is what says there is
	// news to deliver. The checks above are only a cheap way not to reach for a
	// sender for the parents that plainly have nothing to hear.
	cleared, err := e.store.ClearChildWaitIfStranded(e.ctx, parent.ID)
	if err != nil {
		if e.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to clear a wait nothing could end", "parentId", parent.ID, "error", err)
		return
	}
	if !cleared {
		return
	}

	msg := BuildStrandedWaitMessage(parent, child.Title, child.ID, exit)
	meta := NewMessageMeta(parent, parent.CurrentStep+1, e.stepCount(parent))
	meta.Child = &agent.ChildInfo{ID: child.ID, Title: child.Title}
	if err := sender.SendSystemMessage(e.ctx, parent.SessionID, msg, MessageSubtypeWaitStranded, meta); err != nil {
		if e.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to tell a parent its wait had nothing left to end it",
			"parentId", parent.ID, "childId", child.ID, "error", err)
		// The wait is gone but the news never landed, so nobody in this process
		// knows the parent has something to decide. Hand it to the user.
		e.stop(parent.ID, "could not tell a parent its wait had nothing left to end it", strandedNewsUndelivered)
		return
	}
	slog.Info("cleared a wait nothing could end", "parentId", parent.ID, "childId", child.ID, "exit", exit)
}

// The two comments below explain a stop that no user asked for and no agent
// reported: the engine had news a waiting work needed and could not get it into
// the session. Stopping is what keeps the failure findable: `stopped` has a list
// group of its own, ordered above `open`, and a Restart in the row. A work left
// waiting on a subtask that is gone sits in *Active* among the works that are
// genuinely running, which is where it is never looked at again. Neither state
// carries the attention dot (docs/lifecycle-ui.md §4) — a stopped work needs a
// person whenever they get to it, not now.
//
// They are two and not one because they describe opposite news. Telling an agent
// its subtask finished, in words that say its subtasks went wrong, would send the
// user looking for a problem that is not there.
const (
	strandedNewsUndelivered = "Stopped automatically: this work was waiting on its subtasks, none of them is " +
		"running any more, and Pockode could not reach its agent session to say so. Check its subtasks and " +
		"restart the work to continue."

	// It deliberately does not say whether other subtasks are still running. One
	// of the two paths that use it — a send that failed after the wait was
	// already cleared — is reached with another subtask alive, so the claim
	// would be false there.
	childReportUndelivered = "Stopped automatically: a subtask of this work finished, but Pockode could not reach " +
		"this work's agent session to deliver the report. The subtask's own report is on the subtask itself. " +
		"Check this work's subtasks and restart it to continue."
)

// failedToReach is what the engine does with a parent it owes news to and cannot
// reach. The news is lost either way; the parent must not be.
//
// If the wait still has a running subtask behind it, that subtask's own exit
// brings the engine back here, so there is a later chance and nothing to do now.
// If nothing is left, the wait is ended and the work is stopped — the same
// answer RecoverStartup gives, and for the same reason: waking presumes an agent
// to wake, and an unreachable session is not one.
func (e *Engine) failedToReach(parentID, reason, comment string) {
	cleared, err := e.store.ClearChildWaitIfStranded(e.ctx, parentID)
	if err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to clear the wait of a parent that could not be reached",
				"parentId", parentID, "error", err)
		}
		return
	}
	if !cleared {
		return
	}
	e.stop(parentID, reason, comment)
}

// --- Input 7: the session was deleted ---

// deletedSessionComment explains a stop whose cause is no longer on screen: the
// chat the work ran in is gone, so there is nothing for the user to open and
// nothing that says why the work stopped.
const deletedSessionComment = "Stopped automatically: this work's chat session was deleted, so there is nowhere " +
	"for its agent to continue. Restarting the work begins a new session."

// OnSessionChange implements session.OnChangeListener. A deleted session takes
// away the place every answer and every nudge would have gone, so the work above
// it stops — including one that was waiting, which is the case a dying process
// deliberately does not cover (a process can die and be resumed; a deleted
// session cannot).
func (e *Engine) OnSessionChange(event session.SessionChangeEvent) {
	if event.Op != session.OperationDelete {
		return
	}
	sessionID := event.Session.ID
	// The session store holds its lock across this call, and everything below
	// reads and writes the work store.
	e.goFollowUp(func() {
		w, found := e.findWork(sessionID)
		if !found || w.Status == StatusStopped || ValidateProgress(w.Status) != nil {
			return
		}
		e.stop(w.ID, "session deleted", deletedSessionComment)
	})
}

// --- Input 8: startup ---

// orphanedWorkComment explains a stop nobody asked for. Background tasks are
// called out because they are the part a user is least likely to expect to have
// died: they were started to outlive a turn, and they do — but not the process.
const orphanedWorkComment = "Stopped automatically: the Pockode server restarted while this work was still open. " +
	"No agent process survives a restart, so anything that was running for this work — including background tasks — " +
	"is gone and no result is coming from it. Restart the work to continue it."

// strandedWaitComment explains the second half of startup recovery: a work that
// declared a wait, whose wait the first half emptied out from under it.
const strandedWaitComment = "Stopped automatically: this work was waiting for its subtasks to finish, and none " +
	"of them is running any more — no agent process survives a server restart. Nothing is left that could end " +
	"the wait, so the work would have sat here forever. Check its subtasks and restart the work to continue."

// RecoverStartup deals with the work a previous run left active. Call it at
// startup, before any session can be created.
//
// turns is where a session's unanswered questions are read from, and it is a
// parameter rather than the engine's own TurnSource because of when this runs:
// before the worktree manager exists (see main.go, where that order is
// deliberate). What is passed is a reader of the session index on disk, which is
// exactly right here — no process survived the restart, so no worktree holds a
// value newer than the file.
//
// A work with nothing outstanding was being carried by a process that no longer
// exists, and nothing is going to end the turn it was in the middle of: it
// stops, and says why. A work that declared a wait, or whose session has a
// question nobody answered, is left exactly as it is — what it is waiting for
// outlives the process, because a closing child and a person's answer both reach
// it from outside the session. That is the difference the old code could not
// express, and why every paused work used to come back from a restart stopped.
//
// The catch is that the first half invalidates the second: stopping a subtask is
// exactly what empties a parent's `child` wait. So the waits are re-examined
// afterwards, as a *condition* — "is anything left that could end this" — rather
// than as a reaction to the stops just made. A reaction would have to be ordered
// against them, and ordering is what produced the bug this exists to close: the
// engine is not yet a listener on the work store when RecoverStartup runs (see
// main.go, where that order is deliberate), so its own stops reach nobody.
func (e *Engine) RecoverStartup(turns TurnSource) {
	works, err := e.store.List()
	if err != nil {
		slog.Warn("failed to list works for startup recovery", "error", err)
		return
	}

	// One resolver for the whole pass: it reads each worktree's session index
	// once, and a restart is exactly the moment when nothing is changing
	// underneath it.
	resolver := NewActivityResolver(turns)
	for _, w := range works {
		if w.Status != StatusActive || w.Wait != WaitNone {
			continue
		}
		if len(resolver.PendingQuestions(w)) > 0 {
			slog.Info("work left active with questions outstanding, keeping it",
				"workId", w.ID, "sessionId", w.SessionID)
			continue
		}
		e.stop(w.ID, "server restarted while the work was active", orphanedWorkComment)
	}

	e.recoverStrandedWaits()
}

// recoverStrandedWaits stops every work left waiting on subtasks that no longer
// run. It is the startup counterpart of notifyParentOfStrandedWait, and it takes
// the opposite action on purpose: that one wakes an agent and lets it decide,
// which presumes an agent. Here every process died with the last run, so there
// is nobody to decide and nothing to tell. Stopping is also the only way this
// stays findable: `stopped` is its own list group with a Restart in the row,
// while a work waiting on children sits in *Active* alongside the ones that are
// really running (docs/lifecycle-ui.md §6.1).
//
// A work with questions outstanding is *not* exempt here, and that is not an
// oversight. This pass is only about works that declared a `child` wait, and
// such a work is stuck whatever else is true of it: nothing is left that could
// end the wait, the engine does not nudge a waiting work, and an answer to one
// of its questions clears the nudge count rather than the wait
// (HandleUserAnswer). Stopping is what makes it findable — and the questions
// survive the stop, so the user is still offered them and answering one wakes
// the work.
//
// One pass is enough, and that rests on a fact this package enforces rather than
// on luck: a `child` wait is only ever set by Store.SetChildWait, which requires
// an active child, so only a work type that can have children can hold one — and
// today that is exactly the top-level type (validParents). Nothing sits above a
// work stopped here, so no stop in this pass can strand another wait.
// TestOnlyTopLevelWorkCanHaveChildren fails if the hierarchy grows a level,
// which is when this would have to become a loop to a fixed point.
func (e *Engine) recoverStrandedWaits() {
	works, err := e.store.List()
	if err != nil {
		slog.Warn("failed to list works while re-examining stranded waits", "error", err)
		return
	}

	for _, w := range works {
		if w.Status != StatusActive || w.Wait != WaitChild {
			continue
		}
		if HasActiveChild(works, w.ID) {
			continue
		}
		e.stop(w.ID, "server restarted and nothing was left to end the work's wait", strandedWaitComment)
	}
}

// --- Follow-ups requested by the command path ---

// NotifyStepDone sends the next-step prompt after an in-process step advance.
// Requested explicitly by Operations.StepDone rather than read off the change
// event, because only the caller knows the advance is the one it just made.
// Safe to call when the work has closed: sendStepAdvance bounds-checks the step.
func (e *Engine) NotifyStepDone(w Work) {
	sp := e.getStepProvider()
	// Only prompt the next step while the work is still being driven: a
	// concurrent transition may have landed between the caller's StepDone and
	// its re-read.
	if e.getResolver() == nil || sp == nil || w.SessionID == "" || w.Status != StatusActive {
		return
	}
	e.goFollowUp(func() { e.sendStepAdvance(w, sp) })
}

// NotifyReopen sends the reopen message after an in-process work_reopen.
func (e *Engine) NotifyReopen(w Work) {
	if e.getResolver() == nil || w.SessionID == "" {
		return
	}
	e.goFollowUp(func() { e.sendReopen(w) })
}

func (e *Engine) sendStepAdvance(w Work, sp StepProvider) {
	steps, err := sp.GetSteps(w.AgentRoleID)
	if err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to get steps for step advance", "agentRoleId", w.AgentRoleID, "error", err)
		}
		return
	}

	// CurrentStep is already advanced; validate bounds
	if len(steps) == 0 || w.CurrentStep >= len(steps) {
		return
	}

	sender, release, ok := e.resolveSender(w.Worktree)
	if !ok {
		return
	}
	defer release()

	msg := BuildStepAdvanceMessage(w, steps[w.CurrentStep], w.CurrentStep+1, len(steps))
	meta := NewMessageMeta(w, w.CurrentStep+1, len(steps))
	if err := sender.SendSystemMessage(e.ctx, w.SessionID, msg, MessageSubtypeStepAdvance, meta); err != nil {
		if e.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send step advance message", "workId", w.ID, "step", w.CurrentStep, "error", err)
		return
	}
	slog.Info("step advance message sent", "workId", w.ID, "sessionId", w.SessionID, "step", w.CurrentStep+1, "totalSteps", len(steps))
}

func (e *Engine) sendReopen(w Work) {
	sender, release, ok := e.resolveSender(w.Worktree)
	if !ok {
		return
	}
	defer release()

	msg := BuildReopenMessage(w)
	meta := NewMessageMeta(w, w.CurrentStep+1, e.stepCount(w))
	if err := sender.SendSystemMessage(e.ctx, w.SessionID, msg, MessageSubtypeReopen, meta); err != nil {
		if e.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send reopen message", "workId", w.ID, "error", err)
		return
	}
	slog.Info("reopen message sent", "workId", w.ID, "sessionId", w.SessionID)
}

// --- Helpers ---

// stop stops a work and, when there is something to explain, says why in a
// comment. reason is for the log; comment is for the user, and is empty for the
// stops whose cause they just performed themselves.
func (e *Engine) stop(workID, reason, comment string) {
	if err := e.store.Stop(e.ctx, workID); err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to stop work", "workId", workID, "reason", reason, "error", err)
		}
		return
	}
	slog.Info("work stopped", "workId", workID, "reason", reason)

	if comment == "" {
		return
	}
	if _, err := e.store.AddComment(e.ctx, workID, comment); err != nil {
		if e.ctx.Err() == nil {
			slog.Warn("failed to explain why work was stopped", "workId", workID, "error", err)
		}
	}
}

func (e *Engine) findWork(sessionID string) (Work, bool) {
	w, found, err := e.store.FindBySessionID(sessionID)
	if err != nil {
		slog.Warn("failed to find work by session ID", "sessionId", sessionID, "error", err)
		return Work{}, false
	}
	return w, found
}

// findActiveWork is the lookup every engine input starts from: a work the engine
// is not driving is one it must not move.
func (e *Engine) findActiveWork(sessionID string) *Work {
	w, found := e.findWork(sessionID)
	if !found || w.Status != StatusActive {
		return nil
	}
	return &w
}
