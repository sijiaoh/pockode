package codex

import (
	"context"
	"log/slog"
	"maps"
	"os"
	"slices"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/cliprofile/cliprofiletest"
	"github.com/pockode/server/session"
)

// fileCredentials is what a non-default profile is started with on top of
// CODEX_HOME.
var fileCredentials = []string{"-c", "cli_auth_credentials_store=file"}

// TestLaunchesRunAsCurrentProfile starts codex from every place Pockode does —
// a session, a one-shot, and the account calls — and checks what each was
// started with: nothing added for the default profile, and the profile's
// directory with file-stored credentials for another. The `--help` probe is the
// exception, and stays the default profile's: it reads no account.
func TestLaunchesRunAsCurrentProfile(t *testing.T) {
	launchAll := func(t *testing.T, profiles *cliprofile.Store) []cliprofiletest.Invocation {
		t.Helper()
		cliprofiletest.FakeOnPath(t, Binary)
		rec := cliprofiletest.Record(t)

		// Both end in an error once started — the fake dies at the handshake,
		// and answers no prompt — which is all this needs.
		t.Setenv(fakeCodexRoleEnv, fakeExits)
		if _, err := New(profiles).Start(context.Background(), agent.StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), SessionID: "pockode-session", DisableMCP: true}); err == nil {
			t.Fatal("Start succeeded against a fake that exits")
		}
		if _, err := New(profiles).RunOneShot(context.Background(), agent.OneShotRequest{Prompt: "hi", WorkDir: t.TempDir()}); err == nil {
			t.Fatal("RunOneShot succeeded against a fake that answers nothing")
		}

		// The account calls, as the Service makes them: the current profile
		// resolved to an ID first.
		profileID, err := profiles.Resolve(session.AgentTypeCodex, cliprofile.SelectCurrent())
		if err != nil {
			t.Fatal(err)
		}
		auth := &Auth{log: slog.Default(), binary: os.Args[0], workDir: t.TempDir(), profiles: profiles}
		t.Setenv(fakeCodexRoleEnv, fakeSignedIn)
		if _, err := auth.Status(context.Background(), profileID); err != nil {
			t.Fatalf("Status: %v", err)
		}
		if _, err := auth.Logout(context.Background(), profileID); err != nil {
			t.Fatalf("Logout: %v", err)
		}
		t.Setenv(fakeCodexRoleEnv, fakeLoginFails)
		if _, err := auth.Login(context.Background(), cliauth.LoginOptions{ProfileID: profileID}, newTestFlow()); err == nil {
			t.Fatal("Login succeeded against a fake that fails it")
		}
		return rec.Invocations(t)
	}

	t.Run("default profile", func(t *testing.T) {
		f := cliprofiletest.New(t)
		env := map[string]string{"CODEX_HOME": f.DefaultDir(session.AgentTypeCodex)}
		checkLaunches(t, launchAll(t, f.Store), env, nil, env)
	})

	t.Run("another profile", func(t *testing.T) {
		f := cliprofiletest.New(t)
		_, dir := f.UseProfile(t, session.AgentTypeCodex)
		checkLaunches(t, launchAll(t, f.Store),
			map[string]string{"CODEX_HOME": dir}, fileCredentials,
			map[string]string{"CODEX_HOME": f.DefaultDir(session.AgentTypeCodex)})
	})
}

// checkLaunches checks that each kind of start Pockode makes happened, every
// one with wantEnv and wantArgs among its options but `--help`, which has
// helpEnv and nothing added.
func checkLaunches(t *testing.T, invocations []cliprofiletest.Invocation, wantEnv map[string]string, wantArgs []string, helpEnv map[string]string) {
	t.Helper()
	counts := map[string]int{}
	for _, inv := range invocations {
		// CLAUDE_CONFIG_DIR is the fixture's, and none of codex's business.
		delete(inv.Env, "CLAUDE_CONFIG_DIR")
		if slices.Equal(inv.Args, []string{"--help"}) {
			counts["help"]++
			if !maps.Equal(inv.Env, helpEnv) {
				t.Errorf("--help started with %v, want %v", inv.Env, helpEnv)
			}
			continue
		}
		var kind string
		var options []string
		switch {
		case len(inv.Args) > 0 && inv.Args[0] == appServerSubcommand:
			kind, options = "app-server", inv.Args[1:]
		case len(inv.Args) > 1 && inv.Args[0] == "exec" && inv.Args[len(inv.Args)-1] == "-":
			// The prompt is read from stdin, which the trailing "-" says: the
			// options go before it.
			kind, options = "exec", inv.Args[len(oneShotArgs):len(inv.Args)-1]
		default:
			t.Errorf("unexpected start %q", inv.Args)
			continue
		}
		counts[kind]++
		if !maps.Equal(inv.Env, wantEnv) {
			t.Errorf("%s started with %v, want %v", kind, inv.Env, wantEnv)
		}
		if !slices.Equal(options, wantArgs) {
			t.Errorf("%s started with options %q, want %q", kind, options, wantArgs)
		}
	}
	// A session, then Status, Logout and Login each on an app-server of their
	// own, each after a --help probe; and a one-shot.
	if want := map[string]int{"help": 4, "app-server": 4, "exec": 1}; !maps.Equal(counts, want) {
		t.Errorf("started %v, want %v", counts, want)
	}
}
