package manager

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pockode/server/globalconfig"
)

func TestManagerWorkspaceLifecycle(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	workDir := filepath.Join(tmpDir, "workspace")
	if err := os.MkdirAll(workDir, 0755); err != nil {
		t.Fatal(err)
	}

	wsStore, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatal(err)
	}

	ws, err := wsStore.Register(workDir, "Test Workspace")
	if err != nil {
		t.Fatal(err)
	}

	mgr, err := NewManager(ManagerConfig{IdleTimeout: 8 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	if err := mgr.StartWorker(ws.ID); err != nil {
		t.Fatalf("failed to start worker: %v", err)
	}

	worker := mgr.GetWorker(ws.ID)
	if worker == nil {
		t.Fatal("worker should exist")
	}

	if worker.State() != WorkerStateRunning {
		t.Errorf("expected worker state running, got %s", worker.State())
	}

	if err := mgr.StartWorker(ws.ID); err != nil {
		t.Fatalf("second start should not fail: %v", err)
	}

	workers := mgr.ListWorkers()
	if len(workers) != 1 {
		t.Errorf("expected 1 worker, got %d", len(workers))
	}

	statuses := mgr.ListWorkerStatuses()
	if len(statuses) != 1 {
		t.Errorf("expected 1 status, got %d", len(statuses))
	}
	if statuses[0].WorkspaceID != ws.ID {
		t.Errorf("expected workspace ID %s, got %s", ws.ID, statuses[0].WorkspaceID)
	}
	if statuses[0].State != WorkerStateRunning {
		t.Errorf("expected state running, got %s", statuses[0].State)
	}

	mgr.StopWorker(ws.ID)

	if mgr.GetWorker(ws.ID) != nil {
		t.Error("worker should be removed after stop")
	}
}

func TestManagerGetWorkerByPath(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	workDir1 := filepath.Join(tmpDir, "workspace1")
	workDir2 := filepath.Join(tmpDir, "workspace2")
	for _, dir := range []string{workDir1, workDir2} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}

	wsStore, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatal(err)
	}

	ws1, err := wsStore.Register(workDir1, "Workspace 1")
	if err != nil {
		t.Fatal(err)
	}

	ws2, err := wsStore.Register(workDir2, "Workspace 2")
	if err != nil {
		t.Fatal(err)
	}

	mgr, err := NewManager(ManagerConfig{IdleTimeout: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	if err := mgr.StartWorker(ws1.ID); err != nil {
		t.Fatal(err)
	}
	if err := mgr.StartWorker(ws2.ID); err != nil {
		t.Fatal(err)
	}

	worker1 := mgr.GetWorkerByPath(workDir1)
	if worker1 == nil {
		t.Fatal("worker1 not found by path")
	}
	if worker1.ID() != ws1.ID {
		t.Errorf("expected worker1 ID %s, got %s", ws1.ID, worker1.ID())
	}

	worker2 := mgr.GetWorkerByPath(workDir2)
	if worker2 == nil {
		t.Fatal("worker2 not found by path")
	}
	if worker2.ID() != ws2.ID {
		t.Errorf("expected worker2 ID %s, got %s", ws2.ID, worker2.ID())
	}

	if mgr.GetWorkerByPath("/nonexistent") != nil {
		t.Error("expected nil for nonexistent path")
	}
}

func TestManagerStartWorkerNotFound(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	mgr, err := NewManager(ManagerConfig{IdleTimeout: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	err = mgr.StartWorker("nonexistent-id")
	if err == nil {
		t.Error("expected error for nonexistent workspace")
	}
}

func TestManagerWorkspaceStore(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	mgr, err := NewManager(ManagerConfig{IdleTimeout: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	if mgr.WorkspaceStore() == nil {
		t.Error("workspace store should not be nil")
	}
}

func TestManagerRestartStoppedWorker(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	workDir := filepath.Join(tmpDir, "workspace")
	if err := os.MkdirAll(workDir, 0755); err != nil {
		t.Fatal(err)
	}

	wsStore, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatal(err)
	}

	ws, err := wsStore.Register(workDir, "Test")
	if err != nil {
		t.Fatal(err)
	}

	mgr, err := NewManager(ManagerConfig{IdleTimeout: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	// Start worker
	if err := mgr.StartWorker(ws.ID); err != nil {
		t.Fatal(err)
	}

	worker1 := mgr.GetWorker(ws.ID)
	if worker1 == nil {
		t.Fatal("worker should exist")
	}

	// Stop it manually
	worker1.Stop()

	// Start again - should create new worker since old one is stopped
	if err := mgr.StartWorker(ws.ID); err != nil {
		t.Fatalf("restart should succeed: %v", err)
	}

	worker2 := mgr.GetWorker(ws.ID)
	if worker2 == nil {
		t.Fatal("new worker should exist")
	}

	if worker2.State() != WorkerStateRunning {
		t.Errorf("expected running state, got %s", worker2.State())
	}
}

func TestManagerStopNonexistentWorker(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	mgr, err := NewManager(ManagerConfig{IdleTimeout: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	// Should be a no-op, not panic
	mgr.StopWorker("nonexistent-id")
}

func TestManagerShutdown(t *testing.T) {
	tmpDir := t.TempDir()
	os.Setenv("POCKODE_HOME", filepath.Join(tmpDir, "pockode-home"))
	defer os.Unsetenv("POCKODE_HOME")
	defer globalconfig.ResetDir()

	workDir := filepath.Join(tmpDir, "workspace")
	if err := os.MkdirAll(workDir, 0755); err != nil {
		t.Fatal(err)
	}

	wsStore, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatal(err)
	}

	ws, err := wsStore.Register(workDir, "Test")
	if err != nil {
		t.Fatal(err)
	}

	mgr, err := NewManager(ManagerConfig{IdleTimeout: time.Hour})
	if err != nil {
		t.Fatal(err)
	}

	if err := mgr.StartWorker(ws.ID); err != nil {
		t.Fatal(err)
	}

	mgr.Shutdown()

	if len(mgr.ListWorkers()) != 0 {
		t.Error("expected no workers after shutdown")
	}
}
