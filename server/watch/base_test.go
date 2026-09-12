package watch

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestBaseWatcher_AddRemoveSubscription(t *testing.T) {
	b := NewBaseWatcher("test")

	sub := &Subscription{ID: "test_1"}
	b.AddSubscription(sub)

	if !b.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}

	removed := b.RemoveSubscription("test_1")
	if removed == nil {
		t.Error("expected removed subscription")
	}
	if removed.ID != "test_1" {
		t.Errorf("expected ID test_1, got %s", removed.ID)
	}

	if b.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false")
	}

	removed = b.RemoveSubscription("nonexistent")
	if removed != nil {
		t.Error("expected nil for non-existent subscription")
	}
}

// A watcher's Stop is only worth anything if it is synchronous: callers stop a
// watcher because they are about to remove what it reads (a work tree, a data
// directory), and a loop still running would race them.
func TestBaseWatcher_CancelAndWaitBlocksUntilGoroutinesReturn(t *testing.T) {
	b := NewBaseWatcher("test")

	var finished atomic.Bool
	b.Go(func() {
		<-b.Context().Done()
		// Stands in for the last pass of a real loop; without it the assertion
		// below would hold whether or not CancelAndWait actually waits.
		time.Sleep(20 * time.Millisecond)
		finished.Store(true)
	})

	b.CancelAndWait()

	if !finished.Load() {
		t.Error("CancelAndWait returned while the goroutine was still running")
	}
}
