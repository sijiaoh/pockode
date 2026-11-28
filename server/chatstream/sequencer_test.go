package chatstream

import (
	"context"
	"errors"
	"fmt"
	"slices"
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

func (s slowAfterAppend) AppendToHistory(ctx context.Context, sessionID string, record session.HistoryRecord, turn session.HistoryTurn) (session.HistorySeq, error) {
	seq, err := s.FileStore.AppendToHistory(ctx, sessionID, record, turn)
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

// failingStore refuses every write; ApplyTurn and Get come from the embedded
// nil interface and are not reached by the tests that use it.
type failingStore struct {
	Store
	err error
}

func (f failingStore) Get(string) (session.SessionMeta, bool, error) {
	return session.SessionMeta{}, false, nil
}

func (f failingStore) AppendToHistory(context.Context, string, session.HistoryRecord, session.HistoryTurn) (session.HistorySeq, error) {
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

// turnsOf reads the session's history back as each record's type and the turn
// its envelope tags it with.
func turnsOf(t *testing.T, store *session.FileStore, sessionID string) ([]agent.Record, []session.HistoryTurn) {
	t.Helper()
	raws, err := store.GetHistory(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	records := make([]agent.Record, len(raws))
	turns := make([]session.HistoryTurn, len(raws))
	for i, raw := range raws {
		if records[i], err = agent.DecodeRecord(raw); err != nil {
			t.Fatalf("DecodeRecord %s: %v", raw, err)
		}
		turns[i] = session.HistoryTurnOf(raw)
	}
	return records, turns
}

func advance(t *testing.T, s *Sequencer, in session.TurnInput, record agent.Record) session.TurnTransition {
	t.Helper()
	in.At = time.Now()
	transition, err := s.Advance(context.Background(), "sess", in, record, nil)
	if err != nil {
		t.Fatalf("Advance(%s): %v", in.Signal, err)
	}
	return transition
}

// A turn as history holds it: its message untagged, a turn_started naming the
// message, everything until the ending — that included — tagged with the turn,
// and whatever arrives once it is over tagged as belonging to none.
func TestSequencer_TagsEachRecordWithItsTurn(t *testing.T) {
	store := newStore(t, "sess")
	sink := &recordingSink{}
	s := New(store)
	s.SetSink(sink)
	ctx := context.Background()

	message := agent.MessageEvent{Content: "go", MessageID: "m1"}.ToRecord()
	if _, err := s.Append(ctx, "sess", message, nil); err != nil {
		t.Fatalf("Append: %v", err)
	}
	opened := advance(t, s, session.TurnInput{Signal: session.SignalPrompt, MessageID: "m1"}, nil)
	if !opened.Started || opened.Turn == "" {
		t.Fatalf("prompt = %+v, want it to open a turn with an id", opened)
	}
	turn := opened.Turn
	advance(t, s, session.TurnInput{Signal: session.SignalOutput}, agent.TextEvent{Content: "on it"}.ToRecord())
	if _, err := s.Append(ctx, "sess", agent.MessageIngestedEvent{MessageID: "m1"}.ToRecord(), nil); err != nil {
		t.Fatalf("Append: %v", err)
	}
	advance(t, s, session.TurnInput{Signal: session.SignalInterrupted}, agent.InterruptedEvent{}.ToRecord())
	// Claude's second interrupted for the same Stop.
	advance(t, s, session.TurnInput{Signal: session.SignalInterrupted}, agent.InterruptedEvent{}.ToRecord())
	if _, err := s.Append(ctx, "sess", agent.WarningEvent{Message: "after"}.ToRecord(), nil); err != nil {
		t.Fatalf("Append: %v", err)
	}

	records, turns := turnsOf(t, store, "sess")
	want := []struct {
		typ  agent.EventType
		turn session.HistoryTurn
	}{
		{agent.EventTypeMessage, session.HistoryTurn{}},
		{agent.EventTypeTurnStarted, session.InTurn(turn)},
		{agent.EventTypeText, session.InTurn(turn)},
		{agent.EventTypeMessageIngested, session.InTurn(turn)},
		{agent.EventTypeInterrupted, session.InTurn(turn)},
		{agent.EventTypeInterrupted, session.NoTurn},
		{agent.EventTypeWarning, session.NoTurn},
	}
	if len(records) != len(want) {
		t.Fatalf("history = %+v, want %d records", records, len(want))
	}
	for i, w := range want {
		if records[i].Type() != w.typ || turns[i] != w.turn {
			t.Errorf("record %d = %s in %+v, want %s in %+v", i, records[i].Type(), turns[i], w.typ, w.turn)
		}
	}

	started := records[1].(agent.TurnStartedRecord)
	if started.TurnID != turn || started.Origin != agent.TurnOriginPrompt || started.MessageID != "m1" || started.ObservedAt == nil {
		t.Errorf("turn_started = %+v, want turn %q opened by prompt m1, with its moment", started, turn)
	}

	// The turn_started is on the stream too, in its place.
	var streamed []agent.EventType
	for _, e := range sink.snapshot() {
		streamed = append(streamed, e.record.Type())
	}
	if len(streamed) != len(want) || streamed[1] != agent.EventTypeTurnStarted {
		t.Errorf("streamed %v, want every record in history order", streamed)
	}
}

// A turn nothing prompted — output after a done, with no message between —
// still starts with a record of its own, and a new id.
func TestSequencer_OutputWithNoTurnOpenStartsOne(t *testing.T) {
	store := newStore(t, "sess")
	s := New(store)

	first := advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	advance(t, s, session.TurnInput{Signal: session.SignalDone}, agent.DoneEvent{}.ToRecord())
	second := advance(t, s, session.TurnInput{Signal: session.SignalOutput}, agent.TextEvent{Content: "one more thing"}.ToRecord())

	if !second.Started || second.Turn == "" || second.Turn == first.Turn {
		t.Fatalf("output after the turn = %+v, want a new turn opened (the first was %q)", second, first.Turn)
	}
	records, turns := turnsOf(t, store, "sess")
	// turn_started, done, turn_started, text
	if len(records) != 4 {
		t.Fatalf("history = %+v, want two turns' worth", records)
	}
	started, ok := records[2].(agent.TurnStartedRecord)
	if !ok || started.Origin != agent.TurnOriginOutput || started.MessageID != "" || started.TurnID != second.Turn {
		t.Errorf("record 2 = %+v, want turn %q started by output", records[2], second.Turn)
	}
	if turns[3] != session.InTurn(second.Turn) {
		t.Errorf("the output is in %+v, want the turn it opened", turns[3])
	}
}

// process_ended is about the process, not a turn, even when it is what ends
// one.
func TestSequencer_ProcessEndedBelongsToNoTurn(t *testing.T) {
	store := newStore(t, "sess")
	s := New(store)

	advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	ended := advance(t, s, session.TurnInput{Signal: session.SignalProcessEnded}, agent.ProcessEndedEvent{}.ToRecord())
	if !ended.Ended {
		t.Fatalf("process_ended = %+v, want it to abort the open turn", ended)
	}

	records, turns := turnsOf(t, store, "sess")
	if last := len(records) - 1; records[last].Type() != agent.EventTypeProcessEnded || turns[last] != session.NoTurn {
		t.Errorf("last record = %s in %+v, want process_ended in no turn", records[last].Type(), turns[last])
	}
}

// A process whose stream closed before it delivered its own process_ended is
// reduced with no record (the process manager's backstop). If that ends a
// turn, the history still gets the ending, once: the backstop that follows a
// delivered process_ended finds nothing left to end and writes nothing.
func TestSequencer_AProcessEndingWithoutItsRecordStillRecordsTheEnd(t *testing.T) {
	store := newStore(t, "sess")
	s := New(store)

	advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	advance(t, s, session.TurnInput{Signal: session.SignalProcessEnded}, nil)
	advance(t, s, session.TurnInput{Signal: session.SignalProcessEnded}, nil)
	advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	advance(t, s, session.TurnInput{Signal: session.SignalProcessEnded}, agent.ProcessEndedEvent{}.ToRecord())
	advance(t, s, session.TurnInput{Signal: session.SignalProcessEnded}, nil)

	records, turns := turnsOf(t, store, "sess")
	got := make([]string, len(records))
	for i, rec := range records {
		got[i] = string(rec.Type())
		if turns[i] == session.NoTurn {
			got[i] += "@null"
		}
	}
	want := []string{"turn_started", "process_ended@null", "turn_started", "process_ended@null"}
	if !slices.Equal(got, want) {
		t.Errorf("history = %v, want %v", got, want)
	}
}

// A successor that finds its predecessor's turn still open ends it, and the
// history gets the ending no agent reported: process_ended, in no turn, before
// anything of the successor's. One that finds nothing open writes nothing.
func TestSequencer_AProcessTakingOverAnOpenTurnRecordsItsEnd(t *testing.T) {
	store := newStore(t, "sess")
	s := New(store)

	advance(t, s, session.TurnInput{Signal: session.SignalProcessStarted}, nil)
	if records, _ := turnsOf(t, store, "sess"); len(records) != 0 {
		t.Fatalf("a process starting on an idle session wrote %d records, want none", len(records))
	}

	opened := advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	started := advance(t, s, session.TurnInput{Signal: session.SignalProcessStarted}, nil)
	if !started.Ended {
		t.Fatalf("process_started = %+v, want it to abort the open turn", started)
	}
	advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)

	records, turns := turnsOf(t, store, "sess")
	got := make([]string, len(records))
	for i, rec := range records {
		got[i] = string(rec.Type())
		if turns[i] == session.NoTurn {
			got[i] += "@null"
		} else if turns[i].ID() == opened.Turn {
			got[i] += "@first"
		}
	}
	want := []string{"turn_started@first", "process_ended@null", "turn_started"}
	if !slices.Equal(got, want) {
		t.Errorf("history = %v, want %v", got, want)
	}
}

// An answer to a prompt that outlived its turn opens a turn, and says so.
func TestSequencer_AnswerAfterTheTurnStartsOne(t *testing.T) {
	store := newStore(t, "sess")
	s := New(store)

	advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	advance(t, s, session.TurnInput{Signal: session.SignalDone}, agent.DoneEvent{}.ToRecord())
	advance(t, s, session.TurnInput{Signal: session.SignalPermissionRaised, RequestID: "r1"}, nil)
	answered := advance(t, s, session.TurnInput{Signal: session.SignalAnswered, RequestID: "r1"}, nil)
	if !answered.Started {
		t.Fatalf("answer = %+v, want it to open a turn", answered)
	}

	records, _ := turnsOf(t, store, "sess")
	started, ok := records[len(records)-1].(agent.TurnStartedRecord)
	if !ok || started.Origin != agent.TurnOriginAnswer || started.TurnID != answered.Turn {
		t.Errorf("last record = %+v, want turn %q started by an answer", records[len(records)-1], answered.Turn)
	}
}

// AppendTo writes the turn it is told, whatever is open: an expiry the opening
// of a new turn caused belongs to none.
func TestSequencer_AppendToTagsWithTheTurnNamed(t *testing.T) {
	store := newStore(t, "sess")
	s := New(store)

	advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	expiry := agent.RequestCancelledEvent{RequestID: "r1"}.ToRecord()
	if _, err := s.AppendTo(context.Background(), "sess", expiry, session.NoTurn); err != nil {
		t.Fatalf("AppendTo: %v", err)
	}

	_, turns := turnsOf(t, store, "sess")
	if last := turns[len(turns)-1]; last != session.NoTurn {
		t.Errorf("expiry is in %+v, want no turn", last)
	}
}

// unpersistedTurns applies every reduction and then reports the index write as
// failed, which is what a full disk does: the store holds the state and
// retries the write later.
type unpersistedTurns struct{ *session.FileStore }

func (s unpersistedTurns) ApplyTurn(ctx context.Context, sessionID string, in session.TurnInput) (session.TurnTransition, error) {
	transition, _ := s.FileStore.ApplyTurn(ctx, sessionID, in)
	return transition, errors.New("index not written")
}

// A turn the store opened is open whether or not its index write landed, and
// the records tagged with it must not name a turn that has no start.
func TestSequencer_ATurnOpenedButNotPersistedStillStarts(t *testing.T) {
	files := newStore(t, "sess")
	s := New(unpersistedTurns{files})

	transition, err := s.Advance(context.Background(), "sess",
		session.TurnInput{Signal: session.SignalOutput, At: time.Now()}, agent.TextEvent{Content: "hi"}.ToRecord(), nil)
	if err == nil || !transition.Started {
		t.Fatalf("Advance = %+v, %v; want the opened turn and the write error", transition, err)
	}

	records, turns := turnsOf(t, files, "sess")
	if len(records) != 2 || records[0].Type() != agent.EventTypeTurnStarted {
		t.Fatalf("history = %+v, want the turn_started and the text", records)
	}
	if turns[1] != session.InTurn(transition.Turn) {
		t.Errorf("text is in %+v, want the turn %q", turns[1], transition.Turn)
	}
}

// A straggler is written after its turn's ending and tagged with that turn,
// not with the one open as it lands.
func TestSequencer_AStragglerIsTaggedWithTheTurnThatEnded(t *testing.T) {
	store := newStore(t, "sess")
	s := New(store)

	first := advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	advance(t, s, session.TurnInput{Signal: session.SignalInterrupted}, agent.InterruptedEvent{}.ToRecord())
	advance(t, s, session.TurnInput{Signal: session.SignalNoise, AfterTurn: true}, agent.ToolResultEvent{ToolUseID: "exec-1", AfterTurn: true}.ToRecord())
	second := advance(t, s, session.TurnInput{Signal: session.SignalPrompt}, nil)
	advance(t, s, session.TurnInput{Signal: session.SignalNoise, AfterTurn: true}, agent.TextEvent{Content: "sub-done", AfterTurn: true}.ToRecord())
	advance(t, s, session.TurnInput{Signal: session.SignalDone}, agent.DoneEvent{}.ToRecord())
	// The store forgets the ended turn with the process, though that moves
	// nothing a client sees.
	advance(t, s, session.TurnInput{Signal: session.SignalProcessEnded}, agent.ProcessEndedEvent{}.ToRecord())
	advance(t, s, session.TurnInput{Signal: session.SignalNoise, AfterTurn: true}, agent.TextEvent{Content: "late", AfterTurn: true}.ToRecord())

	records, turns := turnsOf(t, store, "sess")
	want := []struct {
		typ  agent.EventType
		turn session.HistoryTurn
	}{
		{agent.EventTypeTurnStarted, session.InTurn(first.Turn)},
		{agent.EventTypeInterrupted, session.InTurn(first.Turn)},
		{agent.EventTypeToolResult, session.InTurn(first.Turn)},
		{agent.EventTypeTurnStarted, session.InTurn(second.Turn)},
		{agent.EventTypeText, session.InTurn(first.Turn)},
		{agent.EventTypeDone, session.InTurn(second.Turn)},
		{agent.EventTypeProcessEnded, session.NoTurn},
		{agent.EventTypeText, session.NoTurn},
	}
	if len(records) != len(want) {
		t.Fatalf("history = %+v, want %d records", records, len(want))
	}
	for i, w := range want {
		if records[i].Type() != w.typ || turns[i] != w.turn {
			t.Errorf("record %d = %s in %+v, want %s in %+v", i, records[i].Type(), turns[i], w.typ, w.turn)
		}
	}
}
