// Package node provides Node management for cluster mode.
package node

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"time"

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
// Token is required and passed as --auth-token command line argument.
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

	// Build command with auth-token as command line argument
	cmd := exec.Command(exePath, "--auth-token", token)
	cmd.Dir = n.Path

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
// It first tries graceful shutdown, then force kill after timeout.
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
