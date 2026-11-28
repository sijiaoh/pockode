package chat

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/projection"
	"github.com/pockode/server/session"
)

// Sends under one id are one message however they arrive: a retry racing the
// attempt it retries waits for it and finds its record, rather than writing a
// second, and every attempt is answered with that one record.
func TestSendMessage_RetriesUnderOneIDAreOneMessage(t *testing.T) {
	f := newQuestionFixture(t)
	id := uuid.NewString()

	const attempts = 5
	sent := make([]Sent, attempts)
	var wg sync.WaitGroup
	for i := range attempts {
		wg.Go(func() {
			var err error
			if sent[i], err = f.client.SendMessage(context.Background(), "sess", "once", nil, id); err != nil {
				t.Errorf("attempt %d: %v", i, err)
			}
		})
	}
	wg.Wait()

	var messages []agent.MessageRecord
	for _, rec := range f.records(t) {
		if m, ok := rec.(agent.MessageRecord); ok {
			messages = append(messages, m)
		}
	}
	if len(messages) != 1 || messages[0].MessageID != id {
		t.Fatalf("message records = %+v, want one under %s", messages, id)
	}
	if got := f.agent.session(t, 1).sentPrompts(); len(got) != 1 {
		t.Errorf("agent was sent %q, want the message once", got)
	}
	retried := 0
	for i, s := range sent {
		if s.MessageID != id || !s.Seq.Valid() {
			t.Errorf("attempt %d answered %+v, want the one record", i, s)
		}
		if s.Retried {
			retried++
		}
	}
	if retried != attempts-1 {
		t.Errorf("%d attempts answered as retries, want all but the one that sent", retried)
	}
}

// An answer retried after it was recorded is answered with that record, not
// refused because the questions it answered are no longer open: the first
// attempt is what settled them.
func TestSendAnswers_ARetryFindsTheAnswerRecorded(t *testing.T) {
	f := newQuestionFixture(t)
	q := f.post(t, "Database")
	id := uuid.NewString()
	answers := []Answer{{RequestID: q, Answers: []string{"Postgres"}}}

	if _, err := f.client.SendAnswers(context.Background(), "sess", answers, id); err != nil {
		t.Fatalf("SendAnswers: %v", err)
	}
	retry, err := f.client.SendAnswers(context.Background(), "sess", answers, id)
	if err != nil {
		t.Fatalf("retried SendAnswers = %v, want it answered with the record", err)
	}
	if !retry.Retried || retry.MessageID != id {
		t.Errorf("retry = %+v, want the recorded answer", retry)
	}
	if got := f.agent.session(t, 1).sentPrompts(); len(got) != 1 {
		t.Errorf("agent was sent %q, want the answer once", got)
	}
	if len(f.settled) != 1 {
		t.Errorf("settled reported %d times, want once", len(f.settled))
	}
}

// A first attempt that wrote its record and then failed to hand the message
// over left a message in the transcript the agent never got. Its retry is not
// answered as a success on the strength of the record, and writes nothing.
func TestSendMessage_ARetryOfAMessageThatNeverReachedTheAgentFails(t *testing.T) {
	f := newQuestionFixture(t)
	f.agent.handoverErr = errors.New("stdin closed")
	id := uuid.NewString()

	if _, err := f.client.SendMessage(context.Background(), "sess", "lost", nil, id); err == nil {
		t.Fatal("first attempt succeeded, want the handover's failure")
	}
	_, err := f.client.SendMessage(context.Background(), "sess", "lost", nil, id)
	if !errors.Is(err, ErrRecordedNotDelivered) {
		t.Fatalf("retry = %v, want %v", err, ErrRecordedNotDelivered)
	}

	var messages int
	for _, rec := range f.records(t) {
		if _, ok := rec.(agent.MessageRecord); ok {
			messages++
		}
	}
	if messages != 1 {
		t.Errorf("%d message records, want the first attempt's alone", messages)
	}
}

// A first attempt the server refused wrote nothing, so the same id is free:
// sending again under it is a send like any other.
func TestSendMessage_ARefusedAttemptLeavesItsIDFree(t *testing.T) {
	f := newQuestionFixture(t)
	id := uuid.NewString()
	files := []agent.Attachment{{File: agent.FileBlock{Name: "shot.png", MIME: "image/png", AttachmentID: "abc"}, Path: "/data/abc"}}

	if _, err := f.client.SendMessage(context.Background(), "sess", "look", files, id); !errors.Is(err, ErrAttachmentsUnsupported) {
		t.Fatalf("first attempt = %v, want %v", err, ErrAttachmentsUnsupported)
	}
	sent, err := f.client.SendMessage(context.Background(), "sess", "look", nil, id)
	if err != nil {
		t.Fatalf("second attempt: %v", err)
	}
	if sent.Retried || sent.MessageID != id {
		t.Errorf("second attempt = %+v, want a send of its own under %s", sent, id)
	}
	if got := f.agent.session(t, 1).sentPrompts(); len(got) != 1 {
		t.Errorf("agent was sent %q, want the message once", got)
	}
}

// A message handed over whose record could not be written is not in history
// for a retry to find, but the agent has it: the retry is answered as sent
// rather than delivering it a second time.
func TestSendMessage_ARetryOfAMessageThatWasNeverRecordedSendsNothing(t *testing.T) {
	base, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	store := failingAppendStore{base}
	pm, ag := newTestManagerWithAgent(t, store)
	t.Cleanup(pm.Shutdown)
	if _, err := store.Create(context.Background(), "sess", session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("Create session: %v", err)
	}
	client := NewClient(store, projection.FromReader(store), pm)
	id := uuid.NewString()

	if _, err := client.SendMessage(context.Background(), "sess", "once", nil, id); err != nil {
		t.Fatalf("first attempt: %v", err)
	}
	retry, err := client.SendMessage(context.Background(), "sess", "once", nil, id)
	if err != nil || !retry.Retried {
		t.Fatalf("retry = %+v, %v; want it answered as sent", retry, err)
	}
	if got := ag.session(t, 1).sentPrompts(); len(got) != 1 {
		t.Errorf("agent was sent %q, want the message once", got)
	}
}
