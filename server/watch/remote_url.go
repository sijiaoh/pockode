package watch

import "log/slog"

// RemoteURLWatcher pushes the server's remote URL to connected clients when it
// changes. Renewing the relay credentials can move the server to a new
// subdomain mid-run, and a relay that stops for good leaves it empty; either
// way the URL a client learned at auth is dead, and a client must not have to
// reconnect to find out. Notifications are remote_url.changed.
//
// Every notification carries the URL as it is when sent, never the one that
// triggered it, so changes that pile up while one is being sent collapse into
// one and the last one sent is always the current URL.
type RemoteURLWatcher struct {
	*BaseWatcher
	read func() string
	wake chan struct{}
}

func NewRemoteURLWatcher(read func() string) *RemoteURLWatcher {
	return &RemoteURLWatcher{
		BaseWatcher: NewBaseWatcher(),
		read:        read,
		wake:        make(chan struct{}, 1),
	}
}

func (w *RemoteURLWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("RemoteURLWatcher started")
	return nil
}

func (w *RemoteURLWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("RemoteURLWatcher stopped")
}

// Changed tells the watcher the remote URL has changed. It never blocks — the
// relay calls it from its reconnect loop, which must not wait on a slow
// client — and never drops a change: the loop reads the URL when it sends.
func (w *RemoteURLWatcher) Changed() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *RemoteURLWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case <-w.wake:
		}
		if !w.HasSubscriptions() {
			continue
		}
		url := w.read()
		w.NotifyAll("remote_url.changed", func(sub *Subscription) any {
			return remoteURLChangedParams{ID: sub.ID, RemoteURL: url}
		})
	}
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current remote URL. It is read after registering, so a change in between is
// either in this answer or in a notification, never lost between the two.
func (w *RemoteURLWatcher) Subscribe(id string, notifier Notifier) (string, error) {
	if err := w.AddSubscription(&Subscription{ID: id, Notifier: notifier}); err != nil {
		return "", err
	}
	return w.read(), nil
}

type remoteURLChangedParams struct {
	ID        string `json:"id"`
	RemoteURL string `json:"remote_url"`
}
