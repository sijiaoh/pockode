package watch

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestBaseWatcher_AddRemoveSubscription(t *testing.T) {
	b := NewBaseWatcher()

	sub := &Subscription{ID: "test_1"}
	if err := b.AddSubscription(sub); err != nil {
		t.Fatalf("add subscription: %v", err)
	}

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
	b := NewBaseWatcher()

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

// The id under which a subscription is registered comes from the client, so
// these two are the whole of what the watcher must not accept. A reused id is
// not a detail: one watcher's id space is shared by every connection it serves,
// and overwriting the entry would silently redirect a live subscriber's
// notifications to whoever asked second.
func TestBaseWatcher_AddSubscriptionRejectsUnusableIDs(t *testing.T) {
	b := NewBaseWatcher()

	if err := b.AddSubscription(&Subscription{ID: ""}); !errors.Is(err, ErrSubscriptionIDRequired) {
		t.Errorf("err = %v, want ErrSubscriptionIDRequired", err)
	}
	if b.HasSubscriptions() {
		t.Error("an id-less subscription must not be registered")
	}

	first := &Subscription{ID: "test_1", Key: "a"}
	if err := b.AddSubscription(first); err != nil {
		t.Fatalf("add subscription: %v", err)
	}

	if err := b.AddSubscription(&Subscription{ID: "test_1", Key: "b"}); !errors.Is(err, ErrSubscriptionIDInUse) {
		t.Errorf("err = %v, want ErrSubscriptionIDInUse", err)
	}
	if got := b.GetSubscription("test_1"); got != first {
		t.Errorf("the sitting subscription must be untouched, got %+v", got)
	}
}
