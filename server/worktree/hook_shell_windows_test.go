//go:build windows

package worktree

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The bash.exe in the Windows directory is the WSL launcher. It would run the
// hook inside a Linux VM, where the Windows paths handed to the hook do not
// resolve, so it must never end up among the candidates.
func TestHookShellCandidates_ExcludeWindowsDirectory(t *testing.T) {
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		t.Skip("SystemRoot is not set")
	}
	prefix := strings.ToLower(systemRoot) + string(filepath.Separator)

	candidates := hookShellCandidates()
	if len(candidates) == 0 {
		t.Fatal("no candidate paths were produced")
	}
	for _, candidate := range candidates {
		if strings.HasPrefix(strings.ToLower(candidate), prefix) {
			t.Errorf("candidate %q is inside the Windows directory", candidate)
		}
	}
}

// Asserted as a shape rather than as "bash must exist": a machine without Git
// for Windows is a supported state, and the skip path is what covers it.
func TestLookupHookShell_ReturnsAnExistingBash(t *testing.T) {
	shell, err := lookupHookShell()
	if err != nil {
		t.Skipf("no Git for Windows bash on this machine: %v", err)
	}

	if !strings.EqualFold(filepath.Base(shell), "bash.exe") {
		t.Errorf("lookupHookShell() = %q, want a bash.exe", shell)
	}
	if info, err := os.Stat(shell); err != nil || info.IsDir() {
		t.Errorf("lookupHookShell() = %q, want an existing file (stat error: %v)", shell, err)
	}
}
