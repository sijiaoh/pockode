package watch

import (
	"encoding/json"
	"sync"
	"testing"
)

// fakeRemoteURL stands in for relay.Manager.RemoteURL.
type fakeRemoteURL struct {
	mu  sync.Mutex
	url string
}

func (f *fakeRemoteURL) set(url string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.url = url
}

func (f *fakeRemoteURL) read() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.url
}

// lastRemoteURL decodes by wire name, and fails on a missing field rather than
// reading it as empty: an empty URL is a message of its own ("remote access
// has ended"), so it has to be sent, not left out.
func lastRemoteURL(t *testing.T, n *captureNotifier) (id, url string) {
	t.Helper()
	var params map[string]*string
	if err := json.Unmarshal(n.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params["id"] == nil || params["remote_url"] == nil {
		t.Fatalf("notification lacks id or remote_url: %s", n.last())
	}
	return *params["id"], *params["remote_url"]
}

// A subscriber hears every move of the remote URL as the URL itself, including
// the move to nothing when remote access ends for good.
func TestRemoteURLWatcher_NotifiesChanges(t *testing.T) {
	const (
		oldURL = "https://abc123.cloud.pockode.com"
		newURL = "https://def456.cloud.pockode.com"
	)
	source := &fakeRemoteURL{url: oldURL}
	w := NewRemoteURLWatcher(source.read)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	got, err := w.Subscribe("client-1", notifier)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if got != oldURL {
		t.Errorf("Subscribe returned %q, want %q", got, oldURL)
	}

	for _, want := range []string{newURL, ""} {
		source.set(want)
		w.Changed()
		waitFor(t, func() bool {
			if notifier.count() == 0 {
				return false
			}
			_, url := lastRemoteURL(t, notifier)
			return url == want
		})
		if id, _ := lastRemoteURL(t, notifier); id != "client-1" {
			t.Errorf("notification id = %q, want %q", id, "client-1")
		}
	}

	notifier.mu.Lock()
	defer notifier.mu.Unlock()
	for i, method := range notifier.methods {
		if method != "remote_url.changed" {
			t.Errorf("notification %d method = %q, want remote_url.changed", i, method)
		}
	}
}

// Changes that pile up before the watcher gets to them are not queued, and
// must not be dropped either: whatever is sent last is the URL as it is now.
// Changed is called before the loop runs, so a watcher that captured the URL
// at Changed time would be left sending the first one.
func TestRemoteURLWatcher_PiledUpChangesEndOnTheLatest(t *testing.T) {
	const latest = "https://def456.cloud.pockode.com"
	source := &fakeRemoteURL{url: "https://abc123.cloud.pockode.com"}
	w := NewRemoteURLWatcher(source.read)

	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("Subscribe: %v", err)
	}

	source.set("https://moved.cloud.pockode.com")
	w.Changed()
	source.set(latest)
	w.Changed()

	w.Start()
	defer w.Stop()

	waitFor(t, func() bool {
		if notifier.count() == 0 {
			return false
		}
		_, url := lastRemoteURL(t, notifier)
		return url == latest
	})
}
