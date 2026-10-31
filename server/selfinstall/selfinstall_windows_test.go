package selfinstall

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// assertOnlyInstalled: the replaced executable is moved aside under a name
// of its own, which Cleanup removes later.
func assertOnlyInstalled(t *testing.T, exe string) {
	t.Helper()
	names := dirNames(t, filepath.Dir(exe))
	if len(names) != 2 {
		t.Fatalf("directory holds %v after the install, want the executable and the old one", names)
	}
	for _, name := range names {
		if name == filepath.Base(exe) {
			continue
		}
		if !isOldName(name, filepath.Base(exe)+".") {
			t.Errorf("%s is not a name the old executable is moved aside to", name)
		}
		if got, err := os.ReadFile(filepath.Join(filepath.Dir(exe), name)); err != nil || string(got) != oldContents {
			t.Errorf("%s = %q, %v; want the old executable", name, got, err)
		}
	}
}

// A moved-aside executable still running elsewhere — held open here without
// FILE_SHARE_DELETE, as a running image is — stays until a later startup.
func TestCleanupKeepsAnOldExecutableInUse(t *testing.T) {
	exe := installed(t)
	inUse := oldName(exe, time.Now().Add(-time.Hour))
	free := oldName(exe, time.Now())
	for _, p := range []string{inUse, free} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	name, err := windows.UTF16PtrFromString(inUse)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)

	newInstaller(t, exe).Cleanup()

	if _, err := os.Stat(inUse); err != nil {
		t.Errorf("an old executable in use was removed: %v", err)
	}
	if _, err := os.Stat(free); err == nil {
		t.Error("an old executable nothing uses was left in place")
	}
}

// Every replaced executable gets a name of its own: the one before may still
// be running.
func TestOldNamesAreDistinct(t *testing.T) {
	exe := `C:\p\pockode.exe`
	now := time.Now()
	a, b := oldName(exe, now), oldName(exe, now.Add(time.Microsecond))
	if a == b || !strings.HasSuffix(a, oldSuffix) {
		t.Errorf("oldName gave %q and %q", a, b)
	}
}

// assertLeftWhileRunning: the moved-aside executable is still running, so
// Cleanup cannot remove it.
func assertLeftWhileRunning(t *testing.T, exe string) {
	t.Helper()
	names := dirNames(t, filepath.Dir(exe))
	var old int
	for _, name := range names {
		if isOldName(name, filepath.Base(exe)+".") {
			old++
		}
	}
	if len(names) != 2 || old != 1 {
		t.Errorf("directory holds %v while the old executable runs, want it and the new one", names)
	}
}
