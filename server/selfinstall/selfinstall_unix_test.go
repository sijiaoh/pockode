//go:build !windows

package selfinstall

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/internal/restarttest"
)

// assertOnlyInstalled: a rename over the target leaves nothing else behind.
func assertOnlyInstalled(t *testing.T, exe string) {
	t.Helper()
	if names := dirNames(t, filepath.Dir(exe)); !slices.Equal(names, []string{filepath.Base(exe)}) {
		t.Errorf("directory holds %v after the install, want only the executable", names)
	}
	info, err := os.Stat(exe)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o751 {
		t.Errorf("mode = %o, want the old executable's 751", perm)
	}
}

// The old file is replaced, never written into: a process still running it —
// here, a descriptor still reading it — keeps the old contents.
func TestInstallNeverWritesIntoTheOldFile(t *testing.T) {
	restarttest.Install(t, newVersion)
	exe := installed(t)
	running, err := os.Open(exe)
	if err != nil {
		t.Fatal(err)
	}
	defer running.Close()

	if err := newInstaller(t, exe).Install(context.Background(), serve(t, publishedRelease(testBinary(t)))); err != nil {
		t.Fatalf("Install: %v", err)
	}
	got, err := io.ReadAll(running)
	if err != nil || string(got) != oldContents {
		t.Errorf("the old file reads %d bytes, %v; want it as it was", len(got), err)
	}
}

// assertLeftWhileRunning: a rename over the target leaves nothing to clean.
func assertLeftWhileRunning(t *testing.T, exe string) {
	t.Helper()
	if names := dirNames(t, filepath.Dir(exe)); !slices.Equal(names, []string{filepath.Base(exe)}) {
		t.Errorf("directory holds %v, want only the executable", names)
	}
}

// The not-writable hint is a command the user pastes into a shell, so the
// directory in it has to survive as one word.
func TestNotWritableHintQuotesTheDirectory(t *testing.T) {
	for dir, want := range map[string]string{
		"/usr/local/bin":         "--install-dir /usr/local/bin`",
		"/Users/a b/bin":         "--install-dir '/Users/a b/bin'`",
		"/opt/it's/bin":          `--install-dir '/opt/it'\''s/bin'` + "`",
		"/home/x/$(touch y)/bin": "--install-dir '/home/x/$(touch y)/bin'`",
	} {
		if got := notWritableHint(dir); !strings.Contains(got, want) {
			t.Errorf("notWritableHint(%q) = %q, want it to contain %q", dir, got, want)
		}
	}
}
