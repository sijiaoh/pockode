package chatstream

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

type enqueued struct {
	sessionID string
	record    agent.Wire
	seq       session.HistorySeq
	exclude   any
}

type recordingSink struct {
	mu      sync.Mutex
	entries []enqueued
}

func (r *recordingSink) Enqueue(sessionID string, record agent.Wire, seq session.HistorySeq, exclude any) {
	r.mu.Lock()
	r.entries = append(r.entries, enqueued{sessionID, record, seq, exclude})
	r.mu.Unlock()
}

func (r *recordingSink) snapshot() []enqueued {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]enqueued(nil), r.entries...)
}

func newStore(t *testing.T, sessionIDs ...string) *session.FileStore {
	t.Helper()
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	for _, id := range sessionIDs {
		if _, err := store.Create(context.Background(), id, session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}
	return store
}

// The promise the whole package exists for: however many writers a session
// has, its subscribers are handed its records in the order history numbered
// them, with live progress in between and never out of place. Several writers
// at once is what a session is — the agent's stream, a person's message, an
// answer, an expiry — and with append and enqueue done separately by each,
// one writer's record could overtake another's between the two.
func TestSequencer_EnqueuesEverySessionsRecordsInSeqOrder(t *testing.T) {
	sessions := []string{"sess-a", "sess-b"}
	store := slowAfterAppend{newStore(t, sessions...)}
	sink := &recordingSink{}
	seq := New(store)
	seq.SetSink(sink)

	const writers, perWriter = 8, 50
	var wg sync.WaitGroup
	for _, sessionID := range sessions {
		for w := range writers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range perWriter {
					if w%2 == 0 {
						seq.Publish(sessionID, agent.ToolActivityEvent{ToolUseID: "call", Activity: fmt.Sprint(i)}.Encode().(agent.LiveEvent))
					}
					record := agent.TextEvent{Content: fmt.Sprintf("%d/%d", w, i)}.ToRecord()
					if _, err := seq.Append(context.Background(), sessionID, record, nil); err != nil {
						t.Errorf("Append: %v", err)
						return
					}
				}
			}()
		}
	}
	wg.Wait()

	for _, sessionID := range sessions {
		var seqs []session.HistorySeq
		live := 0
		for _, e := range sink.snapshot() {
			if e.sessionID != sessionID {
				continue
			}
			if _, ok := e.record.(agent.LiveEvent); ok {
				live++
				continue
			}
			seqs = append(seqs, e.seq)
		}
		if len(seqs) != writers*perWriter {
			t.Fatalf("%s: %d records enqueued, want %d", sessionID, len(seqs), writers*perWriter)
		}
		for i, s := range seqs {
			if s != session.HistorySeq(i+1) {
				t.Fatalf("%s: record %d enqueued with seq %d, want %d: the wire would carry %v", sessionID, i, s, i+1, seqs)
			}
		}
		if live != writers/2*perWriter {
			t.Errorf("%s: %d live events enqueued, want %d", sessionID, live, writers/2*perWriter)
		}
	}
}

// slowAfterAppend widens the window between a record taking its seq and being
// enqueued, which is where a writer outside the sequencer's lock is overtaken.
type slowAfterAppend struct{ *session.FileStore }

func (s slowAfterAppend) AppendToHistory(ctx context.Context, sessionID string, record session.HistoryRecord) (session.HistorySeq, error) {
	seq, err := s.FileStore.AppendToHistory(ctx, sessionID, record)
	if seq%3 == 0 {
		time.Sleep(100 * time.Microsecond)
	}
	return seq, err
}

func TestSequencer_PassesTheSenderOnToBeLeftOut(t *testing.T) {
	store := newStore(t, "sess")
	sink := &recordingSink{}
	seq := New(store)
	seq.SetSink(sink)

	sender := new(int)
	got, err := seq.Append(context.Background(), "sess", agent.MessageEvent{Content: "hi"}.ToRecord(), sender)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	entries := sink.snapshot()
	if len(entries) != 1 || entries[0].seq != got || entries[0].exclude != sender {
		t.Fatalf("enqueued %+v, want the record under seq %d with the sender to leave out", entries, got)
	}
}

type failingStore struct{ err error }

func (f failingStore) AppendToHistory(context.Context, string, session.HistoryRecord) (session.HistorySeq, error) {
	// A plausible seq beside the error, which nothing may pass on.
	return 42, f.err
}

// A record history refused is not shown as if it were there: it would be on
// screen now and gone on the next reload. Everyone watching is told what was
// lost instead — the sender too, whose own copy is not saved either — and the
// caller gets the error to decide what its operation does about it.
func TestSequencer_AFailedWriteIsReportedNotBroadcast(t *testing.T) {
	sink := &recordingSink{}
	writeErr := errors.New("disk full")
	seq := New(failingStore{err: writeErr})
	seq.SetSink(sink)

	got, err := seq.Append(context.Background(), "sess", agent.DoneEvent{}.ToRecord(), new(int))
	if !errors.Is(err, writeErr) {
		t.Fatalf("Append error = %v, want %v", err, writeErr)
	}
	if got.Valid() {
		t.Errorf("Append seq = %d, want none for a record that was not written", got)
	}

	entries := sink.snapshot()
	if len(entries) != 1 {
		t.Fatalf("enqueued %+v, want only the warning", entries)
	}
	warning, ok := entries[0].record.(agent.WarningRecord)
	if !ok || warning.Code != HistoryWriteFailedCode {
		t.Fatalf("enqueued %+v, want a %s warning", entries[0].record, HistoryWriteFailedCode)
	}
	if entries[0].seq.Valid() {
		t.Errorf("warning seq = %d, want none: the warning is not in history either", entries[0].seq)
	}
	if entries[0].exclude != nil {
		t.Errorf("warning leaves out %v, want every subscriber told", entries[0].exclude)
	}
}

// Output still arriving for a session deleted under it is ordinary, and there
// is nobody watching that session to warn.
func TestSequencer_AGoneSessionIsNotWarnedAbout(t *testing.T) {
	sink := &recordingSink{}
	seq := New(failingStore{err: fmt.Errorf("append: %w", session.ErrSessionNotFound)})
	seq.SetSink(sink)

	if _, err := seq.Append(context.Background(), "sess", agent.DoneEvent{}.ToRecord(), nil); !errors.Is(err, session.ErrSessionNotFound) {
		t.Fatalf("Append error = %v, want ErrSessionNotFound", err)
	}
	if entries := sink.snapshot(); len(entries) != 0 {
		t.Errorf("enqueued %+v, want nothing", entries)
	}
}

// A request whose client hung up still has its record written: whatever the
// record says already happened.
func TestSequencer_ACancelledCallerStillHasItsRecordWritten(t *testing.T) {
	store := newStore(t, "sess")
	sink := &recordingSink{}
	seq := New(store)
	seq.SetSink(sink)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := seq.Append(ctx, "sess", agent.MessageEvent{Content: "hi"}.ToRecord(), nil)
	if err != nil || !got.Valid() {
		t.Fatalf("Append = %d, %v; want the record written", got, err)
	}
	if entries := sink.snapshot(); len(entries) != 1 || entries[0].seq != got {
		t.Errorf("enqueued %+v, want the record under seq %d", entries, got)
	}
}
