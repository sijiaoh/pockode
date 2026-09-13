// Package node provides Node management for cluster mode.
package node

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/pockode/server/authtoken"
	"github.com/pockode/server/serverinfo"
)

var (
	ErrNodeAlreadyRunning = errors.New("node already running")
	ErrNodeNotRunning     = errors.New("node not running")
	ErrProcessNotFound    = errors.New("process not found")
)

// ProcessManager handles starting and stopping pockode processes for nodes.
type ProcessManager struct {
	// executablePath is the path to the pockode executable.
	// If empty, uses the current executable.
	executablePath string
}

// NewProcessManager creates a new ProcessManager.
func NewProcessManager() *ProcessManager {
	return &ProcessManager{}
}

// Start starts a pockode process for the given node.
//
// The token is required and passed via the POCKODE_AUTH_TOKEN environment
// variable rather than a command-line flag, so it never appears in the child's
// argv (which is world-readable on Linux through /proc/<pid>/cmdline and `ps`).
// Returns an error if token is empty or if the node is already running.
func (pm *ProcessManager) Start(n Node, token string) error {
	if token == "" {
		return fmt.Errorf("%w: token is required", ErrInvalidNode)
	}

	dataDir := filepath.Join(n.Path, ".pockode")

	// Check if already running
	if pm.IsRunning(n) {
		return ErrNodeAlreadyRunning
	}

	// Get executable path
	exePath, err := pm.getExecutablePath()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %w", err)
	}

	// Pass the token through the environment, not argv, so it stays out of
	// /proc/<pid>/cmdline and `ps` output.
	cmd := exec.Command(exePath)
	cmd.Dir = n.Path
	cmd.Env = nodeEnv(os.Environ(), token)

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
	dataDir := filepath.Join(n.Path, ".pockode")

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

	return nil
}

// IsRunning checks if a pockode process is running for the given node.
func (pm *ProcessManager) IsRunning(n Node) bool {
	dataDir := filepath.Join(n.Path, ".pockode")

	info, err := serverinfo.Read(dataDir)
	if err != nil || info == nil {
		return false
	}

	return processExists(info.PID)
}

// GetNodeStatus returns the NodeStatus for a given node.
// It checks if server.json exists and if the process is running.
func (pm *ProcessManager) GetNodeStatus(n Node) NodeStatus {
	dataDir := filepath.Join(n.Path, ".pockode")

	info, err := serverinfo.Read(dataDir)
	if info == nil {
		if err != nil {
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
	}
}

// nodeEnv returns base with the auth-token env var set to token, dropping any
// inherited value for that key so the child sees exactly one, unambiguous token.
func nodeEnv(base []string, token string) []string {
	prefix := authtoken.EnvVar + "="
	env := make([]string, 0, len(base)+1)
	for _, kv := range base {
		if strings.HasPrefix(kv, prefix) {
			continue
		}
		env = append(env, kv)
	}
	return append(env, prefix+token)
}

// getExecutablePath returns the path to the pockode executable.
func (pm *ProcessManager) getExecutablePath() (string, error) {
	if pm.executablePath != "" {
		return pm.executablePath, nil
	}
	return os.Executable()
}

// ptrOrNil returns a pointer to s if non-empty, otherwise nil.
func ptrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
