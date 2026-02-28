package watch

import (
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/settings"
)

// SettingsWatcher notifies subscribers when settings are updated.
// Uses a channel-based async notification pattern to avoid blocking the settings
// store's mutex during network I/O.
type SettingsWatcher struct {
	*BaseWatcher
	store   *settings.Store
	eventCh chan struct{}
	dirty   atomic.Bool // set when an event is dropped; triggers full resend from store
}

func NewSettingsWatcher(store *settings.Store) *SettingsWatcher {
	w := &SettingsWatcher{
		BaseWatcher: NewBaseWatcher("st"),
		store:       store,
		eventCh:     make(chan struct{}, 16),
	}
	store.SetOnChangeListener(w)
	return w
}

func (w *SettingsWatcher) Start() error {
	go w.eventLoop()
	slog.Info("SettingsWatcher started")
	return nil
}

func (w *SettingsWatcher) Stop() {
	w.Cancel()
	slog.Info("SettingsWatcher stopped")
}

func (w *SettingsWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case <-w.eventCh:
			if w.dirty.Swap(false) {
				slog.Info("recovering from dropped settings event, sending latest from store")
			}
			w.notifyChange(w.store.Get())
		}
	}
}

func (w *SettingsWatcher) notifyChange(s settings.Settings) {
	if !w.HasSubscriptions() {
		return
	}

	w.NotifyAll("settings.changed", func(sub *Subscription) any {
		return settingsChangedParams{
			ID:       sub.ID,
			Settings: s,
		}
	})

	slog.Debug("notified settings change")
}

// Subscribe registers a subscriber and returns the subscription ID along with
// the current settings.
func (w *SettingsWatcher) Subscribe(notifier Notifier) (string, settings.Settings) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	w.AddSubscription(sub)

	return id, w.store.Get()
}

type settingsChangedParams struct {
	ID       string            `json:"id"`
	Settings settings.Settings `json:"settings"`
}

// OnSettingsChange implements settings.OnChangeListener.
// This method is called from the settings store's mutex, so it must not block.
func (w *SettingsWatcher) OnSettingsChange(s settings.Settings) {
	if w.Context().Err() != nil {
		return
	}

	select {
	case w.eventCh <- struct{}{}:
	default:
		w.dirty.Store(true)
		slog.Warn("settings change event dropped, will resend on next event")
	}
}
