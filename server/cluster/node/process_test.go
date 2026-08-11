package node

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/internal/shutdown"
	"github.com/pockode/server/internal/termtest"
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

// --- nodeEnv ---

func TestNodeEnv_SetsTokenAndPreservesBase(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HOME=/home/user"}
	env := nodeEnv(base, "secret-token")

	for _, kv := range base {
		if !containsEnv(env, kv) {
			t.Errorf("nodeEnv dropped base entry %q", kv)
		}
	}
	if !containsEnv(env, "POCKODE_AUTH_TOKEN=secret-token") {
		t.Errorf("nodeEnv did not set token env var, got %v", env)
	}
}

func TestNodeEnv_OverridesInheritedToken(t *testing.T) {
	base := []string{"POCKODE_AUTH_TOKEN=stale", "PATH=/usr/bin"}
	env := nodeEnv(base, "fresh")

	count := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "POCKODE_AUTH_TOKEN=") {
			count++
			if kv != "POCKODE_AUTH_TOKEN=fresh" {
				t.Errorf("token env = %q, want POCKODE_AUTH_TOKEN=fresh", kv)
			}
		}
	}
	if count != 1 {
		t.Errorf("expected exactly one token env entry, got %d", count)
	}
}

func containsEnv(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
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

// --- Stop against a real process ---

// Re-executing the test binary is the portable way to get a real, long-lived
// process to stop, and it is the only way to exercise the request across a
// process boundary — which is the whole point on Windows, where the request
// travels over a named event rather than a signal.

const (
	helperEnv = "POCKODE_TEST_NODE_HELPER"
	// helperReadyEnv names a file the helper creates once it is listening. A
	// node is only ever asked to stop after the cluster has seen its server.json,
	// so a helper signalled before it got that far would be testing a race no
	// node is in. What it writes there is its terminal attachment — the one
	// thing about a child that only the child can answer.
	helperReadyEnv = "POCKODE_TEST_NODE_HELPER_READY"

	// helperListens stands in for a node that shuts down when asked.
	helperListens = "listens"
	// helperIgnores stands in for a node that has stopped responding. It still
	// publishes the shutdown event a node publishes, so the request reaches it
	// through the channel a real one uses and the test is really about the node
	// ignoring it.
	helperIgnores = "ignores"
	// helperReports exits as soon as it has written its report, for the tests
	// that only care what the launch flags did to it.
	helperReports = "reports"

	// helperLifetime is a backstop, not a timeout the tests wait for: a helper
	// left behind by a crashed test run has to go away on its own.
	helperLifetime = 60 * time.Second
)

func TestMain(m *testing.M) {
	mode := os.Getenv(helperEnv)
	if mode == "" {
		os.Exit(m.Run())
	}

	l := shutdown.Listen()
	if err := os.WriteFile(os.Getenv(helperReadyEnv), []byte(termtest.Of()), 0600); err != nil {
		panic(err)
	}

	switch mode {
	case helperReports:
		// The report was the whole job.
	case helperListens:
		select {
		case <-l.Done():
		case <-time.After(helperLifetime):
		}
	default:
		time.Sleep(helperLifetime)
	}
	os.Exit(0)
}

// TestStop_TerminatesProcessAndClearsServerInfo is the cross-process test for
// Stop: the node is gone when it returns, and it leaves no server.json behind —
// a node that had to be killed cannot delete its own, and the leftover file
// would report it as stale even though the cluster is what stopped it.
func TestStop_TerminatesProcessAndClearsServerInfo(t *testing.T) {
	tests := []struct {
		name string
		mode string
	}{
		{"node exits when asked", helperListens},
		{"node has to be killed", helperIgnores},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			nodeDir := t.TempDir()
			dataDir := filepath.Join(nodeDir, ".pockode")
			if err := os.MkdirAll(dataDir, 0755); err != nil {
				t.Fatal(err)
			}

			helper := startHelperNode(t, tc.mode)
			serverJSONPath := filepath.Join(dataDir, "server.json")
			serverInfo := struct {
				PID       int    `json:"pid"`
				Port      int    `json:"port"`
				StartedAt string `json:"started_at"`
			}{
				PID:       helper.pid,
				Port:      9870,
				StartedAt: "2025-06-14T10:00:00Z",
			}
			data, _ := json.Marshal(serverInfo)
			if err := os.WriteFile(serverJSONPath, data, 0644); err != nil {
				t.Fatal(err)
			}

			if err := NewProcessManager().Stop(Node{ID: "test-id", Path: nodeDir}); err != nil {
				t.Fatalf("Stop() = %v, want nil", err)
			}

			select {
			case <-helper.exited:
			case <-time.After(5 * time.Second):
				t.Error("helper node still running after Stop returned")
			}
			if _, err := os.Stat(serverJSONPath); !os.IsNotExist(err) {
				t.Errorf("server.json still present after Stop: %v", err)
			}
		})
	}
}

// helperNode is a running helper: enough of one to stop it, and the path it
// wrote its report to.
type helperNode struct {
	pid    int
	exited <-chan struct{}
	report string
}

// startHelperNode runs the test binary in helper mode and returns it once it has
// reported itself ready.
//
// It launches the way ProcessManager.Start launches a node, platform flags
// included, so what the tests below observe is what a real node gets rather than
// a nearby approximation of it.
func startHelperNode(t *testing.T, mode string) helperNode {
	t.Helper()

	readyPath := filepath.Join(t.TempDir(), "helper-ready")
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperEnv+"="+mode, helperReadyEnv+"="+readyPath)
	setProcessDetached(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start helper node: %v", err)
	}

	// Reap in the background exactly like ProcessManager.Start does, so a dead
	// helper stops looking alive as promptly as a dead node does.
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		_ = cmd.Wait()
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-exited
	})

	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := os.Stat(readyPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("helper node never reported itself ready")
		}
		time.Sleep(10 * time.Millisecond)
	}

	return helperNode{pid: cmd.Process.Pid, exited: exited, report: readyPath}
}

// TestSetProcessDetached_TakesTheNodeOffTheClusterTerminal covers the launch
// flags themselves: a node has to survive the terminal its cluster happened to
// be started from being closed, and the only way it can is by not being on that
// terminal at all. The two platforms get there differently — a session of its
// own on unix, no console at all on Windows — so the assertion is on the outcome
// both are after.
//
// It is the flags that are under test, not their one caller: that Start applies
// them is a line in Start, and a real node would have to reach the point of
// writing server.json before this could be asked through it.
func TestSetProcessDetached_TakesTheNodeOffTheClusterTerminal(t *testing.T) {
	helper := startHelperNode(t, helperReports)

	select {
	case <-helper.exited:
	case <-time.After(30 * time.Second):
		t.Fatal("helper node did not exit after reporting")
	}

	report, err := os.ReadFile(helper.report)
	if err != nil {
		t.Fatalf("reading the helper's report: %v", err)
	}
	if got := termtest.Attachment(report); got != termtest.Detached {
		t.Errorf("node launched the way ProcessManager.Start launches one reports %q, want %q", got, termtest.Detached)
	}

	// What this test cannot prove: a child inherits its parent's terminal only
	// if the parent has one, and a Windows process need not — a service, Task
	// Scheduler, possibly the CI runner. Where that is the case the assertion
	// above holds for a reason that has nothing to do with the flags, so say so
	// rather than let a green result be read as more than it is.
	if !termtest.HasTerminal() {
		t.Log("this process has no terminal of its own, so the helper had none to inherit: the assertion above cannot fail in this environment")
	}
}
