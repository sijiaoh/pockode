package cliupdate_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/cliupdate"
	"github.com/pockode/server/session"
)

// The test binary stands in for the CLI when fakeCLIDirEnv is set. That
// directory holds its installed version, and the version `update` installs.
const (
	fakeCLIDirEnv  = "POCKODE_FAKE_UPDATE_CLI_DIR"
	fakeCLIRoleEnv = "POCKODE_FAKE_UPDATE_CLI_ROLE"
)

// How the fake CLI's `update` behaves.
const (
	// fakeUpdates installs the next version.
	fakeUpdates = "updates"
	// fakeFails exits 1 after a long npm-like error, as with a root-owned prefix.
	fakeFails = "fails"
	// fakeNoop exits 0 without installing anything, as an update of another
	// installation, or one with nothing newer, does.
	fakeNoop = "noop"
	// fakeHangs never finishes.
	fakeHangs = "hangs"
	// fakeNoUpdateCommand predates `update`, and takes it for a prompt.
	fakeNoUpdateCommand = "no-update-command"
)

const fakePackage = "@fake/cli"

func TestMain(m *testing.M) {
	if dir := os.Getenv(fakeCLIDirEnv); dir != "" {
		runFakeCLI(dir, os.Getenv(fakeCLIRoleEnv), os.Args[1:])
		return
	}
	os.Exit(m.Run())
}

func runFakeCLI(dir, role string, args []string) {
	if len(args) > 0 && (args[0] == "install" || args[0] == "prefix") {
		runFakeNPM(dir, role, args)
		return
	}
	versionFile := filepath.Join(dir, "version")
	switch strings.Join(args, " ") {
	case "--version":
		// A test holding the next --version: the one that claims the hold (a
		// rename, which only one process wins) waits until "release" exists.
		if os.Rename(filepath.Join(dir, "hold-version"), filepath.Join(dir, "version-held")) == nil {
			for {
				if _, err := os.Stat(filepath.Join(dir, "release")); err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		v, err := os.ReadFile(versionFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("%s (Fake CLI)\n", v)
		os.Exit(0)
	case "update --help", "update":
		if err := os.WriteFile(filepath.Join(dir, "update-ran"), nil, 0o600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	switch strings.Join(args, " ") {
	case "update --help":
		if role == fakeNoUpdateCommand {
			fmt.Println("Usage: fake [OPTIONS] [PROMPT]")
		} else {
			fmt.Println("Usage: fake update [OPTIONS]")
		}
		os.Exit(0)
	case "update":
		switch role {
		case fakeUpdates:
			next, err := os.ReadFile(filepath.Join(dir, "next"))
			if err == nil {
				err = os.WriteFile(versionFile, next, 0o600)
			}
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			fmt.Printf("Successfully updated to version %s\n", next)
			os.Exit(0)
		case fakeFails:
			fmt.Println("Installing update...")
			for i := range 30 {
				fmt.Fprintf(os.Stderr, "\x1b[31mnpm error\x1b[0m stack line %d\n", i)
			}
			fmt.Fprintln(os.Stderr, "Error: Insufficient permissions to install update")
			os.Exit(1)
		case fakeNoop:
			fmt.Println("Fake CLI is up to date")
			os.Exit(0)
		case fakeHangs:
			time.Sleep(time.Minute)
			os.Exit(0)
		case fakeNoUpdateCommand:
			// What running a prompt would look like: the test fails on it.
			fmt.Fprintln(os.Stderr, "fake CLI: ran `update` as a prompt")
			os.Exit(3)
		}
	}
	fmt.Fprintf(os.Stderr, "fake CLI: unexpected args %q\n", args)
	os.Exit(2)
}

// fakeRegistry serves dist-tags for fakePackage; nil tags is a registry that
// answers 503.
func fakeRegistry(t *testing.T, tags map[string]string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/-/package/"+fakePackage+"/dist-tags" {
			http.NotFound(w, r)
			return
		}
		if tags == nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		var pairs []string
		for tag, v := range tags {
			pairs = append(pairs, fmt.Sprintf("%q:%q", tag, v))
		}
		fmt.Fprintf(w, "{%s}", strings.Join(pairs, ","))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

type fakeCLI struct {
	role      string
	installed string
	// next is what `update` installs.
	next string
	// tags is what the registry says; nil is a registry that is down.
	tags    map[string]string
	channel string
	gate    cliupdate.Gate
	// lockDir is where the machine-wide locks go; empty is a directory of the
	// test's own.
	lockDir string
}

type sessionCount int

func (n sessionCount) AgentProcessCount(session.AgentType) int { return int(n) }

// notified hears every update change.
type notified chan struct{}

func (n notified) OnUpdateChange(session.AgentType) {
	select {
	case n <- struct{}{}:
	default:
	}
}

// fakeDir is the fake CLI's directory for the running test.
func fakeDir() string { return os.Getenv(fakeCLIDirEnv) }

func newService(t *testing.T, f fakeCLI) (*cliupdate.Service, notified) {
	t.Helper()
	dir := t.TempDir()
	if f.installed != "" {
		if err := os.WriteFile(filepath.Join(dir, "version"), []byte(f.installed), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "next"), []byte(f.next), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(fakeCLIDirEnv, dir)
	t.Setenv(fakeCLIRoleEnv, f.role)

	s := cliupdate.NewService(slog.Default(), sessionCount(2), f.gate)
	s.SetRegistry(fakeRegistry(t, f.tags))
	if f.lockDir == "" {
		f.lockDir = t.TempDir()
	}
	s.SetLockDir(f.lockDir)
	cli := cliupdate.CLI{Binary: os.Args[0], Package: fakePackage}
	if f.channel != "" {
		cli.Channel = func() string { return f.channel }
	}
	s.Register(session.AgentTypeClaude, cli)
	n := make(notified, 1)
	s.AddListener(n)
	t.Cleanup(s.Close)
	return s, n
}

func checkOne(t *testing.T, s *cliupdate.Service) cliupdate.Check {
	t.Helper()
	checks, err := s.Checks(context.Background(), session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("Checks: %v", err)
	}
	if len(checks) != 1 {
		t.Fatalf("got %d checks, want 1", len(checks))
	}
	return checks[0]
}

func TestChecks(t *testing.T) {
	tests := []struct {
		name string
		cli  fakeCLI
		want cliupdate.Check
		// wantError is part of the check's error, when there is one.
		wantError string
	}{
		{
			name: "a newer release",
			cli:  fakeCLI{installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}},
			want: cliupdate.Check{State: cliupdate.StateUpdateAvailable, Version: "2.1.283", LatestVersion: "2.1.285", Channel: "latest"},
		},
		{
			name: "the latest release",
			cli:  fakeCLI{installed: "2.1.285", tags: map[string]string{"latest": "2.1.285"}},
			want: cliupdate.Check{State: cliupdate.StateUpToDate, Version: "2.1.285", LatestVersion: "2.1.285", Channel: "latest"},
		},
		{
			// Its own update would not go back to the channel's release.
			name: "newer than its channel",
			cli:  fakeCLI{installed: "2.1.285", tags: map[string]string{"latest": "2.1.285", "stable": "2.1.280"}, channel: "stable"},
			want: cliupdate.Check{State: cliupdate.StateUpToDate, Version: "2.1.285", LatestVersion: "2.1.280", Channel: "stable"},
		},
		{
			name: "the channel is read, not latest",
			cli:  fakeCLI{installed: "2.1.279", tags: map[string]string{"latest": "2.1.285", "stable": "2.1.280"}, channel: "stable"},
			want: cliupdate.Check{State: cliupdate.StateUpdateAvailable, Version: "2.1.279", LatestVersion: "2.1.280", Channel: "stable"},
		},
		{
			// The installed version is still worth showing.
			name:      "a registry that is down",
			cli:       fakeCLI{installed: "2.1.283"},
			want:      cliupdate.Check{State: cliupdate.StateUnavailable, Version: "2.1.283", Channel: "latest"},
			wantError: "503",
		},
		{
			name:      "a channel the registry does not have",
			cli:       fakeCLI{installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}, channel: "nightly"},
			want:      cliupdate.Check{State: cliupdate.StateUnavailable, Version: "2.1.283", Channel: "nightly"},
			wantError: `no "nightly" release`,
		},
		{
			name:      "a version that cannot be read",
			cli:       fakeCLI{tags: map[string]string{"latest": "2.1.285"}},
			want:      cliupdate.Check{State: cliupdate.StateUnavailable, LatestVersion: "2.1.285", Channel: "latest"},
			wantError: "--version exited with status 1",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _ := newService(t, tt.cli)
			got := checkOne(t, s)
			tt.want.Agent = session.AgentTypeClaude
			tt.want.RunningSessions = 2
			if !strings.Contains(got.Error, tt.wantError) || (tt.wantError == "") != (got.Error == "") {
				t.Errorf("error = %q, want one containing %q", got.Error, tt.wantError)
			}
			got.Error = ""
			if got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestChecks_NotInstalled(t *testing.T) {
	s := cliupdate.NewService(slog.Default(), nil, nil)
	s.SetRegistry(fakeRegistry(t, map[string]string{"latest": "1.0.0"}))
	s.Register(session.AgentTypeCodex, cliupdate.CLI{Binary: "pockode-no-such-cli", Package: fakePackage})

	checks, err := s.Checks(context.Background(), "")
	if err != nil {
		t.Fatalf("Checks: %v", err)
	}
	if len(checks) != 1 || checks[0].State != cliupdate.StateNotInstalled || !strings.Contains(checks[0].Error, "not found") {
		t.Errorf("got %+v, want codex not installed", checks)
	}

	if _, err := s.Checks(context.Background(), "gemini"); !errors.Is(err, cliupdate.ErrUnknownAgent) {
		t.Errorf("unknown agent: got %v, want ErrUnknownAgent", err)
	}
}

// awaitEnd waits for the update to end and returns how it ended.
func awaitEnd(t *testing.T, s *cliupdate.Service, n notified) cliupdate.Update {
	t.Helper()
	timeout := time.After(30 * time.Second)
	for {
		u, err := s.Update(session.AgentTypeClaude)
		if err != nil {
			t.Fatalf("Update: %v", err)
		}
		if u != nil && u.Phase != cliupdate.PhaseRunning {
			return *u
		}
		select {
		case <-n:
		case <-timeout:
			t.Fatalf("update still running: %+v", u)
		}
	}
}

func TestStartUpdate(t *testing.T) {
	tests := []struct {
		name        string
		cli         fakeCLI
		wantPhase   cliupdate.Phase
		wantReason  cliupdate.FailureReason
		wantTo      string
		wantDetail  []string
		unwanted    []string
		wantFrom    string
		wantTarget  string
		shortBudget bool
	}{
		{
			name:       "installs the latest release",
			cli:        fakeCLI{role: fakeUpdates, installed: "2.1.283", next: "2.1.285", tags: map[string]string{"latest": "2.1.285"}},
			wantPhase:  cliupdate.PhaseSucceeded,
			wantFrom:   "2.1.283",
			wantTarget: "2.1.285",
			wantTo:     "2.1.285",
		},
		{
			name:       "nothing newer to install",
			cli:        fakeCLI{role: fakeNoop, installed: "2.1.285", tags: map[string]string{"latest": "2.1.285"}},
			wantPhase:  cliupdate.PhaseSucceeded,
			wantFrom:   "2.1.285",
			wantTarget: "2.1.285",
			wantTo:     "2.1.285",
		},
		{
			// Without a latest release to judge by, the CLI's word is taken.
			name:      "a registry that is down",
			cli:       fakeCLI{role: fakeUpdates, installed: "2.1.283", next: "2.1.285"},
			wantPhase: cliupdate.PhaseSucceeded,
			wantFrom:  "2.1.283",
			wantTo:    "2.1.285",
		},
		{
			// The end of what it printed is kept, where the reason is, without
			// the colors or the start of the stack.
			name:       "a command that fails",
			cli:        fakeCLI{role: fakeFails, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}},
			wantPhase:  cliupdate.PhaseFailed,
			wantReason: cliupdate.FailureCommandFailed,
			wantFrom:   "2.1.283",
			wantTarget: "2.1.285",
			wantTo:     "2.1.283",
			wantDetail: []string{"exited with status 1", "npm error stack line 29", "Insufficient permissions"},
			unwanted:   []string{"\x1b", "stack line 0\n"},
		},
		{
			name:       "an update that went somewhere else",
			cli:        fakeCLI{role: fakeNoop, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}},
			wantPhase:  cliupdate.PhaseFailed,
			wantReason: cliupdate.FailureNotApplied,
			wantFrom:   "2.1.283",
			wantTarget: "2.1.285",
			wantTo:     "2.1.283",
			wantDetail: []string{"still 2.1.283", "latest release is 2.1.285", "Fake CLI is up to date"},
		},
		{
			// Not run at all: it would have been a prompt.
			name:       "a CLI without an update command",
			cli:        fakeCLI{role: fakeNoUpdateCommand, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}},
			wantPhase:  cliupdate.PhaseFailed,
			wantReason: cliupdate.FailureOther,
			wantFrom:   "2.1.283",
			wantTarget: "2.1.285",
			wantDetail: []string{"has no `update` command"},
			unwanted:   []string{"as a prompt"},
		},
		{
			name:        "an update that runs out of time",
			cli:         fakeCLI{role: fakeHangs, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}},
			shortBudget: true,
			wantPhase:   cliupdate.PhaseFailed,
			wantReason:  cliupdate.FailureTimeout,
			wantFrom:    "2.1.283",
			wantTarget:  "2.1.285",
			wantTo:      "2.1.283",
			wantDetail:  []string{"did not finish in time"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, n := newService(t, tt.cli)
			if tt.shortBudget {
				// Long enough for the steps before the command (--version,
				// update --help: each a start of this test binary, slow under
				// -race on a busy machine), so that it is the hang that runs
				// out of it.
				s.SetUpdateTimeout(10 * time.Second)
			}

			started, err := s.StartUpdate(session.AgentTypeClaude)
			if err != nil {
				t.Fatalf("StartUpdate: %v", err)
			}
			if started.Phase != cliupdate.PhaseRunning || started.ID == "" || started.BinaryPath != os.Args[0] {
				t.Errorf("started = %+v, want a running update of %s", started, os.Args[0])
			}

			got := awaitEnd(t, s, n)
			if got.ID != started.ID || got.Revision <= started.Revision || got.EndedAt == nil {
				t.Errorf("ended = %+v, want the started update, later, with its end", got)
			}
			if got.Phase != tt.wantPhase || got.FromVersion != tt.wantFrom || got.TargetVersion != tt.wantTarget || got.ToVersion != tt.wantTo {
				t.Errorf("got %s %s → %s (target %s), want %s %s → %s (target %s)",
					got.Phase, got.FromVersion, got.ToVersion, got.TargetVersion,
					tt.wantPhase, tt.wantFrom, tt.wantTo, tt.wantTarget)
			}
			if tt.wantReason == "" {
				if got.Failure != nil {
					t.Errorf("failure = %+v, want none", got.Failure)
				}
				return
			}
			if got.Failure == nil || got.Failure.Reason != tt.wantReason {
				t.Fatalf("failure = %+v, want %s", got.Failure, tt.wantReason)
			}
			for _, want := range tt.wantDetail {
				if !strings.Contains(got.Failure.Detail, want) {
					t.Errorf("detail = %q, want it to contain %q", got.Failure.Detail, want)
				}
			}
			for _, unwanted := range tt.unwanted {
				if strings.Contains(got.Failure.Detail, unwanted) {
					t.Errorf("detail = %q, want it without %q", got.Failure.Detail, unwanted)
				}
			}
		})
	}
}

func TestStartUpdate_NotInstalled(t *testing.T) {
	s := cliupdate.NewService(slog.Default(), nil, nil)
	s.SetRegistry(fakeRegistry(t, map[string]string{"latest": "1.0.0"}))
	s.SetLockDir(t.TempDir())
	s.Register(session.AgentTypeClaude, cliupdate.CLI{Binary: "pockode-no-such-cli", Package: fakePackage})
	n := make(notified, 1)
	s.AddListener(n)
	t.Cleanup(s.Close)

	if _, err := s.StartUpdate(session.AgentTypeClaude); err != nil {
		t.Fatalf("StartUpdate: %v", err)
	}
	got := awaitEnd(t, s, n)
	if got.Failure == nil || got.Failure.Reason != cliupdate.FailureNotInstalled {
		t.Errorf("got %+v, want not installed", got)
	}

	if _, err := s.StartUpdate("gemini"); !errors.Is(err, cliupdate.ErrUnknownAgent) {
		t.Errorf("unknown agent: got %v, want ErrUnknownAgent", err)
	}
}

// One update per CLI: a second Update pressed meanwhile joins the first, and
// a check says it is running instead of reading files being replaced.
func TestStartUpdate_WhileRunning(t *testing.T) {
	s, _ := newService(t, fakeCLI{role: fakeHangs, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}})

	first, err := s.StartUpdate(session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("StartUpdate: %v", err)
	}
	second, err := s.StartUpdate(session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("second StartUpdate: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("second update %s, want the running %s", second.ID, first.ID)
	}

	got := checkOne(t, s)
	if got.State != cliupdate.StateUpdating || got.UpdateID != first.ID || got.Version != "" {
		t.Errorf("check = %+v, want updating %s without versions", got, first.ID)
	}
}

// Shutdown kills a running update rather than waiting out a download, and
// says so.
func TestClose(t *testing.T) {
	s, _ := newService(t, fakeCLI{role: fakeHangs, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}})
	if _, err := s.StartUpdate(session.AgentTypeClaude); err != nil {
		t.Fatalf("StartUpdate: %v", err)
	}

	done := make(chan struct{})
	go func() {
		s.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("Close is still waiting for the update")
	}

	got, err := s.Update(session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got.Phase != cliupdate.PhaseFailed || got.Failure.Reason != cliupdate.FailureOther || !strings.Contains(got.Failure.Detail, "shut down") {
		t.Errorf("got %+v, want failed by the shutdown", got)
	}
	if _, err := s.StartUpdate(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrShuttingDown) {
		t.Errorf("StartUpdate after Close: got %v, want ErrShuttingDown", err)
	}
}

// Every Pockode of the user updates the same install, so a second one is
// refused rather than queued, and leaves no record behind.
func TestStartUpdate_OnePerMachine(t *testing.T) {
	lockDir := t.TempDir()
	first, _ := newService(t, fakeCLI{role: fakeHangs, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}, lockDir: lockDir})
	second, _ := newService(t, fakeCLI{role: fakeHangs, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}, lockDir: lockDir})

	if _, err := first.StartUpdate(session.AgentTypeClaude); err != nil {
		t.Fatalf("first StartUpdate: %v", err)
	}
	if _, err := second.StartUpdate(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrUpdatingElsewhere) {
		t.Fatalf("second StartUpdate: got %v, want ErrUpdatingElsewhere", err)
	}
	if u, _ := second.Update(session.AgentTypeClaude); u != nil {
		t.Errorf("refused start left %+v", u)
	}

	first.Close()
	if _, err := second.StartUpdate(session.AgentTypeClaude); err != nil {
		t.Errorf("StartUpdate after the first ended: %v", err)
	}
}

// gate is a cliupdate.Gate that refuses with err, or records the update it
// held the CLI for and when it let go.
type gate struct {
	err     error
	began   chan string
	release chan struct{}
	ended   chan struct{}
}

func (g *gate) BeginUpdate(_ session.AgentType, updateID string) (func(context.Context) error, func(), error) {
	if g.err != nil {
		return nil, nil, g.err
	}
	g.began <- updateID
	wait := func(ctx context.Context) error {
		select {
		case <-g.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return wait, func() { close(g.ended) }, nil
}

func TestStartUpdate_Gate(t *testing.T) {
	t.Run("a refusal leaves no record and no lock", func(t *testing.T) {
		lockDir := t.TempDir()
		refusal := errors.New("a sign-in to claude is in progress; finish or cancel it before updating")
		s, _ := newService(t, fakeCLI{role: fakeUpdates, installed: "2.1.283", next: "2.1.285", gate: &gate{err: refusal}, lockDir: lockDir})

		if _, err := s.StartUpdate(session.AgentTypeClaude); !errors.Is(err, refusal) {
			t.Fatalf("StartUpdate: got %v, want the gate's refusal", err)
		}
		if u, _ := s.Update(session.AgentTypeClaude); u != nil {
			t.Errorf("refused start left %+v", u)
		}
		other, _ := newService(t, fakeCLI{role: fakeHangs, installed: "2.1.283", lockDir: lockDir})
		if _, err := other.StartUpdate(session.AgentTypeClaude); err != nil {
			t.Errorf("the machine lock was kept: %v", err)
		}
	})

	t.Run("the CLI is run only once the gate lets it, and released after", func(t *testing.T) {
		g := &gate{began: make(chan string, 1), release: make(chan struct{}), ended: make(chan struct{})}
		s, n := newService(t, fakeCLI{role: fakeUpdates, installed: "2.1.283", next: "2.1.285", tags: map[string]string{"latest": "2.1.285"}, gate: g})

		started, err := s.StartUpdate(session.AgentTypeClaude)
		if err != nil {
			t.Fatalf("StartUpdate: %v", err)
		}
		if id := <-g.began; id != started.ID {
			t.Errorf("gate held for %s, want %s", id, started.ID)
		}
		time.Sleep(50 * time.Millisecond)
		if u, _ := s.Update(session.AgentTypeClaude); u.Phase != cliupdate.PhaseRunning || u.FromVersion != "" {
			t.Errorf("before the gate let go: %+v, want running and nothing read", u)
		}

		close(g.release)
		if got := awaitEnd(t, s, n); got.Phase != cliupdate.PhaseSucceeded {
			t.Errorf("got %+v, want succeeded", got)
		}
		select {
		case <-g.ended:
		case <-time.After(5 * time.Second):
			t.Fatal("the gate was not released")
		}
	})
}

func TestDismiss(t *testing.T) {
	s, n := newService(t, fakeCLI{role: fakeFails, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}})
	started, err := s.StartUpdate(session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("StartUpdate: %v", err)
	}
	awaitEnd(t, s, n)

	if err := s.Dismiss("no-such-update"); !errors.Is(err, cliupdate.ErrUpdateNotFound) {
		t.Errorf("Dismiss of an unknown update: got %v, want ErrUpdateNotFound", err)
	}
	if err := s.Dismiss(started.ID); err != nil {
		t.Fatalf("Dismiss: %v", err)
	}
	select {
	case <-n:
	case <-time.After(5 * time.Second):
		t.Error("dismissing notified no one")
	}
	if u, _ := s.Update(session.AgentTypeClaude); u != nil {
		t.Errorf("after Dismiss the latest update is %+v, want none", u)
	}
}

func TestDismiss_Running(t *testing.T) {
	s, _ := newService(t, fakeCLI{role: fakeHangs, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}})
	started, err := s.StartUpdate(session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("StartUpdate: %v", err)
	}
	if err := s.Dismiss(started.ID); !errors.Is(err, cliupdate.ErrUpdateRunning) {
		t.Errorf("Dismiss while running: got %v, want ErrUpdateRunning", err)
	}
}

// An update the install could not take is not offered again until something
// changes, even once its record is dismissed.
func TestChecks_NotYetAvailable(t *testing.T) {
	s, n := newService(t, fakeCLI{role: fakeNoop, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}})
	if got := checkOne(t, s); got.State != cliupdate.StateUpdateAvailable {
		t.Fatalf("before the update: %+v, want update available", got)
	}

	started, err := s.StartUpdate(session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("StartUpdate: %v", err)
	}
	if got := awaitEnd(t, s, n); got.Failure == nil || got.Failure.Reason != cliupdate.FailureNotApplied {
		t.Fatalf("update: %+v, want not applied", got)
	}
	if err := s.Dismiss(started.ID); err != nil {
		t.Fatalf("Dismiss: %v", err)
	}
	if got := checkOne(t, s); got.State != cliupdate.StateNotYetAvailable || got.LatestVersion != "2.1.285" {
		t.Errorf("after it: %+v, want 2.1.285 not yet available", got)
	}

	// Nothing says when the install catches up, so it is offered again later.
	s.SetNotAppliedFor(0)
	if got := checkOne(t, s); got.State != cliupdate.StateUpdateAvailable {
		t.Errorf("once the hold ran out: %+v, want update available", got)
	}
	s.SetNotAppliedFor(time.Hour)

	s.SetRegistry(fakeRegistry(t, map[string]string{"latest": "2.1.286"}))
	if got := checkOne(t, s); got.State != cliupdate.StateUpdateAvailable {
		t.Errorf("once a newer release is out: %+v, want update available", got)
	}
}

func TestRedact(t *testing.T) {
	tests := []struct{ in, want string }{
		{"npm error 404 https://ada:s3cret@registry.example.com/@openai%2fcodex", "npm error 404 https://[redacted]@registry.example.com/@openai%2fcodex"},
		{"//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789", "//registry.npmjs.org/:_authToken=[redacted]"},
		{"authorization: Bearer abc.def.ghi", "authorization: [redacted]"},
		{"token npm_abcdefghijklmnopqrstuvwxyz0123456789 rejected", "token [redacted] rejected"},
		{"https://ada:p@ss@registry.example.com/x", "https://[redacted]@registry.example.com/x"},
		{`_authToken="abc def"`, `_authToken=[redacted]`},
		{"authorization: 'Bearer 1b2c3d4e-0000-4000-8000-000000000000'", "authorization: '[redacted]'"},
		{`{"authorization":"Bearer 1b2c3d4e-0000-4000-8000-000000000000","x":1}`, `{"authorization":"[redacted]","x":1}`},
		{"token github_pat_11ABCDEFG0123456789_abcdefghijklmnop rejected", "token [redacted] rejected"},
		{"Error: Insufficient permissions to install update", "Error: Insufficient permissions to install update"},
		{"Updating Codex via `npm install -g @openai/codex`...", "Updating Codex via `npm install -g @openai/codex`..."},
	}
	for _, tt := range tests {
		if got := cliupdate.Redact(tt.in); got != tt.want {
			t.Errorf("Redact(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// Credentials are removed before the output is cut to its tail, so a cut
// through the middle of one does not leave a fragment redact no longer
// recognizes.
func TestOutputTail_RedactsBeforeCutting(t *testing.T) {
	const url = "https://ada:hunter2hunter2@registry.example.com/"
	// One line past the cap, so its end is kept: the cut falls 20 bytes into
	// the URL, in the middle of its password.
	line := url + strings.Repeat("x", 4<<10-len(url)+20)
	got := cliupdate.OutputTail("npm error code E401\n"+line, 20)
	if strings.Contains(got, "unter2") {
		t.Errorf("tail = %q…, want none of the password", got[:min(len(got), 80)])
	}
	if !strings.HasSuffix(got, "xxxx") || len(got) > 4<<10+len("…") {
		t.Errorf("tail is %d bytes ending %q, want the line's end within 4 KiB", len(got), got[max(0, len(got)-8):])
	}
}

// A check may be running the CLI's --version when an update starts; the update
// does not run the CLI until it has finished, since it replaces the CLI's files.
func TestStartUpdate_WaitsForARunningCheck(t *testing.T) {
	s, n := newService(t, fakeCLI{role: fakeUpdates, installed: "2.1.283", next: "2.1.285", tags: map[string]string{"latest": "2.1.285"}})
	hold := filepath.Join(fakeDir(), "hold-version")
	if err := os.WriteFile(hold, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	type result struct {
		checks []cliupdate.Check
		err    error
	}
	checked := make(chan result, 1)
	go func() {
		checks, err := s.Checks(context.Background(), session.AgentTypeClaude)
		checked <- result{checks, err}
	}()
	deadline := time.Now().Add(20 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(fakeDir(), "version-held")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the check's --version never started")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if _, err := s.StartUpdate(session.AgentTypeClaude); err != nil {
		t.Fatalf("StartUpdate: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(fakeDir(), "update-ran")); err == nil {
		t.Fatal("the update ran the CLI while a check's --version was running")
	}

	if err := os.WriteFile(filepath.Join(fakeDir(), "release"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := <-checked; got.err != nil || len(got.checks) != 1 || got.checks[0].State != cliupdate.StateUpdateAvailable {
		t.Errorf("check = %+v, want one update available", got)
	}
	if got := awaitEnd(t, s, n); got.Phase != cliupdate.PhaseSucceeded {
		t.Errorf("update = %+v, want succeeded", got)
	}
}
