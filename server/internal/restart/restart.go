// Package restart replaces a running pockode process — a server or a cluster —
// with a fresh run of the executable on disk: same arguments, same working
// directory, same password, whichever binary an upgrade has put at that path
// since.
//
// A restart is a shutdown with a different ending. The caller asks for one
// (Restarter.Request), which checks that the file on disk can run at all
// before anything is stopped; the caller then runs its ordinary graceful
// shutdown and, at the very end, calls Restarter.Restart instead of returning.
// How the process is replaced is platform-specific: unix execs in place,
// keeping the PID, the terminal and the session; Windows cannot, and starts a
// successor (see replace_windows.go).
package restart

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/password"
)

// Program is what a restart runs again: the executable, the arguments and the
// working directory this process started with.
//
// It is captured at startup (Current) because none of it can be asked for
// reliably later. Once an upgrade has renamed a new binary over the old one,
// Linux reports os.Executable() as "… (deleted)"; os.Args[0] may be relative,
// or a bare name looked up in PATH.
type Program struct {
	// Path is the absolute path to the executable.
	Path string
	// Args are the arguments after the program name, as given — a password
	// among them included; Restart empties that out.
	Args []string
	// Dir is the working directory the process started in.
	Dir string

	argv0 string
}

// Current resolves the Program of this process. Call it first thing in main,
// before anything could change the working directory.
func Current() (Program, error) {
	exe, err := os.Executable()
	if err != nil {
		return Program{}, fmt.Errorf("resolve executable: %w", err)
	}
	dir, err := os.Getwd()
	if err != nil {
		return Program{}, fmt.Errorf("resolve working directory: %w", err)
	}
	return Program{
		Path:  resolvePath(os.Args[0], exe),
		Args:  append([]string(nil), os.Args[1:]...),
		Dir:   dir,
		argv0: os.Args[0],
	}, nil
}

// resolvePath prefers the path the process was invoked by over exe, the file
// the OS says is running, whenever the two name the same file.
//
// The difference is symlinks: os.Executable resolves them on Linux, and a
// package manager that installs `bin/pockode` as a link into a versioned
// directory moves that link on an upgrade and removes the old directory —
// so the resolved path is precisely the one that stops existing. The invoked
// path is only trusted when it does lead to the running file: argv[0] is
// whatever the parent chose to put there.
func resolvePath(arg0, exe string) string {
	var invoked string
	if filepath.Base(arg0) != arg0 {
		invoked = arg0
	} else if found, err := exec.LookPath(arg0); err == nil {
		invoked = found
	} else {
		return exe
	}
	abs, err := filepath.Abs(invoked)
	if err != nil {
		return exe
	}
	invokedInfo, err := os.Stat(abs)
	if err != nil {
		return exe
	}
	exeInfo, err := os.Stat(exe)
	if err != nil || !os.SameFile(invokedInfo, exeInfo) {
		return exe
	}
	return abs
}

// versionTimeout bounds a run of `pockode --version`, which answers without
// touching the network or the disk; anything that takes this long is not going
// to start a server either.
const versionTimeout = 10 * time.Second

// versionPrefix is what `pockode --version` prints before the version.
const versionPrefix = "pockode "

// Version runs the executable on disk with --version and returns the version it
// reports — the installed version, which an upgrade may have moved past the one
// running. It doubles as the check that the file can run at all.
//
// The error says what went wrong with the run, not which file it was: callers
// name Path themselves, and a client shows the two apart.
//
// The run is kept off the screen on Windows (CREATE_NO_WINDOW), so a process
// with no visible console does not flash one for it.
func (p Program) Version(ctx context.Context) (string, error) {
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, versionTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, p.Path, "--version")
	hideWindow(cmd)
	// --version spawns nothing, so there are no descendants to keep the pipe
	// open after a kill; this only bounds a pathological one.
	cmd.WaitDelay = time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if err := parent.Err(); err != nil {
			// Whoever asked has gone (a client disconnecting, a shutdown):
			// nothing is known about the file.
			return "", fmt.Errorf("--version: %w", err)
		}
		if ctx.Err() != nil {
			return "", fmt.Errorf("--version did not answer within %s", versionTimeout)
		}
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return "", fmt.Errorf("--version: %w: %s", err, msg)
		}
		return "", fmt.Errorf("--version: %w", err)
	}

	line := strings.TrimSpace(string(out))
	version, ok := strings.CutPrefix(line, versionPrefix)
	if !ok || version == "" || strings.ContainsAny(version, "\r\n") {
		return "", fmt.Errorf("--version printed %q, which is not a pockode version", line)
	}
	return version, nil
}

// NotRunnableError is Request's refusal of a program that could not be run
// again: the executable on disk failed Program.Version, or the working
// directory is gone. Err says which, and how.
type NotRunnableError struct{ Err error }

func (e *NotRunnableError) Error() string {
	return "refusing to restart: the program cannot be run again: " + e.Err.Error()
}

func (e *NotRunnableError) Unwrap() error { return e.Err }

// Request's other refusals. A refused request changes nothing.
var (
	// ErrAlreadyRestarting is a request made after another was accepted.
	ErrAlreadyRestarting = errors.New("a restart is already under way")
	// ErrShuttingDown is a request made once the process has started shutting
	// down to exit.
	ErrShuttingDown = errors.New("the process is already shutting down")
)

// Restarter decides whether the shutdown a process is about to go through ends
// in a restart, and carries it out.
//
// One serves the whole process. Requests may come from any goroutine — an RPC,
// a signal — and the first that is accepted is the only one: after it, and
// once the process has started shutting down to exit (Close), every request is
// refused.
type Restarter struct {
	program Program

	// probeMu keeps concurrent requests from running the executable once each.
	probeMu sync.Mutex

	stateMu   sync.Mutex
	requested chan struct{}
	pending   bool // a request was accepted
	closed    bool // a shutdown is underway, for whatever reason
}

// New returns a Restarter for program. It logs to slog.Default as it is when
// each message is written, so it may be created before logging is configured.
func New(program Program) *Restarter {
	return &Restarter{
		program:   program,
		requested: make(chan struct{}),
	}
}

// Program is what a restart runs.
func (r *Restarter) Program() Program { return r.program }

// Request asks for the process to restart. It first checks that the
// working directory is still there and runs the executable on disk
// (Program.Version), and refuses if either fails, leaving the process running
// as it was; otherwise Requested is closed, and the caller is expected to shut
// down and, if Pending still says so, call Restart.
//
// A nil return means the restart is underway, not that it has happened: the
// shutdown still runs first, and the final step can still fail (see Restart).
//
// A refusal is a *NotRunnableError, ErrAlreadyRestarting or ErrShuttingDown.
func (r *Restarter) Request(ctx context.Context) error {
	release, err := r.RequestHeld(ctx)
	if err != nil {
		return err
	}
	release()
	return nil
}

// RequestHeld is Request with the shutdown held back until release is called:
// the request is accepted — Pending, every later request refused — but
// Requested is not closed until then. It is for a requester that still has
// something to finish before the process starts going down, such as telling a
// client the restart was accepted; release has to be called, once it has, or
// the process never shuts down. Calling it again does nothing.
//
// Nothing is held after a refusal, and release is nil.
func (r *Restarter) RequestHeld(ctx context.Context) (release func(), err error) {
	if err := r.refusal(); err != nil {
		return nil, err
	}

	r.probeMu.Lock()
	defer r.probeMu.Unlock()
	// Checked again: a request that waited for the probe ahead of it would
	// otherwise run the executable for a restart that has already been decided.
	if err := r.refusal(); err != nil {
		return nil, err
	}
	// Restart enters Dir before it runs anything, and failing to is past the
	// point of carrying on; a directory removed since startup has to be a
	// refusal instead. Version does not run in Dir, so it would not notice.
	if info, err := os.Stat(r.program.Dir); err != nil || !info.IsDir() {
		return nil, &NotRunnableError{Err: fmt.Errorf("its working directory %s is no longer there", r.program.Dir)}
	}
	version, err := r.program.Version(ctx)
	if err != nil {
		return nil, &NotRunnableError{Err: err}
	}

	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	if err := r.refusalLocked(); err != nil {
		return nil, err
	}
	r.closed = true
	r.pending = true
	slog.Default().Info("restart requested", "path", r.program.Path, "installedVersion", version)
	return sync.OnceFunc(func() { close(r.requested) }), nil
}

func (r *Restarter) refusal() error {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	return r.refusalLocked()
}

func (r *Restarter) refusalLocked() error {
	switch {
	case r.pending:
		return ErrAlreadyRestarting
	case r.closed:
		return ErrShuttingDown
	}
	return nil
}

// Requested is closed once a restart request has been accepted, and released
// if it was held (RequestHeld).
func (r *Restarter) Requested() <-chan struct{} { return r.requested }

// Close is called when the process starts shutting down to exit — an exit
// request was what the shutdown loop picked up. No request is accepted from
// now on, and one accepted in the meantime, its probe finishing while the exit
// request was being taken, is dropped: the request that started the shutdown
// decides how it ends.
func (r *Restarter) Close() {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	r.closed = true
	r.pending = false
}

// Pending reports whether the shutdown is to end in a restart: a request was
// accepted, and no exit request overruled it (Close).
func (r *Restarter) Pending() bool {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	return r.pending
}

// Watch turns every value from requests — shutdown.Listener.Restarts — into a
// Request, logging the ones refused. It returns when requests is closed.
func (r *Restarter) Watch(requests <-chan struct{}) {
	for range requests {
		err := r.Request(context.Background())
		if err != nil && !errors.Is(err, ErrShuttingDown) && !errors.Is(err, ErrAlreadyRestarting) {
			slog.Default().Error("restart refused", "path", r.program.Path, "error", err)
		}
	}
}

// Restart replaces this process with a new run of the Program, handing it pw
// through the environment (password.WithEnv) — never through argv, where any
// local user could read it — and does not return. A password the process was
// started with on its command line is emptied out of the arguments it is run
// with again (password.ClearFlags).
//
// Call it only once the graceful shutdown has finished: on unix nothing of this
// process survives the exec but its PID, its terminal and whatever file
// descriptors were explicitly inherited (Go opens every file close-on-exec).
// A failure at this point is past the point of carrying on: it is logged, and
// the process exits non-zero instead of hanging around with nothing running.
func (r *Restarter) Restart(pw string) {
	program := r.program
	program.Args = password.ClearFlags(program.Args)
	slog.Default().Info("restarting", "path", program.Path, "args", len(program.Args), "dir", program.Dir)
	code, err := replace(program, password.WithEnv(os.Environ(), pw), slog.Default())
	if err != nil {
		slog.Default().Error("restart failed", "path", r.program.Path, "error", err)
		fmt.Fprintf(os.Stderr, "Error: restart failed: %v\n", err)
		os.Exit(1)
	}
	os.Exit(code)
}
