package watch

// RemoteURLWatcher pushes the server's remote URL to connected clients when it
// changes. Renewing the relay credentials can move the server to a new
// subdomain mid-run, and a relay that stops for good leaves it empty; either
// way the URL a client learned at auth is dead, and a client must not have to
// reconnect to find out. Notifications are remote_url.changed.
type RemoteURLWatcher struct {
	*latestWatcher[string]
}

func NewRemoteURLWatcher(read func() string) *RemoteURLWatcher {
	return &RemoteURLWatcher{newLatestWatcher("remote url", "remote_url.changed",
		func() (string, error) { return read(), nil },
		func(id, url string) any { return remoteURLChangedParams{ID: id, RemoteURL: url} })}
}

// Changed tells the watcher the remote URL has changed. The relay calls it from
// its reconnect loop.
func (w *RemoteURLWatcher) Changed() { w.changed() }

type remoteURLChangedParams struct {
	ID        string `json:"id"`
	RemoteURL string `json:"remote_url"`
}
