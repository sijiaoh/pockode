package node

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/internal/restart"
	"github.com/pockode/server/internal/restarttest"
	"github.com/pockode/server/serverinfo"
)

// restartingNode is a helper node that records a restart request and exits on
// it, with the server.json of the start the request goes to.
type restartingNode struct {
	helperNode
	node      Node
	info      serverinfo.Info
	restarted string // created by the helper once the request arrived
}

func startRestartingNode(t *testing.T, version string) restartingNode {
	t.Helper()
	restarted := filepath.Join(t.TempDir(), "restarted")
	t.Setenv(helperRestartedEnv, restarted)
	helper := startHelperNode(t, helperRestarts)
	nodeDir := t.TempDir()
	info := serverinfo.Info{
		PID:       helper.pid,
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
		Token:     "first-start",
		Version:   version,
	}
	writeServerJSON(t, nodeDir, info)
	return restartingNode{helperNode: helper, node: Node{ID: "test-id", Path: nodeDir}, info: info, restarted: restarted}
}

// requireReceived waits for the helper to have been asked to restart.
func (r restartingNode) requireReceived(t *testing.T) {
	t.Helper()
	select {
	case <-r.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("helper node did not receive the restart request")
	}
	if _, err := os.Stat(r.restarted); err != nil {
		t.Fatalf("helper exited without recording the restart request: %v", err)
	}
}

// requireNotReceived gives a request that was sent anyway the time to show;
// nothing sent has nothing to wait for.
func (r restartingNode) requireNotReceived(t *testing.T) {
	t.Helper()
	select {
	case <-r.exited:
		t.Fatal("helper node exited although no request should have been sent")
	case <-time.After(300 * time.Millisecond):
	}
}

// fakeClock replaces pm's clock with one the test moves.
func fakeClock(pm *ProcessManager) *time.Time {
	now := time.Date(2025, 6, 14, 10, 0, 0, 0, time.UTC)
	pm.now = func() time.Time { return now }
	return &now
}

// TestRestart is the cross-process round trip a cluster makes. Only a node
// whose server.json carries a version is sent anything: on unix the signal
// would terminate a build that predates restarts.
func TestRestart(t *testing.T) {
	restarttest.Install(t, "1.2.4")

	t.Run("node with a version", func(t *testing.T) {
		r := startRestartingNode(t, "1.2.3")
		pm := NewProcessManager(os.Args[0])
		now := fakeClock(pm)

		if err := pm.Restart(context.Background(), r.node); err != nil {
			t.Fatalf("Restart() = %v", err)
		}
		r.requireReceived(t)

		status := pm.GetNodeStatus(r.node)
		if status.Status != StatusRestarting {
			t.Errorf("status = %q, want %q", status.Status, StatusRestarting)
		}
		if want := now.Format(time.RFC3339); status.RestartRequestedAt == nil || *status.RestartRequestedAt != want {
			t.Errorf("restart_requested_at = %v, want %s", status.RestartRequestedAt, want)
		}
		if status.RestartError != nil || status.Version != nil {
			t.Errorf("a restarting node carries %+v, want neither an error nor a version", status)
		}
	})

	t.Run("node that predates restarts", func(t *testing.T) {
		r := startRestartingNode(t, "")
		pm := NewProcessManager(os.Args[0])

		if err := pm.Restart(context.Background(), r.node); !errors.Is(err, ErrRestartUnsupported) {
			t.Fatalf("Restart() = %v, want ErrRestartUnsupported", err)
		}
		r.requireNotReceived(t)
		if status := pm.GetNodeStatus(r.node); status.Status != StatusRunning {
			t.Errorf("status = %q, want it still running", status.Status)
		}
	})

	t.Run("installed executable does not run", func(t *testing.T) {
		restarttest.Break(t, "boom")
		r := startRestartingNode(t, "1.2.3")
		pm := NewProcessManager(os.Args[0])

		err := pm.Restart(context.Background(), r.node)
		var notRunnable *restart.NotRunnableError
		if !errors.As(err, &notRunnable) || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("Restart() = %v, want a NotRunnableError carrying the run's stderr", err)
		}
		r.requireNotReceived(t)
		if status := pm.GetNodeStatus(r.node); status.Status != StatusRunning {
			t.Errorf("status = %q, want it still running", status.Status)
		}
	})
}

func TestRestart_NotRunning(t *testing.T) {
	restarttest.Install(t, "1.2.4")
	pm := NewProcessManager(os.Args[0])

	t.Run("no server.json", func(t *testing.T) {
		if err := pm.Restart(context.Background(), Node{ID: "test-id", Path: t.TempDir()}); !errors.Is(err, ErrNodeNotRunning) {
			t.Errorf("Restart() = %v, want ErrNodeNotRunning", err)
		}
	})
	t.Run("stale server.json", func(t *testing.T) {
		requireDeadPID(t)
		nodeDir := t.TempDir()
		serverJSONPath := writeServerJSON(t, nodeDir, serverinfo.Info{PID: deadPID, Port: 9870, Version: "1.2.3"})
		if err := pm.Restart(context.Background(), Node{ID: "test-id", Path: nodeDir}); !errors.Is(err, ErrNodeNotRunning) {
			t.Errorf("Restart() = %v, want ErrNodeNotRunning", err)
		}
		if _, err := os.Stat(serverJSONPath); err != nil {
			t.Errorf("server.json of a stale node was touched: %v", err)
		}
	})
}

// TestRestart_WhileRestarting covers what a restart under way refuses: a
// second request — on unix one landing just after the exec would terminate the
// node — and a start, which in the Windows gap between the old server.json and
// the new one would put a second server on the project.
func TestRestart_WhileRestarting(t *testing.T) {
	restarttest.Install(t, "1.2.4")
	r := startRestartingNode(t, "1.2.3")
	pm := NewProcessManager(os.Args[0])

	// Two presses at once, as from two devices: exactly one is sent.
	errs := make(chan error, 2)
	for range 2 {
		go func() { errs <- pm.Restart(context.Background(), r.node) }()
	}
	var sent, refused int
	for range 2 {
		switch err := <-errs; {
		case err == nil:
			sent++
		case errors.Is(err, ErrNodeRestarting):
			refused++
		default:
			t.Fatalf("Restart() = %v", err)
		}
	}
	if sent != 1 || refused != 1 {
		t.Fatalf("concurrent restarts: %d sent, %d refused; want 1 and 1", sent, refused)
	}
	r.requireReceived(t)

	// The successor has not written its file yet: the old one is gone, as on
	// Windows.
	if err := serverinfo.Delete(filepath.Join(r.node.Path, ".pockode")); err != nil {
		t.Fatal(err)
	}
	if status := pm.GetNodeStatus(r.node); status.Status != StatusRestarting {
		t.Errorf("status without server.json = %q, want %q", status.Status, StatusRestarting)
	}
	if err := pm.Restart(context.Background(), r.node); !errors.Is(err, ErrNodeRestarting) {
		t.Errorf("Restart() while restarting = %v, want ErrNodeRestarting", err)
	}
	if err := pm.Start(r.node, "password"); !errors.Is(err, ErrNodeRestarting) {
		t.Errorf("Start() while restarting = %v, want ErrNodeRestarting", err)
	}
}

// TestRestart_Outcome follows a restart to its end, read off server.json: a
// file from a new start with a live process is done, and after the timeout
// the node reads what its files say with the reason it did not come back —
// until a successor turns up after all.
func TestRestart_Outcome(t *testing.T) {
	restarttest.Install(t, "1.2.4")

	// successor is the server.json a new start writes; the PID is any live
	// process, as the restarted node's own is on unix.
	successor := func(old serverinfo.Info) serverinfo.Info {
		old.PID = os.Getpid()
		old.Token = "second-start"
		old.Version = "1.2.4"
		return old
	}

	tests := []struct {
		name string
		// after is the node's server.json once the request went out; nil is
		// none.
		after      func(serverinfo.Info) *serverinfo.Info
		wantStatus Status
		wantError  string // a fragment of restart_error after the timeout
	}{
		{
			name: "the old start still runs",
			after: func(old serverinfo.Info) *serverinfo.Info {
				old.PID = os.Getpid() // the same start, still alive
				return &old
			},
			wantStatus: StatusRunning,
			wantError:  "the old server is still running",
		},
		{
			name:       "nothing came back",
			after:      func(serverinfo.Info) *serverinfo.Info { return nil },
			wantStatus: StatusStopped,
			wantError:  "Stopped for the restart and didn't come back",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := startRestartingNode(t, "1.2.3")
			pm := NewProcessManager(os.Args[0])
			now := fakeClock(pm)
			dataDir := filepath.Join(r.node.Path, ".pockode")

			if err := pm.Restart(context.Background(), r.node); err != nil {
				t.Fatalf("Restart() = %v", err)
			}
			r.requireReceived(t)
			requestedAt := now.Format(time.RFC3339)
			if err := serverinfo.Delete(dataDir); err != nil {
				t.Fatal(err)
			}
			if info := tc.after(r.info); info != nil {
				writeServerJSON(t, r.node.Path, *info)
			}

			*now = now.Add(restartTimeout - time.Second)
			if status := pm.GetNodeStatus(r.node); status.Status != StatusRestarting {
				t.Fatalf("status before the timeout = %q, want %q", status.Status, StatusRestarting)
			}

			*now = now.Add(time.Second)
			status := pm.GetNodeStatus(r.node)
			if status.Status != tc.wantStatus {
				t.Errorf("status after the timeout = %q, want %q", status.Status, tc.wantStatus)
			}
			if status.RestartError == nil || !strings.Contains(*status.RestartError, tc.wantError) ||
				!strings.Contains(*status.RestartError, filepath.Join(dataDir, "server.log")) {
				t.Errorf("restart_error = %v, want one saying %q and naming the node's log", status.RestartError, tc.wantError)
			}
			if status.RestartRequestedAt == nil || *status.RestartRequestedAt != requestedAt {
				t.Errorf("restart_requested_at = %v, want %s alongside the error", status.RestartRequestedAt, requestedAt)
			}

			// A successor after the timeout still counts.
			writeServerJSON(t, r.node.Path, successor(r.info))
			status = pm.GetNodeStatus(r.node)
			if status.Status != StatusRunning || status.RestartError != nil || status.RestartRequestedAt != nil {
				t.Errorf("status with a late successor = %+v, want running with no restart fields", status)
			}
			if status.Version == nil || *status.Version != "1.2.4" {
				t.Errorf("version = %v, want the successor's 1.2.4", status.Version)
			}
		})
	}

	t.Run("a successor in time", func(t *testing.T) {
		r := startRestartingNode(t, "1.2.3")
		pm := NewProcessManager(os.Args[0])
		fakeClock(pm)

		if err := pm.Restart(context.Background(), r.node); err != nil {
			t.Fatalf("Restart() = %v", err)
		}
		r.requireReceived(t)
		writeServerJSON(t, r.node.Path, successor(r.info))

		status := pm.GetNodeStatus(r.node)
		if status.Status != StatusRunning || status.RestartRequestedAt != nil {
			t.Errorf("status = %+v, want running with no restart fields", status)
		}
	})
}

// A restart that did not come back leaves its error until something else
// succeeds on the node; Cleanup of the stale file it left is one.
func TestRestart_ErrorClearedBySucceedingAction(t *testing.T) {
	restarttest.Install(t, "1.2.4")
	requireDeadPID(t)
	r := startRestartingNode(t, "1.2.3")
	pm := NewProcessManager(os.Args[0])
	now := fakeClock(pm)

	if err := pm.Restart(context.Background(), r.node); err != nil {
		t.Fatalf("Restart() = %v", err)
	}
	r.requireReceived(t)
	stale := r.info
	stale.PID = deadPID
	writeServerJSON(t, r.node.Path, stale)
	*now = now.Add(restartTimeout)

	if status := pm.GetNodeStatus(r.node); status.Status != StatusStale || status.RestartError == nil {
		t.Fatalf("status = %+v, want stale with a restart error", status)
	}
	if err := pm.Cleanup(r.node); err != nil {
		t.Fatalf("Cleanup() = %v", err)
	}
	if status := pm.GetNodeStatus(r.node); status.Status != StatusStopped || status.RestartError != nil {
		t.Errorf("status after Cleanup = %+v, want stopped with no restart error", status)
	}
}
