package agent

import (
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
)

// BinaryNotFoundError reports an AI CLI that could not be located.
//
// It exists so the failure reads as the environment problem it is. The bare
// exec error ("executable file not found in %PATH%") names neither the CLI the
// user was trying to use nor anything they can act on, and the two ways this
// happens on Windows to someone who did install the CLI — it went into WSL, or
// it went onto a PATH this process never saw — are both invisible from it.
type BinaryNotFoundError struct {
	// Name is the executable that was looked up.
	Name string
	// Dirs are the directories searched after PATH came up empty.
	Dirs []string
}

func (e *BinaryNotFoundError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s CLI not found: install it and make sure %q is on the PATH of the process running pockode, then restart pockode so it picks up the change", e.Name, e.Name)
	if len(e.Dirs) > 0 {
		fmt.Fprintf(&b, " (also looked in: %s)", strings.Join(e.Dirs, ", "))
	}
	b.WriteString(binaryNotFoundHint)
	return b.String()
}

// lookupBinary resolves an AI CLI name to the executable to run. It stays
// unexported so Command remains the only way in: a caller that resolved the
// path itself and then reached for exec.Command would silently lose the
// command-line handling that the resolved path is what selects.
//
// PATH decides first, so whichever copy the user's own shell would run is the
// one we run too. Windows then falls back to the directories the installers
// write to. That mirrors worktree.hookShellCandidates in shape but not in
// reason: bash.exe is never on PATH to begin with, whereas an AI CLI usually
// is — just not on the PATH this process inherited, because a process keeps the
// environment it started with and these installers all append to the user PATH.
//
// A name that already contains a separator is taken as given — the caller has
// resolved it, and exec reports it if it turns out not to be runnable.
func lookupBinary(name string) (string, error) {
	if filepath.Base(name) != name {
		return name, nil
	}

	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}

	dirs := fallbackBinaryDirs()
	for _, dir := range dirs {
		// LookPath rather than a plain stat: on Windows this is what appends the
		// PATHEXT extension, so `claude` finds `claude.cmd` here as it would on PATH.
		if path, err := exec.LookPath(filepath.Join(dir, name)); err == nil {
			return path, nil
		}
	}

	return "", &BinaryNotFoundError{Name: name, Dirs: dirs}
}

// Command builds the exec.Cmd that runs an AI CLI.
//
// Every AI CLI invocation goes through here, because both things it does are
// easy to get wrong once and then never notice: resolving the executable
// (lookupBinary) and, on Windows, taking over the command line when that
// executable turns out to be the .cmd wrapper npm installs (see cmdline.go).
func Command(name string, args ...string) (*exec.Cmd, error) {
	path, err := lookupBinary(name)
	if err != nil {
		return nil, err
	}

	cmd := exec.Command(path, args...)
	if err := prepareCommandLine(cmd); err != nil {
		return nil, fmt.Errorf("cannot run %s: %w", name, err)
	}
	return cmd, nil
}

// BinaryStatus is the outcome of looking up one AI CLI at startup.
//
// Where the CLI was found is deliberately not part of it: nothing outside the
// log line below has any use for the path, and a field carried for no reader
// is a field that goes stale.
type BinaryStatus struct {
	// Name is the CLI that was looked up.
	Name string
	// Err is why the lookup failed, nil when the CLI is available.
	Err error
}

func (s BinaryStatus) Found() bool { return s.Err == nil }

// CheckBinaries reports at startup which AI CLIs are missing.
//
// Without it the first sign of a CLI that pockode cannot see is the error a
// user gets when they open a session, which can be days after the install step
// it points back to.
//
// The returned statuses exist because the log is not where a user finds this
// out: in production it goes to dataDir/server.log, not the console they are
// looking at. The caller puts them on the startup banner instead.
func CheckBinaries(log *slog.Logger, names ...string) []BinaryStatus {
	statuses := make([]BinaryStatus, 0, len(names))
	for _, name := range names {
		path, err := lookupBinary(name)
		if err != nil {
			log.Warn("AI CLI not found; sessions using it will fail to start", "cli", name, "error", err)
			statuses = append(statuses, BinaryStatus{Name: name, Err: err})
			continue
		}
		log.Info("AI CLI found", "cli", name, "path", path)
		statuses = append(statuses, BinaryStatus{Name: name})
	}
	return statuses
}
