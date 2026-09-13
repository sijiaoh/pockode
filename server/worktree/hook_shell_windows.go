//go:build windows

package worktree

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// lookupHookShell locates the bash that ships with Git for Windows.
//
// Windows has no bash of its own and the setup hook is a POSIX shell script.
// Worktrees already require git, and every Git for Windows install bundles
// bash.exe, so that copy is the one interpreter we can expect to be present.
//
// bash.exe is deliberately not resolved through PATH: on Windows 10+ the system
// directory ships a bash.exe that is the WSL launcher. It runs the script inside
// a Linux VM, where the Windows paths handed to the hook do not resolve, so it
// would fail in a far more confusing way than not running at all.
func lookupHookShell() (string, error) {
	candidates := hookShellCandidates()
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	if len(candidates) == 0 {
		return "", errors.New("no Git for Windows installation found: git is not on PATH and no default install directory is known")
	}
	return "", fmt.Errorf("no bash.exe from Git for Windows found; installing it from https://git-scm.com/download/win enables the hook (looked in: %s)", strings.Join(candidates, ", "))
}

// hookShellCandidates lists the paths where Git for Windows keeps bash.exe,
// most specific first. The install the user actually runs git from is preferred
// over well-known install directories, so a portable or relocated install wins
// over a stale one under Program Files.
func hookShellCandidates() []string {
	var roots []string

	if gitPath, err := exec.LookPath("git"); err == nil {
		// git.exe sits in <root>\cmd, <root>\bin or <root>\mingw64\bin, so the
		// install root is one or two levels above it.
		binDir := filepath.Dir(gitPath)
		roots = append(roots, filepath.Dir(binDir), filepath.Dir(filepath.Dir(binDir)))
	}

	// Default install locations: system-wide, then 32-bit on 64-bit Windows.
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
		if base := os.Getenv(env); base != "" {
			roots = append(roots, filepath.Join(base, "Git"))
		}
	}
	// The per-user install the Git for Windows setup offers without admin rights.
	if base := os.Getenv("LocalAppData"); base != "" {
		roots = append(roots, filepath.Join(base, "Programs", "Git"))
	}

	seen := make(map[string]bool)
	var candidates []string
	for _, root := range roots {
		// <root>\bin\bash.exe is the launcher meant for outside callers;
		// <root>\usr\bin\bash.exe is the MSYS2 binary it wraps and is the only
		// one present in some minimal/portable layouts.
		for _, candidate := range []string{
			filepath.Join(root, "bin", "bash.exe"),
			filepath.Join(root, "usr", "bin", "bash.exe"),
		} {
			if !seen[candidate] {
				seen[candidate] = true
				candidates = append(candidates, candidate)
			}
		}
	}
	return candidates
}
