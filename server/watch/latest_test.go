package watch

import (
	"errors"
	"testing"
)

// A subscribe whose value cannot be read fails, and leaves nothing under its
// id: the client gets no reply to unsubscribe with, and must be able to try
// the same id again.
func TestLatestWatcher_SubscribeThatCannotReadLeavesNothing(t *testing.T) {
	readErr := errors.New("disk on fire")
	failing := true
	w := newLatestWatcher("test", "test.changed", func() (string, error) {
		if failing {
			return "", readErr
		}
		return "value", nil
	}, func(id, v string) any { return v })

	if _, err := w.Subscribe("client-1", &captureNotifier{}); !errors.Is(err, readErr) {
		t.Fatalf("Subscribe = %v, want the read error", err)
	}
	if w.HasSubscriptions() {
		t.Fatal("a failed subscribe left its subscription behind")
	}

	failing = false
	if got, err := w.Subscribe("client-1", &captureNotifier{}); err != nil || got != "value" {
		t.Errorf("Subscribe again = %q, %v; want the value", got, err)
	}
}
