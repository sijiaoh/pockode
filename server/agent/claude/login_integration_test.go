//go:build integration

package claude

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliprofile/cliprofiletest"
)

// codePrompt is how `claude auth login` asks for the code, on stdout and with
// no newline (Claude Code 2.1.330: "Paste code here if prompted > "). Login
// never reads it — readLines cannot deliver a line that does not end — so only
// this test notices if it goes.
const codePrompt = "Paste code here"

// promptTimeout bounds the wait for codePrompt once the link is out. The CLI
// prints it straight after the link; the rest is room for a contended machine.
// It ends before ctx does, so that a missing prompt is reported as that rather
// than as driveLogin giving up on ctx.
const promptTimeout = 15 * time.Second

// smokeTimeout bounds one sign-in up to the prompt: driveLogin's own wait for
// the link, the wait for the prompt, and room to stop.
const smokeTimeout = linkTimeout + promptTimeout + 15*time.Second

// TestIntegration_LoginReachesCodePrompt runs the installed claude's
// `auth login` as Login runs it — same command, same environment, same driver —
// against a throwaway configuration directory, as far as a person would take
// over: the link is printed, checkLink accepts it, and the CLI is waiting for a
// code. It then stops the CLI. No code is ever written, so nothing signs in,
// nothing is billed, and the user's own configuration is never read: the
// fixture points CLAUDE_CONFIG_DIR at a temporary directory, and an unknown
// CLAUDE_CONFIG_DIR is also a keychain entry of its own on macOS.
//
// It is here because the unit tests' fake claude prints what Pockode expects by
// construction, so they cannot see a CLI that changed — as 2.1.330 did when it
// started shortening the link, which only the undocumented loginFullLink
// variable undoes.
func TestIntegration_LoginReachesCodePrompt(t *testing.T) {
	fixture := cliprofiletest.New(t)
	auth := NewAuth(t.TempDir(), fixture.Store)
	t.Logf("claude version: %s", claudeVersion(t))

	requireSignedOut(t, auth, "before")
	for _, kind := range auth.AccountKinds() {
		t.Run(string(kind), func(t *testing.T) {
			driveToCodePrompt(t, auth, kind)
		})
	}
	// The sign-in was never finished, so the directory has to say so still.
	requireSignedOut(t, auth, "after")
}

func driveToCodePrompt(t *testing.T, auth *Auth, kind cliauth.AccountKind) {
	ctx, cancel := context.WithTimeout(context.Background(), smokeTimeout)
	defer cancel()

	proc, err := auth.startLogin(ctx, cliauth.LoginOptions{AccountKind: kind})
	if err != nil {
		t.Fatalf("start claude auth login: %v", err)
	}
	defer stopLogin(proc)
	stdout := newPromptWatch()
	proc.Stdout = io.TeeReader(proc.Stdout, stdout)

	flow := newTestFlow()
	driven := make(chan error, 1)
	go func() {
		res, err := auth.driveLogin(ctx, proc, flow)
		if err == nil {
			err = loginFailure(res)
		}
		driven <- err
	}()

	select {
	case p := <-flow.prompts:
		t.Logf("sign-in link accepted: %s", p.URL)
	case err := <-driven:
		t.Fatalf("claude auth login ended before Pockode accepted a sign-in link: %v%s\nstdout:\n%s",
			err, linkHint(err), stdout.String())
	}

	select {
	case <-stdout.prompted:
	case err := <-driven:
		t.Fatalf("claude auth login ended after printing the link and before asking for a code (%q): %v\nstdout:\n%s",
			codePrompt, err, stdout.String())
	case <-time.After(promptTimeout):
		t.Fatalf("claude auth login printed the link but did not ask for a code (%q) within %s; Pockode writes the user's code to its stdin and needs it waiting there\nstdout:\n%s",
			codePrompt, promptTimeout, stdout.String())
	}

	cancel()
	if err := <-driven; !errors.Is(err, context.Canceled) {
		t.Fatalf("stopping the sign-in at the code prompt: got %v, want context.Canceled\nstdout:\n%s", err, stdout.String())
	}
}

// linkHint names the likeliest cause of a refused link, so that a failure says
// what changed rather than only that something did.
func linkHint(err error) string {
	var le *cliauth.LoginError
	if !errors.As(err, &le) || le.Reason != cliauth.FailureFlowBroken {
		return ""
	}
	return "\nIf the link in stdout below is a short https://claude.ai/oauth/authorize?z-... link, " +
		"this Claude Code no longer honours " + loginFullLink + " (loginFullLink in login.go): " +
		"a phone cannot finish that link, so Pockode needs another way to get the full one."
}

func requireSignedOut(t *testing.T, auth *Auth, when string) {
	t.Helper()
	st, err := auth.Status(context.Background(), "")
	if err != nil {
		t.Fatalf("claude auth status %s the sign-in: %v", when, err)
	}
	switch st.State {
	case cliauth.StateSignedOut:
	case cliauth.StateExternal:
		t.Fatalf("claude reads credentials from outside its configuration directory (%+v); "+
			"Login refuses to sign in over them, so unset them to run this test", *st.External)
	default:
		t.Fatalf("claude auth status %s the sign-in in a throwaway configuration directory: got %q, want %q",
			when, st.State, cliauth.StateSignedOut)
	}
}

func claudeVersion(t *testing.T) string {
	t.Helper()
	cmd, err := agent.Command(Binary, "--version")
	if err != nil {
		t.Fatalf("claude --version: %v", err)
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("claude --version: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// promptWatch keeps what the CLI wrote to stdout and closes prompted once the
// code prompt is among it.
type promptWatch struct {
	bufMu    sync.Mutex
	buf      bytes.Buffer
	prompted chan struct{}
	once     sync.Once
}

func newPromptWatch() *promptWatch { return &promptWatch{prompted: make(chan struct{})} }

func (w *promptWatch) Write(p []byte) (int, error) {
	w.bufMu.Lock()
	defer w.bufMu.Unlock()
	w.buf.Write(p)
	if bytes.Contains(w.buf.Bytes(), []byte(codePrompt)) {
		w.once.Do(func() { close(w.prompted) })
	}
	return len(p), nil
}

func (w *promptWatch) String() string {
	w.bufMu.Lock()
	defer w.bufMu.Unlock()
	return w.buf.String()
}
