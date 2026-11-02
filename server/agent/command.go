package agent

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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

// installDirs maps an AI CLI's executable name to where its official installer
// puts it. It is written only by RegisterInstallDir, from package init, so it
// is never written once anything can read it.
var installDirs = map[string]func() string{}

// RegisterInstallDir declares where name's official installer puts it, for the
// lookup to fall back to when name is not on PATH. dir is asked at lookup time,
// not here, because it is read from the environment (the home directory, an
// installer's override variable); "" means it cannot be told, and nothing is
// searched for it.
//
// Each CLI declares its own because the installers disagree: one directory for
// all of them would be right for some and a guess for the rest. Call it from
// the CLI package's init.
func RegisterInstallDir(name string, dir func() string) {
	if _, ok := installDirs[name]; ok {
		panic("agent: install directory registered twice for " + name)
	}
	installDirs[name] = dir
}

// binarySearchDirs is where lookupBinary looks after PATH, in order: the
// directory name's official installer uses, then the ones this platform adds
// for every CLI. Duplicates are dropped, so the not-found error names each
// place once. A relative installer directory (CODEX_INSTALL_DIR=bin) is
// skipped: it names wherever the installer happened to run, and exec would
// resolve the path found there against the CLI's working directory instead.
func binarySearchDirs(name string) []string {
	var dirs []string
	if dir, ok := installDirs[name]; ok {
		if d := dir(); filepath.IsAbs(d) {
			dirs = append(dirs, d)
		}
	}
	for _, d := range fallbackBinaryDirs() {
		if !slices.Contains(dirs, d) {
			dirs = append(dirs, d)
		}
	}
	return dirs
}

// resolvedBinary is where lookupBinary found an AI CLI.
type resolvedBinary struct {
	// Path is the executable to run.
	Path string
	// OffPath is the directory it was found in when that is not on PATH, ""
	// when PATH found it. The CLI's child process gets it appended to its PATH.
	OffPath string
}

// lookupBinary resolves an AI CLI name to the executable to run. It stays
// unexported so Command remains the only way in: a caller that resolved the
// path itself and then reached for exec.Command would silently lose the
// command-line handling that the resolved path is what selects, and the PATH
// the CLI needs when it was found off PATH. BinaryPath hands the path out for
// showing, not for running.
//
// PATH decides first, always: whichever copy the user's own shell would run is
// the one we run too, and nothing found elsewhere overrides it. Only when name
// is not on PATH at all do the directories of binarySearchDirs get a turn. An
// official installer adds its directory to PATH by editing a shell profile (or,
// on Windows, the user PATH), and a process keeps the environment it started
// with — so a CLI installed a moment ago, or a pockode started before the
// profile was edited, finds the CLI exactly there and not on PATH.
//
// A name that already contains a separator is taken as given — the caller has
// resolved it, and exec reports it if it turns out not to be runnable.
func lookupBinary(name string) (resolvedBinary, error) {
	if filepath.Base(name) != name {
		return resolvedBinary{Path: name}, nil
	}

	if path, err := exec.LookPath(name); err == nil {
		return resolvedBinary{Path: path}, nil
	}

	dirs := binarySearchDirs(name)
	for _, dir := range dirs {
		// LookPath rather than a plain stat: on Windows this is what appends the
		// PATHEXT extension, so `claude` finds `claude.cmd` here as it would on PATH.
		if path, err := exec.LookPath(filepath.Join(dir, name)); err == nil {
			return resolvedBinary{Path: path, OffPath: dir}, nil
		}
	}

	return resolvedBinary{}, &BinaryNotFoundError{Name: name, Dirs: dirs}
}

// BinaryPath is the executable an AI CLI name resolves to, for telling a user
// which of the installs on the machine is the one Pockode runs. To run it, use
// Command.
func BinaryPath(name string) (string, error) {
	bin, err := lookupBinary(name)
	return bin.Path, err
}

// Command builds the exec.Cmd that runs an AI CLI.
//
// Every AI CLI invocation goes through here, because what it does is easy to
// get wrong once and then never notice: resolving the executable
// (lookupBinary), giving a CLI found off PATH a PATH that has it, and, on
// Windows, taking over the command line when that executable turns out to be
// the .cmd wrapper npm installs (see cmdline.go).
//
// A caller adding to the environment builds on cmd.Environ(), not
// os.Environ(), or the PATH set here is lost; one setting Dir sets PWD itself
// when Env is non-nil, as StartProcessEnv does, because exec keeps PWD in step
// with Dir only while Env is nil.
func Command(name string, args ...string) (*exec.Cmd, error) {
	// Background rather than a nil context: exec skips its cancellation
	// machinery when ctx.Done() is nil, so this is exec.Command exactly.
	return command(context.Background(), name, args)
}

// CommandContext is Command for an invocation the caller has to be able to give
// up on — a short-lived probe such as `--version`, where a CLI that never
// answers would otherwise hang the session start waiting on it. Session CLIs go
// through StartProcess instead, which owns their lifetime itself.
func CommandContext(ctx context.Context, name string, args ...string) (*exec.Cmd, error) {
	return command(ctx, name, args)
}

func command(ctx context.Context, name string, args []string) (*exec.Cmd, error) {
	bin, err := lookupBinary(name)
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, bin.Path, args...)
	if bin.OffPath != "" {
		// Whatever the CLI runs in turn — a hook, or itself again by name —
		// resolves through this PATH. Appended rather than prepended, so it
		// shadows nothing the user already has.
		cmd.Env = appendToPath(os.Environ(), bin.OffPath)
	}
	if err := prepareCommandLine(cmd); err != nil {
		return nil, fmt.Errorf("cannot run %s: %w", name, err)
	}
	return cmd, nil
}

// appendToPath returns env with dir added to the end of its PATH, or with a
// PATH of just dir when env has none. env is not modified.
func appendToPath(env []string, dir string) []string {
	out := slices.Clone(env)
	for i := len(out) - 1; i >= 0; i-- {
		key, value, ok := strings.Cut(out[i], "=")
		if !ok || !isPathKey(key) {
			continue
		}
		// The last entry is the one exec passes on when a key repeats.
		if value == "" {
			out[i] = key + "=" + dir
		} else {
			out[i] = key + "=" + value + string(os.PathListSeparator) + dir
		}
		return out
	}
	return append(out, "PATH="+dir)
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
		bin, err := lookupBinary(name)
		if err != nil {
			log.Warn("AI CLI not found; sessions using it will fail to start", "cli", name, "error", err)
			statuses = append(statuses, BinaryStatus{Name: name, Err: err})
			continue
		}
		if bin.OffPath != "" {
			log.Info("AI CLI found outside PATH; appending its directory to the PATH it runs with", "cli", name, "path", bin.Path, "dir", bin.OffPath)
		} else {
			log.Info("AI CLI found", "cli", name, "path", bin.Path)
		}
		statuses = append(statuses, BinaryStatus{Name: name})
	}
	return statuses
}
