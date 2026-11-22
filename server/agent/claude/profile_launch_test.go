package claude

import (
	"context"
	"encoding/json"
	"log/slog"
	"maps"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/cliprofile/cliprofiletest"
	"github.com/pockode/server/session"
)

// TestLaunchesRunAsCurrentProfile starts claude from every place Pockode does —
// a session, a one-shot, and the sign-in commands — and checks what each was
// started with: nothing added for the default profile, and the profile's
// directory for another. `--version` is the exception, and stays the default
// profile's: it reads no account.
func TestLaunchesRunAsCurrentProfile(t *testing.T) {
	launchAll := func(t *testing.T, profiles *cliprofile.Store) []cliprofiletest.Invocation {
		t.Helper()
		cliprofiletest.FakeOnPath(t, Binary)
		t.Setenv(fakeClaudeRoleEnv, fakeSession)
		t.Setenv(fakeClaudeDirEnv, t.TempDir())
		rec := cliprofiletest.Record(t)

		startSession(t, New(profiles), rec, agent.StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), SessionID: "pockode-session", DisableMCP: true})
		if got, err := New(profiles).RunOneShot(context.Background(), agent.OneShotRequest{Prompt: "hi", WorkDir: t.TempDir()}); err != nil || got != "ok" {
			t.Fatalf("RunOneShot = %q, %v; want ok", got, err)
		}

		// The sign-in commands, as the Service runs them: the current profile
		// resolved to an ID first.
		profileID, err := profiles.Resolve(session.AgentTypeClaude, cliprofile.SelectCurrent())
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv(fakeClaudeRoleEnv, fakeManaged)
		auth := &Auth{log: slog.Default(), binary: os.Args[0], workDir: t.TempDir(), profiles: profiles, linkTimeout: 5 * time.Second, verifyTimeout: 2 * time.Second}
		if _, err := auth.Status(context.Background(), profileID); err != nil {
			t.Fatalf("Status: %v", err)
		}
		if _, err := auth.Logout(context.Background(), profileID); err != nil {
			t.Fatalf("Logout: %v", err)
		}
		// Refused by the fake's managed settings once started, which is all
		// this needs.
		if _, err := auth.Login(context.Background(), cliauth.LoginOptions{ProfileID: profileID}, newTestFlow()); err == nil {
			t.Fatal("Login succeeded against a fake that refuses it")
		}
		return rec.Invocations(t)
	}

	t.Run("default profile", func(t *testing.T) {
		f := cliprofiletest.New(t)
		invocations := launchAll(t, f.Store)
		want := map[string]string{"CLAUDE_CONFIG_DIR": f.DefaultDir(session.AgentTypeClaude)}
		checkLaunches(t, invocations, want, want)
	})

	t.Run("another profile", func(t *testing.T) {
		f := cliprofiletest.New(t)
		_, dir := f.UseProfile(t, session.AgentTypeClaude)
		invocations := launchAll(t, f.Store)
		checkLaunches(t, invocations,
			map[string]string{"CLAUDE_CONFIG_DIR": dir, "CLAUDE_SECURESTORAGE_CONFIG_DIR": dir},
			map[string]string{"CLAUDE_CONFIG_DIR": f.DefaultDir(session.AgentTypeClaude)})
	})
}

// startSession starts a session on the fake, waits for its process to have
// recorded the start, and ends it.
func startSession(t *testing.T, a *Agent, rec *cliprofiletest.Recorder, opts agent.StartOptions) {
	t.Helper()
	sess, err := a.Start(context.Background(), opts)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer sess.Close()
	rec.WaitFor(t, func(inv cliprofiletest.Invocation) bool { return slices.Contains(inv.Args, "--input-format") })
	sess.Close()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case _, ok := <-sess.Events():
			if !ok {
				return
			}
		case <-timeout:
			t.Fatal("the session's process did not end after Close")
		}
	}
}

// checkLaunches checks that each kind of start Pockode makes happened, every
// one with wantEnv but `--version`, which has versionEnv.
func checkLaunches(t *testing.T, invocations []cliprofiletest.Invocation, wantEnv, versionEnv map[string]string) {
	t.Helper()
	kinds := map[string]bool{}
	for _, inv := range invocations {
		var kind string
		switch {
		case slices.Equal(inv.Args, []string{"--version"}):
			kind = "version"
		case slices.Contains(inv.Args, "--print"):
			kind = "one-shot"
		case slices.Contains(inv.Args, "--input-format"):
			kind = "session"
		case len(inv.Args) >= 2 && inv.Args[0] == "auth":
			kind = "auth " + inv.Args[1]
		default:
			t.Errorf("unexpected start %q", inv.Args)
			continue
		}
		kinds[kind] = true
		want := wantEnv
		if kind == "version" {
			want = versionEnv
		}
		// CODEX_HOME is the fixture's, and none of claude's business.
		delete(inv.Env, "CODEX_HOME")
		if !maps.Equal(inv.Env, want) {
			t.Errorf("%s started with %v, want %v", kind, inv.Env, want)
		}
	}
	for _, kind := range []string{"version", "session", "one-shot", "auth status", "auth logout", "auth login"} {
		if !kinds[kind] {
			t.Errorf("no %s was started", kind)
		}
	}
}

// A permission reviewer's CLI is started with settings that turn every
// CLAUDE.md off (reviewerSettings).
func TestReviewerLaunchesWithItsSettings(t *testing.T) {
	f := cliprofiletest.New(t)
	cliprofiletest.FakeOnPath(t, Binary)
	t.Setenv(fakeClaudeRoleEnv, fakeSession)
	t.Setenv(fakeClaudeDirEnv, t.TempDir())
	rec := cliprofiletest.Record(t)

	startSession(t, New(f.Store), rec, agent.StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), SessionID: "reviewer", DisableMCP: true, PermissionReviewer: true})

	var args []string
	for _, inv := range rec.Invocations(t) {
		if slices.Contains(inv.Args, "--input-format") {
			args = inv.Args
		}
	}
	i := slices.Index(args, "--settings")
	if i < 0 || i+1 >= len(args) {
		t.Fatalf("reviewer launched without --settings: %v", args)
	}
	data, err := os.ReadFile(args[i+1])
	if err != nil {
		t.Fatalf("read the reviewer's settings: %v", err)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("the reviewer's settings are not JSON: %v (%s)", err, data)
	}
	if got := settings.Env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"]; got != "1" {
		t.Errorf("CLAUDE_CODE_DISABLE_CLAUDE_MDS = %q, want 1", got)
	}
}
