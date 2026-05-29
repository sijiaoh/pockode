package manager

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pockode/server/globalconfig"
)

func TestWorkerLifecycle(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	workDir := filepath.Join(tmpDir, "workspace")
	if err := os.MkdirAll(workDir, 0755); err != nil {
		t.Fatal(err)
	}

	worker := NewWorker(WorkerConfig{
		Workspace: globalconfig.Workspace{
			ID:   "test-workspace-1",
			Path: workDir,
			Name: "Test Workspace",
		},
		IdleTimeout: 8 * time.Hour,
	})

	if worker.State() != WorkerStateStopped {
		t.Errorf("expected initial state stopped, got %s", worker.State())
	}

	if worker.ID() != "test-workspace-1" {
		t.Errorf("expected ID test-workspace-1, got %s", worker.ID())
	}

	if worker.Name() != "Test Workspace" {
		t.Errorf("expected name Test Workspace, got %s", worker.Name())
	}

	if worker.Path() != workDir {
		t.Errorf("expected path %s, got %s", workDir, worker.Path())
	}

	if err := worker.Start(); err != nil {
		t.Fatalf("failed to start worker: %v", err)
	}

	if worker.State() != WorkerStateRunning {
		t.Errorf("expected state running, got %s", worker.State())
	}

	if err := worker.Start(); err != nil {
		t.Fatalf("second start should not fail: %v", err)
	}

	if worker.SettingsStore() == nil {
		t.Error("settings store should be initialized")
	}
	if worker.WorkStore() == nil {
		t.Error("work store should be initialized")
	}
	if worker.AgentRoleStore() == nil {
		t.Error("agent role store should be initialized")
	}
	if worker.CommandStore() == nil {
		t.Error("command store should be initialized")
	}
	if worker.WorktreeManager() == nil {
		t.Error("worktree manager should be initialized")
	}
	if worker.DataDir() == "" {
		t.Error("data dir should be set")
	}
	if worker.WorkStarter() == nil {
		t.Error("work starter should be initialized")
	}
	if worker.WorkStopper() == nil {
		t.Error("work stopper should be initialized")
	}

	worker.Stop()

	if worker.State() != WorkerStateStopped {
		t.Errorf("expected state stopped after stop, got %s", worker.State())
	}

	worker.Stop()
	if worker.State() != WorkerStateStopped {
		t.Errorf("expected state stopped after second stop, got %s", worker.State())
	}
}

func TestWorkerStartError(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	worker := NewWorker(WorkerConfig{
		Workspace: globalconfig.Workspace{
			ID:   "test-workspace-error",
			Path: "/nonexistent/path/that/does/not/exist",
			Name: "Error Workspace",
		},
		IdleTimeout: time.Hour,
	})

	err := worker.Start()
	if err == nil {
		worker.Stop()
		t.Fatal("expected error starting worker with nonexistent path")
	}

	if worker.State() != WorkerStateError {
		t.Errorf("expected state error, got %s", worker.State())
	}

	if worker.StateError() == nil {
		t.Error("expected state error to be set")
	}
}
