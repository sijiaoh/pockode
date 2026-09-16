package session

import "time"

// TurnPhase is what a session is doing right now, in three values that cover
// everything: it is producing output, it is stuck on something only someone
// else can clear, or it is neither.
//
// A phase is never assigned by hand: it is derived from TurnState.Open and
// TurnState.Blockers, every time, by phaseFor.
type TurnPhase string

const (
	// PhaseIdle is a session with no turn under way. The state a session is born
	// in, and the state every ending lands in.
	PhaseIdle TurnPhase = "idle"
	// PhaseRunning is a turn that is being worked on. It says nothing about how
	// often output arrives: a turn can be silent for as long as a tool call
	// takes.
	PhaseRunning TurnPhase = "running"
	// PhaseBlocked is a turn that is open but not being worked on, because
	// something outside the agent has to happen first. What, exactly, is in
	// TurnState.Blockers.
	PhaseBlocked TurnPhase = "blocked"
)

// BlockerKind names the three things a turn can be stuck on. The list is
// closed on purpose: each kind has a different thing that clears it and a
// different thing to do when it expires, so a fourth would need both answers
// before it could be added.
type BlockerKind string

const (
	// BlockerPermission is a permission request on screen with no answer yet.
	// Cleared by an answer, by the agent withdrawing it, or by the death of the
	// process that raised it.
	BlockerPermission BlockerKind = "permission"
	// BlockerQuestion is an AskUserQuestion on screen with no answer yet.
	// Cleared the same three ways.
	BlockerQuestion BlockerKind = "question"
	// BlockerBackground is a turn parked on work that outlives the tool call
	// that started it. Nobody is going to answer it: it is cleared by the agent
	// producing content again, which is what resuming looks like.
	//
	// It is a blocker rather than a kind of running because the alternative was
	// tried and is what this model replaces — the adapter used to swallow the
	// CLI's end-of-turn frame so a two-hour wait read as one long thought, which
	// left every surface drawing a spinner for work nobody was doing.
	BlockerBackground BlockerKind = "background"
)

// Blocker is one thing a turn is stuck on.
//
// It belongs to the process incarnation that raised it, and that is the whole
// of its lifetime: only the process that raised a prompt can take its answer,
// and background work dies with the CLI that started it. A blocker therefore
// never outlives its process — see ReduceTurn's handling of SignalProcessEnded
// and SignalProcessStarted.
type Blocker struct {
	Kind BlockerKind `json:"kind"`
	// RequestID is the agent's own id for the prompt, and is what an answer
	// names. Empty for BlockerBackground, which nobody answers; that is also
	// what keeps a session to a single background blocker, since two of them
	// would be indistinguishable.
	RequestID string `json:"request_id,omitempty"`
	// RaisedAt is when the blocker appeared, which is what a budget is measured
	// from once one exists.
	RaisedAt time.Time `json:"raised_at"`
}

// TurnOutcome is how the last turn ended. Empty until one has.
type TurnOutcome string

const (
	// OutcomeCompleted is a turn the agent finished.
	OutcomeCompleted TurnOutcome = "completed"
	// OutcomeFailed is a turn that stopped on an error the agent reported.
	OutcomeFailed TurnOutcome = "failed"
	// OutcomeAborted is a turn that was taken away rather than finished: a user
	// interrupt, or the death of the process carrying it. Kept apart from
	// failed because the two mean opposite things to whatever drives the work —
	// a failure is worth carrying on from, an abort is the instruction not to.
	OutcomeAborted TurnOutcome = "aborted"
)

// TurnState is what a session is doing, and it is the only place that fact is
// kept. Persisted with the session (SessionMeta.Turn), because the question
// "what is this session waiting for" has to be answerable about a session whose
// process is long gone.
//
// Phase is stored rather than recomputed on read so that what a client sees and
// what was written are the same value, but it is never assigned by hand: only
// ReduceTurn produces a TurnState, and it derives the phase from Open and
// Blockers every time (see phaseFor). A state with blockers is blocked, which is
// the invariant everything drawing this relies on.
type TurnState struct {
	Phase TurnPhase `json:"phase"`
	// Open says a turn is under way behind whatever is in its way.
	//
	// It is the one thing a phase cannot say on its own, and the case that needs
	// it is real: a CLI can raise a prompt *after* the turn it belonged to has
	// already reported its end. That session is blocked — somebody has to answer
	// — but there is no turn behind the prompt, so withdrawing it must leave the
	// session idle rather than inventing one. The old model kept this as a
	// second flag on the process for the same reason; what has changed is that
	// it is now an input to one rule instead of a rule of its own.
	Open bool `json:"open"`
	// Blockers are in the order they were raised. More than one is ordinary:
	// Claude can raise a second permission request while the first is still on
	// screen.
	Blockers []Blocker `json:"blockers,omitempty"`
	// Since is when this phase was entered, and it does not move while the phase
	// holds — an event that leaves the phase alone leaves this alone too. It is
	// what a phase budget is measured against.
	Since time.Time `json:"since"`
	// LastOutcome is how the previous turn ended, and is cleared the moment a
	// new turn starts. Reading it while Open is true would therefore be reading
	// about nothing.
	LastOutcome TurnOutcome `json:"last_outcome,omitempty"`
}

// TurnSignal is one thing that happened to a session, in the vocabulary the
// reducer reads.
//
// It is deliberately not agent.EventType. Two reasons: the session package sits
// below agent and cannot import it, and — the one that would matter anyway —
// several distinct event types mean the same thing here while one event type
// (a `system` frame) means something different depending on what raised it. The
// translation from events to signals lives with the process that streams them
// (process.turnInputFor).
type TurnSignal string

const (
	// SignalProcessStarted is a new process incarnation for this session. It
	// owns nothing yet, so anything the previous one left behind is over.
	SignalProcessStarted TurnSignal = "process_started"
	// SignalPrompt is a prompt handed to the agent — typed by the user or sent
	// by Pockode itself. Either way a turn begins.
	SignalPrompt TurnSignal = "prompt"
	// SignalOutput is the agent putting something into the conversation: text, a
	// tool call, a result. This is the only signal that ends a background wait,
	// because it is the only one that proves the CLI has resumed.
	SignalOutput TurnSignal = "output"
	// SignalNoise is the agent's process saying something that is not content —
	// a `system` frame, a live progress line. It shows the turn is alive and
	// deliberately does not clear a background blocker: the background task list
	// changing is itself a `system` frame, so treating it as resumption would
	// make a task *finishing* look like the turn coming back.
	SignalNoise TurnSignal = "noise"
	// SignalPermissionRaised and SignalQuestionRaised carry the RequestID an
	// answer will name.
	SignalPermissionRaised TurnSignal = "permission_raised"
	SignalQuestionRaised   TurnSignal = "question_raised"
	// SignalBackgroundParked is the turn being parked on background work.
	SignalBackgroundParked TurnSignal = "background_parked"
	// SignalRequestCancelled is the agent withdrawing a prompt it no longer
	// needs answered. The wait ends; the turn does not.
	SignalRequestCancelled TurnSignal = "request_cancelled"
	// SignalAnswered is the user answering a prompt. The turn resumes.
	SignalAnswered TurnSignal = "answered"
	// SignalDone, SignalFailed and SignalInterrupted are the three ways a turn
	// ends, and map one-to-one onto the three TurnOutcomes.
	SignalDone        TurnSignal = "done"
	SignalFailed      TurnSignal = "failed"
	SignalInterrupted TurnSignal = "interrupted"
	// SignalProcessEnded is the process going away — reaped, closed, crashed, or
	// killed with the server. Every blocker it raised expires with it, and a
	// turn still open when it arrives was aborted.
	SignalProcessEnded TurnSignal = "process_ended"
)

// TurnInput is one signal plus what the reducer needs to act on it.
type TurnInput struct {
	Signal TurnSignal
	// RequestID names the prompt a raise, an answer or a cancellation is about.
	// Ignored by every other signal.
	RequestID string
	// At is when this happened. Supplied by the caller rather than read from the
	// clock inside so that the reducer stays a function of its arguments.
	At time.Time
}

// TurnTransition is the result of one input: the state that follows, plus the
// two things about the step itself that cannot be read off the state afterwards.
type TurnTransition struct {
	State TurnState
	// Expired are the blockers this input ended without them being resolved —
	// nobody answered, and now nobody can. They are reported rather than merely
	// dropped because the record of a blocker's fate is Pockode's own: a CLI
	// killed with SIGKILL may not have written so much as the assistant message
	// that raised the question, so its transcript cannot be asked what happened.
	//
	// Empty for a blocker that was answered or withdrawn: those were resolved.
	Expired []Blocker
	// Ended is set when this input ended a turn. State.LastOutcome says how.
	// It is reported here rather than read off the state afterwards because the
	// state cannot tell a turn that just ended from one that ended earlier, and
	// a turn must be reported over exactly once.
	Ended bool
	// Changed is false when the input left the state exactly as it was, which is
	// the common case — most of a turn's events are output, and the second one
	// says nothing the first did not. It is what keeps a persisted TurnState
	// from being rewritten once per event.
	Changed bool
}

// ReduceTurn is the single rule for how a session's turn state changes. Every
// caller goes through it, including the ones that want a turn to end: a reaper
// with an expired lease sends the signal for the ending it wants rather than
// writing the state itself, so there is exactly one place where the transitions
// are defined and exactly one place they can be wrong.
//
// Pure, and it is worth keeping that way. This is the function that decides
// whether a session is stuck, and the alternative to testing it by enumerating
// event sequences is testing it by running agents.
func ReduceTurn(state TurnState, in TurnInput) TurnTransition {
	// A session written before turn state existed reads back with an empty
	// phase. Filling it in here rather than at every call site is what lets the
	// index be read as it is, with no migration pass over the file.
	state = state.withPhaseDefaulted()

	next := state
	next.Blockers = cloneBlockers(state.Blockers)

	var expired []Blocker
	ended := false

	switch in.Signal {
	case SignalProcessStarted:
		// A new incarnation owns nothing. Anything still listed was raised by the
		// process before it and cannot be answered now, so it expires here rather
		// than surviving as a blocker no answer can reach. Normally there is
		// nothing to expire — SignalProcessEnded already cleared it — and this is
		// what covers the case where the server died before that arrived.
		expired = next.Blockers
		next.Blockers = nil
		next.Open = false
		ended = state.Open
		if ended {
			next.LastOutcome = OutcomeAborted
		}

	case SignalPrompt:
		// Sending instead of answering abandons whatever was on screen. The
		// process is still alive, but the prompt it was holding open has been
		// overtaken, and the turn that follows is a new one.
		expired = next.Blockers
		next.Blockers = nil
		next.Open = true

	case SignalOutput:
		// The only signal that ends a background wait, and it ends every one of
		// them: content is the CLI resuming, and it resumes once.
		next.Blockers = dropKind(next.Blockers, BlockerBackground)
		next.Open = true

	case SignalNoise:
		next.Open = true

	case SignalAnswered:
		// Resolved, not expired: someone dealt with it. A signal naming a request
		// that is not listed is not an error — an answer can race the agent
		// withdrawing the same prompt — it simply removes nothing, and the answer
		// still hands the agent something to do.
		next.Blockers = dropRequest(next.Blockers, in.RequestID)
		next.Open = true

	case SignalPermissionRaised:
		next.Blockers = addBlocker(next.Blockers, Blocker{
			Kind: BlockerPermission, RequestID: in.RequestID, RaisedAt: in.At,
		})

	case SignalQuestionRaised:
		next.Blockers = addBlocker(next.Blockers, Blocker{
			Kind: BlockerQuestion, RequestID: in.RequestID, RaisedAt: in.At,
		})

	case SignalBackgroundParked:
		next.Blockers = addBlocker(next.Blockers, Blocker{
			Kind: BlockerBackground, RaisedAt: in.At,
		})

	case SignalRequestCancelled:
		// The agent withdrawing a prompt ends that wait and nothing else. Open is
		// deliberately untouched: a withdrawal during a turn leaves the turn
		// running, and a withdrawal of a prompt that outlived its turn leaves the
		// session idle. Reading it as either one outright gets the other wrong.
		next.Blockers = dropRequest(next.Blockers, in.RequestID)

	case SignalDone, SignalFailed, SignalInterrupted:
		expired = next.Blockers
		next.Blockers = nil
		next.Open = false
		// Reported once. Agents can announce the same ending twice — Codex
		// answers an aborted call itself while Pockode synthesizes a response for
		// the same call — and a second ending reads downstream as a second stop.
		ended = state.Open
		if ended {
			next.LastOutcome = outcomeFor(in.Signal)
		}

	case SignalProcessEnded:
		expired = next.Blockers
		next.Blockers = nil
		next.Open = false
		ended = state.Open
		if ended {
			// Whatever the turn was doing, it did not finish it.
			next.LastOutcome = OutcomeAborted
		}
	}

	// A turn that has just started says nothing about the one before it. Keyed
	// on the transition rather than on the signal so that every way a turn can
	// begin clears it the same way: a prompt, output the CLI resumed by itself,
	// an answer to a prompt that outlived its turn.
	if next.Open && !state.Open {
		next.LastOutcome = ""
	}

	next.Phase = phaseFor(next.Open, next.Blockers)
	if next.Phase != state.Phase {
		next.Since = in.At
	}

	return TurnTransition{
		State:   next,
		Expired: expired,
		Ended:   ended,
		Changed: !next.equal(state),
	}
}

// phaseFor is the only place a phase is decided, and it reads the blockers
// first: a turn with something in its way is blocked, whatever else is true, so
// that nothing drawing this has to look past the phase to find out. Open is what
// separates the other two — and it only ever becomes false by a turn being
// ended, which is what makes silence (a turn that has been quiet for an hour)
// read as running rather than as over.
func phaseFor(open bool, blockers []Blocker) TurnPhase {
	switch {
	case len(blockers) > 0:
		return PhaseBlocked
	case open:
		return PhaseRunning
	default:
		return PhaseIdle
	}
}

func outcomeFor(signal TurnSignal) TurnOutcome {
	switch signal {
	case SignalDone:
		return OutcomeCompleted
	case SignalFailed:
		return OutcomeFailed
	default:
		return OutcomeAborted
	}
}

// addBlocker appends unless the same prompt is already listed. A CLI can repeat
// a request id (Claude re-sends a control request it has not had an answer to),
// and two entries for one prompt would need two answers to clear.
func addBlocker(blockers []Blocker, b Blocker) []Blocker {
	for _, existing := range blockers {
		if existing.Kind == b.Kind && existing.RequestID == b.RequestID {
			return blockers
		}
	}
	return append(blockers, b)
}

func dropKind(blockers []Blocker, kind BlockerKind) []Blocker {
	kept := blockers[:0]
	for _, b := range blockers {
		if b.Kind != kind {
			kept = append(kept, b)
		}
	}
	return kept
}

// dropRequest removes the prompt an answer or a cancellation names. Background
// blockers have no request id and are never removed this way, which is why an
// empty RequestID matches nothing.
func dropRequest(blockers []Blocker, requestID string) []Blocker {
	if requestID == "" {
		return blockers
	}
	kept := blockers[:0]
	for _, b := range blockers {
		if b.RequestID != requestID {
			kept = append(kept, b)
		}
	}
	return kept
}

func cloneBlockers(blockers []Blocker) []Blocker {
	if len(blockers) == 0 {
		return nil
	}
	out := make([]Blocker, len(blockers))
	copy(out, blockers)
	return out
}

func (t TurnState) equal(other TurnState) bool {
	if t.Phase != other.Phase || t.Open != other.Open ||
		!t.Since.Equal(other.Since) || t.LastOutcome != other.LastOutcome {
		return false
	}
	if len(t.Blockers) != len(other.Blockers) {
		return false
	}
	for i := range t.Blockers {
		if t.Blockers[i].Kind != other.Blockers[i].Kind ||
			t.Blockers[i].RequestID != other.Blockers[i].RequestID ||
			!t.Blockers[i].RaisedAt.Equal(other.Blockers[i].RaisedAt) {
			return false
		}
	}
	return true
}

// withPhaseDefaulted reads an absent phase as idle, which is what it means: a
// session that has never had a turn, and every session stored by a build from
// before this field.
func (t TurnState) withPhaseDefaulted() TurnState {
	if t.Phase == "" {
		t.Phase = PhaseIdle
	}
	return t
}

// BlockedOn reports whether a blocker of this kind is in the way.
func (t TurnState) BlockedOn(kind BlockerKind) bool {
	for _, b := range t.Blockers {
		if b.Kind == kind {
			return true
		}
	}
	return false
}

// AwaitingUserAnswer reports whether the turn is stuck on something only a
// person can clear. This is what the session's old NeedsInput flag used to be
// stored as, and deriving it is why that flag is gone: a stored copy had to be
// cleared by whoever cleared the thing it described, from three different
// places, and a missed one left a session marked as waiting forever.
func (t TurnState) AwaitingUserAnswer() bool {
	return t.BlockedOn(BlockerPermission) || t.BlockedOn(BlockerQuestion)
}

// WaitingForBackground reports whether the turn is parked on background work.
func (t TurnState) WaitingForBackground() bool {
	return t.BlockedOn(BlockerBackground)
}

// InProgress reports whether a turn is open at all, blocked or running. A
// process with one still owes an ending.
//
// Not "the phase is not idle": a prompt raised after its turn already ended
// leaves a blocked session with no turn behind it (see TurnState.Open).
func (t TurnState) InProgress() bool {
	return t.Open
}

// NormalizeTurn is what a stored TurnState becomes when it is read back after a
// restart, and it is why there is no migration script for the session index.
//
// Every blocker belongs to a process incarnation, and no incarnation survives a
// restart, so a session that was mid-turn when the server stopped is a session
// whose turn was aborted — whatever the file says. Reducing the stored state
// with SignalProcessEnded is how that is stated: the same rule that handles a
// process dying while the server runs, applied to the whole index at load.
//
// It is also what a session written by an older build gets. Those carry no turn
// at all, which reads back as the zero value, and the zero phase is idle — so
// the reduction is a no-op for them and the obsolete needs_input they still
// carry on disk is simply not read.
func NormalizeTurn(state TurnState, now time.Time) TurnTransition {
	return ReduceTurn(state, TurnInput{Signal: SignalProcessEnded, At: now})
}
