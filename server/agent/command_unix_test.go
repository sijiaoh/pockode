//go:build !windows

package agent

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

// TestOffPathCLIGetsItsWorkingDirectoryAsPWD pins that giving a CLI found off
// PATH an environment of its own does not cost it the PWD exec sets for one
// found on PATH: its hooks would otherwise run with pockode's directory there.
func TestOffPathCLIGetsItsWorkingDirectoryAsPWD(t *testing.T) {
	const name = "pockode-fake-cli"
	installed := filepath.Join(t.TempDir(), "installer")
	writeFakeCLI(t, installed, name)
	registerTestInstallDir(t, name, installed)
	t.Setenv("PATH", t.TempDir())
	t.Setenv(roleEnv, rolePWD)
	dir := t.TempDir()

	proc, err := StartProcess(context.Background(), discardLog(), name, nil, dir)
	if err != nil {
		t.Fatalf("starting the CLI found off PATH: %v", err)
	}
	_ = proc.Stdin.Close()
	out, err := io.ReadAll(proc.Stdout)
	if err != nil {
		t.Fatalf("read the CLI's output: %v", err)
	}
	if err := proc.Wait(); err != nil {
		t.Fatalf("the CLI failed: %v", err)
	}
	proc.OutputDone()
	if got := strings.TrimSpace(string(out)); got != dir {
		t.Errorf("the CLI ran with PWD %q, want its working directory %q", got, dir)
	}
}
