package claude

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
)

// What `claude auth login` is expected to do when driven over pipes, as
// measured on Claude Code 2.1.283. Each is a place a later version could
// differ, and each difference ends the sign-in as cliauth.FailureFlowBroken
// rather than leaving it waiting. Auth holds them, so tests can shorten them.
const (
	// linkTimeout bounds the wait for the sign-in link. It is printed within a
	// second or two of starting; the rest is room for a contended machine.
	linkTimeout = 30 * time.Second
	// verifyTimeout bounds the wait for the CLI's verdict on a pasted code,
	// which is one request to Anthropic's token endpoint.
	verifyTimeout = 60 * time.Second
)

// loginBrowser is the BROWSER the CLI is given: a command that does nothing.
// The CLI tries to open the link on this machine as well as printing it, and a
// browser popping up on the server's desktop helps nobody signing in from a
// phone. Where `true` is not a command (Windows), the attempt fails quietly and
// the link is printed all the same (measured with a BROWSER naming nothing).
const loginBrowser = "BROWSER=true"

// linkPattern finds the sign-in link in the line that offers it ("If the
// browser didn't open, visit: https://...").
var linkPattern = regexp.MustCompile(`https://\S+`)

// codeCallbackPath is where the link sends the browser after sign-in: the page
// that shows the code for the user to paste. A link that goes anywhere else
// ends at a local callback on the server, which a phone cannot reach.
const codeCallbackPath = "/oauth/code/callback"

// Lines `claude auth login` writes to stderr, as of Claude Code 2.1.283.
var (
	// malformedCodePrefix starts the line printed for a pasted code with no
	// "#state" part; the CLI then waits for another.
	malformedCodePrefix = "Invalid code."
	// rejectedCodePattern is the line printed when the token endpoint refuses
	// the code ("Login failed: Request failed with status code 400"); the CLI
	// then exits 1.
	rejectedCodePattern = regexp.MustCompile(`status code 4\d\d`)
	// managedSettingsPrefix starts the line printed when managed settings on
	// the machine require another sign-in (a cloud gateway); the CLI exits 1.
	managedSettingsPrefix = "Managed settings"
)

// AccountKinds are the subscription (the default: what someone signing in
// from a phone most likely has) and the Console, which `auth login --console`
// signs in to through the same pasted-code page.
func (a *Auth) AccountKinds() []cliauth.AccountKind {
	return []cliauth.AccountKind{cliauth.AccountClaudeAI, cliauth.AccountConsole}
}

// Login drives `claude auth login`: it hands the user the link the CLI prints,
// writes each code the user pastes to the CLI's stdin, and takes the CLI's
// exit status as the verdict.
//
// The CLI has no timeout of its own and does not end when stdin closes, so it
// ends when ctx does — cancelled or expired, the Service's call.
func (a *Auth) Login(ctx context.Context, opts cliauth.LoginOptions, flow cliauth.LoginFlow) (cliauth.Status, error) {
	// Credentials from the environment or settings outrank the file a sign-in
	// writes, so a sign-in would succeed and change nothing a session uses.
	st, err := a.Status(ctx)
	if err != nil {
		return cliauth.Status{}, err
	}
	if st.State == cliauth.StateExternal {
		return cliauth.Status{}, &cliauth.LoginError{Reason: cliauth.FailureExternal, External: st.External}
	}

	args := []string{"auth", "login"}
	if opts.AccountKind == cliauth.AccountConsole {
		args = append(args, "--console")
	}

	proc, err := agent.StartProcessEnv(ctx, a.log, a.binary, args, a.workDir, []string{loginBrowser})
	if err != nil {
		return cliauth.Status{}, err
	}
	// The CLI is gone before Login returns, whichever way it ends: the Service
	// hands its lock to the next command then, and a cancel or a shutdown is
	// reported as done. Left running, it would keep its local callback open.
	defer func() {
		proc.Terminate()
		proc.Wait()
		proc.OutputDone()
	}()

	res, err := a.driveLogin(ctx, proc, flow)
	if err != nil {
		return cliauth.Status{}, err
	}
	if res.exitCode != 0 {
		return cliauth.Status{}, loginFailure(res)
	}

	st, err = a.Status(ctx)
	if err != nil {
		return cliauth.ErrorStatus(err), nil
	}
	return st, nil
}

// loginResult is how `claude auth login` ended.
type loginResult struct {
	exitCode int
	// lastStderr is its last stderr line: the reason, on a failure.
	lastStderr string
	// codeSent says a code had been written and not yet answered.
	codeSent bool
}

// driveLogin runs the conversation with the CLI until it exits. It returns an
// error only for a sign-in that cannot go on: ctx done, or a CLI that stopped
// behaving as expected.
func (a *Auth) driveLogin(ctx context.Context, proc *agent.Process, flow cliauth.LoginFlow) (loginResult, error) {
	stop := make(chan struct{})
	defer close(stop)
	stdout := readLines(proc.Stdout, stop)
	stderr := readLines(proc.Stderr, stop)
	exited := make(chan error, 1)
	go func() { exited <- proc.Wait() }()

	linkTimer := time.NewTimer(a.linkTimeout)
	defer linkTimer.Stop()
	var verifyTimer <-chan time.Time
	var codes <-chan string // nil until the link is out: no code can come before
	var res loginResult
	var waitErr error
	var drained <-chan time.Time
	prompted, processDone := false, false

	for {
		// The verdict waits for both streams to end: the reason is on stderr,
		// and may be read after the exit is.
		if processDone && stdout == nil && stderr == nil {
			break
		}
		select {
		case line, ok := <-stdout:
			if !ok {
				stdout = nil
				continue
			}
			// A link printed after the exit is no use to anyone: there is
			// nothing left to paste a code into.
			if prompted || processDone {
				continue
			}
			link := linkPattern.FindString(line)
			if link == "" {
				continue
			}
			if err := checkLink(link); err != nil {
				return loginResult{}, err
			}
			linkTimer.Stop()
			prompted = true
			flow.Prompt(cliauth.Prompt{URL: link, TakesCode: true})
			codes = flow.Codes()
		case line, ok := <-stderr:
			if !ok {
				stderr = nil
				continue
			}
			if line = strings.TrimSpace(line); line == "" {
				continue
			}
			res.lastStderr = line
			if res.codeSent && strings.HasPrefix(line, malformedCodePrefix) {
				res.codeSent = false
				verifyTimer = nil
				flow.CodeMalformed()
			}
		case code := <-codes:
			if _, err := proc.Stdin.Write([]byte(code + "\n")); err != nil {
				// The CLI is going away; its exit says why.
				a.log.Warn("could not pass the pasted code to claude auth login", "error", err)
			}
			res.codeSent = true
			verifyTimer = time.After(a.verifyTimeout)
		case waitErr = <-exited:
			processDone = true
			codes, verifyTimer = nil, nil
			linkTimer.Stop()
			drained = time.After(agent.StderrReadTimeout)
		case <-drained:
			stdout, stderr = nil, nil
		case <-linkTimer.C:
			return loginResult{}, flowBroken(fmt.Sprintf("claude auth login printed no sign-in link within %s", a.linkTimeout))
		case <-verifyTimer:
			return loginResult{}, flowBroken(fmt.Sprintf("claude auth login did not answer the pasted code within %s", a.verifyTimeout))
		case <-ctx.Done():
			// An exit already seen is the verdict — a sign-in that succeeded
			// just as it was cancelled did write the credentials. What is
			// left of its output is not waited for.
			if !processDone {
				return loginResult{}, ctx.Err()
			}
			stdout, stderr = nil, nil
		}
	}

	var exitErr *exec.ExitError
	switch {
	case waitErr == nil:
	case errors.As(waitErr, &exitErr):
		res.exitCode = exitErr.ExitCode()
	default:
		return loginResult{}, fmt.Errorf("claude auth login: %w", waitErr)
	}
	return res, nil
}

// checkLink makes sure the link leads to the page that shows a code to paste:
// the one path through this sign-in a phone can finish. The host is not
// checked — the subscription and the Console each have their own.
func checkLink(link string) error {
	u, err := url.Parse(link)
	if err != nil {
		return flowBroken("claude auth login printed a sign-in link Pockode cannot read")
	}
	q := u.Query()
	redirect, err := url.Parse(q.Get("redirect_uri"))
	if q.Get("code") != "true" || err != nil || !strings.HasSuffix(redirect.Path, codeCallbackPath) {
		return flowBroken("claude auth login printed a sign-in link that does not lead to a page showing a code to paste")
	}
	return nil
}

// loginFailure reads why `claude auth login` exited non-zero.
func loginFailure(res loginResult) error {
	reason := res.lastStderr
	if reason == "" {
		reason = fmt.Sprintf("claude auth login exited with status %d", res.exitCode)
	}
	switch {
	case strings.HasPrefix(res.lastStderr, managedSettingsPrefix):
		return &cliauth.LoginError{Reason: cliauth.FailureExternal, Detail: reason}
	case res.codeSent && rejectedCodePattern.MatchString(res.lastStderr):
		return &cliauth.LoginError{Reason: cliauth.FailureCodeRejected, Detail: reason}
	default:
		return &cliauth.LoginError{Reason: cliauth.FailureOther, Detail: reason}
	}
}

func flowBroken(detail string) error {
	return &cliauth.LoginError{Reason: cliauth.FailureFlowBroken, Detail: detail + "; this Claude Code version may sign in differently than Pockode expects"}
}

// readLines delivers r's lines until it ends or stop is closed. The prompt the
// CLI leaves waiting for a code has no newline, so it is never delivered —
// nothing here waits for it.
func readLines(r io.Reader, stop <-chan struct{}) <-chan string {
	lines := make(chan string)
	go func() {
		defer close(lines)
		scanner := agent.NewLineScanner(r, agent.MaxLineBytes)
		for scanner.Scan() {
			if scanner.Truncated() {
				continue
			}
			select {
			case lines <- string(scanner.Bytes()):
			case <-stop:
				return
			}
		}
	}()
	return lines
}
