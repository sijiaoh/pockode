package agent

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
)

func TestLookupBinaryAcceptsAnAlreadyResolvedPath(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	got, err := lookupBinary(exe)
	if err != nil {
		t.Fatalf("lookupBinary(%q): %v", exe, err)
	}
	if got != exe {
		t.Errorf("lookupBinary rewrote a path it was handed: got %q, want %q", got, exe)
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
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

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
