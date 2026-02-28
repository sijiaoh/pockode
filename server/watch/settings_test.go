package watch

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/settings"
)

func newTestSettingsStore(t *testing.T) *settings.Store {
	t.Helper()
	store, err := settings.NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return store
}

func TestSettingsWatcher_Subscribe(t *testing.T) {
	store := newTestSettingsStore(t)
	w := NewSettingsWatcher(store)

	id, s := w.Subscribe(nil)
	if id == "" {
		t.Error("expected non-empty subscription ID")
	}
	if s != store.Get() {
		t.Error("expected settings to match store")
	}
	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

func TestSettingsWatcher_NotifyChange(t *testing.T) {
	store := newTestSettingsStore(t)
	w := NewSettingsWatcher(store)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe(notifier)

	store.Update(settings.Settings{DefaultAgentRoleID: "role-1"})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params settingsChangedParams
	json.Unmarshal(notifier.last(), &params)
	if params.Settings.DefaultAgentRoleID != "role-1" {
		t.Errorf("DefaultAgentRoleID = %q, want %q", params.Settings.DefaultAgentRoleID, "role-1")
	}
}

func TestSettingsWatcher_DirtyFlag_ResendsAfterDrop(t *testing.T) {
	store := newTestSettingsStore(t)
	// Don't register as listener — we control the channel manually
	w := &SettingsWatcher{
		BaseWatcher: NewBaseWatcher("st"),
		store:       store,
		eventCh:     make(chan struct{}, 1),
	}

	notifier := &captureNotifier{}
	w.Subscribe(notifier)

	// Simulate dirty flag being set (as if events were dropped)
	w.dirty.Store(true)

	// Update store to the "latest" state (no listener, so eventCh stays empty)
	store.Update(settings.Settings{DefaultAgentRoleID: "latest"})

	// Start eventLoop AFTER setting dirty so the next event triggers recovery
	w.Start()
	defer w.Stop()

	// Send a trigger event — eventLoop sees dirty=true and fetches latest from store
	w.eventCh <- struct{}{}

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params settingsChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Should contain the latest store value, not a stale channel value
	if params.Settings.DefaultAgentRoleID != "latest" {
		t.Errorf("DefaultAgentRoleID = %q, want %q", params.Settings.DefaultAgentRoleID, "latest")
	}

	// dirty flag should be cleared
	if w.dirty.Load() {
		t.Error("dirty flag should be cleared after recovery")
	}
}

func TestSettingsWatcher_OnSettingsChange_BufferFull_SetsDirty(t *testing.T) {
	store := newTestSettingsStore(t)
	w := &SettingsWatcher{
		BaseWatcher: NewBaseWatcher("st"),
		store:       store,
		eventCh:     make(chan struct{}, 1),
	}

	// Fill the buffer
	w.eventCh <- struct{}{}

	// This should set dirty instead of blocking
	w.OnSettingsChange(settings.Settings{DefaultAgentRoleID: "overflow"})

	if !w.dirty.Load() {
		t.Error("expected dirty flag to be set after buffer overflow")
	}
}

func TestSettingsWatcher_OnSettingsChange_AfterStop(t *testing.T) {
	store := newTestSettingsStore(t)
	w := NewSettingsWatcher(store)
	w.Start()
	w.Stop()

	// Should not block or panic
	w.OnSettingsChange(settings.Settings{DefaultAgentRoleID: "after-stop"})
}
