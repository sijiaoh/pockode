package claude

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/cliauth"
)

// The test binary re-execs itself as a fake `claude`, so that the sign-in is
// driven over a real process and real pipes — on Windows too — without a
// Claude Code install or an account.
const (
	fakeClaudeRoleEnv = "POCKODE_TEST_FAKE_CLAUDE"
	// fakeClaudeDirEnv is where the fake keeps its credentials: a file whose
	// presence is "signed in", so that `auth status` after `auth login` sees it.
	fakeClaudeDirEnv = "POCKODE_TEST_FAKE_CLAUDE_DIR"

	// fakeLogin behaves as Claude Code 2.1.283 does: a link, then a line per
	// code — "Invalid code." for one without "#", a 400 for a wrong one, and
	// "Login successful." for fakeGoodCode.
	fakeLogin = "login"
	// fakeNoLink never prints a link.
	fakeNoLink = "no_link"
	// fakeLocalLink prints a link whose redirect goes to a local callback.
	fakeLocalLink = "local_link"
	// fakeSilentVerify takes a code and never answers it.
	fakeSilentVerify = "silent_verify"
	// fakeManaged refuses to sign in because managed settings want a gateway.
	fakeManaged = "managed"
	// fakeExternal reports an API key from the environment.
	fakeExternal = "external"
)

const (
	fakeState    = "fake-state-0123456789"
	fakeGoodCode = "fake-code-0123456789#" + fakeState
)

func TestMain(m *testing.M) {
	if role := os.Getenv(fakeClaudeRoleEnv); role != "" {
		runFakeClaude(role, os.Args[1:])
		return
	}
	os.Exit(m.Run())
}

func runFakeClaude(role string, args []string) {
	credentials := filepath.Join(os.Getenv(fakeClaudeDirEnv), "credentials")
	switch {
	case slices.Equal(args, []string{"--version"}):
		fmt.Println("2.1.283 (Claude Code)")
		os.Exit(0)
	case len(args) >= 2 && args[0] == "auth" && args[1] == "status":
		if role == fakeExternal {
			fmt.Println(`{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}`)
			os.Exit(0)
		}
		if _, err := os.Stat(credentials); err == nil {
			fmt.Println(`{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"ada@example.com","subscriptionType":"max"}`)
			os.Exit(0)
		}
		fmt.Println(`{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`)
		os.Exit(1)
	case len(args) >= 2 && args[0] == "auth" && args[1] == "login":
	default:
		fmt.Fprintf(os.Stderr, "fake claude: unexpected arguments %q\n", args)
		os.Exit(2)
	}

	if os.Getenv("BROWSER") != "true" {
		fmt.Fprintln(os.Stderr, "fake claude: BROWSER is not the no-op Pockode is meant to set")
		os.Exit(3)
	}
	if role == fakeManaged {
		fmt.Fprintln(os.Stderr, "Managed settings on this machine configure a Cloud gateway sign-in; run claude to sign in")
		os.Exit(1)
	}

	host := "claude.com/cai"
	if slices.Contains(args, "--console") {
		host = "platform.claude.com"
	}
	redirect := "https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
	if role == fakeLocalLink {
		redirect = "http%3A%2F%2Flocalhost%3A54545%2Fcallback"
	}
	fmt.Println("Opening browser to sign in…")
	if role != fakeNoLink {
		fmt.Printf("If the browser didn't open, visit: https://%s/oauth/authorize?code=true&client_id=abc&redirect_uri=%s&state=%s\n", host, redirect, fakeState)
	}
	fmt.Print("Paste code here if prompted > ")

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		code := scanner.Text()
		switch {
		case role == fakeSilentVerify:
		case !strings.Contains(code, "#"):
			fmt.Fprintln(os.Stderr, "Invalid code. Please make sure the full code was copied.")
		case code == fakeGoodCode:
			if err := os.WriteFile(credentials, nil, 0o600); err != nil {
				fmt.Fprintln(os.Stderr, "Login failed:", err)
				os.Exit(1)
			}
			fmt.Println("Login successful.")
			os.Exit(0)
		default:
			fmt.Fprintln(os.Stderr, "Login failed: Request failed with status code 400")
			os.Exit(1)
		}
	}
	// The real CLI does not end when stdin does; nor does this one.
	select {}
}

func fakeClaudeAuth(t *testing.T, role string) *Auth {
	t.Helper()
	t.Setenv(fakeClaudeRoleEnv, role)
	t.Setenv(fakeClaudeDirEnv, t.TempDir())
	return &Auth{
		log:           slog.Default(),
		binary:        os.Args[0],
		workDir:       t.TempDir(),
		linkTimeout:   5 * time.Second,
		verifyTimeout: 2 * time.Second,
	}
}

// testFlow is a cliauth.LoginFlow a test drives by hand.
type testFlow struct {
	prompts   chan cliauth.Prompt
	codes     chan string
	malformed chan struct{}
}

func newTestFlow() *testFlow {
	return &testFlow{
		prompts:   make(chan cliauth.Prompt, 1),
		codes:     make(chan string, 1),
		malformed: make(chan struct{}, 1),
	}
}

func (f *testFlow) Prompt(p cliauth.Prompt) { f.prompts <- p }
func (f *testFlow) Codes() <-chan string    { return f.codes }
func (f *testFlow) CodeMalformed()          { f.malformed <- struct{}{} }

type loginOutcome struct {
	status cliauth.Status
	err    error
}

func startLogin(t *testing.T, a *Auth, kind cliauth.AccountKind) (*testFlow, <-chan loginOutcome, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	flow := newTestFlow()
	done := make(chan loginOutcome, 1)
	go func() {
		st, err := a.Login(ctx, cliauth.LoginOptions{AccountKind: kind}, flow)
		done <- loginOutcome{st, err}
	}()
	return flow, done, cancel
}

func awaitPrompt(t *testing.T, flow *testFlow, done <-chan loginOutcome) cliauth.Prompt {
	t.Helper()
	select {
	case p := <-flow.prompts:
		return p
	case out := <-done:
		t.Fatalf("sign-in ended before its link: %+v, %v", out.status, out.err)
	case <-time.After(20 * time.Second):
		t.Fatal("no link")
	}
	return cliauth.Prompt{}
}

func awaitOutcome(t *testing.T, done <-chan loginOutcome) loginOutcome {
	t.Helper()
	select {
	case out := <-done:
		return out
	case <-time.After(20 * time.Second):
		t.Fatal("sign-in did not end")
	}
	return loginOutcome{}
}

func wantLoginError(t *testing.T, err error, reason cliauth.FailureReason, detail string) {
	t.Helper()
	var loginErr *cliauth.LoginError
	if !errors.As(err, &loginErr) || loginErr.Reason != reason || !strings.Contains(loginErr.Detail, detail) {
		t.Errorf("got %v, want %s containing %q", err, reason, detail)
	}
}

func TestLogin_PastedCode(t *testing.T) {
	flow, done, _ := startLogin(t, fakeClaudeAuth(t, fakeLogin), cliauth.AccountClaudeAI)

	p := awaitPrompt(t, flow, done)
	if !p.TakesCode || !strings.HasPrefix(p.URL, "https://claude.com/cai/oauth/authorize?") || !strings.HasSuffix(p.URL, fakeState) {
		t.Errorf("prompt = %+v, want the subscription's link, whole, taking a code", p)
	}

	// A code missing its "#state" part: the CLI says so and waits for another.
	flow.codes <- "fake-code-without-state"
	select {
	case <-flow.malformed:
	case out := <-done:
		t.Fatalf("a malformed code ended the sign-in: %+v, %v", out.status, out.err)
	case <-time.After(10 * time.Second):
		t.Fatal("a malformed code was not reported")
	}

	flow.codes <- fakeGoodCode
	out := awaitOutcome(t, done)
	if out.err != nil {
		t.Fatalf("Login: %v", out.err)
	}
	if out.status.State != cliauth.StateSignedIn || out.status.Account == nil || out.status.Account.Email != "ada@example.com" {
		t.Errorf("status after sign-in = %+v, want signed in as ada@example.com", out.status)
	}
}

func TestLogin_Console(t *testing.T) {
	flow, done, cancel := startLogin(t, fakeClaudeAuth(t, fakeLogin), cliauth.AccountConsole)

	if p := awaitPrompt(t, flow, done); !strings.HasPrefix(p.URL, "https://platform.claude.com/") {
		t.Errorf("link = %q, want the Console's", p.URL)
	}
	cancel()
	if out := awaitOutcome(t, done); !errors.Is(out.err, context.Canceled) {
		t.Errorf("after cancel: got %v, want context.Canceled", out.err)
	}
}

// A wrong code ends the CLI, so the sign-in has to start over.
func TestLogin_RejectedCode(t *testing.T) {
	flow, done, _ := startLogin(t, fakeClaudeAuth(t, fakeLogin), "")
	awaitPrompt(t, flow, done)

	flow.codes <- "wrong-code-0123456789#" + fakeState
	wantLoginError(t, awaitOutcome(t, done).err, cliauth.FailureCodeRejected, "status code 400")
}

// Each way the CLI can stop matching what Pockode expects ends the sign-in
// with a reason, never a wait that outlasts the user.
func TestLogin_FlowBroken(t *testing.T) {
	t.Run("no link", func(t *testing.T) {
		a := fakeClaudeAuth(t, fakeNoLink)
		a.linkTimeout = 500 * time.Millisecond
		_, done, _ := startLogin(t, a, "")
		wantLoginError(t, awaitOutcome(t, done).err, cliauth.FailureFlowBroken, "no sign-in link")
	})

	t.Run("a link to a local callback", func(t *testing.T) {
		_, done, _ := startLogin(t, fakeClaudeAuth(t, fakeLocalLink), "")
		wantLoginError(t, awaitOutcome(t, done).err, cliauth.FailureFlowBroken, "does not lead to a page showing a code")
	})

	t.Run("no answer to a code", func(t *testing.T) {
		flow, done, _ := startLogin(t, fakeClaudeAuth(t, fakeSilentVerify), "")
		awaitPrompt(t, flow, done)
		flow.codes <- fakeGoodCode
		wantLoginError(t, awaitOutcome(t, done).err, cliauth.FailureFlowBroken, "did not answer the pasted code")
	})
}

func TestLogin_External(t *testing.T) {
	t.Run("credentials from the environment", func(t *testing.T) {
		_, done, _ := startLogin(t, fakeClaudeAuth(t, fakeExternal), "")
		err := awaitOutcome(t, done).err
		var loginErr *cliauth.LoginError
		if !errors.As(err, &loginErr) || loginErr.Reason != cliauth.FailureExternal || loginErr.External == nil || loginErr.External.Source != "ANTHROPIC_API_KEY" {
			t.Errorf("got %v, want external naming ANTHROPIC_API_KEY", err)
		}
	})

	t.Run("managed settings", func(t *testing.T) {
		_, done, _ := startLogin(t, fakeClaudeAuth(t, fakeManaged), "")
		wantLoginError(t, awaitOutcome(t, done).err, cliauth.FailureExternal, "Managed settings")
	})
}

func TestCheckLink(t *testing.T) {
	const callback = "redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
	tests := []struct {
		link string
		ok   bool
	}{
		{"https://claude.com/cai/oauth/authorize?code=true&" + callback + "&state=s", true},
		// The host is not pinned: the Console's is another.
		{"https://platform.claude.com/oauth/authorize?code=true&" + callback, true},
		{"https://claude.com/cai/oauth/authorize?" + callback, false},
		{"https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback", false},
		{"https://claude.com/cai/oauth/authorize?code=true", false},
	}
	for _, tt := range tests {
		if err := checkLink(tt.link); (err == nil) != tt.ok {
			t.Errorf("checkLink(%q) = %v, want ok=%v", tt.link, err, tt.ok)
		}
	}
}
