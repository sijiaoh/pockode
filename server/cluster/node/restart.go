package node

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/pockode/server/internal/restart"
	"github.com/pockode/server/internal/shutdown"
	"github.com/pockode/server/serverinfo"
)

// restartTimeout is how long a node may take to come back before the cluster
// gives up on it. Where: the same minute as the frontends' RESTART_NOT_BACK_MS,
// for the same reason — a node publishes server.json only once its relay
// tunnel is up again.
const restartTimeout = 60 * time.Second

// ErrNodeRestarting is a node this cluster asked to restart that has not come
// back yet: it refuses Start, and a second Restart.
var ErrNodeRestarting = errors.New("node is restarting")

// restartRecord is a restart this cluster asked for. The record is what the
// cluster knows and the node's files do not: the start the request went to,
// and when. Whether that restart is still under way, back, or failed is never
// stored — it is read off server.json against these two, every time.
type restartRecord struct {
	requestedAt time.Time
	// token is the per-start token of the server.json the request was sent
	// to. A file with another one was written by a new start. started_at is
	// not used: it has one-second resolution, and a unix restart with the
	// relay off can finish inside the same second.
	token string
}

// restartPhase is where a recorded restart stands against the node's files.
type restartPhase int

const (
	restartNone    restartPhase = iota // no record, or the successor is up
	restartPending                     // within restartTimeout, no successor yet
	restartFailed                      // restartTimeout passed, no successor
)

// Restart asks a running node to restart itself into the installed executable
// — with its own password and options, which the cluster never sees — and
// records it, so that the node reads StatusRestarting until its successor
// writes server.json or restartTimeout passes. It returns once the node has
// been asked, not once it is back.
//
// Refusals, none of which sends anything:
//   - ErrNodeRestarting: a restart this cluster asked for is still under way.
//     Asking again is not merely redundant: on unix there is a moment after
//     the node has exec'd and before the new program catches the signal, in
//     which a second one would terminate it.
//   - ErrNodeNotRunning: no server.json, or its process is gone.
//   - ErrRestartUnsupported: a server.json without a version, from a build
//     that predates restarts, which on unix the signal would terminate. On
//     Windows also a node with a version but no restart event.
//   - *restart.NotRunnableError: the installed executable does not run. The
//     node would refuse the restart for it too, but a node asked by signal
//     cannot answer, so the refusal would only ever show as the timeout.
func (pm *ProcessManager) Restart(ctx context.Context, n Node) error {
	if err := pm.claimRestart(n); err != nil {
		return err
	}
	defer pm.releaseClaim(n)

	info, err := serverinfo.Read(nodeDataDir(n))
	if err != nil {
		return fmt.Errorf("failed to read server info: %w", err)
	}
	if info == nil || !processExists(info.PID) {
		return ErrNodeNotRunning
	}
	if info.Version == "" {
		return ErrRestartUnsupported
	}

	if _, err := (restart.Program{Path: pm.executablePath}).Version(ctx); err != nil {
		return &restart.NotRunnableError{Err: err}
	}

	// Recorded before the request goes out, not after: a Stop that lands
	// between the two would otherwise have its forgetRestart undone, and a
	// node it stopped would read restarting — and refuse Start — for a minute.
	pm.restartsMu.Lock()
	pm.restarts[n.ID] = restartRecord{requestedAt: pm.now(), token: info.Token}
	pm.restartsMu.Unlock()

	if err := shutdown.RequestRestart(info.PID); err != nil {
		// Nothing was asked, so there is nothing to wait for. The claim keeps
		// any other Restart from having replaced the record meanwhile.
		pm.forgetRestart(n)
		if errors.Is(err, shutdown.ErrRestartUnsupported) {
			return err
		}
		return fmt.Errorf("failed to request restart: %w", err)
	}
	return nil
}

// claimRestart makes this the one request for n until releaseClaim: one being
// made, or one made and still under way, refuses the next. The claim is held
// across the probe of the installed executable, which takes a moment, so two
// presses on two devices cannot both get past the check.
func (pm *ProcessManager) claimRestart(n Node) error {
	info, _ := serverinfo.Read(nodeDataDir(n))

	pm.restartsMu.Lock()
	defer pm.restartsMu.Unlock()
	if pm.requesting[n.ID] || pm.restartPhaseLocked(n, info) == restartPending {
		return ErrNodeRestarting
	}
	pm.requesting[n.ID] = true
	return nil
}

func (pm *ProcessManager) releaseClaim(n Node) {
	pm.restartsMu.Lock()
	delete(pm.requesting, n.ID)
	pm.restartsMu.Unlock()
}

// isRestarting reports whether a restart this cluster asked for is still under
// way.
func (pm *ProcessManager) isRestarting(n Node) bool {
	info, _ := serverinfo.Read(nodeDataDir(n))

	pm.restartsMu.Lock()
	defer pm.restartsMu.Unlock()
	return pm.restartPhaseLocked(n, info) == restartPending
}

// forgetRestart drops n's record, and with it a restart error: what Start,
// Stop and Cleanup do once they have succeeded, since the node is then in the
// state they made, not the one the restart left.
func (pm *ProcessManager) forgetRestart(n Node) {
	pm.restartsMu.Lock()
	delete(pm.restarts, n.ID)
	pm.restartsMu.Unlock()
}

// restartPhaseLocked compares n's record with info, its server.json as just
// read. A successor — a file from another start, with a live process — ends
// the record, also one that turns up after the timeout.
func (pm *ProcessManager) restartPhaseLocked(n Node, info *serverinfo.Info) restartPhase {
	r, ok := pm.restarts[n.ID]
	if !ok {
		return restartNone
	}
	if info != nil && info.Token != r.token && processExists(info.PID) {
		delete(pm.restarts, n.ID)
		return restartNone
	}
	if pm.now().Before(r.requestedAt.Add(restartTimeout)) {
		return restartPending
	}
	return restartFailed
}

// withRestart puts n's recorded restart, if any, over status, the status of
// info alone.
func (pm *ProcessManager) withRestart(n Node, info *serverinfo.Info, status NodeStatus) NodeStatus {
	pm.restartsMu.Lock()
	defer pm.restartsMu.Unlock()

	phase := pm.restartPhaseLocked(n, info)
	if phase == restartNone {
		return status
	}
	requestedAt := pm.restarts[n.ID].requestedAt.UTC().Format(time.RFC3339)
	if phase == restartPending {
		return NodeStatus{ID: n.ID, Status: StatusRestarting, RestartRequestedAt: &requestedAt}
	}

	// Running here can only be the start the request went to: another start
	// would have been a successor.
	logPath := filepath.Join(nodeDataDir(n), "server.log")
	var msg string
	if status.Status == StatusRunning {
		msg = "Didn't restart within a minute; the old server is still running. It may have refused — its project directory gone, say — or still be ending its AI sessions. Its log says which: " + logPath
	} else {
		msg = "Stopped for the restart and didn't come back within a minute. Its log says why: " + logPath
	}
	status.RestartRequestedAt = &requestedAt
	status.RestartError = &msg
	return status
}
