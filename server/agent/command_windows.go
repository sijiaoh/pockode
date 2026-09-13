//go:build windows

package agent

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// binaryNotFoundHint names the Windows-only reason a CLI the user can run
// themselves is still unreachable from here: WSL and Windows have separate
// filesystems and separate PATHs, and `npm install -g` inside WSL installs into
// the Linux one.
const binaryNotFoundHint = " A CLI installed inside WSL is not visible to pockode.exe running on Windows."

// fallbackBinaryDirs lists where the AI CLI installers put their executables.
//
// PATH is not the whole picture on Windows: a process keeps the environment it
// was started with, so an installer that appended to the user PATH — which is
// what all of these do — leaves the CLI invisible to an already-running
// pockode.exe, and to any shell that was open at the time. The install is right
// there; only the PATH we inherited is stale.
func fallbackBinaryDirs() []string {
	var dirs []string

	// `npm install -g` writes its .cmd shims here, which is how both CLIs are
	// most commonly installed.
	if appData := os.Getenv("APPDATA"); appData != "" {
		dirs = append(dirs, filepath.Join(appData, "npm"))
	}

	if home := os.Getenv("USERPROFILE"); home != "" {
		// Where the native (non-npm) Claude Code installer puts claude.exe.
		dirs = append(dirs, filepath.Join(home, ".local", "bin"))
		// `cargo install`, which is how Codex ships outside npm.
		dirs = append(dirs, filepath.Join(home, ".cargo", "bin"))
	}

	return dirs
}

// prepareCommandLine takes over the command line when the executable turns out
// to be a batch file, so the arguments survive cmd.exe. See cmdline.go for why
// that is necessary and what the quoting has to satisfy.
//
// cmd.exe is invoked explicitly rather than left to the fallback inside
// CreateProcess that would otherwise run the batch file: it is the same
// process tree either way, but doing it here is what makes the switches below
// ours to set, and what makes the shape of the command line visible in this
// package instead of implied by an undocumented corner of Win32.
func prepareCommandLine(cmd *exec.Cmd) error {
	// Trailing dots and spaces are stripped by Windows when it resolves a path,
	// so `claude.cmd. ` still runs as a batch file. Rust's first fix for the same
	// class of bug matched the extension literally and had to be reissued as
	// CVE-2024-43402 for exactly this; trimming first costs nothing.
	switch strings.ToLower(filepath.Ext(strings.TrimRight(cmd.Path, ". "))) {
	case ".bat", ".cmd":
	default:
		return nil
	}

	line, err := batchCommandLine(cmd.Path, cmd.Args[1:])
	if err != nil {
		return err
	}
	shell, err := commandProcessor()
	if err != nil {
		return err
	}

	// The first three switches pin behaviour that is otherwise inherited from
	// however the user has configured cmd.exe — AutoRun, command extensions and
	// delayed expansion all have registry settings, and any of them can change
	// what actually runs:
	//
	//   /d      skips the AutoRun command, so a user's profile script cannot run
	//           in front of the CLI.
	//   /e:on   forces command extensions on. npm's wrapper needs them —
	//           SETLOCAL, `EXIT /b` and `%PATHEXT:;.JS;=;%` are all extensions —
	//           so a machine with EnableExtensions turned off would break it.
	//   /v:off  keeps a `!` in a path from being read as delayed expansion.
	//
	// /s is about our own command line rather than the user's setup: it makes
	// cmd strip exactly the outer pair of quotes batchCommandLine added, instead
	// of leaving that to the conditional rule cmd applies by default.
	switches := []string{"/d", "/e:on", "/v:off", "/s", "/c"}

	cmd.Path = shell
	// CmdLine is what actually reaches CreateProcess; Args is ignored once it is
	// set. Rewriting Args anyway keeps it in step with Path, so cmd.String() —
	// the form that ends up in a log or a debugger — describes the command that
	// really ran instead of a mixture of the two.
	cmd.Args = append(append([]string{shell}, switches...), line)
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CmdLine = syscall.EscapeArg(shell) + " " + strings.Join(switches, " ") + " " + line
	return nil
}

// commandProcessor locates cmd.exe. COMSPEC comes first because that is what
// Windows itself consults when it runs a batch file.
func commandProcessor() (string, error) {
	if shell := os.Getenv("COMSPEC"); shell != "" {
		return shell, nil
	}
	if root := os.Getenv("SystemRoot"); root != "" {
		return filepath.Join(root, "System32", "cmd.exe"), nil
	}
	return "", errors.New("cannot locate cmd.exe: neither COMSPEC nor SystemRoot is set")
}
