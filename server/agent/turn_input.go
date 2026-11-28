package agent

import "github.com/pockode/server/session"

// TurnInputOf translates what the agent's stream put on the wire — a record,
// or a live event — into the turn reducer's vocabulary, and reports false for
// what moves no turn. Only Signal, RequestID and MessageID are filled in: the
// moment, and whether the content arrived after its turn (ArrivedAfterTurn),
// are facts about the event as it arrived, which the caller has and a record
// does not keep.
//
// It is the one definition of what an agent's output does to a turn, read by
// both of the places that need it: the process reading a live stream
// (process.turnInputFor), and the inference of turns in a history written
// before they had ids (InferHistoryTurns), which has only the records.
//
// The types that map to nothing are the ones that say nothing about a turn. A
// warning is a session-level problem and can arrive before the first message
// ever goes out — the startup warning Codex emits for a thread it cannot resume
// once marked a session as running with nothing running. A message is a prompt
// whose turn the send path starts, and an answer to a prompt likewise: neither
// comes from the agent.
//
// The fall-through is deliberately the inert one: a type nobody named here and
// nobody put in IndicatesAgentActivity moves no turn at all. That is the right
// default for something that only describes, and the wrong one for something
// that ends or blocks a turn — such a type has to be named in the switch
// below, because no predicate will pick it up.
func TurnInputOf(w Wire) (session.TurnInput, bool) {
	var in session.TurnInput

	switch r := w.(type) {
	case PermissionRequestRecord:
		in.Signal, in.RequestID = session.SignalPermissionRaised, r.RequestID
	// Only ever read back out of a history: the CLI's own question, from before
	// Pockode stopped letting a CLI ask one, held the turn on an answer the way
	// a permission request does.
	case AskUserQuestionRecord:
		in.Signal, in.RequestID = session.SignalPermissionRaised, r.RequestID
	case RequestCancelledRecord:
		in.Signal, in.RequestID = session.SignalRequestCancelled, r.RequestID
	case BackgroundWaitRecord:
		in.Signal = session.SignalBackgroundParked
	case DoneRecord:
		in.Signal = session.SignalDone
	case ErrorRecord:
		in.Signal = session.SignalFailed
		if r.AuthFailure != nil {
			in.Signal = session.SignalAuthFailed
		}
	case InterruptedRecord:
		in.Signal = session.SignalInterrupted
	case ProcessEndedRecord:
		in.Signal = session.SignalProcessEnded
	case MessageDiscardedRecord:
		in.Signal, in.MessageID = session.SignalMessageDiscarded, r.MessageID
	// The tool results that are not content: the record of how background
	// work ended. A task finishing, or being stopped, is not the CLI resuming
	// — what the model writes next is — so this must neither end a wait nor
	// open a turn. Otherwise the stopped notification of a task Stop ended
	// would reopen the turn whenever it lands after the interrupt's
	// acknowledgement, an order the CLI never promised.
	//
	// Every other result is session.SignalToolResult rather than output: a
	// result can continue a turn but never open one (see there).
	case ToolResultRecord:
		in.Signal = session.SignalToolResult
		if r.Subtype.SettlesBackgroundWork() {
			in.Signal = session.SignalNoise
		}
	default:
		switch {
		// Content is the one thing that ends a background wait: it is the
		// proof that the CLI resumed by itself. ActivatesSession is exactly
		// that set — what the agent put into the conversation, as opposed to
		// what it said about it.
		case w.Type().ActivatesSession():
			in.Signal = session.SignalOutput
		// Everything else that only arrives mid-turn shows the turn is alive
		// without proving the CLI came back: a `system` frame, a live progress
		// line. The background task list changing is a `system` frame, so
		// counting these as a resumption would make a task *finishing* look
		// like the turn returning.
		case w.Type().IndicatesAgentActivity():
			in.Signal = session.SignalNoise
		default:
			return session.TurnInput{}, false
		}
	}
	return in, true
}
