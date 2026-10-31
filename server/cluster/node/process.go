// Package node provides Node management for cluster mode.
package node

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/pockode/server/internal/shutdown"
	"github.com/pockode/server/password"
	"github.com/pockode/server/serverinfo"
)

var (
	ErrNodeAlreadyRunning = errors.New("node already running")
	ErrNodeNotRunning     = errors.New("node not running")
	ErrNodeStillRunning   = errors.New("node is still running")
	ErrProcessNotFound    = errors.New("process not found")
	// ErrRestartUnsupported is a running node that cannot be asked to restart:
	// a build that predates restarts, which only stopping and starting it
	// again brings up to date. The same value as shutdown's, so errors.Is
	// matches either.
	ErrRestartUnsupported = shutdown.ErrRestartUnsupported
)

// ProcessManager handles starting, stopping and restarting pockode processes
// for nodes.
type ProcessManager struct {
	executablePath string

	// restartsMu guards restarts and requesting: the restarts this cluster
	// asked for, by node ID (see restart.go).
	restartsMu sync.Mutex
	restarts   map[string]restartRecord
	requesting map[string]bool
	// now is time.Now, replaced by tests that need a restart to run out.
	now func() time.Time
}

// NewProcessManager creates a ProcessManager that starts nodes from
// executablePath.
//
// The path is the one resolved when the cluster started (restart.Program.Path),
// not os.Executable() asked now: that resolves symlinks to the file this
// process started from, which an upgrade that moved a link into a new
// versioned directory has removed, and starting a node from that fails.
func NewProcessManager(executablePath string) *ProcessManager {
	return &ProcessManager{
		executablePath: executablePath,
		restarts:       map[string]restartRecord{},
		requesting:     map[string]bool{},
		now:            time.Now,
	}
}

// ExecutablePath is the file nodes are started from, and restart into.
func (pm *ProcessManager) ExecutablePath() string {
	return pm.executablePath
}

// Start starts a pockode process for the given node.
//
// The password is required and passed via the POCKODE_PASSWORD environment
// variable rather than a command-line flag, so it never appears in the child's
// argv (which is world-readable on Linux through /proc/<pid>/cmdline and `ps`).
// Returns an error if the password is empty, if the node is already running,
// or if it is restarting (ErrNodeRestarting) — on Windows a restarting node has
// no server.json for a moment, and starting it then would put a second server
// on the project.
func (pm *ProcessManager) Start(n Node, nodePassword string) error {
	if nodePassword == "" {
		return fmt.Errorf("%w: password is required", ErrInvalidNode)
	}

	dataDir := nodeDataDir(n)

	if pm.isRestarting(n) {
		return ErrNodeRestarting
	}
	if pm.IsRunning(n) {
		return ErrNodeAlreadyRunning
	}

	// A node that was killed or crashed leaves its server.json behind, and the
	// node is not running, so the check above lets us through with that file
	// still on disk. waitForServerInfo would read it on its first attempt and
	// report the node started before the process we are about to spawn has
	// written anything — while every later status read still sees the dead PID
	// and reports the node stale. Removing it first is what makes the wait below
	// wait for *this* process.
	if err := serverinfo.Delete(dataDir); err != nil {
		return fmt.Errorf("failed to remove stale server.json: %w", err)
	}

	// Pass the password through the environment, not argv, so it stays out of
	// /proc/<pid>/cmdline and `ps` output.
	cmd := exec.Command(pm.executablePath)
	cmd.Dir = n.Path
	cmd.Env = password.WithEnv(os.Environ(), nodePassword)

	// Set platform-specific process attributes
	setProcessDetached(cmd)

	// Redirect output to null (process runs in background)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start process: %w", err)
	}

	// Release process handle to prevent zombie processes.
	// The child process is detached and will continue running independently.
	go cmd.Wait()

	if err := pm.waitForServerInfo(dataDir); err != nil {
		return err
	}

	pm.forgetRestart(n)
	return nil
}

func (pm *ProcessManager) waitForServerInfo(dataDir string) error {
	const (
		initialWait   = 100 * time.Millisecond
		maxWait       = 2 * time.Second
		maxRetries    = 10
		backoffFactor = 2
	)

	wait := initialWait
	for attempt := 1; attempt <= maxRetries; attempt++ {
		time.Sleep(wait)

		info, err := serverinfo.Read(dataDir)
		if err != nil {
			// Read error (e.g., JSON parse error) - fail immediately
			return fmt.Errorf("failed to read server.json: %w", err)
		}
		if info != nil {
			if attempt > 1 {
				slog.Info("server.json found", "attempts", attempt)
			}
			return nil
		}

		slog.Debug("server.json not found, retrying", "attempt", attempt, "maxRetries", maxRetries)

		wait *= backoffFactor
		if wait > maxWait {
			wait = maxWait
		}
	}

	return errors.New("process started but server.json not created within timeout")
}

// Stop stops the pockode process for the given node.
// It first asks the node to exit, then force kills it after a timeout.
func (pm *ProcessManager) Stop(n Node) error {
	dataDir := nodeDataDir(n)

	info, err := serverinfo.Read(dataDir)
	if err != nil {
		return fmt.Errorf("failed to read server info: %w", err)
	}
	if info == nil {
		return ErrNodeNotRunning
	}

	// Check if process is actually running
	if !processExists(info.PID) {
		// Process doesn't exist, clean up server.json
		_ = serverinfo.Delete(dataDir)
		return ErrNodeNotRunning
	}

	// Perform platform-specific process termination
	if err := terminateProcess(info.PID); err != nil {
		return fmt.Errorf("failed to terminate process: %w", err)
	}

	// The process is gone by now (terminateProcess only returns nil once it is).
	// A node that shut down gracefully already removed its own server.json; one
	// that had to be killed could not, and the leftover file would report the
	// node as stale even though the cluster is what stopped it.
	if err := serverinfo.Delete(dataDir); err != nil {
		return fmt.Errorf("failed to clean up server.json: %w", err)
	}

	pm.forgetRestart(n)
	return nil
}

// Cleanup removes a node's leftover server.json: the file a node that was
// killed or crashed could not remove itself, and which is the only reason the
// node is reported stale. Nothing else is touched — the project directory and
// its data are not this operation's business.
//
// It is idempotent. A node with no server.json is already in the state Cleanup
// is asked for, so it succeeds rather than reporting a problem the caller
// cannot act on.
//
// A node whose process is alive is refused: that file is how the rest of the
// system reaches the running server, and deleting it would leave a node nobody
// can find or stop.
func (pm *ProcessManager) Cleanup(n Node) error {
	if pm.IsRunning(n) {
		return ErrNodeStillRunning
	}

	dataDir := nodeDataDir(n)
	if err := serverinfo.Delete(dataDir); err != nil {
		return fmt.Errorf("failed to remove server.json: %w", err)
	}

	pm.forgetRestart(n)
	return nil
}

// IsRunning checks if a pockode process is running for the given node.
func (pm *ProcessManager) IsRunning(n Node) bool {
	dataDir := nodeDataDir(n)

	info, err := serverinfo.Read(dataDir)
	if err != nil || info == nil {
		return false
	}

	return processExists(info.PID)
}

// GetNodeStatus returns the NodeStatus for a given node: what its server.json
// says, unless a restart this cluster asked for is still under way or did not
// come back (see restart.go). server.json is read afresh on every call — a
// restart on Windows replaces the file under a new PID.
func (pm *ProcessManager) GetNodeStatus(n Node) NodeStatus {
	info, err := serverinfo.Read(nodeDataDir(n))
	return pm.withRestart(n, info, fileStatus(n, info, err))
}

// fileStatus is the status server.json alone gives.
func fileStatus(n Node, info *serverinfo.Info, readErr error) NodeStatus {
	if info == nil {
		if readErr != nil {
			// File exists but couldn't be read/parsed (corrupted or permission issue)
			return NodeStatus{
				ID:     n.ID,
				Status: StatusStale,
			}
		}
		// File doesn't exist
		return NodeStatus{
			ID:     n.ID,
			Status: StatusStopped,
		}
	}

	if !processExists(info.PID) {
		return NodeStatus{
			ID:     n.ID,
			Status: StatusStale,
		}
	}

	return NodeStatus{
		ID:        n.ID,
		Status:    StatusRunning,
		Port:      &info.Port,
		StartedAt: &info.StartedAt,
		LocalURL:  ptrOrNil(info.LocalURL),
		RemoteURL: ptrOrNil(info.RemoteURL),
		Version:   ptrOrNil(info.Version),
	}
}

func nodeDataDir(n Node) string {
	return filepath.Join(n.Path, ".pockode")
}

// ptrOrNil returns a pointer to s if non-empty, otherwise nil.
func ptrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
