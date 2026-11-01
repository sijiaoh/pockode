package restart

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/internal/symlinktest"
	"github.com/pockode/server/password"
)

const (
	// helperEnv selects what the test binary does when it is run as a child
	// rather than as the test suite.
	helperEnv = "POCKODE_TEST_RESTART_HELPER"
	// helperVersion prints a version for --version, as pockode does.
	helperVersion = "version"
	// helperVersionFails fails --version with something on stderr.
	helperVersionFails = "version-fails"
	// helperVersionGarbage answers --version with something that is not one.
	helperVersionGarbage = "version-garbage"
	// helperRestarts reports itself, restarts, and reports itself again from
	// the restarted process (see runRestartHelper).
	helperRestarts = "restarts"
	// helperRestartFails asks for a restart whose final step cannot work.
	helperRestartFails = "restart-fails"

	// helperReportDirEnv is where helperRestarts writes its reports.
	helperReportDirEnv = "POCKODE_TEST_RESTART_REPORT_DIR"

	helperVersionOutput = "1.2.3-test"
)

func TestMain(m *testing.M) {
	mode := os.Getenv(helperEnv)
	if mode == "" {
		os.Exit(m.Run())
	}
	if slices.Contains(os.Args[1:], "--version") {
		switch mode {
		case helperVersionFails:
			fmt.Fprintln(os.Stderr, "boom")
			os.Exit(3)
		case helperVersionGarbage:
			fmt.Println("hello")
		default:
			fmt.Println(versionPrefix + helperVersionOutput)
		}
		os.Exit(0)
	}
	switch mode {
	case helperRestarts:
		runRestartHelper()
	case helperRestartFails:
		r := New(Program{Path: filepath.Join(os.TempDir(), "pockode-does-not-exist"), argv0: os.Args[0], Dir: "."})
		r.Restart("secret")
	}
	os.Exit(0)
}

// report is what one generation of helperRestarts saw of itself.
type report struct {
	PID         int      `json:"pid"`
	Dir         string   `json:"dir"`
	Args        []string `json:"args"`
	Password    string   `json:"password"`
	HasPassword bool     `json:"has_password"`
	HasLegacy   bool     `json:"has_legacy"`
}

func writeReport(path string) {
	dir, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	pw, hasPassword := os.LookupEnv(password.EnvVar)
	_, hasLegacy := os.LookupEnv(password.LegacyEnvVar)
	data, err := json.Marshal(report{
		PID:         os.Getpid(),
		Dir:         dir,
		Args:        os.Args[1:],
		Password:    pw,
		HasPassword: hasPassword,
		HasLegacy:   hasLegacy,
	})
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		panic(err)
	}
}

// runRestartHelper is both generations: the first reports and restarts, and
// the process that replaces it finds the first report there and writes the
// second.
func runRestartHelper() {
	reportDir := os.Getenv(helperReportDirEnv)
	first := filepath.Join(reportDir, "first.json")
	if _, err := os.Stat(first); err == nil {
		writeReport(filepath.Join(reportDir, "second.json"))
		return
	}

	writeReport(first)
	program, err := Current()
	if err != nil {
		panic(err)
	}
	r := New(program)
	if err := r.Request(context.Background()); err != nil {
		panic(err)
	}
	if !r.Pending() {
		panic("an accepted request is not pending")
	}
	r.Restart("the-password")
}

func readReport(t *testing.T, path string) report {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var r report
	if err := json.Unmarshal(data, &r); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return r
}

// TestRestart is the whole round trip in real processes: the program that
// comes back has the arguments and the working directory it started with, the
// password arrives through the environment — never argv, even when the first
// run had it there — and the deprecated variable is not handed on beside it.
func TestRestart(t *testing.T) {
	reportDir := t.TempDir()
	workDir := t.TempDir()
	// The password on the command line too: it must come back through the
	// environment alone.
	args := []string{"-test.run=^$", "an argument with spaces", "-password", "the-password", "--flag=value"}
	wantArgs := []string{"-test.run=^$", "an argument with spaces", "-password=", "--flag=value"}

	cmd := exec.Command(os.Args[0], args...)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(),
		helperEnv+"="+helperRestarts,
		helperReportDirEnv+"="+reportDir,
		password.LegacyEnvVar+"=stale",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper failed: %v\n%s", err, out)
	}

	// On Windows the first generation exits as soon as its successor is up
	// (its standard input is not a console), so the second may still be on its
	// way.
	secondPath := filepath.Join(reportDir, "second.json")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(secondPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the restarted process never reported; helper output:\n%s", out)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// The file is written in one call, but it may be caught between create
	// and write.
	var second report
	for {
		data, err := os.ReadFile(secondPath)
		if err == nil && json.Unmarshal(data, &second) == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the restarted process's report is unreadable: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	first := readReport(t, filepath.Join(reportDir, "first.json"))
	if !slices.Equal(first.Args, args) {
		t.Fatalf("helper started with args %q, want %q", first.Args, args)
	}
	if !slices.Equal(second.Args, wantArgs) {
		t.Errorf("restarted with args %q, want %q", second.Args, wantArgs)
	}
	if !sameDir(t, second.Dir, workDir) {
		t.Errorf("restarted in %s, want %s", second.Dir, workDir)
	}
	if !second.HasPassword || second.Password != "the-password" {
		t.Errorf("restarted with %s=%q (set: %v), want the password", password.EnvVar, second.Password, second.HasPassword)
	}
	if second.HasLegacy {
		t.Errorf("restarted with %s still set", password.LegacyEnvVar)
	}
	for _, arg := range second.Args {
		if strings.Contains(arg, "the-password") {
			t.Errorf("the password reached argv: %q", arg)
		}
	}
	if KeepsPID && second.PID != first.PID {
		t.Errorf("restarted as PID %d, want %d: a restart must keep the PID here", second.PID, first.PID)
	}
}

func sameDir(t *testing.T, a, b string) bool {
	t.Helper()
	ai, err := os.Stat(a)
	if err != nil {
		t.Fatalf("stat %s: %v", a, err)
	}
	bi, err := os.Stat(b)
	if err != nil {
		t.Fatalf("stat %s: %v", b, err)
	}
	return os.SameFile(ai, bi)
}

// TestRestart_FailureExits pins down the last resort: a restart that fails
// once the process has shut down must end it, non-zero, rather than leave it
// running with nothing in it.
func TestRestart_FailureExits(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), helperEnv+"="+helperRestartFails)
	out, err := cmd.CombinedOutput()

	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("helper ended with %v, want exit status 1\n%s", err, out)
	}
	if !strings.Contains(string(out), "restart failed") {
		t.Errorf("the failure was not reported:\n%s", out)
	}
}

func helperProgram(t *testing.T, mode string) Program {
	t.Helper()
	// The child inherits the environment, which is how it knows what to be.
	t.Setenv(helperEnv, mode)
	return Program{Path: os.Args[0], Dir: t.TempDir()}
}

func TestVersion(t *testing.T) {
	t.Run("reports the installed version", func(t *testing.T) {
		got, err := helperProgram(t, helperVersion).Version(context.Background())
		if err != nil {
			t.Fatalf("Version() = %v", err)
		}
		if got != helperVersionOutput {
			t.Errorf("Version() = %q, want %q", got, helperVersionOutput)
		}
	})

	tests := []struct {
		name    string
		program func(t *testing.T) Program
		want    string
	}{
		{"a failing run carries its stderr", func(t *testing.T) Program { return helperProgram(t, helperVersionFails) }, "boom"},
		{"output that is not a version", func(t *testing.T) Program { return helperProgram(t, helperVersionGarbage) }, "not a pockode version"},
		{"a file that is not there", func(t *testing.T) Program {
			return Program{Path: filepath.Join(t.TempDir(), "pockode")}
		}, "--version"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.program(t).Version(context.Background())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Version() = %v, want an error mentioning %q", err, tc.want)
			}
		})
	}
}

func TestRestarter_RefusesWhatCannotRun(t *testing.T) {
	r := New(helperProgram(t, helperVersionFails))

	var notRunnable *NotRunnableError
	if err := r.Request(context.Background()); !errors.As(err, &notRunnable) || !strings.Contains(notRunnable.Err.Error(), "boom") {
		t.Fatalf("Request() = %v, want a NotRunnableError carrying the run's stderr", err)
	}
	select {
	case <-r.Requested():
		t.Fatal("a refused request was reported as accepted")
	default:
	}
	if r.Pending() {
		t.Error("Pending() = true for a refused request")
	}
}

func TestRestarter_AcceptsOnce(t *testing.T) {
	r := New(helperProgram(t, helperVersion))

	if err := r.Request(context.Background()); err != nil {
		t.Fatalf("Request() = %v", err)
	}
	select {
	case <-r.Requested():
	default:
		t.Fatal("Requested not closed after an accepted request")
	}
	if err := r.Request(context.Background()); !errors.Is(err, ErrAlreadyRestarting) {
		t.Errorf("second Request() = %v, want ErrAlreadyRestarting", err)
	}
	if !r.Pending() {
		t.Error("Pending() = false after an accepted request")
	}
}

// A held request is accepted at once — it is pending and refuses the next —
// but the shutdown it starts waits for its release.
func TestRestarter_RequestHeld(t *testing.T) {
	r := New(helperProgram(t, helperVersion))

	release, err := r.RequestHeld(context.Background())
	if err != nil {
		t.Fatalf("RequestHeld() = %v", err)
	}
	if !r.Pending() {
		t.Error("Pending() = false for a held request")
	}
	if err := r.Request(context.Background()); !errors.Is(err, ErrAlreadyRestarting) {
		t.Errorf("Request() while held = %v, want ErrAlreadyRestarting", err)
	}
	select {
	case <-r.Requested():
		t.Fatal("Requested closed before the hold was released")
	default:
	}

	release()
	release()
	select {
	case <-r.Requested():
	default:
		t.Fatal("Requested not closed after the hold was released")
	}
}

// An exit request taken by the shutdown loop decides how the shutdown ends,
// even when a restart's probe finished while it was being taken.
func TestRestarter_ExitOverrulesAcceptedRequest(t *testing.T) {
	r := New(helperProgram(t, helperVersion))

	if err := r.Request(context.Background()); err != nil {
		t.Fatalf("Request() = %v", err)
	}
	r.Close()
	if r.Pending() {
		t.Error("Pending() = true after Close: the exit request was overruled")
	}
}

// An exit request that got there first settles it: the process is going down,
// and a restart asked for during that shutdown would turn an exit into a
// restart nobody wanted.
func TestRestarter_RefusesAfterClose(t *testing.T) {
	r := New(helperProgram(t, helperVersion))

	r.Close()
	if err := r.Request(context.Background()); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("Request() after Close = %v, want ErrShuttingDown", err)
	}
}

func TestResolvePath(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "pockode.exe")
	other := filepath.Join(dir, "other.exe")
	for _, p := range []string{exe, other} {
		if err := os.WriteFile(p, []byte("x"), 0755); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("absolute invocation of the running file", func(t *testing.T) {
		if got := resolvePath(exe, exe); got != exe {
			t.Errorf("resolvePath = %q, want %q", got, exe)
		}
	})
	t.Run("relative invocation is made absolute", func(t *testing.T) {
		t.Chdir(dir)
		if got := resolvePath(filepath.Join(".", "pockode.exe"), exe); !sameFileAt(t, got, exe) || !filepath.IsAbs(got) {
			t.Errorf("resolvePath = %q, want %q", got, exe)
		}
	})
	t.Run("bare name is looked up in PATH", func(t *testing.T) {
		t.Setenv("PATH", dir)
		if got := resolvePath("pockode.exe", exe); !sameFileAt(t, got, exe) || !filepath.IsAbs(got) {
			t.Errorf("resolvePath = %q, want %q", got, exe)
		}
	})
	t.Run("an argv[0] naming another file is not trusted", func(t *testing.T) {
		if got := resolvePath(other, exe); got != exe {
			t.Errorf("resolvePath = %q, want %q", got, exe)
		}
	})
	t.Run("an argv[0] naming nothing falls back", func(t *testing.T) {
		if got := resolvePath(filepath.Join(dir, "missing"), exe); got != exe {
			t.Errorf("resolvePath = %q, want %q", got, exe)
		}
	})
	// The link is what an upgrade moves; the file it points at is what it
	// removes. Resolving through it would restart into a deleted directory.
	t.Run("a symlink invocation is kept", func(t *testing.T) {
		link := filepath.Join(dir, "link.exe")
		symlinktest.Make(t, exe, link)
		if got := resolvePath(link, exe); got != link {
			t.Errorf("resolvePath = %q, want the link %q", got, link)
		}
	})
}

func sameFileAt(t *testing.T, a, b string) bool {
	t.Helper()
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	if err != nil {
		t.Fatal(err)
	}
	return os.SameFile(ai, bi)
}

// Restart enters the working directory first, past the point of carrying on,
// so a directory removed since startup has to be refused here instead.
func TestRestarter_RefusesAMissingWorkingDirectory(t *testing.T) {
	program := helperProgram(t, helperVersion)
	program.Dir = filepath.Join(t.TempDir(), "removed")
	r := New(program)

	var notRunnable *NotRunnableError
	if err := r.Request(context.Background()); !errors.As(err, &notRunnable) || !strings.Contains(err.Error(), program.Dir) {
		t.Fatalf("Request() = %v, want a NotRunnableError naming the directory", err)
	}
	if r.Pending() {
		t.Error("a refused request is pending")
	}
}

// A probe its caller gave up on says nothing about the file, so it must not
// read as one that hung.
func TestVersion_CancelledIsNotATimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := helperProgram(t, helperVersion).Version(ctx)
	if !errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "did not answer") {
		t.Errorf("Version() = %v, want the cancellation, not a timeout", err)
	}
}
