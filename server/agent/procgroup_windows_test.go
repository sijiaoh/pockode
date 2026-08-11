//go:build windows

package agent

import (
	"bufio"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/pockode/server/internal/termtest"
)

// TestStartProcess_KeepsTheCLIOffOurConsole covers CREATE_NO_WINDOW.
//
// The flag is there for the case this test cannot reproduce: a server with no
// console of its own, where Windows would allocate a visible one for the first
// console program it starts and flash a black window on every AI CLI call. What
// is observable from a test is the mechanism underneath — that the CLI gets a
// console of its own rather than joining ours — and that is what breaks if the
// flag is dropped.
func TestStartProcess_KeepsTheCLIOffOurConsole(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	t.Setenv(roleEnv, roleTerminal)

	proc, err := StartProcess(t.Context(), slog.Default(), exe, nil, "")
	if err != nil {
		t.Fatalf("StartProcess: %v", err)
	}
	t.Cleanup(proc.Terminate)

	out := bufio.NewReader(proc.Stdout)
	line, err := out.ReadString('\n')
	if err != nil {
		t.Fatalf("waiting for the CLI to report its terminal: %v", err)
	}
	if got := termtest.Attachment(strings.TrimSpace(line)); got != termtest.Detached {
		t.Errorf("AI CLI reports %q, want %q", got, termtest.Detached)
	}
	// Not decoration: without it the reap path waits out its drain backstop and
	// reports a straggler that is not there.
	requireDrained(t, proc, out)

	// A child can only inherit a console its parent has, and a Windows process
	// need not have one — a service, Task Scheduler, possibly the CI runner.
	// Where that is the case the assertion above holds no matter what flags were
	// passed, so say so rather than let a green result be read as more than it is.
	if !termtest.HasTerminal() {
		t.Log("this process has no console of its own, so the CLI had none to inherit: the assertion above cannot fail in this environment")
	}
}
