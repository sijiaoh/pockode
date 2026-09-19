package node

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/internal/shutdown"
	"github.com/pockode/server/internal/termtest"
	"github.com/pockode/server/serverinfo"
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

// TestProcessExists_NonexistentPID guards the premise every stale-node test is
// built on: that deadPID is a PID no process on this machine has. It skips
// rather than fails when that is not true, because a machine with a process at
// that PID has not broken anything — it has just taken the stand-in away.
func TestProcessExists_NonexistentPID(t *testing.T) {
	requireDeadPID(t)
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
	writeServerJSON(t, nodeDir, serverinfo.Info{
		PID:       os.Getpid(),
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
		LocalURL:  "http://localhost:9870",
		RemoteURL: "https://example.com",
	})

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
	writeServerJSON(t, nodeDir, serverinfo.Info{
		PID:       os.Getpid(),
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	})

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
	requireDeadPID(t)
	writeServerJSON(t, nodeDir, serverinfo.Info{
		PID:       deadPID,
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	})

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
	writeRawServerJSON(t, nodeDir, []byte("not valid json"))

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

func TestStart_EmptyPassword(t *testing.T) {
	pm := NewProcessManager()
	node := Node{
		ID:   "test-id",
		Path: t.TempDir(),
	}

	err := pm.Start(node, "")
	if err == nil {
		t.Error("Start() with empty password should return error")
	}
	if err.Error() != "invalid node: password is required" {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestStart_AlreadyRunning(t *testing.T) {
	pm := NewProcessManager()
	nodeDir := t.TempDir()
	writeServerJSON(t, nodeDir, serverinfo.Info{
		PID:       os.Getpid(),
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	})

	node := Node{
		ID:   "test-id",
		Path: nodeDir,
	}

	err := pm.Start(node, "test-password")
	if err != ErrNodeAlreadyRunning {
		t.Errorf("Start() on running node should return ErrNodeAlreadyRunning, got: %v", err)
	}
}

// --- nodeEnv ---

func TestNodeEnv_SetsPasswordAndPreservesBase(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HOME=/home/user"}
	env := nodeEnv(base, "secret-password")

	for _, kv := range base {
		if !containsEnv(env, kv) {
			t.Errorf("nodeEnv dropped base entry %q", kv)
		}
	}
	if !containsEnv(env, "POCKODE_PASSWORD=secret-password") {
		t.Errorf("nodeEnv did not set the password env var, got %v", env)
	}
}

// A child that inherited either spelling would be given two answers to the same
// question, and which one it obeys depends on its own build's precedence rules.
func TestNodeEnv_OverridesInheritedCredentials(t *testing.T) {
	base := []string{"POCKODE_PASSWORD=stale", "POCKODE_AUTH_TOKEN=stale-legacy", "PATH=/usr/bin"}
	env := nodeEnv(base, "fresh")

	count := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "POCKODE_AUTH_TOKEN=") {
			t.Errorf("nodeEnv kept the deprecated env var %q", kv)
		}
		if strings.HasPrefix(kv, "POCKODE_PASSWORD=") {
			count++
			if kv != "POCKODE_PASSWORD=fresh" {
				t.Errorf("password env = %q, want POCKODE_PASSWORD=fresh", kv)
			}
		}
	}
	if count != 1 {
		t.Errorf("expected exactly one password env entry, got %d", count)
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
	requireDeadPID(t)
	serverJSONPath := writeServerJSON(t, nodeDir, serverinfo.Info{
		PID:       deadPID,
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
	})

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
	// helperWritesServerInfo stands in for a node being started: it writes its
	// own server.json into the directory named by helperDataDirEnv, but only
	// after a pause, because what Start has to get right is waiting for the file
	// this process writes rather than one that was already there. It shuts down
	// when asked, like helperListens.
	helperWritesServerInfo = "writes-server-info"

	// helperDataDirEnv names the data directory helperWritesServerInfo writes
	// its server.json into.
	helperDataDirEnv = "POCKODE_TEST_NODE_HELPER_DATA_DIR"
	// serverInfoDelay is how long that helper waits first. It has to outlast the
	// first read in waitForServerInfo (100ms) by enough that a machine under
	// load cannot reorder the two, while staying well inside the retries that
	// follow it.
	serverInfoDelay = 600 * time.Millisecond

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
	case helperWritesServerInfo:
		time.Sleep(serverInfoDelay)
		if err := serverinfo.Write(os.Getenv(helperDataDirEnv), 9871, "http://localhost:9871", "", ""); err != nil {
			panic(err)
		}
		// Then behave like helperListens, so the test can stop it the way the
		// cluster stops a node instead of leaving it to the backstop.
		select {
		case <-l.Done():
		case <-time.After(helperLifetime):
		}
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
			helper := startHelperNode(t, tc.mode)
			serverJSONPath := writeServerJSON(t, nodeDir, serverinfo.Info{
				PID:       helper.pid,
				Port:      9870,
				StartedAt: "2025-06-14T10:00:00Z",
			})

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

// --- Cleanup ---

func TestCleanup_RemovesServerInfoThatIsAllThatIsLeftOfANode(t *testing.T) {
	tests := []struct {
		name string
		// write leaves the node in the state under test and returns the path it
		// wrote. A func rather than a payload because the two states are reached
		// differently: one needs a PID this machine agrees is dead.
		write func(t *testing.T, nodeDir string) string
	}{
		{"dead pid", func(t *testing.T, nodeDir string) string {
			requireDeadPID(t)
			return writeServerJSON(t, nodeDir, serverinfo.Info{PID: deadPID, Port: 9870})
		}},
		{"unreadable", func(t *testing.T, nodeDir string) string {
			return writeRawServerJSON(t, nodeDir, []byte("not valid json"))
		}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			nodeDir := t.TempDir()
			serverJSONPath := tc.write(t, nodeDir)
			n := Node{ID: "test-id", Path: nodeDir}

			if err := NewProcessManager().Cleanup(n); err != nil {
				t.Fatalf("Cleanup() = %v, want nil", err)
			}

			if _, err := os.Stat(serverJSONPath); !os.IsNotExist(err) {
				t.Errorf("server.json still present after Cleanup: %v", err)
			}
			if status := NewProcessManager().GetNodeStatus(n); status.Status != StatusStopped {
				t.Errorf("status after Cleanup = %q, want %q", status.Status, StatusStopped)
			}
		})
	}
}

// TestCleanup_OnANodeWithNothingToCleanUp pins the idempotence the frontend
// relies on to offer cleanup without a confirmation: asking twice, or asking
// about a node that was already stopped, is not an error the user can act on.
func TestCleanup_OnANodeWithNothingToCleanUp(t *testing.T) {
	n := Node{ID: "test-id", Path: t.TempDir()}

	if err := NewProcessManager().Cleanup(n); err != nil {
		t.Fatalf("Cleanup() on a stopped node = %v, want nil", err)
	}
}

// TestCleanup_RefusesARunningNode: server.json is how everything else reaches a
// running node, so removing one that is still alive would leave a server nobody
// can find or stop.
func TestCleanup_RefusesARunningNode(t *testing.T) {
	nodeDir := t.TempDir()
	serverJSONPath := writeServerJSON(t, nodeDir, serverinfo.Info{PID: os.Getpid(), Port: 9870})

	err := NewProcessManager().Cleanup(Node{ID: "test-id", Path: nodeDir})
	if !errors.Is(err, ErrNodeStillRunning) {
		t.Errorf("Cleanup() on a running node = %v, want ErrNodeStillRunning", err)
	}

	if _, err := os.Stat(serverJSONPath); err != nil {
		t.Errorf("server.json should survive a refused Cleanup: %v", err)
	}
}

// --- Start against a real process ---

// TestStart_WaitsForTheNodeItStartedRatherThanTheFileItFound is the regression
// test for a stale node that would not start: the leftover server.json answered
// the wait on its first read, so Start reported success within 100ms while every
// status read afterwards still saw the dead PID and called the node stale.
func TestStart_WaitsForTheNodeItStartedRatherThanTheFileItFound(t *testing.T) {
	requireDeadPID(t)

	nodeDir := t.TempDir()
	dataDir := filepath.Join(nodeDir, ".pockode")
	writeServerJSON(t, nodeDir, serverinfo.Info{PID: deadPID, Port: 9870})
	n := Node{ID: "test-id", Path: nodeDir}

	// The helper inherits these: Start hands the child os.Environ() plus the
	// node's password.
	t.Setenv(helperEnv, helperWritesServerInfo)
	t.Setenv(helperReadyEnv, filepath.Join(t.TempDir(), "helper-ready"))
	t.Setenv(helperDataDirEnv, dataDir)

	pm := &ProcessManager{executablePath: os.Args[0]}
	t.Cleanup(func() { _ = pm.Stop(n) })

	if err := pm.Start(n, "test-password"); err != nil {
		t.Fatalf("Start() = %v, want nil", err)
	}

	status := pm.GetNodeStatus(n)
	if status.Status != StatusRunning {
		t.Fatalf("status after Start = %q, want %q", status.Status, StatusRunning)
	}
	if status.Port == nil || *status.Port != 9871 {
		t.Errorf("status.Port = %v, want the started node's 9871, not the stale file's", status.Port)
	}
}

// --- test helpers ---

// deadPID is a PID no process is expected to have. Tests that depend on that
// call requireDeadPID.
const deadPID = 999999999

func requireDeadPID(t *testing.T) {
	t.Helper()
	if processExists(deadPID) {
		t.Skipf("PID %d exists on this system, skipping", deadPID)
	}
}

// writeServerJSON gives nodeDir the server.json a running node would have left
// there and returns its path. Tests set the fields they assert on and leave the
// rest zero.
func writeServerJSON(t *testing.T, nodeDir string, info serverinfo.Info) string {
	t.Helper()

	data, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	return writeRawServerJSON(t, nodeDir, data)
}

// writeRawServerJSON is writeServerJSON for content that is not a valid Info —
// the state a node interrupted mid-write leaves behind.
func writeRawServerJSON(t *testing.T, nodeDir string, content []byte) string {
	t.Helper()

	dataDir := filepath.Join(nodeDir, ".pockode")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, "server.json")
	if err := os.WriteFile(path, content, 0644); err != nil {
		t.Fatal(err)
	}
	return path
}
