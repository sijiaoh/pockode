package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// gitCommand builds a git command running in dir with core.quotePath disabled.
//
// git's default core.quotePath=true C-escapes non-ASCII paths (rendering "中"
// as "\344\270\255") in human-readable output such as diff headers. Disabling
// it keeps those paths as real UTF-8; paths containing quotes, backslashes or
// control characters are still quoted by git regardless of this setting.
func gitCommand(dir string, args ...string) *exec.Cmd {
	return gitCommandContext(context.Background(), dir, args...)
}

func gitCommandContext(ctx context.Context, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "core.quotePath=false"}, args...)...)
	cmd.Dir = dir
	return cmd
}

// CommandError reports a git command that exited non-zero, carrying git's own
// stderr as the error message.
//
// The panel shows these messages to the user verbatim: a refused checkout names
// the files that would be overwritten, a rejected push names the ref. A summary
// written here would drop exactly the part a developer needs to act on.
type CommandError struct {
	Args   []string
	Stderr string
	// TimedOut marks a command stopped by its deadline, with Timeout the deadline
	// it hit. git says nothing on the way out when it is signalled, so the only
	// account of what happened is the one written here.
	TimedOut bool
	Timeout  time.Duration
	Err      error
}

func (e *CommandError) Error() string {
	if e.TimedOut {
		msg := fmt.Sprintf("git %s timed out after %s", strings.Join(e.Args, " "), e.Timeout)
		if e.Stderr != "" {
			return msg + "\n" + e.Stderr
		}
		return msg
	}
	if e.Stderr != "" {
		return e.Stderr
	}
	return fmt.Sprintf("git %s failed: %v", strings.Join(e.Args, " "), e.Err)
}

func (e *CommandError) Unwrap() error { return e.Err }

func newCommandError(args []string, stderr string, err error) *CommandError {
	return &CommandError{Args: args, Stderr: redactCredentials(strings.TrimSpace(stderr)), Err: err}
}

// credentialInURL matches the userinfo part of a URL git may echo back, such as
// the remote it failed to reach.
//
// Pockode stores its token in a credential helper rather than in the remote URL
// (see Init), so this normally matches nothing — it is the guard for a repository
// whose remote was configured elsewhere with the token inline.
var credentialInURL = regexp.MustCompile(`(?i)(https?://)[^\s/@]+@`)

func redactCredentials(s string) string {
	return credentialInURL.ReplaceAllString(s, "${1}***@")
}

// execGit runs a git command in dir and returns its trimmed stdout.
// A non-zero exit becomes a *CommandError carrying stderr.
func execGit(dir string, args ...string) (string, error) {
	cmd := gitCommand(dir, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	output, err := cmd.Output()
	if err != nil {
		return "", newCommandError(args, stderr.String(), err)
	}
	return strings.TrimSpace(string(output)), nil
}

// execGitLines is execGit split into lines.
//
// Safe for the ref listings it is used with: git rejects control characters in
// ref names, so no name can span two lines. Path listings must keep using -z.
func execGitLines(dir string, args ...string) ([]string, error) {
	output, err := execGit(dir, args...)
	if err != nil {
		return nil, err
	}
	if output == "" {
		return nil, nil
	}
	return strings.Split(output, "\n"), nil
}

// networkTimeout bounds a command that talks to a remote. Generous enough for a
// large fetch over a slow link, but finite: an RPC that never answers leaves the
// sync sheet spinning with no way out. Authentication does not consume it —
// prompts are disabled, so a missing credential fails immediately.
const networkTimeout = 5 * time.Minute

// terminateGrace is how long a timed-out git gets to clean up after SIGTERM
// before it is killed.
const terminateGrace = 10 * time.Second

// execGitNetwork runs a git command that contacts a remote.
//
// Every prompt git could raise is turned into an immediate failure: a server
// process has no one to answer "Username:", and git will open /dev/tty to ask
// unless GIT_TERMINAL_PROMPT says otherwise.
func execGitNetwork(dir string, args ...string) error {
	return execGitNetworkTimeout(dir, networkTimeout, args...)
}

// execGitNetworkTimeout is execGitNetwork with the deadline spelled out, so a
// test does not have to wait out networkTimeout to exercise it.
func execGitNetworkTimeout(dir string, timeout time.Duration, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := gitCommandContext(ctx, dir, args...)
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		// git treats an empty askpass as unset, which is what disables the
		// graphical prompt that would otherwise hang with nobody to see it.
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
	)
	// Only when the operator has not chosen their own ssh command, whose options
	// this would silently drop.
	if os.Getenv("GIT_SSH_COMMAND") == "" {
		cmd.Env = append(cmd.Env, "GIT_SSH_COMMAND=ssh -o BatchMode=yes")
	}

	// Stop git as gracefully as the platform allows rather than killing it
	// outright. Where git can be asked to stop it removes its lock files
	// (index.lock, FETCH_HEAD.lock) on the way out, and a lock left behind by a
	// timeout would break every later git command in the worktree — a worse
	// outcome than the hang the timeout exists to prevent. What "as gracefully
	// as allowed" means differs per platform, and on Windows it is not much; see
	// terminate_windows.go.
	term := newTerminator(cmd)
	defer term.close()
	cmd.Cancel = func() error { return term.stop(cmd) }
	// The backstop for a git that ignores the request.
	cmd.WaitDelay = terminateGrace

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return newCommandError(args, stderr.String(), err)
	}
	if err := term.adopt(cmd); err != nil {
		// Not fatal: git itself can still be stopped, only the guarantee about the
		// helpers it starts is lost. Worth saying out loud — a straggler holding
		// the stderr pipe is the explanation for a deadline that then takes
		// WaitDelay to land.
		slog.Warn("failed to attach process tree tracking to git", "error", err, "pid", cmd.Process.Pid)
	}

	if err := cmd.Wait(); err != nil {
		cmdErr := newCommandError(args, stderr.String(), err)
		cmdErr.TimedOut = ctx.Err() == context.DeadlineExceeded
		cmdErr.Timeout = timeout
		return cmdErr
	}
	return nil
}

// execGitVerbose runs a git command that explains its failures on stdout.
//
// git commit is that case: "nothing to commit" and "no changes added to commit"
// go to stdout and exit non-zero with nothing on stderr, so an error built from
// stderr alone would say no more than "exit status 1". Hook output can land on
// either stream, so both are kept.
func execGitVerbose(dir string, args ...string) error {
	cmd := gitCommand(dir, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr

	if err := cmd.Run(); err != nil {
		var parts []string
		for _, out := range []string{stdout.String(), stderr.String()} {
			if trimmed := strings.TrimSpace(out); trimmed != "" {
				parts = append(parts, trimmed)
			}
		}
		return newCommandError(args, strings.Join(parts, "\n"), err)
	}
	return nil
}

// errNotAFile is what a path that names no file inside its repository fails
// with. Wrapped by callers, which add the path they were handed.
var errNotAFile = errors.New("not a file inside the repository")

// literalPathspec turns a path into a pathspec that matches itself and nothing
// else.
//
// Everything after `--` is still a pathspec, and pathspec magic lives in the
// leading characters of the string rather than in the shell, so handing the
// path straight to exec does not disarm it. A file actually named
// ":!important.txt" reads as ":!" — exclude — applied to "important.txt", which
// matches every path *but* that one: `git clean -f -- ':!important.txt'` then
// deletes the whole untracked tree and `git add -- ':!important.txt'` stages
// every change, each exiting 0 and reported as the success the user asked for.
// `git status` hands out such a name the moment a file has it. `:(literal)`
// turns the magic off.
//
// An empty path is refused rather than prefixed, and this is the reverse trap:
// git rejects a bare empty pathspec on its own ("fatal: empty string is not a
// valid pathspec"), but ":(literal)" with nothing behind it matches
// *everything*. A path that is exactly a submodule's own directory resolves to
// the empty string, so the refusal is reachable from the wire.
func literalPathspec(path string) (string, error) {
	if path == "" {
		return "", errNotAFile
	}
	return ":(literal)" + path, nil
}
