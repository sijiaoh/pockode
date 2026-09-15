package agent

import (
	"io"
	"log/slog"
	"testing"
	"time"
)

// emitProcessEndedRounds is what makes the delivery test a guarantee rather than
// a coin toss: the send it locks used to be decided by a select whose cases were
// both ready, so a single green round would prove nothing.
const emitProcessEndedRounds = 200

// discardLog is a logger for tests that exercise a path which logs; shared
// across this package's tests.
func discardLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestEmitProcessEndedAlwaysReachesTheConsumer covers the deliberate close: the
// consumer is not parked on the channel at the moment the event is emitted, so
// any send that can give up — on a cancelled context, on a default case — loses
// the event and leaves the client showing a session that is still running.
func TestEmitProcessEndedAlwaysReachesTheConsumer(t *testing.T) {
	for round := range emitProcessEndedRounds {
		events := make(chan AgentEvent)
		started := make(chan struct{})
		returned := make(chan struct{})
		go func() {
			defer close(returned)
			close(started)
			EmitProcessEnded(discardLog(), events)
		}()
		// Let the emit run first, so it has to wait for a consumer that is not
		// there yet. Sleeping only ever weakens the trap, never this test: a send
		// that waits passes however long the pause is.
		<-started
		time.Sleep(time.Millisecond)

		select {
		case event := <-events:
			if _, ok := event.(ProcessEndedEvent); !ok {
				t.Fatalf("round %d: got %T, want ProcessEndedEvent", round, event)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("round %d: process_ended never arrived", round)
		}

		// The send waited for this consumer instead of racing it.
		select {
		case <-returned:
		case <-time.After(5 * time.Second):
			t.Fatalf("round %d: EmitProcessEnded did not return after delivery", round)
		}
	}
}

// TestEmitProcessEndedGivesUpOnAnAbandonedChannel covers the one consumer that
// never comes back: a read loop killed by a panic recovered above it. Waiting
// forever there would leak this goroutine silently.
func TestEmitProcessEndedGivesUpOnAnAbandonedChannel(t *testing.T) {
	returned := make(chan struct{})
	go func() {
		defer close(returned)
		emitProcessEnded(discardLog(), make(chan AgentEvent), time.Millisecond)
	}()

	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("emitProcessEnded never gave up on a channel nobody reads")
	}
}
