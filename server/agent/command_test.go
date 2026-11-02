package agent

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// registerTestInstallDir declares dir as name's installer directory for one
// test. RegisterInstallDir itself refuses a second registration, which a test
// run with -count would trip.
func registerTestInstallDir(t *testing.T, name, dir string) {
	t.Helper()
	installDirs[name] = func() string { return dir }
	t.Cleanup(func() { delete(installDirs, name) })
}

// writeFakeCLI puts a CLI called name in dir and returns its path. It is a copy
// of the test binary, so it can be run in any of the roles TestMain plays.
func writeFakeCLI(t *testing.T, dir, name string) string {
	t.Helper()
	exe, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatalf("read test binary: %v", err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("create %s: %v", dir, err)
	}
	path := filepath.Join(dir, name+exeSuffix)
	if err := os.WriteFile(path, exe, 0755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

// TestLookupBinaryPrefersPath pins that the user's PATH wins over the
// installer directory, and that a CLI found on PATH runs in the environment it
// was given, untouched.
func TestLookupBinaryPrefersPath(t *testing.T) {
	const name = "pockode-fake-cli"
	onPath := filepath.Join(t.TempDir(), "on-path")
	installed := filepath.Join(t.TempDir(), "installer")
	want := writeFakeCLI(t, onPath, name)
	writeFakeCLI(t, installed, name)
	registerTestInstallDir(t, name, installed)
	t.Setenv("PATH", onPath)

	got, err := lookupBinary(name)
	if err != nil {
		t.Fatalf("lookupBinary: %v", err)
	}
	if got.Path != want || got.OffPath != "" {
		t.Errorf("lookupBinary = %+v, want %q found on PATH", got, want)
	}

	cmd, err := Command(name)
	if err != nil {
		t.Fatalf("Command: %v", err)
	}
	if cmd.Env != nil {
		t.Errorf("a CLI found on PATH should inherit the environment as is, got Env %q", cmd.Env)
	}
}

// TestLookupBinaryFallsBackToInstallDir covers what the installer directory is
// for: the CLI is installed, but its directory is not on the PATH this process
// has. The CLI then gets that directory at the end of its PATH, so what it runs
// finds it too, without anything already on PATH being shadowed.
func TestLookupBinaryFallsBackToInstallDir(t *testing.T) {
	const name = "pockode-fake-cli"
	onPath := t.TempDir()
	installed := filepath.Join(t.TempDir(), "installer")
	want := writeFakeCLI(t, installed, name)
	registerTestInstallDir(t, name, installed)
	t.Setenv("PATH", onPath)

	got, err := lookupBinary(name)
	if err != nil {
		t.Fatalf("lookupBinary did not fall back to the installer directory: %v", err)
	}
	if got.Path != want || got.OffPath != installed {
		t.Errorf("lookupBinary = %+v, want %q found off PATH in %q", got, want, installed)
	}

	// What the CLI actually receives, through the path that adds variables of
	// its own: those must go on top of this PATH, not replace it.
	t.Setenv(roleEnv, rolePath)
	proc, err := StartProcessEnv(context.Background(), discardLog(), name, nil, "", []string{"POCKODE_TEST_EXTRA=1"})
	if err != nil {
		t.Fatalf("starting the CLI found off PATH: %v", err)
	}
	_ = proc.Stdin.Close()
	out, err := io.ReadAll(proc.Stdout)
	if err != nil {
		t.Fatalf("read the CLI's output: %v", err)
	}
	if err := proc.Wait(); err != nil {
		t.Fatalf("the CLI failed: %v", err)
	}
	proc.OutputDone()
	wantOut := onPath + string(os.PathListSeparator) + installed + "\n1"
	if got := strings.ReplaceAll(strings.TrimSpace(string(out)), "\r\n", "\n"); got != wantOut {
		t.Errorf("the CLI ran with PATH and extra variable %q, want %q", got, wantOut)
	}
}

// TestLookupBinaryMissingNamesInstallDir pins that a CLI found in neither place
// says both: PATH, and the installer directory it was also looked for in.
func TestLookupBinaryMissingNamesInstallDir(t *testing.T) {
	const name = "pockode-fake-cli"
	installed := filepath.Join(t.TempDir(), "installer")
	registerTestInstallDir(t, name, installed)
	t.Setenv("PATH", t.TempDir())

	_, err := lookupBinary(name)
	var notFound *BinaryNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("expected a *BinaryNotFoundError, got %v", err)
	}
	if !slices.Contains(notFound.Dirs, installed) {
		t.Errorf("searched directories %q do not include the installer directory %q", notFound.Dirs, installed)
	}
	for _, want := range []string{"PATH", installed} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error message is missing %q:\n%s", want, err)
		}
	}
}

func TestAppendToPath(t *testing.T) {
	sep := string(os.PathListSeparator)
	for _, tc := range []struct {
		name string
		env  []string
		want []string
	}{
		{"appends to the end", []string{"HOME=/h", "PATH=/a" + sep + "/b"}, []string{"HOME=/h", "PATH=/a" + sep + "/b" + sep + "/x"}},
		{"empty PATH", []string{"PATH="}, []string{"PATH=/x"}},
		{"no PATH", []string{"HOME=/h"}, []string{"HOME=/h", "PATH=/x"}},
		// exec passes the last of a repeated key on, so that is the one to extend.
		{"repeated PATH", []string{"PATH=/a", "PATH=/b"}, []string{"PATH=/a", "PATH=/b" + sep + "/x"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := slices.Clone(tc.env)
			if got := appendToPath(env, "/x"); !slices.Equal(got, tc.want) {
				t.Errorf("appendToPath(%q) = %q, want %q", tc.env, got, tc.want)
			}
			if !slices.Equal(env, tc.env) {
				t.Errorf("appendToPath modified its input: %q", env)
			}
		})
	}
}

func TestLookupBinaryAcceptsAnAlreadyResolvedPath(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	got, err := lookupBinary(exe)
	if err != nil {
		t.Fatalf("lookupBinary(%q): %v", exe, err)
	}
	if got.Path != exe || got.OffPath != "" {
		t.Errorf("lookupBinary rewrote a path it was handed: got %+v, want %q", got, exe)
	}
}

// TestLookupBinaryMissingIsActionable pins the error the user actually reads.
// The bare exec error it replaces names neither the CLI nor anything to do
// about it, which is the whole complaint this lookup exists to answer.
func TestLookupBinaryMissingIsActionable(t *testing.T) {
	_, err := lookupBinary("pockode-no-such-binary")
	if err == nil {
		t.Fatal("expected an error for a binary that is not installed")
	}

	var notFound *BinaryNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("expected a *BinaryNotFoundError, got %T", err)
	}
	if notFound.Name != "pockode-no-such-binary" {
		t.Errorf("error does not carry the name that was looked up: %q", notFound.Name)
	}

	msg := err.Error()
	for _, want := range []string{"pockode-no-such-binary", "PATH", "restart pockode"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error message is missing %q:\n%s", want, msg)
		}
	}

	// Anywhere the lookup searched beyond PATH has to be named, or "not found"
	// is unfalsifiable from the user's side.
	for _, dir := range fallbackBinaryDirs() {
		if !strings.Contains(msg, dir) {
			t.Errorf("error message does not name the searched directory %q:\n%s", dir, msg)
		}
	}
}

// TestCheckBinariesReportsEveryName pins that the startup check hands back a
// status per CLI, in order: the banner is built from it, and a CLI silently
// dropped from that list reads to the user as one that is fine.
func TestCheckBinariesReportsEveryName(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	log := discardLog()

	got := CheckBinaries(log, exe, "pockode-no-such-binary")
	if len(got) != 2 {
		t.Fatalf("got %d statuses, want 2: %+v", len(got), got)
	}

	if got[0].Name != exe || !got[0].Found() {
		t.Errorf("an installed CLI was reported as %+v", got[0])
	}

	if got[1].Name != "pockode-no-such-binary" {
		t.Errorf("status carries name %q, want the name that was looked up", got[1].Name)
	}
	var notFound *BinaryNotFoundError
	if got[1].Found() || !errors.As(got[1].Err, &notFound) {
		t.Errorf("a missing CLI was reported as %+v", got[1])
	}
}

// TestCommandPassesArgumentsThrough covers the plain-executable path on every
// platform. On Windows that is the native claude.exe case, which os/exec quotes
// correctly on its own — the point is that going through Command did not break
// it while making the .cmd case work.
func TestCommandPassesArgumentsThrough(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	t.Setenv(roleEnv, roleArgv)

	args := []string{
		"--mcp-config", `C:\a&b ^c (d) !e\.pockode\mcp-config.json`,
		"--add-dir", `C:\a&b ^c (d) !e\`,
	}
	cmd, err := Command(exe, args...)
	if err != nil {
		t.Fatalf("Command: %v", err)
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("running the argv role: %v", err)
	}
	assertArgvLines(t, string(out), args)
}

func assertArgvLines(t *testing.T, out string, want []string) {
	t.Helper()
	got := strings.Split(strings.ReplaceAll(strings.TrimSpace(out), "\r\n", "\n"), "\n")
	if len(got) != len(want) {
		t.Fatalf("the command line was split into %d arguments, want %d\ngot:  %q\nwant: %q", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("argument %d arrived as %q, want %q", i, got[i], want[i])
		}
	}
}

// TestLookupBinarySkipsRelativeInstallDir pins that an installer directory
// that is not absolute is not searched: the path found there would be resolved
// against the CLI's working directory when it runs, not where it was found.
func TestLookupBinarySkipsRelativeInstallDir(t *testing.T) {
	const name = "pockode-fake-cli"
	registerTestInstallDir(t, name, "relative-bin")
	if dirs := binarySearchDirs(name); slices.Contains(dirs, "relative-bin") {
		t.Errorf("binarySearchDirs = %q, want the relative directory left out", dirs)
	}
}
