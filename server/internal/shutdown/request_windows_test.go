//go:build windows

package shutdown

import (
	"os"
	"testing"
	"time"
)

// TestWatchExitRequests_ReleasesEventName pins down what TestListen_AfterStop
// cannot see: RequestExit falls back to a console control event when the named
// event is missing, so on a machine that has a console — a CI runner does — that
// fallback would quietly stand in for a name that was never released. Watching
// the event directly leaves it nothing to hide behind.
func TestWatchExitRequests_ReleasesEventName(t *testing.T) {
	for attempt := 1; attempt <= 2; attempt++ {
		notified := make(chan struct{})
		w := watchExitRequests(func() { close(notified) })
		if w == nil {
			t.Fatalf("attempt %d: shutdown event was not published", attempt)
		}

		if err := RequestExit(os.Getpid()); err != nil {
			t.Fatalf("attempt %d: RequestExit: %v", attempt, err)
		}
		select {
		case <-notified:
		case <-time.After(notifyTimeout):
			t.Fatalf("attempt %d: watcher was not notified", attempt)
		}

		w.stop()
	}
}
