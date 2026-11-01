//go:build windows

package shutdown

import (
	"errors"
	"os"
	"os/exec"
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

// helperSleepEnv makes the test binary a live process that publishes no
// restart event — what a node from a build that predates restarts looks like.
const helperSleepEnv = "POCKODE_TEST_SHUTDOWN_HELPER_SLEEP"

func TestMain(m *testing.M) {
	if os.Getenv(helperSleepEnv) != "" {
		time.Sleep(60 * time.Second)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// TestRequestRestart_ProcessWithoutEvent is how a cluster tells an old node on
// Windows: nothing answers, and the caller can say so rather than report a
// request as made.
func TestRequestRestart_ProcessWithoutEvent(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperSleepEnv+"=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	err := RequestRestart(cmd.Process.Pid)
	if !errors.Is(err, ErrRestartUnsupported) {
		t.Fatalf("RequestRestart = %v, want ErrRestartUnsupported", err)
	}
}
