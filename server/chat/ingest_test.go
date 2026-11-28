package chat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// records reads the session's whole transcript back as typed records, which is
// what a client replaying the conversation sees.
func (f *midTurnFixture) records(t *testing.T) []agent.Record {
	t.Helper()
	return sessionRecords(t, f.store, "sess")
}

// sessionRecords reads a session's whole transcript back as typed records.
func sessionRecords(t *testing.T, store session.Store, sessionID string) []agent.Record {
	t.Helper()
	raws, err := store.GetHistory(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	return decodeRecords(t, raws)
}

func decodeRecords(t *testing.T, raws []json.RawMessage) []agent.Record {
	t.Helper()
	records := make([]agent.Record, 0, len(raws))
	for _, raw := range raws {
		rec, err := agent.DecodeRecord(raw)
		if err != nil {
			t.Fatalf("parse history record %s: %v", raw, err)
		}
		records = append(records, rec)
	}
	return records
}

// recordAs asserts rec is a T, failing the test with what it is instead.
func recordAs[T agent.Record](t *testing.T, rec agent.Record) T {
	t.Helper()
	got, ok := rec.(T)
	if !ok {
		var want T
		t.Fatalf("record = %q %+v, want %q", rec.Type(), rec, want.Type())
	}
	return got
}

// A message that arrives mid-turn is steered into the turn already running, so
// the turn's own ending says nothing about which message the output that
// follows belongs to. The read point is what says it, and it has to be in the
// transcript: the split it marks must survive a reload, a resubscribe and a
// second device.
//
// This agent reports no read point of its own, so the send path writes one at
// the moment of delivery — see agent.MessageIngestedEvent.
func TestClient_MidTurnMessageRecordsTheReadPoint(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)

	reply, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil, nil)
	if err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}

	records := f.records(t)
	if len(records) != 3 {
		t.Fatalf("history = %+v, want both messages and one read point", records)
	}
	readPoint, ok := records[2].(agent.MessageIngestedRecord)
	if !ok {
		t.Fatalf("last record is %q, want the read point", records[2].Type())
	}
	// The read point names the message it is about rather than leaving it to be
	// inferred from position, which is what keeps two queued messages apart.
	second := recordAs[agent.MessageRecord](t, records[1])
	if second.MessageID == "" {
		t.Fatal("the message record carries no id for the read point to name")
	}
	if readPoint.MessageID != second.MessageID {
		t.Errorf("read point names %q, want the second message %q", readPoint.MessageID, second.MessageID)
	}
	// And the agent was handed the same id, which is the only way an agent that
	// echoes messages back can report the read point itself.
	sent := sess.sent()
	if len(sent) != 2 || sent[1].ID != second.MessageID {
		t.Errorf("prompts handed to the agent = %+v, want the second carrying %q", sent, second.MessageID)
	}
	// And so was the sender, which the broadcast of the record leaves out: it
	// has to recognise its own message when a later record names it.
	if reply.MessageID != second.MessageID {
		t.Errorf("sender told id %q, want the record's %q", reply.MessageID, second.MessageID)
	}

	// Everyone is told, the sender included: unlike the message itself, no
	// client has a local echo of this to fall back on.
	last := f.broadcasts[len(f.broadcasts)-1]
	if ingested, ok := last.(agent.MessageIngestedRecord); !ok || ingested.MessageID != second.MessageID {
		t.Errorf("last broadcast = %+v, want the read point", last)
	}
}

// The message that starts a turn has nothing above it to cut away, so a read
// point for it would only mark a boundary where the message record already is —
// and the frontend would draw an empty bubble for the content that never
// preceded it.
func TestClient_MessageThatStartsATurnRecordsNoReadPoint(t *testing.T) {
	f := newMidTurnFixture(t)
	f.startTurn(t)

	records := f.records(t)
	if len(records) != 1 || records[0].Type() != agent.EventTypeMessage {
		t.Fatalf("history = %+v, want only the message that started the turn", records)
	}
}

// A message sent between turns is the same case: the turn it starts is its own.
func TestClient_MessageBetweenTurnsRecordsNoReadPoint(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)

	sess.events <- agent.DoneEvent{}
	f.waitForPhase(t, session.PhaseIdle)

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil, nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}

	for _, rec := range f.records(t) {
		if rec.Type() == agent.EventTypeMessageIngested {
			t.Fatalf("history = %+v, want no read point for a message that started its own turn", f.records(t))
		}
	}
}

// Several messages can be queued into one turn, and the agent reads them one at
// a time — so each needs a boundary of its own, naming its own message. This is
// the case position alone cannot resolve, and the reason the records are joined
// by an id at all.
func TestClient_EachQueuedMessageGetsItsOwnReadPoint(t *testing.T) {
	f := newMidTurnFixture(t)
	f.startTurn(t)

	for _, text := range []string{"second", "third"} {
		if _, err := f.client.SendMessageExcluding(context.Background(), "sess", text, nil, nil); err != nil {
			t.Fatalf("SendMessageExcluding(%q): %v", text, err)
		}
	}

	records := f.records(t)
	if len(records) != 5 {
		t.Fatalf("history = %+v, want three messages and two read points", records)
	}
	for _, pair := range [][2]int{{1, 2}, {3, 4}} {
		message, isMessage := records[pair[0]].(agent.MessageRecord)
		readPoint, isReadPoint := records[pair[1]].(agent.MessageIngestedRecord)
		if !isMessage || !isReadPoint {
			t.Fatalf("records %d and %d are %q and %q, want a message and its read point",
				pair[0], pair[1], records[pair[0]].Type(), records[pair[1]].Type())
		}
		if readPoint.MessageID != message.MessageID {
			t.Errorf("read point at %d names %q, want the message above it %q (%q)",
				pair[1], readPoint.MessageID, message.MessageID, message.Content)
		}
	}
}

// countingFailStore cannot write history and counts what was offered to it,
// which is the only way to see a record that was never attempted.
type countingFailStore struct {
	session.Store
	attempts int
}

func (s *countingFailStore) AppendToHistory(context.Context, string, session.HistoryRecord) (session.HistorySeq, error) {
	s.attempts++
	return session.NoHistorySeq, errors.New("history is not writable")
}

// A message whose own record could not be written is not in the transcript at
// all, so there is nothing for a boundary to sit under: the read point is not
// even attempted. Without this, a replayed conversation would break into a new
// bubble at a message nobody can see.
func TestClient_NoReadPointForAMessageThatWasNotRecorded(t *testing.T) {
	base, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	store := &countingFailStore{Store: base}
	pm, _ := newTestManagerWithAgent(t, store)
	t.Cleanup(pm.Shutdown)
	if _, err := store.Create(context.Background(), "sess",
		session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("Create session: %v", err)
	}

	client := NewClient(store, pm)
	for _, text := range []string{"first", "second"} {
		if _, err := client.SendMessageExcluding(context.Background(), "sess", text, nil, nil); err != nil {
			t.Fatalf("SendMessageExcluding(%q) = %v, want the prompt to go through anyway", text, err)
		}
	}

	if store.attempts != 2 {
		t.Errorf("history appends attempted = %d, want one per message and no read point", store.attempts)
	}
}

// An agent that echoes messages back knows its own read point, and it is the
// exact one. Pockode must not write an approximate one beside it: the two would
// split the same message twice.
func TestClient_ReadPointLeftToAnAgentThatReportsItsOwn(t *testing.T) {
	f := newMidTurnFixture(t)
	f.agent.reportsIngest = true
	f.startTurn(t)

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil, nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}

	records := f.records(t)
	if len(records) != 2 {
		t.Fatalf("history = %+v, want the two messages and no read point of Pockode's", records)
	}
}

// A reply's span is measured between moments its records carry, so the record
// of a message that opens a turn has to carry the very instant the turn opened
// at: the tail line's clock counts from TurnState.OpenedAt, and the settled
// figure from the record, and the two must start together. The sender, left
// out of the record's broadcast, is told the same instant in its answer.
func TestClient_MessageThatOpensATurnCarriesTheTurnsOpeningMoment(t *testing.T) {
	f := newMidTurnFixture(t)

	sent, err := f.client.SendMessageExcluding(context.Background(), "sess", "first", nil, nil)
	if err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}

	records := f.records(t)
	if len(records) != 1 {
		t.Fatalf("history = %+v, want one message carrying observed_at", records)
	}
	message, ok := records[0].(agent.MessageRecord)
	if !ok || message.ObservedAt == nil {
		t.Fatalf("history = %+v, want one message carrying observed_at", records)
	}
	at := *message.ObservedAt
	if opened := f.pm.GetProcess("sess").TurnState().OpenedAt; !opened.Equal(at) {
		t.Errorf("turn opened at %v, record says %v", opened, at)
	}
	if !sent.ObservedAt.Equal(at) {
		t.Errorf("sender told %v, record says %v", sent.ObservedAt, at)
	}
}

// A read point the send path writes ends the reply above it and opens the one
// below, so it carries the moment it was written.
func TestClient_ReadPointCarriesItsMoment(t *testing.T) {
	f := newMidTurnFixture(t)
	f.startTurn(t)

	before := time.Now()
	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil, nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}
	after := time.Now()

	records := f.records(t)
	last := records[len(records)-1]
	readPoint, ok := last.(agent.MessageIngestedRecord)
	if !ok || readPoint.ObservedAt == nil {
		t.Fatalf("last record = %q %+v, want a read point carrying observed_at", last.Type(), last)
	}
	if at := *readPoint.ObservedAt; at.Before(before) || at.After(after) {
		t.Errorf("read point observed_at = %v, want between %v and %v", at, before, after)
	}
}
