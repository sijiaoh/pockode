package chat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// records reads the session's whole transcript back as typed records, which is
// what a client replaying the conversation sees.
func (f *midTurnFixture) records(t *testing.T) []agent.EventRecord {
	t.Helper()
	raws, err := f.store.GetHistory(context.Background(), "sess")
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	records := make([]agent.EventRecord, 0, len(raws))
	for _, raw := range raws {
		var rec agent.EventRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			t.Fatalf("parse history record: %v", err)
		}
		records = append(records, rec)
	}
	return records
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

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}

	records := f.records(t)
	if len(records) != 3 {
		t.Fatalf("history = %+v, want both messages and one read point", records)
	}
	if records[2].Type != agent.EventTypeMessageIngested {
		t.Fatalf("last record is %q, want the read point", records[2].Type)
	}
	// The read point names the message it is about rather than leaving it to be
	// inferred from position, which is what keeps two queued messages apart.
	second := records[1]
	if second.MessageID == "" {
		t.Fatal("the message record carries no id for the read point to name")
	}
	if records[2].MessageID != second.MessageID {
		t.Errorf("read point names %q, want the second message %q", records[2].MessageID, second.MessageID)
	}
	// And the agent was handed the same id, which is the only way an agent that
	// echoes messages back can report the read point itself.
	sent := sess.sent()
	if len(sent) != 2 || sent[1].ID != second.MessageID {
		t.Errorf("prompts handed to the agent = %+v, want the second carrying %q", sent, second.MessageID)
	}

	// Everyone is told, the sender included: unlike the message itself, no
	// client has a local echo of this to fall back on.
	last := f.broadcasts[len(f.broadcasts)-1]
	if last.Type != agent.EventTypeMessageIngested || last.MessageID != second.MessageID {
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
	if len(records) != 1 || records[0].Type != agent.EventTypeMessage {
		t.Fatalf("history = %+v, want only the message that started the turn", records)
	}
}

// A message sent between turns is the same case: the turn it starts is its own.
func TestClient_MessageBetweenTurnsRecordsNoReadPoint(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)

	sess.events <- agent.DoneEvent{}
	f.waitForPhase(t, session.PhaseIdle)

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}

	for _, rec := range f.records(t) {
		if rec.Type == agent.EventTypeMessageIngested {
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
		if _, err := f.client.SendMessageExcluding(context.Background(), "sess", text, nil); err != nil {
			t.Fatalf("SendMessageExcluding(%q): %v", text, err)
		}
	}

	records := f.records(t)
	if len(records) != 5 {
		t.Fatalf("history = %+v, want three messages and two read points", records)
	}
	for _, pair := range [][2]int{{1, 2}, {3, 4}} {
		message, readPoint := records[pair[0]], records[pair[1]]
		if message.Type != agent.EventTypeMessage || readPoint.Type != agent.EventTypeMessageIngested {
			t.Fatalf("records %d and %d are %q and %q, want a message and its read point",
				pair[0], pair[1], message.Type, readPoint.Type)
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

func (s *countingFailStore) AppendToHistory(context.Context, string, any) (session.HistorySeq, error) {
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
		if _, err := client.SendMessageExcluding(context.Background(), "sess", text, nil); err != nil {
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

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}

	records := f.records(t)
	if len(records) != 2 {
		t.Fatalf("history = %+v, want the two messages and no read point of Pockode's", records)
	}
}
