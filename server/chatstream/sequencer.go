// Package chatstream puts every record of a session on its live stream in the
// order its history holds them, and says which turn each one belongs to.
//
// A session's records come from several writers — the process reading the
// agent, the chat client writing what a person or Pockode itself said, the
// expiry of a prompt nobody answered — and each of them used to persist and
// then broadcast on its own, so a record with a higher seq could reach a client
// before one below it. The Sequencer is the one place both happen, under one
// lock per session, so the order records are handed to the Sink is the order
// they were numbered in.
//
// Turns are decided under the same lock, which is what makes a record's turn
// a fact about its position: every change that opens or ends a turn is
// reduced here (Advance), so a record appended while turn T is open lands
// after T's turn_started and before T's ending, and is tagged T. The one
// record that lies after its turn's ending is a straggler: content Codex
// reports after the turn it belongs to was over (session.TurnInput.AfterTurn),
// or a tool result arriving with no turn open (session.SignalToolResult) —
// tagged with that turn rather than with the one open as it lands, or none.
package chatstream

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// HistoryWriteFailedCode is the code of the warning a session's subscribers
// are sent in place of a record its history refused.
const HistoryWriteFailedCode = "history_write_failed"

// Sink is what the Sequencer hands a session's records to, in seq order: the
// chat subscribers' queues (watch.ChatMessagesWatcher). Enqueue is called with
// the session's lock held, so it must not block — delivery to connections
// happens behind it, never inside it. Reading what the record changed off the
// session's projection is no delivery: at worst it loads the projection once
// from the file, and it holds up only this session.
//
// seq is session.NoHistorySeq for a live event, and for the warning that
// stands in for a record that could not be written. exclude, if not nil, is a
// subscriber's notifier to leave out: the client that sent the record and has
// drawn it already.
type Sink interface {
	Enqueue(sessionID string, record agent.Wire, seq session.HistorySeq, exclude any)
}

// Store is the part of session.Store the Sequencer writes through.
type Store interface {
	AppendToHistory(ctx context.Context, sessionID string, record session.HistoryRecord, turn session.HistoryTurn) (session.HistorySeq, error)
	ApplyTurn(ctx context.Context, sessionID string, in session.TurnInput) (session.TurnTransition, error)
	Get(sessionID string) (session.SessionMeta, bool, error)
}

// Sequencer appends a session's records and enqueues them, and does nothing
// else: it never writes to a connection.
type Sequencer struct {
	store Store
	sink  Sink

	locksMu sync.Mutex
	locks   map[string]*sessionLock
}

type sessionLock struct {
	sync.Mutex
	// users counts the callers holding or waiting for the lock, so the entry
	// can be dropped once nobody needs it: sessions come and go for the whole
	// life of the server.
	users int
}

func New(store Store) *Sequencer {
	return &Sequencer{store: store, locks: make(map[string]*sessionLock)}
}

// SetSink names where records go. Left unset, records are only appended. Set
// before any session produces one.
func (s *Sequencer) SetSink(sink Sink) {
	s.sink = sink
}

// Append writes record to the session's history and enqueues it with the seq
// it was stored under, before any other record of the session can be either.
// It is tagged with the turn open as it is written, or as belonging to none.
//
// A write that fails is never passed off as a live record: what a client is
// shown and then loses on reload is worse than a gap it is told about. So the
// record is not enqueued; every subscriber of the session — the sender too,
// since its own copy is not saved either — is sent a warning saying what was
// lost, and the error is returned for the caller to decide whether its own
// operation failed. A session that no longer exists has nobody to tell.
//
// The caller's cancellation is not honoured: a record is written because
// something already happened — a message reached the agent, an answer was
// given — and a client that hung up mid-request does not undo that. Losing the
// record to it would put a "could not save" warning in front of everyone else
// for nothing but a dropped connection.
func (s *Sequencer) Append(ctx context.Context, sessionID string, record agent.Record, exclude any) (session.HistorySeq, error) {
	unlock := s.lock(sessionID)
	defer unlock()
	return s.appendLocked(ctx, sessionID, record, s.openTurnLocked(sessionID), exclude)
}

// AppendTo is Append with the turn named by the caller, for a record whose
// turn is not the one open as it is written: the expiry of a prompt raised
// before the turn that has just opened, which belongs to none.
func (s *Sequencer) AppendTo(ctx context.Context, sessionID string, record agent.Record, turn session.HistoryTurn) (session.HistorySeq, error) {
	unlock := s.lock(sessionID)
	defer unlock()
	return s.appendLocked(ctx, sessionID, record, turn, nil)
}

// Advance reduces in into the session's turn state and writes what it caused,
// in one step that no other record of the session can come between: the
// turn_started record when in opened a turn, then record — nil for none —
// tagged with the turn in happened in (TurnTransition.Turn). An ending is
// tagged with the turn it ended, a straggler with the turn that ended last; an
// input that found no turn and opened none is tagged as belonging to
// none, which is what a duplicate ending is.
//
// process_ended always belongs to no turn, the one it aborts included: it is
// about the process, which outlives turns and is not one of them. It is also
// how every turn whose process stopped carrying it ends in the history, so a
// process going away that aborts a turn — or expires a prompt — with no record
// of its own to carry writes one too (abortsWithoutRecord).
//
// applied, if not nil, is handed the transition after the reduction and before
// anything is written: a caller keeping its own copy of the turn state updates
// it there, so that whoever sees one of these records sees the state it
// caused, in that copy too.
//
// Every input that can open or end a turn comes through here; that is what
// lets Append read the open turn off the store and trust it. A reduction the
// store applied but could not persist is logged and otherwise carried out —
// the store holds that state, so a turn it opened must have its turn_started —
// and returned with the error. One that applied nothing (the session is gone)
// leaves the turn where it was; the record is written anyway, tagged with
// whatever turn is open (process_ended with none), since the agent did act on
// it.
func (s *Sequencer) Advance(ctx context.Context, sessionID string, in session.TurnInput, record agent.Record, applied func(session.TurnTransition)) (session.TurnTransition, error) {
	unlock := s.lock(sessionID)
	defer unlock()

	// Minted for every input, because only the reduction can say whether this
	// one opens a turn.
	in.TurnID = newTurnID()
	transition, err := s.store.ApplyTurn(ctx, sessionID, in)
	if err != nil {
		if errors.Is(err, session.ErrSessionNotFound) {
			slog.Debug("turn state dropped, session is gone", "sessionId", sessionID, "signal", in.Signal)
		} else {
			slog.Error("failed to apply turn state", "sessionId", sessionID, "signal", in.Signal, "error", err)
		}
		if !transition.Changed {
			if record != nil {
				_, _ = s.appendLocked(ctx, sessionID, record, recordTurn(in.Signal, s.openTurnLocked(sessionID)), nil)
			}
			return transition, err
		}
	}
	if applied != nil {
		applied(transition)
	}

	if record == nil && abortsWithoutRecord(in.Signal, transition) {
		_, _ = s.appendLocked(ctx, sessionID, agent.ProcessEndedRecord{}, session.NoTurn, nil)
	}

	if transition.Started {
		started := agent.TurnStartedRecord{
			TurnID: transition.Turn,
			Origin: originOf(in.Signal),
		}
		if !in.At.IsZero() {
			started.ObservedAt = &in.At
		}
		if in.Signal == session.SignalPrompt {
			started.MessageID = in.MessageID
		}
		_, _ = s.appendLocked(ctx, sessionID, started, session.InTurn(transition.Turn), nil)
	}

	if record != nil {
		_, _ = s.appendLocked(ctx, sessionID, record, recordTurn(in.Signal, session.InTurn(transition.Turn)), nil)
	}
	return transition, err
}

func (s *Sequencer) appendLocked(ctx context.Context, sessionID string, record agent.Record, turn session.HistoryTurn, exclude any) (session.HistorySeq, error) {
	// A message is written before anyone can know whether it opens a turn or
	// joins one; the turn_started that names it says which.
	if record.Type() == agent.EventTypeMessage {
		turn = session.HistoryTurn{}
	}
	seq, err := s.store.AppendToHistory(context.WithoutCancel(ctx), sessionID, record, turn)
	if err != nil {
		if errors.Is(err, session.ErrSessionNotFound) {
			slog.Debug("history record dropped, session is gone", "sessionId", sessionID, "type", record.Type())
			return session.NoHistorySeq, err
		}
		slog.Error("failed to append to history", "sessionId", sessionID, "type", record.Type(), "error", err)
		s.enqueue(sessionID, writeFailedWarning(record.Type(), err), session.NoHistorySeq, nil)
		return session.NoHistorySeq, err
	}
	s.enqueue(sessionID, record, seq, exclude)
	return seq, nil
}

// recordTurn is the tag of the record an input of signal carries, turn being
// the one it happened in: process_ended belongs to no turn, whichever it
// aborts (see Advance).
func recordTurn(signal session.TurnSignal, turn session.HistoryTurn) session.HistoryTurn {
	if signal == session.SignalProcessEnded {
		return session.NoTurn
	}
	return turn
}

// abortsWithoutRecord reports a process going away that ends a turn, or
// expires a prompt, with no process_ended of the agent's to say so: a
// successor taking over what its predecessor never said it had stopped
// carrying (SignalProcessStarted), or a process whose stream closed before
// delivering its own (SignalProcessEnded with no record — the backstop
// process.Manager reduces when an agent fails on the way up or its loop
// panics). Its ending is written here all the same: every turn's ending is in
// the history, and an ending no agent reported is the process going away —
// the record restart repair writes for the same case (session.FileStore).
// Without it the turn's turn_started has no ending before the next one, and
// the prompts it held stay answerable on every replay.
func abortsWithoutRecord(signal session.TurnSignal, transition session.TurnTransition) bool {
	if signal != session.SignalProcessStarted && signal != session.SignalProcessEnded {
		return false
	}
	return transition.Ended || len(transition.Expired) > 0
}

// openTurnLocked is the turn a record written now belongs to. Read under the
// session's lock, and every reduction that moves a turn is made under it too
// (Advance), so it cannot change between this read and the write.
func (s *Sequencer) openTurnLocked(sessionID string) session.HistoryTurn {
	meta, ok, err := s.store.Get(sessionID)
	if err != nil || !ok {
		// Nothing to tag: the append that follows fails the same way.
		return session.NoTurn
	}
	return session.InTurn(meta.Turn.TurnID)
}

// originOf names what opened a turn from the signal that did; the reducer
// opens one on these three only.
func originOf(signal session.TurnSignal) agent.TurnOrigin {
	switch signal {
	case session.SignalPrompt:
		return agent.TurnOriginPrompt
	case session.SignalAnswered:
		return agent.TurnOriginAnswer
	default:
		return agent.TurnOriginOutput
	}
}

// newTurnID is time-ordered, so turn ids sort the way their turns began.
func newTurnID() string {
	return uuid.Must(uuid.NewV7()).String()
}

// Publish enqueues an event that is never persisted, in its place among the
// session's records.
func (s *Sequencer) Publish(sessionID string, event agent.LiveEvent) {
	unlock := s.lock(sessionID)
	defer unlock()
	s.enqueue(sessionID, event, session.NoHistorySeq, nil)
}

func (s *Sequencer) enqueue(sessionID string, record agent.Wire, seq session.HistorySeq, exclude any) {
	if s.sink != nil {
		s.sink.Enqueue(sessionID, record, seq, exclude)
	}
}

func (s *Sequencer) lock(sessionID string) (unlock func()) {
	s.locksMu.Lock()
	l, ok := s.locks[sessionID]
	if !ok {
		l = &sessionLock{}
		s.locks[sessionID] = l
	}
	l.users++
	s.locksMu.Unlock()

	l.Lock()
	return func() {
		l.Unlock()
		s.locksMu.Lock()
		l.users--
		if l.users == 0 {
			delete(s.locks, sessionID)
		}
		s.locksMu.Unlock()
	}
}

// writeFailedWarning is what a session's subscribers see in place of a record
// its history refused. It is itself not persisted — the history that just
// refused one record is no place to explain it — so it carries no seq, like
// the warning GetHistory puts in place of entries it could not read.
func writeFailedWarning(lost agent.EventType, err error) agent.WarningRecord {
	return agent.WarningEvent{
		Message: fmt.Sprintf("Pockode could not save a %s record to this session's history, so it is not shown and will be missing after a reload: %v", lost, err),
		Code:    HistoryWriteFailedCode,
	}.ToRecord()
}
