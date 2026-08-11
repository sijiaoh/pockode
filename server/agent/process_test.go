package agent

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// The scenarios below all need the same shape: a child that spawns a grandchild
// which inherits stdout and outlives it. That is exactly what an AI CLI does
// (shell commands, MCP servers, and on Windows the cmd.exe wrapper npm installs
// as `claude.cmd`), and it is what used to deadlock the reap path.
//
// The test binary re-execs itself to play those roles rather than shelling out,
// so the same tests run on Windows.
const (
	roleEnv  = "POCKODE_TEST_PROCESS_ROLE"
	roleTree = "tree"
	roleLeaf = "leaf"
	// roleArgv stands in for the real CLI in the argument-passing tests: it
	// prints what it was actually given, which is the only way to see what
	// survived the command line.
	roleArgv = "argv"

	// leafLifetime only has to outlast the assertions; every test kills the leaf
	// long before it elapses.
	leafLifetime = time.Minute
)

func TestMain(m *testing.M) {
	switch os.Getenv(roleEnv) {
	case roleTree:
		runTreeRole()
	case roleLeaf:
		runLeafRole()
	case roleArgv:
		runArgvRole()
	default:
		os.Exit(m.Run())
	}
}

// runTreeRole spawns a grandchild that inherits stdout, then waits for the test
// to close or write to stdin before exiting — leaving the grandchild holding
// the pipe. Exiting on a cue rather than immediately keeps the test off a race
// the real CLIs never lose: on Windows a process can only be put into its job
// object once it exists, so it must still be alive when StartProcess returns.
func runTreeRole() {
	leaf := exec.Command(os.Args[0])
	leaf.Env = append(os.Environ(), roleEnv+"="+roleLeaf)
	leaf.Stdout = os.Stdout
	leaf.Stderr = os.Stderr
	if err := leaf.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "failed to start leaf:", err)
		os.Exit(1)
	}
	fmt.Println("tree ready")

	// Either a newline or EOF means "exit now", so the read error is irrelevant.
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	os.Exit(0)
}

func runLeafRole() {
	fmt.Println("leaf ready")
	time.Sleep(leafLifetime)
	os.Exit(0)
}

// runArgvRole prints one argument per line, so a caller can tell an argument
// that was split from one that merely looks odd.
func runArgvRole() {
	for _, arg := range os.Args[1:] {
		fmt.Println(arg)
	}
	os.Exit(0)
}

// startTestProcess launches the tree role and returns once the grandchild is
// known to exist, so tests that terminate immediately still exercise a real
// two-level tree. It returns the buffered reader used for that handshake;
// reading the raw pipe afterwards would drop whatever it had buffered.
func startTestProcess(t *testing.T, ctx context.Context) (*Process, *bufio.Reader) {
	t.Helper()

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	// Inherited by the child, which makes it re-exec into the tree role.
	t.Setenv(roleEnv, roleTree)

	proc, err := StartProcess(ctx, slog.Default(), exe, nil, "")
	if err != nil {
		t.Fatalf("StartProcess: %v", err)
	}
	t.Cleanup(proc.Terminate)

	out := bufio.NewReader(proc.Stdout)
	line, err := out.ReadString('\n')
	if err != nil {
		t.Fatalf("waiting for the process tree to come up: %v", err)
	}
	// Either role announcing itself proves the grandchild has been started: the
	// tree role prints only after leaf.Start returned.
	if got := strings.TrimSpace(line); got != "tree ready" && got != "leaf ready" {
		t.Fatalf("unexpected first line from the process tree: %q", got)
	}
	return proc, out
}

func requireWait(t *testing.T, proc *Process, msg string) {
	t.Helper()
	waited := make(chan error, 1)
	go func() { waited <- proc.Wait() }()
	select {
	case <-waited:
	case <-time.After(10 * time.Second):
		t.Fatal(msg)
	}
}

// requireDrained reads r to completion and reports that the whole tree really
// was terminated.
//
// EOF alone is not enough: the drain backstop force-closes the pipes a few
// seconds in, so a reader would unblock even if the grandchild survived. The
// escapedTree flag distinguishes the two — it is set only when the backstop had
// to step in — and asserting on it keeps the test out of timing guesswork.
func requireDrained(t *testing.T, proc *Process, r io.Reader) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, r)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("draining output: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("output never reached EOF: a descendant is still holding the pipe")
	}
	proc.OutputDone()
	if proc.escapedTree.Load() {
		t.Fatal("a descendant survived tree termination and had to be cut off by the drain backstop")
	}
}

// TestProcessSurvivesOrphanHoldingOutputPipe covers the deadlock: the direct
// child exits normally but a grandchild keeps the stdout write end open.
//
// Both orders are exercised because they pin different properties. "Drain then
// reap" is the order the real callers use, and is the deadlock itself: the drain
// never finished, so Wait was never reached, so the session never ended. "Reap
// then drain" pins what the fix rests on — Wait returns with the pipe still held
// and nobody reading it, an order the old Cmd.StdoutPipe shape forbade outright.
func TestProcessSurvivesOrphanHoldingOutputPipe(t *testing.T) {
	tests := []struct {
		name      string
		reapFirst bool
	}{
		{"drain then reap", false},
		{"reap then drain", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			proc, out := startTestProcess(t, t.Context())

			if _, err := proc.Stdin.Write([]byte("\n")); err != nil {
				t.Fatalf("cueing the child to exit: %v", err)
			}

			if tt.reapFirst {
				requireWait(t, proc, "Wait blocked on output nobody is reading")
				requireDrained(t, proc, out)
				return
			}
			requireDrained(t, proc, out)
			requireWait(t, proc, "Wait blocked on a pipe held by an orphaned grandchild")
		})
	}
}

// TestProcessTerminateKillsDescendants covers session close: cancelling the
// context must take down the whole tree, not just the process we started.
func TestProcessTerminateKillsDescendants(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	proc, out := startTestProcess(t, ctx)

	cancel()

	requireDrained(t, proc, out)
	requireWait(t, proc, "Wait did not return after the context was cancelled")
}

// TestWaitForProcessReleasesPipesAfterStderr pins the ordering that decides
// whether a failing CLI can explain itself. Signalling OutputDone closes both
// pipes, so doing it while stderr is still being collected drops whatever the
// process wrote on its way out — the very text reported back to the user as the
// failure reason.
//
// The stderr channel is driven by hand rather than by a real collector: the
// truncation it guards against is a race, and asserting on the order the pipes
// are released catches it every time instead of a few runs in a hundred.
func TestWaitForProcessReleasesPipesAfterStderr(t *testing.T) {
	proc, out := startTestProcess(t, t.Context())
	if _, err := proc.Stdin.Write([]byte("\n")); err != nil {
		t.Fatalf("cueing the child to exit: %v", err)
	}
	if _, err := io.Copy(io.Discard, out); err != nil {
		t.Fatalf("draining stdout: %v", err)
	}

	// Buffered so the send below cannot block: if WaitForProcess had already
	// given up on stderr, an unbuffered send would deadlock the test instead of
	// failing it.
	stderrCh := make(chan string, 1)
	returned := make(chan struct{})
	go func() {
		defer close(returned)
		WaitForProcess(t.Context(), slog.Default(), proc, stderrCh, make(chan AgentEvent, 1))
	}()

	select {
	case <-proc.outputDone:
		t.Fatal("output pipes were released while stderr was still being collected")
	case <-returned:
		// Only reachable if StderrReadTimeout elapsed, which would make the
		// assertion below meaningless rather than merely failing.
		t.Fatal("WaitForProcess stopped waiting for stderr before the test delivered it")
	case <-time.After(200 * time.Millisecond):
	}

	stderrCh <- "some failure the CLI reported on its way out"
	<-returned

	select {
	case <-proc.outputDone:
	default:
		t.Fatal("output pipes were never released, so they only close on the drain timeout")
	}
}

// TestProcessStartFailure checks that a missing binary surfaces as an error
// rather than a half-built Process.
func TestProcessStartFailure(t *testing.T) {
	if _, err := StartProcess(t.Context(), slog.Default(), "pockode-no-such-binary", nil, ""); err == nil {
		t.Fatal("expected an error starting a nonexistent binary")
	}
}
