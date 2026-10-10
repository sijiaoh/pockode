package cliupdate_test

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/cliupdate"
	"github.com/pockode/server/session"
)

// fakeInstalledCLI is the name the fake npm installs the CLI as, into the
// "bin" directory of the fake's directory, which the test puts on PATH.
const fakeInstalledCLI = "pockode-fake-installed-cli"

// fakeDenied is the fake npm's install failing on a prefix it cannot write.
const fakeDenied = "denied"

// runFakeNPM is the test binary standing in for npm. Its roles are the fake
// CLI's: fakeUpdates installs the CLI at the version in "next", fakeFails
// fails for a reason other than permissions, fakeNoop exits 0 without putting
// the CLI anywhere on PATH, fakeHangs never finishes.
func runFakeNPM(dir, role string, args []string) {
	if strings.Join(args, " ") == "prefix --global" {
		fmt.Println(filepath.Join(dir, "npm-global"))
		os.Exit(0)
	}
	if err := os.WriteFile(filepath.Join(dir, "npm-args"), []byte(strings.Join(args, " ")), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	switch role {
	case fakeUpdates:
		if err := installFakeCLI(dir); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("added 3 packages in 2s")
		os.Exit(0)
	case fakeDenied:
		fmt.Fprintln(os.Stderr, "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/lib/node_modules/@fake\nnpm error The operation was rejected by your operating system.")
		os.Exit(243)
	case fakeFails:
		fmt.Fprintln(os.Stderr, "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@fake%2fcli")
		os.Exit(1)
	case fakeNoop:
		fmt.Println("added 3 packages in 2s")
		os.Exit(0)
	case fakeHangs:
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	fmt.Fprintf(os.Stderr, "fake npm: unexpected role %q\n", role)
	os.Exit(2)
}

// installFakeCLI copies the test binary onto PATH as fakeInstalledCLI, keeping
// its .exe so that Windows finds it, at the version in "next".
func installFakeCLI(dir string) error {
	next, err := os.ReadFile(filepath.Join(dir, "next"))
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "version"), next, 0o600); err != nil {
		return err
	}
	src, err := os.Open(os.Args[0])
	if err != nil {
		return err
	}
	defer src.Close()
	name := fakeInstalledCLI
	if strings.EqualFold(filepath.Ext(os.Args[0]), ".exe") {
		name += ".exe"
	}
	dst, err := os.OpenFile(filepath.Join(dir, "bin", name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

// newInstallService is a Service for a CLI that is not installed: fakeInstalledCLI
// is nowhere on PATH until the fake npm puts it there.
func newInstallService(t *testing.T, f fakeCLI) (*cliupdate.Service, notified) {
	t.Helper()
	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	if err := os.Mkdir(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "next"), []byte(f.next), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv(fakeCLIDirEnv, dir)
	t.Setenv(fakeCLIRoleEnv, f.role)

	s := cliupdate.NewService(slog.Default(), sessionCount(0), f.gate)
	s.SetRegistry(fakeRegistry(t, f.tags))
	s.SetInstaller(os.Args[0])
	if f.lockDir == "" {
		f.lockDir = t.TempDir()
	}
	s.SetLockDir(f.lockDir)
	cli := cliupdate.CLI{Binary: fakeInstalledCLI, Package: fakePackage}
	if f.channel != "" {
		cli.Channel = func() string { return f.channel }
	}
	s.Register(session.AgentTypeClaude, cli)
	n := make(notified, 1)
	s.AddListener(n)
	t.Cleanup(s.Close)
	return s, n
}

func TestStartInstall(t *testing.T) {
	tests := []struct {
		name        string
		cli         fakeCLI
		wantReason  cliupdate.FailureReason
		wantTo      string
		wantDetail  []string
		shortBudget bool
	}{
		{
			name:   "installs the channel's release",
			cli:    fakeCLI{role: fakeUpdates, next: "2.1.280", tags: map[string]string{"latest": "2.1.285", "stable": "2.1.280"}, channel: "stable"},
			wantTo: "2.1.280",
		},
		{
			name:       "a global prefix npm cannot write",
			cli:        fakeCLI{role: fakeDenied, tags: map[string]string{"latest": "2.1.285"}},
			wantReason: cliupdate.FailurePermissionDenied,
			wantDetail: []string{"exited with status 243", "code EACCES", "/usr/lib/node_modules"},
		},
		{
			name:       "npm failing otherwise",
			cli:        fakeCLI{role: fakeFails, tags: map[string]string{"latest": "2.1.285"}},
			wantReason: cliupdate.FailureCommandFailed,
			wantDetail: []string{"exited with status 1", "404 Not Found"},
		},
		{
			// Installed, but where this server does not look.
			name:       "npm's bin directory not on PATH",
			cli:        fakeCLI{role: fakeNoop, tags: map[string]string{"latest": "2.1.285"}},
			wantReason: cliupdate.FailureNotOnPath,
			wantDetail: []string{"still not found", "npm-global", "not on this server's PATH"},
		},
		{
			name:        "an install that runs out of time",
			cli:         fakeCLI{role: fakeHangs, tags: map[string]string{"latest": "2.1.285"}},
			shortBudget: true,
			wantReason:  cliupdate.FailureTimeout,
			wantDetail:  []string{"install did not finish in time"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, n := newInstallService(t, tt.cli)
			if tt.shortBudget {
				s.SetUpdateTimeout(5 * time.Second)
			}
			if got := checkOne(t, s); got.State != cliupdate.StateNotInstalled {
				t.Fatalf("before: check = %+v, want not installed", got)
			}

			started, err := s.StartInstall(session.AgentTypeClaude)
			if err != nil {
				t.Fatalf("StartInstall: %v", err)
			}
			if started.Kind != cliupdate.KindInstall || started.Phase != cliupdate.PhaseRunning || started.BinaryPath != "" {
				t.Errorf("started = %+v, want a running install with no binary yet", started)
			}

			got := awaitEnd(t, s, n)
			if got.ID != started.ID || got.Kind != cliupdate.KindInstall || got.ToVersion != tt.wantTo || got.FromVersion != "" {
				t.Errorf("ended = %+v, want install %s ending at %q", got, started.ID, tt.wantTo)
			}
			if tt.wantReason == "" {
				if got.Phase != cliupdate.PhaseSucceeded || got.Failure != nil {
					t.Fatalf("ended = %+v, want succeeded", got)
				}
				if got.TargetVersion != tt.wantTo || !strings.Contains(got.BinaryPath, fakeInstalledCLI) {
					t.Errorf("ended = %+v, want target %s and the installed binary", got, tt.wantTo)
				}
				args, _ := os.ReadFile(filepath.Join(fakeDir(), "npm-args"))
				if want := "install --global --no-fund --no-audit " + fakePackage + "@" + tt.cli.channel; string(args) != want {
					t.Errorf("npm ran with %q, want %q", args, want)
				}
				// Nothing is cached: the next check finds it.
				if c := checkOne(t, s); c.State != cliupdate.StateUpToDate || c.Version != tt.wantTo {
					t.Errorf("after: check = %+v, want up to date at %s", c, tt.wantTo)
				}
				if _, err := s.StartInstall(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrAlreadyInstalled) {
					t.Errorf("second StartInstall: got %v, want ErrAlreadyInstalled", err)
				}
				return
			}
			if got.Phase != cliupdate.PhaseFailed || got.Failure == nil || got.Failure.Reason != tt.wantReason {
				t.Fatalf("ended = %+v, want failed as %s", got, tt.wantReason)
			}
			for _, want := range tt.wantDetail {
				if !strings.Contains(got.Failure.Detail, want) {
					t.Errorf("detail = %q, want it to contain %q", got.Failure.Detail, want)
				}
			}
		})
	}
}

// A refused install leaves no record, so a client has nothing to dismiss.
func TestStartInstall_Refused(t *testing.T) {
	t.Run("already installed", func(t *testing.T) {
		s, _ := newService(t, fakeCLI{installed: "2.1.283"})
		_, err := s.StartInstall(session.AgentTypeClaude)
		if !errors.Is(err, cliupdate.ErrAlreadyInstalled) || !strings.Contains(err.Error(), os.Args[0]) {
			t.Errorf("got %v, want ErrAlreadyInstalled naming where", err)
		}
		if u, _ := s.Update(session.AgentTypeClaude); u != nil {
			t.Errorf("refused install left %+v", u)
		}
	})

	t.Run("no npm", func(t *testing.T) {
		s, _ := newInstallService(t, fakeCLI{role: fakeUpdates})
		s.SetInstaller("pockode-no-such-npm")
		if _, err := s.StartInstall(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrInstallerNotFound) || !strings.Contains(err.Error(), "Node.js") {
			t.Errorf("got %v, want ErrInstallerNotFound", err)
		}
		if u, _ := s.Update(session.AgentTypeClaude); u != nil {
			t.Errorf("refused install left %+v", u)
		}
	})

	t.Run("unknown agent", func(t *testing.T) {
		s, _ := newInstallService(t, fakeCLI{role: fakeUpdates})
		if _, err := s.StartInstall("gemini"); !errors.Is(err, cliupdate.ErrUnknownAgent) {
			t.Errorf("got %v, want ErrUnknownAgent", err)
		}
	})

	t.Run("a sign-in running", func(t *testing.T) {
		refusal := errors.New("a sign-in to claude is in progress")
		s, _ := newInstallService(t, fakeCLI{role: fakeUpdates, gate: &gate{err: refusal}})
		if _, err := s.StartInstall(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrBusy) || !errors.Is(err, refusal) {
			t.Errorf("got %v, want ErrBusy with the gate's refusal", err)
		}
	})

	t.Run("another Pockode installing", func(t *testing.T) {
		lockDir := t.TempDir()
		first, _ := newInstallService(t, fakeCLI{role: fakeHangs, lockDir: lockDir})
		second, _ := newInstallService(t, fakeCLI{role: fakeHangs, lockDir: lockDir})
		if _, err := first.StartInstall(session.AgentTypeClaude); err != nil {
			t.Fatalf("first StartInstall: %v", err)
		}
		if _, err := second.StartInstall(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrBusy) || !errors.Is(err, cliupdate.ErrUpdatingElsewhere) {
			t.Errorf("second StartInstall: got %v, want ErrBusy, elsewhere", err)
		}
	})
}

// One update or install per CLI: a second Install joins the first, a check
// says it is being installed, and an Update is refused until it ends.
func TestStartInstall_WhileRunning(t *testing.T) {
	s, _ := newInstallService(t, fakeCLI{role: fakeHangs, tags: map[string]string{"latest": "2.1.285"}})

	first, err := s.StartInstall(session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("StartInstall: %v", err)
	}
	second, err := s.StartInstall(session.AgentTypeClaude)
	if err != nil || second.ID != first.ID {
		t.Errorf("second StartInstall = %+v, %v; want the running %s", second, err, first.ID)
	}
	if got := checkOne(t, s); got.State != cliupdate.StateInstalling || got.UpdateID != first.ID {
		t.Errorf("check = %+v, want installing %s", got, first.ID)
	}
	if _, err := s.StartUpdate(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrBusy) {
		t.Errorf("StartUpdate: got %v, want ErrBusy", err)
	}
}

func TestStartInstall_WhileUpdating(t *testing.T) {
	s, _ := newService(t, fakeCLI{role: fakeHangs, installed: "2.1.283", tags: map[string]string{"latest": "2.1.285"}})
	if _, err := s.StartUpdate(session.AgentTypeClaude); err != nil {
		t.Fatalf("StartUpdate: %v", err)
	}
	if _, err := s.StartInstall(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrBusy) {
		t.Errorf("StartInstall: got %v, want ErrBusy", err)
	}
}
