// Package selfinstall puts a release of Pockode in place of the executable on
// disk — the one a restart will run (restart.Program.Path) — after checking it
// against the checksums its release published. It replaces the file and
// nothing else: the running process carries on as it was, and goes over to the
// new version only when it restarts (internal/restart).
//
// The executable is only ever replaced by renaming a new file over it, never by
// writing into it: Linux refuses to open a running executable for writing
// (ETXTBSY), and macOS kills a running process whose code pages no longer match
// its signature. A rename leaves the running process on the old file, which
// lives on until it exits. How the rename is done differs per platform (see
// replace_unix.go and replace_windows.go).
//
// A server and a cluster manager use the same Installer, and every Pockode of
// one OS user shares one lock, so only one install runs at a time.
package selfinstall

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/filestore"
	"github.com/pockode/server/internal/release"
	"github.com/pockode/server/internal/restart"
)

// Release is the release an install puts in place: this platform's asset and
// the checksums.txt of the same release, which the asset is verified against.
// Both URLs must belong to one release, or the checksum proves nothing.
type Release struct {
	// Version is the version the new executable reports, without the "v" of
	// the tag: what its --version prints after "pockode ".
	Version string
	// AssetName is this platform's asset, as checksums.txt lists it:
	// pockode-<os>-<arch>[.exe].
	AssetName    string
	AssetURL     string
	ChecksumsURL string
}

// lockName is the lock every install of this OS user takes, in
// filestore.UserLockDir.
const lockName = "self-install.lock"

// Reason says why this Pockode cannot install a release over itself.
type Reason string

const (
	// ReasonDevBuild: the running build has no release version, so there is
	// nothing to compare a release against and no release it came from.
	ReasonDevBuild Reason = "dev_build"
	// ReasonContainer: the executable belongs to a container image; a newer
	// version is a newer image, not a file replaced inside this one, which
	// the next container would not have.
	ReasonContainer Reason = "container"
	// ReasonNotWritable: this process cannot create files in the directory
	// holding the executable, so it cannot put a new one there.
	ReasonNotWritable Reason = "not_writable"
)

// UnavailableError is why installing is not possible here. Its message is
// for the user, and says what to do instead where there is something to do.
// Restarting is unaffected by any of these.
type UnavailableError struct {
	Reason Reason
	// Dir is the directory that is not writable; set for ReasonNotWritable.
	Dir string
	// Err is the underlying failure, when there is one.
	Err error
}

func (e *UnavailableError) Error() string {
	switch e.Reason {
	case ReasonDevBuild:
		return "this is a development build, which is not installed from a release"
	case ReasonContainer:
		return "Pockode is running in a container; update it by pulling a newer image"
	case ReasonNotWritable:
		return fmt.Sprintf("Pockode cannot write to %s, where its executable is (%v). %s", e.Dir, e.Err, e.Hint())
	}
	return string(e.Reason)
}

func (e *UnavailableError) Unwrap() error { return e.Err }

// Hint is what the user can do instead, on this OS, for ReasonNotWritable —
// the closing sentences of Error — and empty for the other reasons. A client
// that words the reason itself shows this beside it.
func (e *UnavailableError) Hint() string {
	if e.Reason != ReasonNotWritable {
		return ""
	}
	return notWritableHint(e.Dir)
}

// ErrNotNewer is an install refused because the executable on disk already
// reports the version asked for, or a newer one — installed by another
// Pockode since the caller looked. Matched with errors.Is; the message names
// both versions.
var ErrNotNewer = errors.New("not newer than the installed version")

// ErrClosed is an install that was not put in place because Close was called:
// the process is shutting down.
var ErrClosed = errors.New("shutting down, so the update was not put in place")

// ErrBusy is an install refused because another one is under way — in this
// process or in another Pockode of the same OS user.
var ErrBusy = errors.New("another Pockode on this machine is already installing an update")

// Failure says which step of an install failed, so that a client can say what
// it means and whether trying again can help.
type Failure string

const (
	// FailureDownload: a file of the release could not be fetched or written
	// beside the executable — the network, a proxy, a full disk.
	FailureDownload Failure = "download_failed"
	// FailureNoAsset: the release has no asset for this platform, or its
	// checksums.txt does not list it.
	FailureNoAsset Failure = "no_asset"
	// FailureNoChecksums: the release has no usable checksums.txt, so nothing
	// it publishes can be verified.
	FailureNoChecksums Failure = "no_checksums"
	// FailureChecksumMismatch: the download is not what the release published.
	FailureChecksumMismatch Failure = "checksum_mismatch"
	// FailureNotRunnable: the verified download does not run here, or reports
	// another version than the one asked for.
	FailureNotRunnable Failure = "not_runnable"
	// FailureReplace: the new file could not be put in place; the old one is
	// where it was.
	FailureReplace Failure = "replace_failed"
	// FailureInterrupted: the context Install was given ended first — a
	// timeout, or a caller that went away. Matches the context's error too.
	FailureInterrupted Failure = "interrupted"
	// FailureRestore (Windows only): the old executable was moved aside, the
	// new one could not be moved in, and the old one could not be moved back
	// either. The message says where it is and how to put it back.
	FailureRestore Failure = "restore_failed"
)

// InstallError is an install that failed at one step. Its message can be shown
// to the user as it is. Whatever the failure, the executable is as it was —
// FailureRestore aside.
type InstallError struct {
	Failure Failure
	Err     error
}

func (e *InstallError) Error() string { return e.Err.Error() }

func (e *InstallError) Unwrap() error { return e.Err }

func fail(f Failure, format string, args ...any) error {
	return &InstallError{Failure: f, Err: fmt.Errorf(format, args...)}
}

// Installer installs releases over one executable.
type Installer struct {
	path           string
	runningVersion string
	client         *http.Client
	userAgent      string
	log            *slog.Logger

	// inContainer, installedVersion and lockDir are fixed by New everywhere
	// but in tests.
	inContainer      func() bool
	installedVersion func(ctx context.Context) (string, error)
	lockDir          string
	lockDirErr       error
	// renameBudget is how long a rename on Windows is retried for.
	renameBudget time.Duration

	// replaceMu is held for the whole of a replacement, so that Close waits
	// for one under way; closed refuses the next.
	replaceMu sync.Mutex
	closed    bool
}

// New returns an Installer for program — the one a restart runs, so that a
// restart runs what was installed — in a process running runningVersion.
//
// Downloads go through Go's default proxy handling (HTTPS_PROXY, HTTP_PROXY,
// NO_PROXY) and are bounded only by the context Install is given.
func New(program restart.Program, runningVersion string, log *slog.Logger) *Installer {
	lockDir, lockDirErr := filestore.UserLockDir()
	return &Installer{
		path:             program.Path,
		runningVersion:   runningVersion,
		client:           &http.Client{},
		userAgent:        "pockode/" + runningVersion,
		log:              log,
		inContainer:      inContainer,
		installedVersion: restart.Program{Path: program.Path}.Version,
		lockDir:          lockDir,
		lockDirErr:       lockDirErr,
		renameBudget:     renameBudget,
	}
}

// Available reports whether Install could replace the executable, without
// touching anything but a probe file it removes again. It returns nil, an
// *UnavailableError, or an error naming what could not be found out.
func (in *Installer) Available() error {
	_, err := in.available()
	return err
}

// available returns the file an install replaces: the executable with every
// symlink followed. A link (a package manager's bin/pockode) stays where it
// is and goes on pointing at the replaced file, so the path a restart runs
// leads to the new version either way; and it is the real file's directory
// whose permissions decide whether it can be replaced.
func (in *Installer) available() (target string, err error) {
	if !release.IsRelease(in.runningVersion) {
		return "", &UnavailableError{Reason: ReasonDevBuild}
	}
	if in.inContainer() {
		return "", &UnavailableError{Reason: ReasonContainer}
	}
	target, err = filepath.EvalSymlinks(in.path)
	if err != nil {
		return "", fmt.Errorf("find the executable %s: %w", in.path, err)
	}
	dir := filepath.Dir(target)
	// A file created and removed again answers for ACLs, group membership and
	// read-only mounts alike, on both platforms, where mode bits answer for
	// none of them.
	// Named as a staged download, so that Cleanup takes care of one this
	// could not remove.
	staging, _ := stagingPattern(target)
	probe, err := os.CreateTemp(dir, staging+"probe-*")
	if err != nil {
		if isPermission(err) {
			return "", &UnavailableError{Reason: ReasonNotWritable, Dir: dir, Err: err}
		}
		return "", fmt.Errorf("check whether %s is writable: %w", dir, err)
	}
	probe.Close()
	if err := os.Remove(probe.Name()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		in.log.Warn("could not remove the write probe", "path", probe.Name(), "error", err)
	}
	return target, nil
}

// Install downloads rel, verifies it and puts it in place of the executable.
// On any error the executable is left exactly as it was, and nothing that was
// downloaded is left behind (Windows aside, if putting the old file back
// fails too: the error then says where it is).
//
// Refusals are an *UnavailableError (see Available), ErrBusy and ErrNotNewer;
// ErrClosed is an install stopped by Close; a failure
// is an *InstallError. The checks, in order: checksums.txt lists
// rel.AssetName; the download matches that checksum; the downloaded
// executable runs here and reports rel.Version.
//
// ctx bounds everything up to the replacement, which is not given up halfway
// once begun: on unix it is one rename, and on Windows it can take up to the
// rename budget per step while antivirus holds a file (see replace).
func (in *Installer) Install(ctx context.Context, rel Release) error {
	target, err := in.available()
	if err != nil {
		return err
	}
	unlock, err := in.lock()
	if err != nil {
		return err
	}
	defer unlock()
	in.cleanupLocked(target)
	// Only now, under the lock: whatever the caller compared against may have
	// been replaced by another install that finished meanwhile, and putting
	// rel over it could be a downgrade.
	if err := in.checkNewer(ctx, rel.Version); err != nil {
		return err
	}

	info, err := os.Stat(target)
	if err != nil {
		return fmt.Errorf("read the executable %s: %w", target, err)
	}
	want, err := in.checksum(ctx, rel)
	if err != nil {
		return interrupted(ctx, err)
	}
	staged, err := in.stage(ctx, rel, target, want, info.Mode().Perm())
	if err != nil {
		return interrupted(ctx, err)
	}
	if err := ctx.Err(); err != nil {
		in.discard(staged)
		return interrupted(ctx, err)
	}
	if err := in.replaceStagedUnlessClosed(staged, target); err != nil {
		return err
	}
	in.log.Info("installed a new version over the executable", "path", target, "from", in.runningVersion, "to", rel.Version)
	return nil
}

// checkNewer refuses version unless it is newer than the one the executable
// reports. An executable that does not run, or is not a release, sets no
// floor: replacing it is what fixes it.
func (in *Installer) checkNewer(ctx context.Context, version string) error {
	installed, err := in.installedVersion(ctx)
	if err != nil || !release.IsRelease(installed) {
		return nil
	}
	if c, err := agent.CompareVersions(version, installed); err == nil && c <= 0 {
		return fmt.Errorf("%w: %s is installed at %s already, and %s is not newer", ErrNotNewer, installed, in.path, version)
	}
	return nil
}

// Close waits for a replacement under way to finish, and keeps any later
// install from starting one: one still downloading ends with ErrClosed when
// it gets there, if the process has not gone first. Call it on shutdown, before the process exits or restarts: on
// Windows a replacement is two renames that may each wait out antivirus, and
// a process gone between them leaves no executable at the path.
func (in *Installer) Close() {
	in.replaceMu.Lock()
	defer in.replaceMu.Unlock()
	in.closed = true
}

func (in *Installer) replaceStagedUnlessClosed(staged, target string) error {
	in.replaceMu.Lock()
	if in.closed {
		in.replaceMu.Unlock()
		// Outside the lock: on Windows discard can retry for the rename
		// budget, and Close has nothing to wait for here.
		in.discard(staged)
		return ErrClosed
	}
	defer in.replaceMu.Unlock()
	return in.replaceStaged(staged, target)
}

func (in *Installer) replaceStaged(staged, target string) error {
	// Not turned into ReasonNotWritable: the directory was just found
	// writable, and on Windows a denied rename is far more often the file
	// being held (see filestore.RenamePatiently) than a permission.
	left, err := replace(staged, target, in.renameBudget)
	if err != nil {
		in.discard(left)
		return err
	}
	syncDir(filepath.Dir(target))
	return nil
}

// interrupted turns err into FailureInterrupted when ctx has ended: the
// step it failed at only failed because it was stopped, and saying it
// failed there — not_runnable, say — would blame the release.
func interrupted(ctx context.Context, err error) error {
	if ctx.Err() == nil {
		return err
	}
	return &InstallError{Failure: FailureInterrupted, Err: fmt.Errorf("the install was stopped before it finished: %w", err)}
}

// discardRetryDelay paces discard's retries.
const discardRetryDelay = 200 * time.Millisecond

// discard removes a staged download. On Windows the file an install gives up
// on is often held by antivirus — the very reason it was given up on — so the
// removal is retried as long as a rename would be; one that still fails is
// logged, and goes at the next Cleanup.
func (in *Installer) discard(path string) {
	deadline := time.Now().Add(in.renameBudget)
	for {
		err := os.Remove(path)
		if err == nil || errors.Is(err, fs.ErrNotExist) {
			return
		}
		if time.Now().Add(discardRetryDelay).After(deadline) {
			in.log.Warn("could not remove a download the install gave up on; it is removed at the next startup", "path", path, "error", err)
			return
		}
		time.Sleep(discardRetryDelay)
	}
}

// Cleanup removes what earlier installs left beside the executable and can be
// removed now: downloads an interrupted install abandoned, and on Windows the
// executables replaced since, once nothing runs them any more. Call it at
// startup. It does nothing while an install is under way, which cleans up for
// itself, and nothing for a build that cannot install.
func (in *Installer) Cleanup() {
	target, err := in.available()
	var unavailable *UnavailableError
	if errors.As(err, &unavailable) {
		return
	}
	if err != nil {
		in.log.Warn("could not look for leftovers of earlier installs", "error", err)
		return
	}
	unlock, err := in.lock()
	if errors.Is(err, ErrBusy) {
		return
	}
	if err != nil {
		in.log.Warn("could not look for leftovers of earlier installs", "error", err)
		return
	}
	defer unlock()
	in.cleanupLocked(target)
}

// cleanupLocked is Cleanup for a caller holding the lock: no install of this
// OS user is running, so every staged download beside target is abandoned.
func (in *Installer) cleanupLocked(target string) {
	dir := filepath.Dir(target)
	entries, err := os.ReadDir(dir)
	if err != nil {
		in.log.Warn("could not look for leftovers of earlier installs", "dir", dir, "error", err)
		return
	}
	staging, _ := stagingPattern(target)
	oldPrefix := filepath.Base(target) + "."
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() {
			continue
		}
		isStaged := strings.HasPrefix(name, staging)
		isOld := isOldName(name, oldPrefix)
		if !isStaged && !isOld {
			continue
		}
		path := filepath.Join(dir, name)
		// A replaced executable another process still runs cannot be removed
		// on Windows; it goes at a later startup.
		if err := os.Remove(path); err != nil {
			in.log.Debug("left an earlier install's file in place", "path", path, "error", err)
			continue
		}
		in.log.Info("removed an earlier install's file", "path", path)
	}
}

// Busy reports whether an install is under way, in this process or in
// another Pockode of this OS user. It is a snapshot, for showing; Install
// decides for itself.
func (in *Installer) Busy() bool {
	unlock, err := in.lock()
	if err != nil {
		return errors.Is(err, ErrBusy)
	}
	unlock()
	return false
}

// lockAttempts and lockRetryDelay let lock outwait a holder that only looks:
// Busy and Cleanup hold the lock for moments, and a press of Update arriving
// then must not be refused. An install holds it for as long as a download
// takes, far longer than this.
const (
	lockAttempts   = 5
	lockRetryDelay = 20 * time.Millisecond
)

func (in *Installer) lock() (unlock func(), err error) {
	if in.lockDir == "" {
		return nil, fmt.Errorf("no directory for the install lock: %w", in.lockDirErr)
	}
	if err := os.MkdirAll(in.lockDir, 0o700); err != nil {
		return nil, fmt.Errorf("create the directory for the install lock: %w", err)
	}
	path := filepath.Join(in.lockDir, lockName)
	for attempt := 1; ; attempt++ {
		unlock, err = filestore.TryLock(path)
		if !errors.Is(err, filestore.ErrLocked) {
			return unlock, err
		}
		if attempt == lockAttempts {
			return nil, ErrBusy
		}
		time.Sleep(lockRetryDelay)
	}
}

// stagingPattern is the os.CreateTemp pattern a download beside target is
// staged under, and the prefix every such file starts with. The extension is
// kept last, so that Windows runs the staged file for the version check.
func stagingPattern(target string) (prefix, pattern string) {
	base := filepath.Base(target)
	ext := filepath.Ext(base)
	prefix = "." + strings.TrimSuffix(base, ext) + ".install-"
	return prefix, prefix + "*" + ext
}

// A replaced executable is moved aside on Windows to
// <name>.<oldStampLayout>.old: a name of its own for each, because the one an
// earlier install moved aside may still be running in another Pockode — a
// cluster's node — and can be neither removed nor replaced until it exits.
const (
	oldStampLayout = "20060102-150405.000000000"
	oldSuffix      = ".old"
)

func oldName(target string, now time.Time) string {
	return target + "." + now.Format(oldStampLayout) + oldSuffix
}

// isOldName reports whether name is one oldName gives for a target whose base
// name is followed by prefix's dot — so that a file of the user's that merely
// ends in .old is never removed.
func isOldName(name, prefix string) bool {
	stamp, ok := strings.CutPrefix(name, prefix)
	if !ok {
		return false
	}
	stamp, ok = strings.CutSuffix(stamp, oldSuffix)
	if !ok {
		return false
	}
	_, err := time.Parse(oldStampLayout, stamp)
	return err == nil
}

// versionCheckAttempts and versionCheckRetryDelay bound the retries of a
// version check that found the staged file busy (ETXTBSY): a fork elsewhere
// in this process while the file was open for writing hands the descriptor to
// the child until it execs, and Linux will not run a file open for writing.
// It clears within milliseconds (golang.org/issue/22315).
const (
	versionCheckAttempts   = 5
	versionCheckRetryDelay = 50 * time.Millisecond
)

// checkVersion runs the staged executable the way a restart's probe does
// (restart.Program.Version) and wants rel.Version back. The checksum proves the
// file is what the release published; this proves it runs on this machine and
// is the version the user asked for — the restart that follows would refuse
// it otherwise, with the old executable already gone.
func checkVersion(ctx context.Context, staged, version string) error {
	program := restart.Program{Path: staged}
	var got string
	var err error
	for range versionCheckAttempts {
		got, err = program.Version(ctx)
		if !errors.Is(err, syscall.ETXTBSY) {
			break
		}
		time.Sleep(versionCheckRetryDelay)
	}
	if err != nil {
		return fail(FailureNotRunnable, "the downloaded executable does not run on this machine: %w", err)
	}
	if got != version {
		return fail(FailureNotRunnable, "the downloaded executable reports version %s, not %s", got, version)
	}
	return nil
}

func isPermission(err error) bool {
	return errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EROFS)
}

// syncDir makes the rename durable, so a crash right after cannot bring the
// old executable back. Best effort: the rename has happened, and not every
// platform can sync a directory.
func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
}
