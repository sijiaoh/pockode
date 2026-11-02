package cliupdate_test

import (
	"errors"
	"fmt"
	"io"
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

// fakeInstalledCLI is the name the fake installer installs the CLI as, into
// the "bin" directory of the fake's directory, which the test puts on PATH.
const fakeInstalledCLI = "pockode-fake-installed-cli"

// fakeShellFlag is the first argument of the fake shell, the test binary
// standing in for bash, sh or PowerShell: the flags a real shell is given
// before the script's path.
const fakeShellFlag = "--fake-shell"

// fakeScript is what the fake download server serves as the install script.
const fakeScript = "#!/bin/sh\necho fake installer\n"

// fakeInstallerEnv is the variable the fake installer's Script sets, the way
// Codex's sets CODEX_NON_INTERACTIVE.
const fakeInstallerEnv = "POCKODE_FAKE_INSTALLER_UNATTENDED"

// runFakeInstaller is the fake shell running the downloaded script, args[0],
// with the script's arguments after it. It records what it was given, then
// plays the fake CLI's role: fakeUpdates installs the CLI at the version in
// "next", fakeFails exits 1, fakeNoop exits 0 without putting the CLI anywhere
// it is looked for, fakeHangs never finishes.
func runFakeInstaller(dir, role string, args []string) {
	script, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Stdin is closed: a script that asked would read EOF, not wait.
	stdin, err := io.ReadAll(os.Stdin)
	record := fmt.Sprintf("script=%s|args=%s|env=%s|stdin=%q,%v",
		script, strings.Join(args[1:], " "), os.Getenv(fakeInstallerEnv), stdin, err)
	if err := os.WriteFile(filepath.Join(dir, "installer-ran"), []byte(record), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	switch role {
	case fakeUpdates:
		if err := installFakeCLI(dir); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("Installation complete!")
		os.Exit(0)
	case fakeFails:
		fmt.Println("==> Downloading Codex CLI")
		fmt.Fprintln(os.Stderr, "tar is required to install Codex.")
		os.Exit(1)
	case fakeNoop:
		fmt.Println("==> Installed to /elsewhere/bin")
		os.Exit(0)
	case fakeHangs:
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	fmt.Fprintf(os.Stderr, "fake installer: unexpected role %q\n", role)
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

// fakeDownloads serves fakeScript at /install.sh and /install.ps1, and
// nothing else.
func fakeDownloads(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/install.sh" && r.URL.Path != "/install.ps1" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, fakeScript)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// fakeInstallScript is a Script run by the fake shell, downloaded from
// fakeDownloads, taking the channel as its argument.
func fakeInstallScript(t *testing.T) cliupdate.Script {
	return cliupdate.Script{
		URL:   fakeDownloads(t) + "/install.sh",
		Shell: []string{os.Args[0], fakeShellFlag},
		Args:  func(channel string) []string { return []string{"--channel", channel} },
		Env:   []string{fakeInstallerEnv + "=1"},
	}
}

// newInstallService is a Service for a CLI that is not installed:
// fakeInstalledCLI is nowhere on PATH until the fake installer puts it there.
// script, when not nil, changes the fake Script.
func newInstallService(t *testing.T, f fakeCLI, script func(*cliupdate.Script)) (*cliupdate.Service, notified) {
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
	if f.lockDir == "" {
		f.lockDir = t.TempDir()
	}
	s.SetLockDir(f.lockDir)
	sc := fakeInstallScript(t)
	if script != nil {
		script(&sc)
	}
	cli := cliupdate.CLI{
		Binary:    fakeInstalledCLI,
		Package:   fakePackage,
		Installer: cliupdate.Installer{Unix: sc, Windows: sc},
	}
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
		script      func(*cliupdate.Script)
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
			name:       "a script that cannot be downloaded",
			cli:        fakeCLI{role: fakeUpdates, tags: map[string]string{"latest": "2.1.285"}},
			script:     func(sc *cliupdate.Script) { sc.URL = strings.TrimSuffix(sc.URL, "install.sh") + "missing.sh" },
			wantReason: cliupdate.FailureDownloadFailed,
			wantDetail: []string{"could not download", "missing.sh", "404"},
		},
		{
			name:       "a script that fails",
			cli:        fakeCLI{role: fakeFails, tags: map[string]string{"latest": "2.1.285"}},
			wantReason: cliupdate.FailureCommandFailed,
			wantDetail: []string{"install.sh", "exited with status 1", "tar is required"},
		},
		{
			// Installed, but where this server does not look.
			name:       "installed off PATH",
			cli:        fakeCLI{role: fakeNoop, tags: map[string]string{"latest": "2.1.285"}},
			wantReason: cliupdate.FailureNotOnPath,
			wantDetail: []string{"still not found", "restart pockode", "Installed to /elsewhere/bin"},
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
			s, n := newInstallService(t, tt.cli, tt.script)
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
				ran, _ := os.ReadFile(filepath.Join(fakeDir(), "installer-ran"))
				if want := fmt.Sprintf("script=%s|args=--channel %s|env=1|stdin=\"\",<nil>", fakeScript, tt.cli.channel); string(ran) != want {
					t.Errorf("installer ran as %q, want %q", ran, want)
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

	for _, tt := range []struct {
		name   string
		script func(*cliupdate.Script)
		want   string
	}{
		{"no shell", func(sc *cliupdate.Script) { sc.Shell = []string{"pockode-no-such-shell"} }, "runs with pockode-no-such-shell"},
		{"no downloader", func(sc *cliupdate.Script) { sc.Downloaders = []string{"pockode-no-curl", "pockode-no-wget"} }, "pockode-no-curl or pockode-no-wget"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s, _ := newInstallService(t, fakeCLI{role: fakeUpdates}, tt.script)
			_, err := s.StartInstall(session.AgentTypeClaude)
			if !errors.Is(err, cliupdate.ErrInstallerToolNotFound) || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("got %v, want ErrInstallerToolNotFound naming %q", err, tt.want)
			}
			if u, _ := s.Update(session.AgentTypeClaude); u != nil {
				t.Errorf("refused install left %+v", u)
			}
		})
	}

	t.Run("unknown agent", func(t *testing.T) {
		s, _ := newInstallService(t, fakeCLI{role: fakeUpdates}, nil)
		if _, err := s.StartInstall("gemini"); !errors.Is(err, cliupdate.ErrUnknownAgent) {
			t.Errorf("got %v, want ErrUnknownAgent", err)
		}
	})

	t.Run("a sign-in running", func(t *testing.T) {
		refusal := errors.New("a sign-in to claude is in progress")
		s, _ := newInstallService(t, fakeCLI{role: fakeUpdates, gate: &gate{err: refusal}}, nil)
		if _, err := s.StartInstall(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrBusy) || !errors.Is(err, refusal) {
			t.Errorf("got %v, want ErrBusy with the gate's refusal", err)
		}
	})

	t.Run("another Pockode installing", func(t *testing.T) {
		lockDir := t.TempDir()
		first, _ := newInstallService(t, fakeCLI{role: fakeHangs, lockDir: lockDir}, nil)
		second, _ := newInstallService(t, fakeCLI{role: fakeHangs, lockDir: lockDir}, nil)
		if _, err := first.StartInstall(session.AgentTypeClaude); err != nil {
			t.Fatalf("first StartInstall: %v", err)
		}
		if _, err := second.StartInstall(session.AgentTypeClaude); !errors.Is(err, cliupdate.ErrBusy) || !errors.Is(err, cliupdate.ErrUpdatingElsewhere) {
			t.Errorf("second StartInstall: got %v, want ErrBusy, elsewhere", err)
		}
	})
}

func TestStartInstall_OneDownloaderIsEnough(t *testing.T) {
	s, n := newInstallService(t, fakeCLI{role: fakeUpdates, next: "2.1.285"}, func(sc *cliupdate.Script) {
		sc.Downloaders = []string{"pockode-no-curl", os.Args[0]}
	})
	if _, err := s.StartInstall(session.AgentTypeClaude); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}
	if got := awaitEnd(t, s, n); got.Phase != cliupdate.PhaseSucceeded {
		t.Errorf("ended = %+v, want succeeded", got)
	}
}

// Windows PowerShell 5.1 reads a .ps1 without a BOM in the ANSI code page.
func TestStartInstall_PowerShellScriptGetsBOM(t *testing.T) {
	s, n := newInstallService(t, fakeCLI{role: fakeUpdates, next: "2.1.285"}, func(sc *cliupdate.Script) {
		sc.URL = strings.TrimSuffix(sc.URL, ".sh") + ".ps1"
	})
	if _, err := s.StartInstall(session.AgentTypeClaude); err != nil {
		t.Fatalf("StartInstall: %v", err)
	}
	if got := awaitEnd(t, s, n); got.Phase != cliupdate.PhaseSucceeded {
		t.Fatalf("ended = %+v, want succeeded", got)
	}
	ran, _ := os.ReadFile(filepath.Join(fakeDir(), "installer-ran"))
	if want := "script=\uFEFF" + fakeScript; !strings.HasPrefix(string(ran), want) {
		t.Errorf("installer ran as %q, want the script after a BOM", ran)
	}
}

// A redirect is followed, but never from HTTPS to anything else: the script
// runs as the server's user.
func TestCheckScriptRedirect(t *testing.T) {
	tests := []struct {
		from, to string
		hops     int
		wantErr  bool
	}{
		{"https://claude.ai/install.sh", "https://downloads.claude.ai/bootstrap.sh", 1, false},
		{"https://claude.ai/install.sh", "http://downloads.claude.ai/bootstrap.sh", 1, true},
		{"https://claude.ai/install.sh", "https://downloads.claude.ai/bootstrap.sh", 10, true},
		// A test's plain HTTP server.
		{"http://127.0.0.1/install.sh", "http://127.0.0.1/moved.sh", 1, false},
	}
	for _, tt := range tests {
		from, _ := http.NewRequest(http.MethodGet, tt.from, nil)
		to, _ := http.NewRequest(http.MethodGet, tt.to, nil)
		via := make([]*http.Request, tt.hops)
		for i := range via {
			via[i] = from
		}
		if err := cliupdate.CheckScriptRedirect(to, via); (err != nil) != tt.wantErr {
			t.Errorf("%s -> %s after %d: err = %v, want error %v", tt.from, tt.to, tt.hops, err, tt.wantErr)
		}
	}
}

// One update or install per CLI: a second Install joins the first, a check
// says it is being installed, and an Update is refused until it ends.
func TestStartInstall_WhileRunning(t *testing.T) {
	s, _ := newInstallService(t, fakeCLI{role: fakeHangs, tags: map[string]string{"latest": "2.1.285"}}, nil)

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
