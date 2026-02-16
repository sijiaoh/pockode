package watch

import "testing"

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
