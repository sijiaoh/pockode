package node

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// --- processExists ---

func TestProcessExists_CurrentProcess(t *testing.T) {
	pid := os.Getpid()
	if !processExists(pid) {
		t.Errorf("processExists(%d) = false, want true for current process", pid)
	}
}

func TestProcessExists_InvalidPID(t *testing.T) {
	tests := []struct {
		name string
		pid  int
	}{
		{"zero", 0},
		{"negative", -1},
		{"very negative", -999999},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if processExists(tc.pid) {
				t.Errorf("processExists(%d) = true, want false", tc.pid)
			}
		})
	}
}

func TestProcessExists_NonexistentPID(t *testing.T) {
	// Use a very high PID that's unlikely to exist
	// Note: This test may be flaky on systems with many processes
	pid := 999999999
	if processExists(pid) {
		t.Skipf("PID %d exists on this system, skipping", pid)
	}
}

// --- GetNodeStatus ---

func TestGetNodeStatus_Stopped(t *testing.T) {
	pm := NewProcessManager()
	node := Node{
		ID:   "test-id",
		Path: t.TempDir(), // Empty directory, no server.json
	}

	status := pm.GetNodeStatus(node)

	if status.ID != "test-id" {
		t.Errorf("status.ID = %q, want %q", status.ID, "test-id")
	}
	if status.Status != StatusStopped {
		t.Errorf("status.Status = %q, want %q", status.Status, StatusStopped)
	}
	if status.Port != nil {
		t.Errorf("status.Port = %v, want nil", status.Port)
	}
	if status.StartedAt != nil {
		t.Errorf("status.StartedAt = %v, want nil", status.StartedAt)
	}
}

func TestGetNodeStatus_Running(t *testing.T) {
	pm := NewProcessManager()
	nodeDir := t.TempDir()
	dataDir := filepath.Join(nodeDir, ".pockode")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create server.json with current process PID
	serverInfo := struct {
		PID       int    `json:"pid"`
		Port      int    `json:"port"`
		StartedAt string `json:"started_at"`
		LocalURL  string `json:"local_url,omitempty"`
		RemoteURL string `json:"remote_url,omitempty"`
	}{
		PID:       os.Getpid(),
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
		LocalURL:  "http://localhost:9870",
		RemoteURL: "https://example.com",
	}
	data, _ := json.Marshal(serverInfo)
	if err := os.WriteFile(filepath.Join(dataDir, "server.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	node := Node{
		ID:   "test-id",
		Path: nodeDir,
	}

	status := pm.GetNodeStatus(node)

	if status.ID != "test-id" {
		t.Errorf("status.ID = %q, want %q", status.ID, "test-id")
	}
	if status.Status != StatusRunning {
		t.Errorf("status.Status = %q, want %q", status.Status, StatusRunning)
	}
	if status.Port == nil || *status.Port != 9870 {
		t.Errorf("status.Port = %v, want 9870", status.Port)
	}
	if status.StartedAt == nil || *status.StartedAt != "2025-06-14T10:00:00Z" {
		t.Errorf("status.StartedAt = %v, want 2025-06-14T10:00:00Z", status.StartedAt)
	}
	if status.LocalURL == nil || *status.LocalURL != "http://localhost:9870" {
		t.Errorf("status.LocalURL = %v, want http://localhost:9870", status.LocalURL)
	}
	if status.RemoteURL == nil || *status.RemoteURL != "https://example.com" {
		t.Errorf("status.RemoteURL = %v, want https://example.com", status.RemoteURL)
	}
}

func TestGetNodeStatus_Running_EmptyURLs(t *testing.T) {
	pm := NewProcessManager()
	nodeDir := t.TempDir()
	dataDir := filepath.Join(nodeDir, ".pockode")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create server.json without URL fields
	serverInfo := struct {
		PID       int    `json:"pid"`
		Port      int    `json:"port"`
		StartedAt string `json:"started_at"`
	}{
		PID:       os.Getpid(),
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	}
	data, _ := json.Marshal(serverInfo)
	if err := os.WriteFile(filepath.Join(dataDir, "server.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	node := Node{
		ID:   "test-id",
		Path: nodeDir,
	}

	status := pm.GetNodeStatus(node)

	if status.Status != StatusRunning {
		t.Errorf("status.Status = %q, want %q", status.Status, StatusRunning)
	}
	if status.LocalURL != nil {
		t.Errorf("status.LocalURL = %v, want nil for empty URL", status.LocalURL)
	}
	if status.RemoteURL != nil {
		t.Errorf("status.RemoteURL = %v, want nil for empty URL", status.RemoteURL)
	}
}

func TestGetNodeStatus_Stale_ProcessNotRunning(t *testing.T) {
	pm := NewProcessManager()
	nodeDir := t.TempDir()
	dataDir := filepath.Join(nodeDir, ".pockode")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create server.json with a non-existent PID
	serverInfo := struct {
		PID       int    `json:"pid"`
		Port      int    `json:"port"`
		StartedAt string `json:"started_at"`
	}{
		PID:       999999999, // Very unlikely to exist
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	}
	data, _ := json.Marshal(serverInfo)
	if err := os.WriteFile(filepath.Join(dataDir, "server.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	// Skip if PID happens to exist
	if processExists(999999999) {
		t.Skip("PID 999999999 exists, skipping")
	}

	node := Node{
		ID:   "test-id",
		Path: nodeDir,
	}

	status := pm.GetNodeStatus(node)

	if status.Status != StatusStale {
		t.Errorf("status.Status = %q, want %q", status.Status, StatusStale)
	}
	if status.Port != nil {
		t.Errorf("status.Port should be nil for stale status")
	}
}

func TestGetNodeStatus_Stale_CorruptedJSON(t *testing.T) {
	pm := NewProcessManager()
	nodeDir := t.TempDir()
	dataDir := filepath.Join(nodeDir, ".pockode")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create corrupted server.json
	if err := os.WriteFile(filepath.Join(dataDir, "server.json"), []byte("not valid json"), 0644); err != nil {
		t.Fatal(err)
	}

	node := Node{
		ID:   "test-id",
		Path: nodeDir,
	}

	status := pm.GetNodeStatus(node)

	if status.Status != StatusStale {
		t.Errorf("status.Status = %q, want %q for corrupted JSON", status.Status, StatusStale)
	}
}

// --- IsRunning ---

func TestIsRunning_NotRunning(t *testing.T) {
	pm := NewProcessManager()
	node := Node{
		ID:   "test-id",
		Path: t.TempDir(),
	}

	if pm.IsRunning(node) {
		t.Error("IsRunning() = true, want false for node without server.json")
	}
}

func TestIsRunning_Running(t *testing.T) {
	pm := NewProcessManager()
	nodeDir := t.TempDir()
	dataDir := filepath.Join(nodeDir, ".pockode")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create server.json with current process PID
	serverInfo := struct {
		PID       int    `json:"pid"`
		Port      int    `json:"port"`
		StartedAt string `json:"started_at"`
	}{
		PID:       os.Getpid(),
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	}
	data, _ := json.Marshal(serverInfo)
	if err := os.WriteFile(filepath.Join(dataDir, "server.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	node := Node{
		ID:   "test-id",
		Path: nodeDir,
	}

	if !pm.IsRunning(node) {
		t.Error("IsRunning() = false, want true for node with valid server.json")
	}
}

// --- Start ---

func TestStart_EmptyToken(t *testing.T) {
	pm := NewProcessManager()
	node := Node{
		ID:   "test-id",
		Path: t.TempDir(),
	}

	err := pm.Start(node, "")
	if err == nil {
		t.Error("Start() with empty token should return error")
	}
	if err.Error() != "invalid node: token is required" {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestStart_AlreadyRunning(t *testing.T) {
	pm := NewProcessManager()
	nodeDir := t.TempDir()
	dataDir := filepath.Join(nodeDir, ".pockode")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create server.json with current process PID to simulate running
	serverInfo := struct {
		PID       int    `json:"pid"`
		Port      int    `json:"port"`
		StartedAt string `json:"started_at"`
	}{
		PID:       os.Getpid(),
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	}
	data, _ := json.Marshal(serverInfo)
	if err := os.WriteFile(filepath.Join(dataDir, "server.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	node := Node{
		ID:   "test-id",
		Path: nodeDir,
	}

	err := pm.Start(node, "test-token")
	if err != ErrNodeAlreadyRunning {
		t.Errorf("Start() on running node should return ErrNodeAlreadyRunning, got: %v", err)
	}
}

// --- Stop ---

func TestStop_NotRunning(t *testing.T) {
	pm := NewProcessManager()
	node := Node{
		ID:   "test-id",
		Path: t.TempDir(),
	}

	err := pm.Stop(node)
	if err != ErrNodeNotRunning {
		t.Errorf("Stop() on non-running node should return ErrNodeNotRunning, got: %v", err)
	}
}

func TestStop_StaleProcess(t *testing.T) {
	pm := NewProcessManager()
	nodeDir := t.TempDir()
	dataDir := filepath.Join(nodeDir, ".pockode")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create server.json with a non-existent PID
	serverInfo := struct {
		PID       int    `json:"pid"`
		Port      int    `json:"port"`
		StartedAt string `json:"started_at"`
	}{
		PID:       999999999,
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	}
	data, _ := json.Marshal(serverInfo)
	serverJSONPath := filepath.Join(dataDir, "server.json")
	if err := os.WriteFile(serverJSONPath, data, 0644); err != nil {
		t.Fatal(err)
	}

	// Skip if PID happens to exist
	if processExists(999999999) {
		t.Skip("PID 999999999 exists, skipping")
	}

	node := Node{
		ID:   "test-id",
		Path: nodeDir,
	}

	err := pm.Stop(node)
	if err != ErrNodeNotRunning {
		t.Errorf("Stop() on stale process should return ErrNodeNotRunning, got: %v", err)
	}

	// server.json should be cleaned up
	if _, err := os.Stat(serverJSONPath); !os.IsNotExist(err) {
		t.Error("server.json should be deleted for stale process")
	}
}
