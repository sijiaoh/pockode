package selfinstall

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/internal/restart"
	"github.com/pockode/server/internal/restarttest"
	"github.com/pockode/server/internal/symlinktest"
	"github.com/pockode/server/internal/unwritabletest"
)

const (
	testAsset   = "pockode-test-arch"
	newVersion  = "1.2.0"
	oldContents = "the old executable"
)

func sha(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// testBinary is the release asset every successful install downloads: the
// test binary itself, which runs on this machine and answers --version as
// restarttest.Install says.
func testBinary(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fakeRelease serves a release's files by URL path; anything else is a 404.
type fakeRelease map[string][]byte

func (f fakeRelease) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, ok := f[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Write(body)
}

// publishedRelease lists asset in checksums.txt the way scripts/build.sh
// writes it, beside another platform's asset.
func publishedRelease(asset []byte) fakeRelease {
	return fakeRelease{
		"/" + testAsset: asset,
		"/checksums.txt": []byte(sha([]byte("other")) + "  pockode-other-arch\n" +
			sha(asset) + "  " + testAsset + "\n"),
	}
}

func serve(t *testing.T, rel fakeRelease) Release {
	t.Helper()
	srv := httptest.NewServer(rel)
	t.Cleanup(srv.Close)
	return Release{
		Version:      newVersion,
		AssetName:    testAsset,
		AssetURL:     srv.URL + "/" + testAsset,
		ChecksumsURL: srv.URL + "/checksums.txt",
	}
}

// installed puts an old executable in a directory of its own, so a test can
// see everything an install left there.
func installed(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "pockode"+filepath.Ext(os.Args[0]))
	if err := os.WriteFile(exe, []byte(oldContents), 0o751); err != nil {
		t.Fatal(err)
	}
	return exe
}

func newInstaller(t *testing.T, path string) *Installer {
	t.Helper()
	in := New(restart.Program{Path: path}, "1.0.0", slog.New(slog.NewTextHandler(io.Discard, nil)))
	in.inContainer = func() bool { return false }
	in.lockDir = t.TempDir()
	return in
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// assertUntouched checks what every failure promises: the old executable is
// there as it was, and nothing downloaded was left beside it.
func assertUntouched(t *testing.T, exe string) {
	t.Helper()
	if got, err := os.ReadFile(exe); err != nil || string(got) != oldContents {
		t.Errorf("old executable changed: %q, %v", got, err)
	}
	if names := dirNames(t, filepath.Dir(exe)); !slices.Equal(names, []string{filepath.Base(exe)}) {
		t.Errorf("directory holds %v, want only the old executable", names)
	}
}

func TestInstallPutsVerifiedReleaseInPlace(t *testing.T) {
	restarttest.Install(t, newVersion)
	exe := installed(t)
	binary := testBinary(t)

	if err := newInstaller(t, exe).Install(context.Background(), serve(t, publishedRelease(binary))); err != nil {
		t.Fatalf("Install: %v", err)
	}

	got, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if sha(got) != sha(binary) {
		t.Error("the executable is not the release's asset")
	}
	// What a restart will run, checked the way it checks.
	if v, err := (restart.Program{Path: exe}).Version(context.Background()); err != nil || v != newVersion {
		t.Errorf("installed executable reports %q, %v; want %s", v, err, newVersion)
	}
	assertOnlyInstalled(t, exe)
}

func TestInstallFailuresLeaveTheExecutable(t *testing.T) {
	tests := []struct {
		name    string
		release func(binary []byte) fakeRelease
		// reports is what the downloaded executable's --version says; empty
		// makes it fail to run.
		reports     string
		wantErr     string
		wantFailure Failure
	}{
		{
			name:        "checksum mismatch",
			wantFailure: FailureChecksumMismatch,
			release: func(b []byte) fakeRelease {
				r := publishedRelease(b)
				r["/"+testAsset] = append(slices.Clone(b), "tampered"...)
				return r
			},
			reports: newVersion,
			wantErr: "does not match the checksum",
		},
		{
			name:        "asset missing from checksums.txt",
			wantFailure: FailureNoAsset,
			release: func(b []byte) fakeRelease {
				r := publishedRelease(b)
				r["/checksums.txt"] = []byte(sha(b) + "  pockode-other-arch\n")
				return r
			},
			reports: newVersion,
			wantErr: "does not list " + testAsset,
		},
		{
			name:        "malformed checksum",
			wantFailure: FailureNoChecksums,
			release: func(b []byte) fakeRelease {
				r := publishedRelease(b)
				r["/checksums.txt"] = []byte("abc  " + testAsset + "\n")
				return r
			},
			reports: newVersion,
			wantErr: "not a SHA-256",
		},
		{
			name:        "no checksums.txt",
			wantFailure: FailureNoChecksums,
			release: func(b []byte) fakeRelease {
				r := publishedRelease(b)
				delete(r, "/checksums.txt")
				return r
			},
			reports: newVersion,
			wantErr: "no checksums.txt",
		},
		{
			name:        "no asset",
			wantFailure: FailureNoAsset,
			release: func(b []byte) fakeRelease {
				r := publishedRelease(b)
				delete(r, "/"+testAsset)
				return r
			},
			reports: newVersion,
			wantErr: "no " + testAsset,
		},
		{
			// The checksum only proves the file is what was published.
			name:        "asset reports another version",
			wantFailure: FailureNotRunnable,
			release:     publishedRelease,
			reports:     "1.1.0",
			wantErr:     "reports version 1.1.0, not " + newVersion,
		},
		{
			name:        "asset does not run",
			wantFailure: FailureNotRunnable,
			release:     publishedRelease,
			wantErr:     "does not run on this machine",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.reports == "" {
				restarttest.Break(t, "exec format error")
			} else {
				restarttest.Install(t, tt.reports)
			}
			exe := installed(t)
			err := newInstaller(t, exe).Install(context.Background(), serve(t, tt.release(testBinary(t))))
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Install error = %v, want one containing %q", err, tt.wantErr)
			}
			assertFailure(t, err, tt.wantFailure)
			assertUntouched(t, exe)
		})
	}
}

func TestInstallCancelledLeavesTheExecutable(t *testing.T) {
	exe := installed(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := newInstaller(t, exe).Install(ctx, serve(t, publishedRelease(testBinary(t))))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Install error = %v, want context.Canceled", err)
	}
	assertFailure(t, err, FailureInterrupted)
	assertUntouched(t, exe)
}

// A server that answers with an error is a failed download, not a release
// without the file: trying again may help.
func TestInstallServerErrorIsADownloadFailure(t *testing.T) {
	exe := installed(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	rel := Release{Version: newVersion, AssetName: testAsset, AssetURL: srv.URL + "/a", ChecksumsURL: srv.URL + "/c"}
	err := newInstaller(t, exe).Install(context.Background(), rel)
	assertFailure(t, err, FailureDownload)
	assertUntouched(t, exe)
}

func assertFailure(t *testing.T, err error, want Failure) {
	t.Helper()
	var failed *InstallError
	if !errors.As(err, &failed) || failed.Failure != want {
		t.Fatalf("error = %v, want an InstallError with failure %s", err, want)
	}
}

// A replace whose new file cannot be moved into place leaves the old one where
// it was — on Windows, after moving it aside and back.
func TestReplaceFailureLeavesTarget(t *testing.T) {
	exe := installed(t)
	missing := filepath.Join(filepath.Dir(exe), "missing")
	_, err := replace(missing, exe, time.Second)
	assertFailure(t, err, FailureReplace)
	assertUntouched(t, exe)
}

func TestAvailable(t *testing.T) {
	exe := installed(t)

	t.Run("a release build in a writable directory", func(t *testing.T) {
		in := newInstaller(t, exe)
		if err := in.Available(); err != nil {
			t.Fatalf("Available = %v, want nil", err)
		}
		assertUntouched(t, exe)
	})
	t.Run("a dev build", func(t *testing.T) {
		in := newInstaller(t, exe)
		in.runningVersion = "dev"
		assertUnavailable(t, in.Available(), ReasonDevBuild)
	})
	t.Run("in a container", func(t *testing.T) {
		in := newInstaller(t, exe)
		in.inContainer = func() bool { return true }
		assertUnavailable(t, in.Available(), ReasonContainer)
	})
	t.Run("an executable that is gone", func(t *testing.T) {
		in := newInstaller(t, filepath.Join(t.TempDir(), "gone"))
		var unavailable *UnavailableError
		if err := in.Available(); err == nil || errors.As(err, &unavailable) {
			t.Fatalf("Available = %v, want an error naming the missing executable", err)
		}
	})
}

// An install is refused, not queued, while another holds the lock — another
// Pockode of the same OS user, or another request in this one.
func TestInstallRefusedWhileAnotherRuns(t *testing.T) {
	exe := installed(t)
	in := newInstaller(t, exe)
	unlock, err := in.lock()
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()

	other := newInstaller(t, exe)
	other.lockDir = in.lockDir
	if !other.Busy() {
		t.Error("Busy = false while another install holds the lock")
	}
	if err := other.Install(context.Background(), serve(t, publishedRelease(testBinary(t)))); !errors.Is(err, ErrBusy) {
		t.Fatalf("Install error = %v, want ErrBusy", err)
	}
	assertUntouched(t, exe)
}

func TestCleanup(t *testing.T) {
	exe := installed(t)
	dir := filepath.Dir(exe)
	prefix, pattern := stagingPattern(exe)
	abandoned := filepath.Join(dir, prefix+"123"+filepath.Ext(pattern))
	replaced := oldName(exe, time.Now())
	mine := filepath.Join(dir, filepath.Base(exe)+".backup.old")
	for _, p := range []string{abandoned, replaced, mine} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	in := newInstaller(t, exe)
	in.Cleanup()

	for _, gone := range []string{abandoned, replaced} {
		if _, err := os.Stat(gone); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s left in place: %v", filepath.Base(gone), err)
		}
	}
	if _, err := os.Stat(mine); err != nil {
		t.Errorf("a file of the user's was removed: %v", err)
	}

	// Nothing is touched while an install runs: what is staged is its own.
	if err := os.WriteFile(abandoned, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	unlock, err := in.lock()
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	in.Cleanup()
	if _, err := os.Stat(abandoned); err != nil {
		t.Errorf("Cleanup removed a running install's download: %v", err)
	}
}

func TestFindChecksum(t *testing.T) {
	want := sha([]byte("bin"))
	tests := []struct {
		name string
		sums string
	}{
		{"sha256sum", want + "  " + testAsset + "\n"},
		{"shasum binary mode", want + " *" + testAsset + "\n"},
		{"CRLF", sha([]byte("x")) + "  other\r\n" + want + "  " + testAsset + "\r\n"},
		{"upper case", strings.ToUpper(want) + "  " + testAsset},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := findChecksum([]byte(tt.sums), testAsset, newVersion)
			if err != nil || got != want {
				t.Errorf("findChecksum = %q, %v; want %q", got, err, want)
			}
		})
	}
	// A name that merely starts with the asset's is another asset.
	if _, err := findChecksum([]byte(want+"  "+testAsset+".exe\n"), testAsset, newVersion); err == nil {
		t.Error("findChecksum matched a different asset")
	}
}

// A directory turned unwritable is reported with what to do, both before and
// at an install.
func TestUnwritableDirectory(t *testing.T) {
	exe := installed(t)
	unwritabletest.Make(t, filepath.Dir(exe))
	in := newInstaller(t, exe)

	assertUnavailable(t, in.Available(), ReasonNotWritable)
	err := in.Install(context.Background(), serve(t, publishedRelease(testBinary(t))))
	assertUnavailable(t, err, ReasonNotWritable)
	// The directory the file really is in: a temporary directory behind a
	// symlink (macOS's /var) is named as what it resolves to.
	dir, evalErr := filepath.EvalSymlinks(filepath.Dir(exe))
	if evalErr != nil {
		t.Fatal(evalErr)
	}
	if !strings.Contains(err.Error(), dir) || !strings.Contains(err.Error(), "install") {
		t.Errorf("error %q does not name the directory and what to do", err)
	}
	assertUntouched(t, exe)
}

func assertUnavailable(t *testing.T, err error, want Reason) {
	t.Helper()
	var unavailable *UnavailableError
	if !errors.As(err, &unavailable) || unavailable.Reason != want {
		t.Fatalf("error = %v, want an UnavailableError with reason %s", err, want)
	}
}

// Through a symlink, the file it points at is replaced and the link stays a
// link, so the path a restart runs leads to the new version.
func TestInstallReplacesTheFileALinkPointsAt(t *testing.T) {
	restarttest.Install(t, newVersion)
	real := installed(t)
	link := filepath.Join(t.TempDir(), "pockode")
	symlinktest.Make(t, real, link)
	binary := testBinary(t)

	if err := newInstaller(t, link).Install(context.Background(), serve(t, publishedRelease(binary))); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if target, err := os.Readlink(link); err != nil || target != real {
		t.Errorf("link = %q, %v; want it still pointing at %s", target, err, real)
	}
	got, err := os.ReadFile(real)
	if err != nil || sha(got) != sha(binary) {
		t.Errorf("the linked file is not the release's asset (%v)", err)
	}
	assertOnlyInstalled(t, real)
}

// Looking does not get in the way: an install that starts while Busy (or
// Cleanup) holds the lock for a moment still runs.
func TestBusyDoesNotRefuseAnInstall(t *testing.T) {
	restarttest.Install(t, newVersion)
	exe := installed(t)
	in := newInstaller(t, exe)
	if in.Busy() {
		t.Fatal("Busy = true with no install under way")
	}
	unlock, err := in.lock()
	if err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(lockRetryDelay, unlock)
	if err := in.Install(context.Background(), serve(t, publishedRelease(testBinary(t)))); err != nil {
		t.Fatalf("Install while the lock was held for a moment: %v", err)
	}
}

// The case the whole package is for: the executable is running while it is
// replaced. The running process is unaffected, the path now runs the new
// version, and on Windows the moved-aside file outlives Cleanup until the
// process exits.
func TestInstallOverARunningExecutable(t *testing.T) {
	restarttest.Install(t, newVersion)
	binary := testBinary(t)
	exe := filepath.Join(t.TempDir(), "pockode"+filepath.Ext(os.Args[0]))
	if err := os.WriteFile(exe, binary, 0o755); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(exe)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), runningEnv+"=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stopped := false
	stop := func() error {
		stopped = true
		stdin.Close()
		return cmd.Wait()
	}
	t.Cleanup(func() {
		if !stopped {
			stop()
		}
	})

	in := newInstaller(t, exe)
	// The old file is the test binary too, and would answer newVersion.
	in.installedVersion = func(context.Context) (string, error) { return "1.0.0", nil }
	if err := in.Install(context.Background(), serve(t, publishedRelease(binary))); err != nil {
		t.Fatalf("Install over a running executable: %v", err)
	}
	after, err := os.Stat(exe)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(before, after) {
		t.Error("the executable is the same file as before: it was written into, not replaced")
	}
	if v, err := (restart.Program{Path: exe}).Version(context.Background()); err != nil || v != newVersion {
		t.Errorf("installed executable reports %q, %v; want %s", v, err, newVersion)
	}

	in.Cleanup()
	assertLeftWhileRunning(t, exe)
	if err := stop(); err != nil {
		t.Errorf("the running process did not carry on unaffected: %v", err)
	}
	// Windows refuses for a moment to delete an image that has just exited
	// (antivirus and the indexer open it as it closes), which Cleanup leaves
	// for a later startup; the test waits that moment out.
	want := []string{filepath.Base(exe)}
	var names []string
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		in.Cleanup()
		if names = dirNames(t, filepath.Dir(exe)); slices.Equal(names, want) || time.Now().After(deadline) {
			break
		}
	}
	if !slices.Equal(names, want) {
		t.Errorf("directory holds %v once nothing runs the old executable, want only the executable", names)
	}
}

// Whatever the caller compared against, the install compares again under the
// lock: another install may have put the same or a newer version there since.
func TestInstallRefusesWhatIsNotNewerThanTheInstalledFile(t *testing.T) {
	for _, onDisk := range []string{newVersion, "1.3.0", "1.3.0-alpha.1"} {
		t.Run(onDisk, func(t *testing.T) {
			restarttest.Install(t, newVersion)
			exe := installed(t)
			in := newInstaller(t, exe)
			in.installedVersion = func(context.Context) (string, error) { return onDisk, nil }
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("requested %s before refusing", r.URL.Path)
			}))
			t.Cleanup(srv.Close)
			rel := Release{Version: newVersion, AssetName: testAsset, AssetURL: srv.URL + "/" + testAsset, ChecksumsURL: srv.URL + "/checksums.txt"}

			err := in.Install(context.Background(), rel)
			if !errors.Is(err, ErrNotNewer) || !strings.Contains(err.Error(), onDisk) {
				t.Fatalf("Install over %s = %v, want ErrNotNewer naming it", onDisk, err)
			}
			assertUntouched(t, exe)
		})
	}

	t.Run("a development build, or one that does not run, sets no floor", func(t *testing.T) {
		for _, answer := range []func(context.Context) (string, error){
			func(context.Context) (string, error) { return "dev", nil },
			func(context.Context) (string, error) { return "", errors.New("exec format error") },
		} {
			restarttest.Install(t, newVersion)
			in := newInstaller(t, installed(t))
			in.installedVersion = answer
			if err := in.Install(context.Background(), serve(t, publishedRelease(testBinary(t)))); err != nil {
				t.Errorf("Install = %v, want it to replace the file", err)
			}
		}
	})
}

// Close keeps a later install from replacing anything, so that a process
// shutting down never exits between the renames of a replacement.
func TestInstallAfterClose(t *testing.T) {
	restarttest.Install(t, newVersion)
	exe := installed(t)
	in := newInstaller(t, exe)
	in.Close()

	if err := in.Install(context.Background(), serve(t, publishedRelease(testBinary(t)))); !errors.Is(err, ErrClosed) {
		t.Fatalf("Install after Close = %v, want ErrClosed", err)
	}
	assertUntouched(t, exe)
	if names := dirNames(t, filepath.Dir(exe)); len(names) != 1 {
		t.Errorf("directory holds %v, want the download gone", names)
	}
}
