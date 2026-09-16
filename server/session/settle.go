package session

import (
	"sync"
	"time"
)

// DefaultSettleDelay is how long a session has to stay idle before its turn is
// announced as over.
//
// Where the number comes from: it is long enough to cover the gap between one
// turn ending and its replacement starting — an aborted turn is followed
// immediately by the one that replaced it, and a user answering a dead session's
// prompt builds a new process — and short enough that a person waiting for the
// work to move on does not notice it.
const DefaultSettleDelay = 2 * time.Second

// TurnEnd is a turn that ended and stayed ended.
type TurnEnd struct {
	SessionID string
	Outcome   TurnOutcome
}

// TurnSettler is the one heuristic in this design, and it is here so that it is
// the only one.
//
// A turn reaching idle is a fact; "this session has stopped" is a guess, because
// a session can start running again a moment later and for reasons that have
// nothing to do with the turn that just ended. Everything downstream of a turn
// ending acts on it — stopping work, nudging the agent to carry on — and acting
// on an ending that was immediately superseded means stopping or nudging work
// that is running right now.
//
// So the ending is held for a moment and dropped if the session comes back.
// Every consumer gets the settled answer, from here, rather than each one
// keeping its own timer and its own idea of how long to wait.
//
// A settler with no listener arms nothing at all, which is what makes it free to
// construct before anything is reading it — and today nothing is: the work
// engine is what will, and until it does the settled ending is simply not
// announced. The raw state changes every current consumer reads are unaffected
// (process.Manager.emitTurn).
type TurnSettler struct {
	delay time.Duration

	mu      sync.Mutex
	notify  func(TurnEnd)
	pending map[string]pendingEnd
	stopped bool
}

// pendingEnd is an ending waiting out the delay, and the timer that will
// announce it. The ending is held here rather than captured by the timer's
// closure so that what is waiting is a fact the settler can be asked about —
// which is also what lets its tests assert on the decision instead of on a
// stopwatch.
type pendingEnd struct {
	end   TurnEnd
	timer *time.Timer
}

func NewTurnSettler(delay time.Duration) *TurnSettler {
	return &TurnSettler{delay: delay, pending: make(map[string]pendingEnd)}
}

// SetListener names what to tell when a turn has settled. One listener: two
// would be two consumers of a guess, which is how the guess ends up made twice
// with two answers.
func (s *TurnSettler) SetListener(notify func(TurnEnd)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notify = notify
}

// Observe feeds the settler one transition. A session that is running again
// cancels whatever ending was waiting to be announced; an ending starts the
// wait.
func (s *TurnSettler) Observe(sessionID string, transition TurnTransition) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.stopped || s.notify == nil {
		return
	}

	if transition.State.InProgress() {
		s.cancelLocked(sessionID)
		return
	}
	if !transition.Ended {
		return
	}

	// Replaced rather than left alone: the newest ending is the one that
	// describes the session, and its outcome may differ from the one before it.
	s.cancelLocked(sessionID)
	s.pending[sessionID] = pendingEnd{
		end:   TurnEnd{SessionID: sessionID, Outcome: transition.State.LastOutcome},
		timer: time.AfterFunc(s.delay, func() { s.fire(sessionID) }),
	}
}

// OnSessionChange implements OnChangeListener: a deleted session has no ending
// worth announcing, because there is nothing left for anyone to do about it.
// Registering for this rather than being told by each caller is what makes it
// cover every way a session can be deleted, including the rollbacks.
//
// Called with the store's lock held, so it does no more than stop a timer.
func (s *TurnSettler) OnSessionChange(event SessionChangeEvent) {
	if event.Op != OperationDelete {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancelLocked(event.Session.ID)
}

// Stop abandons every pending announcement. Used at shutdown, where a turn
// ending is no longer anything for the server to act on.
func (s *TurnSettler) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopped = true
	for sessionID := range s.pending {
		s.cancelLocked(sessionID)
	}
}

func (s *TurnSettler) fire(sessionID string) {
	s.mu.Lock()
	// The timer may have fired while Observe or Stop was taking the lock to
	// cancel it, so the entry — not the timer — is what says this announcement
	// is still wanted, and what says which ending it is about.
	waiting, wanted := s.pending[sessionID]
	if !wanted || s.stopped {
		s.mu.Unlock()
		return
	}
	delete(s.pending, sessionID)
	end := waiting.end
	notify := s.notify
	s.mu.Unlock()

	// Outside the lock: a listener is free to do real work, and Observe keeps
	// arriving from the event streams while it does.
	notify(end)
}

func (s *TurnSettler) cancelLocked(sessionID string) {
	if waiting, ok := s.pending[sessionID]; ok {
		waiting.timer.Stop()
		delete(s.pending, sessionID)
	}
}

// waitingOn reports the ending currently held for a session, if any. It is what
// the settler's own tests assert on: whether an ending is still waiting is
// decided synchronously inside Observe, so reading that decision needs no timer
// to fire and cannot lose a race with one.
func (s *TurnSettler) waitingOn(sessionID string) (TurnEnd, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	waiting, ok := s.pending[sessionID]
	return waiting.end, ok
}
