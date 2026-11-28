// Package chatstream puts every record of a session on its live stream in the
// order its history holds them.
//
// A session's records come from several writers — the process reading the
// agent, the chat client writing what a person or Pockode itself said, the
// expiry of a prompt nobody answered — and each of them used to persist and
// then broadcast on its own, so a record with a higher seq could reach a client
// before one below it. The Sequencer is the one place both happen, under one
// lock per session, so the order records are handed to the Sink is the order
// they were numbered in.
package chatstream

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// HistoryWriteFailedCode is the code of the warning a session's subscribers
// are sent in place of a record its history refused.
const HistoryWriteFailedCode = "history_write_failed"

// Sink is what the Sequencer hands a session's records to, in seq order: the
// chat subscribers' queues (watch.ChatMessagesWatcher). Enqueue is called with
// the session's lock held, so it must not block — delivery to connections
// happens behind it, never inside it.
//
// seq is session.NoHistorySeq for a live event, and for the warning that
// stands in for a record that could not be written. exclude, if not nil, is a
// subscriber's notifier to leave out: the client that sent the record and has
// drawn it already.
type Sink interface {
	Enqueue(sessionID string, record agent.Wire, seq session.HistorySeq, exclude any)
}

// Appender is the half of session.Store the Sequencer writes through.
type Appender interface {
	AppendToHistory(ctx context.Context, sessionID string, record session.HistoryRecord) (session.HistorySeq, error)
}

// Sequencer appends a session's records and enqueues them, and does nothing
// else: it never writes to a connection.
type Sequencer struct {
	store Appender
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

func New(store Appender) *Sequencer {
	return &Sequencer{store: store, locks: make(map[string]*sessionLock)}
}

// SetSink names where records go. Left unset, records are only appended. Set
// before any session produces one.
func (s *Sequencer) SetSink(sink Sink) {
	s.sink = sink
}

// Append writes record to the session's history and enqueues it with the seq
// it was stored under, before any other record of the session can be either.
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

	seq, err := s.store.AppendToHistory(context.WithoutCancel(ctx), sessionID, record)
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
