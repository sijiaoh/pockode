package watch

import "testing"

func TestBaseWatcher_AddRemoveSubscription(t *testing.T) {
	b := NewBaseWatcher("test")

	sub := &Subscription{ID: "test_1", ConnID: "conn1"}
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

func TestBaseWatcher_CleanupConnection(t *testing.T) {
	b := NewBaseWatcher("test")

	b.AddSubscription(&Subscription{ID: "test_1", ConnID: "conn1"})
	b.AddSubscription(&Subscription{ID: "test_2", ConnID: "conn1"})
	b.AddSubscription(&Subscription{ID: "test_3", ConnID: "conn2"})

	if len(b.GetAllSubscriptions()) != 3 {
		t.Errorf("expected 3 subscriptions, got %d", len(b.GetAllSubscriptions()))
	}

	b.CleanupConnection("conn1")

	subs := b.GetAllSubscriptions()
	if len(subs) != 1 {
		t.Errorf("expected 1 subscription after cleanup, got %d", len(subs))
	}
	if subs[0].ID != "test_3" {
		t.Errorf("expected test_3 to remain, got %s", subs[0].ID)
	}

	b.CleanupConnection("nonexistent")
}

func TestBaseWatcher_GetSubscriptionsByConnID(t *testing.T) {
	b := NewBaseWatcher("test")

	b.AddSubscription(&Subscription{ID: "test_1", ConnID: "conn1"})
	b.AddSubscription(&Subscription{ID: "test_2", ConnID: "conn1"})
	b.AddSubscription(&Subscription{ID: "test_3", ConnID: "conn2"})

	subs := b.GetSubscriptionsByConnID("conn1")
	if len(subs) != 2 {
		t.Errorf("expected 2 subscriptions for conn1, got %d", len(subs))
	}

	subs = b.GetSubscriptionsByConnID("conn2")
	if len(subs) != 1 {
		t.Errorf("expected 1 subscription for conn2, got %d", len(subs))
	}

	subs = b.GetSubscriptionsByConnID("nonexistent")
	if subs != nil {
		t.Errorf("expected nil for non-existent connection, got %v", subs)
	}
}

func TestBaseWatcher_RemoveSubscription_CleansConnToIDs(t *testing.T) {
	b := NewBaseWatcher("test")

	b.AddSubscription(&Subscription{ID: "test_1", ConnID: "conn1"})
	b.AddSubscription(&Subscription{ID: "test_2", ConnID: "conn1"})

	b.RemoveSubscription("test_1")

	subs := b.GetSubscriptionsByConnID("conn1")
	if len(subs) != 1 {
		t.Errorf("expected 1 subscription for conn1, got %d", len(subs))
	}

	b.RemoveSubscription("test_2")

	subs = b.GetSubscriptionsByConnID("conn1")
	if subs != nil {
		t.Errorf("expected nil after removing all subscriptions, got %v", subs)
	}
}
