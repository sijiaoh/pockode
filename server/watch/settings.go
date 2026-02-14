package watch

import (
	"log/slog"

	"github.com/pockode/server/settings"
)

// SettingsWatcher notifies subscribers when settings are updated.
// Uses a channel-based async notification pattern to avoid blocking the settings
// store's mutex during network I/O.
type SettingsWatcher struct {
	*BaseWatcher
	store   *settings.Store
	eventCh chan settings.Settings
}

func NewSettingsWatcher(store *settings.Store) *SettingsWatcher {
	w := &SettingsWatcher{
		BaseWatcher: NewBaseWatcher("st"),
		store:       store,
		eventCh:     make(chan settings.Settings, 16),
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
		case s := <-w.eventCh:
			w.notifyChange(s)
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
	case w.eventCh <- s:
	default:
		slog.Warn("settings change event dropped (buffer full)")
	}
}
