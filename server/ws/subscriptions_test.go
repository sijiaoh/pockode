package ws

import (
	"slices"
	"testing"

	"github.com/pockode/server/watch"
)

// recordingWatcher records which subscriptions were given back to it.
type recordingWatcher struct {
	unsubscribed []string
}

var _ watch.Watcher = (*recordingWatcher)(nil)

func (w *recordingWatcher) Start() error          { return nil }
func (w *recordingWatcher) Stop()                 {}
func (w *recordingWatcher) Unsubscribe(id string) { w.unsubscribed = append(w.unsubscribed, id) }

// Close gives back what the connection still holds — the same id on two
// watchers being two subscriptions — and nothing the client already ended.
func TestSubscriptions_CloseGivesBackWhatIsHeld(t *testing.T) {
	a, b := &recordingWatcher{}, &recordingWatcher{}
	subs := NewSubscriptions()
	subs.Track("1", a)
	subs.Track("1", b)
	subs.Track("2", a)
	subs.Untrack("2", a)

	subs.Close()

	if !slices.Equal(a.unsubscribed, []string{"1"}) || !slices.Equal(b.unsubscribed, []string{"1"}) {
		t.Errorf("given back: a %v, b %v; want 1 on each", a.unsubscribed, b.unsubscribed)
	}
}

// A subscribe still in flight when the connection went must give its
// subscription back at once: Close has run and will never see it.
func TestSubscriptions_TrackAfterCloseGivesBack(t *testing.T) {
	w := &recordingWatcher{}
	subs := NewSubscriptions()
	subs.Close()

	subs.Track("1", w)

	if !slices.Equal(w.unsubscribed, []string{"1"}) {
		t.Errorf("given back %v, want 1", w.unsubscribed)
	}
}

func TestSubscriptions_UnsubscribeFromLeavesOtherWatchers(t *testing.T) {
	left, kept := &recordingWatcher{}, &recordingWatcher{}
	subs := NewSubscriptions()
	subs.Track("1", left)
	subs.Track("1", kept)

	subs.UnsubscribeFrom([]watch.Watcher{left})
	if !slices.Equal(left.unsubscribed, []string{"1"}) || len(kept.unsubscribed) != 0 {
		t.Fatalf("given back: left %v, kept %v; want only left's", left.unsubscribed, kept.unsubscribed)
	}

	subs.Close()
	if !slices.Equal(left.unsubscribed, []string{"1"}) || !slices.Equal(kept.unsubscribed, []string{"1"}) {
		t.Errorf("after Close: left %v, kept %v; want each given back once", left.unsubscribed, kept.unsubscribed)
	}
}
