package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pockode/server/internal/release"
	"github.com/pockode/server/internal/restart"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/selfinstall"
	"github.com/sourcegraph/jsonrpc2"
)

// ReleaseChecker is what Updater needs of a *release.Checker.
type ReleaseChecker interface {
	Status(ctx context.Context) release.Status
	Recheck(ctx context.Context) release.Status
}

// SelfInstaller is what Updater needs of a *selfinstall.Installer.
type SelfInstaller interface {
	Available() error
	Busy() bool
	Install(ctx context.Context, rel selfinstall.Release) error
	Close()
}

// updateTimeout is the budget of one install, from the request to the
// replaced file; docs/self-update-ui.md tells the user about it.
const updateTimeout = 5 * time.Minute

// Updater serves server.update_check and server.update: the releases this
// process could move to, and installing one over its executable. It installs
// and nothing else — restarting into the new file is the client's following
// server.restart, refused or accepted exactly as any other. One per process,
// shared by every connection, so that an install started from one device is
// what another device's check reports.
type Updater struct {
	checker   ReleaseChecker
	installer SelfInstaller
	timeout   time.Duration
	now       func() time.Time
	// base is what every install runs under instead of its request, which a
	// dropped connection must not stop; Close cancels it.
	base       context.Context
	cancelBase context.CancelFunc

	installingMu sync.Mutex
	installing   *rpc.UpdateInstalling // this process's install under way
}

// NewReleaseUpdater returns the Updater of a process running version from
// program, checking GitHub's releases and installing over program.Path. It
// also clears what earlier installs left behind (selfinstall.Installer.Cleanup),
// so call it once, at startup.
func NewReleaseUpdater(log *slog.Logger, program restart.Program, version string) *Updater {
	installer := selfinstall.New(program, version, log)
	installer.Cleanup()
	return NewUpdater(release.NewChecker(log, version, release.NewGitHub(version)), installer)
}

func NewUpdater(checker ReleaseChecker, installer SelfInstaller) *Updater {
	base, cancel := context.WithCancel(context.Background())
	return &Updater{checker: checker, installer: installer, timeout: updateTimeout, now: time.Now, base: base, cancelBase: cancel}
}

// Close stops the installs under way short of their replacement, waits for a
// replacement already begun, and keeps any later one from starting
// (selfinstall.Installer.Close). Call it on shutdown before the connections
// are closed, so that closing them does not wait out its timeout on a handler
// still installing.
func (u *Updater) Close() {
	u.cancelBase()
	u.installer.Close()
}

// HandleUpdateCheck answers server.update_check. Candidates are only those
// newer than the installed version as well as the running one: a release
// already on disk is a restart away, not an update.
func (c ServerControl) HandleUpdateCheck(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, log *slog.Logger) {
	var params rpc.ServerUpdateCheckParams
	if req.Params != nil {
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			replyInvalidParams(ctx, conn, req, log)
			return
		}
	}
	result := c.Updater.check(ctx, params.Force, c.Installed(ctx).Version)
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send server.update_check response", "error", err)
	}
}

// HandleUpdate answers server.update once the install has ended: the empty
// object when the executable has been replaced, CodeUpdateFailed otherwise.
// The install belongs to the process, not the connection: it runs on if the
// client goes away, and the next check reports how it ended.
func (c ServerControl) HandleUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, log *slog.Logger) {
	var params rpc.ServerUpdateParams
	if req.Params == nil || json.Unmarshal(*req.Params, &params) != nil || params.Version == "" {
		replyInvalidParams(ctx, conn, req, log)
		return
	}
	installed := func(ctx context.Context) string { return c.Installed(ctx).Version }
	if err := c.Updater.install(ctx, params.Version, installed, log); err != nil {
		var failed *updateFailed
		if !errors.As(err, &failed) {
			failed = &updateFailed{message: err.Error()}
		}
		replyErr := &jsonrpc2.Error{Code: rpc.CodeUpdateFailed, Message: failed.message}
		replyErr.SetError(rpc.UpdateFailedData{Reason: failed.reason})
		if err := conn.ReplyWithError(ctx, req.ID, replyErr); err != nil {
			log.Warn("failed to send server.update failure", "error", err)
		}
		return
	}
	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Warn("installed an update, but could not reply to server.update", "error", err)
	}
}

func replyInvalidParams(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, log *slog.Logger) {
	if err := conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: jsonrpc2.CodeInvalidParams, Message: "invalid params"}); err != nil {
		log.Error("failed to send error response", "method", req.Method, "error", err)
	}
}

func (u *Updater) check(ctx context.Context, force bool, installed string) rpc.ServerUpdateCheckResult {
	var st release.Status
	if force {
		st = u.checker.Recheck(ctx)
	} else {
		st = u.checker.Status(ctx)
	}
	result := rpc.ServerUpdateCheckResult{
		Candidates: []rpc.UpdateCandidate{},
		Platform:   release.Platform(),
		Asset:      release.HostAsset(),
	}
	result.LatestVersion = st.Latest
	if !st.CheckedAt.IsZero() {
		result.CheckedAt = &st.CheckedAt
	}
	switch {
	case errors.Is(st.Err, release.ErrDevBuild):
		result.CheckError = &rpc.UpdateCheckError{Reason: rpc.UpdateCheckDevBuild, Message: st.Err.Error()}
	case st.Err != nil:
		result.CheckError = &rpc.UpdateCheckError{Reason: rpc.UpdateCheckUnavailable, Message: st.Err.Error()}
	}
	for _, cand := range release.NewerThan(st.Candidates, installed) {
		wire := rpc.UpdateCandidate{Channel: string(cand.Channel), Version: cand.Version, NotesURL: cand.NotesURL}
		if cand.Unavailable != nil {
			wire.Unavailable = &rpc.UpdateUnavailable{Reason: string(cand.Unavailable.Reason), Message: cand.Unavailable.Message}
		}
		result.Candidates = append(result.Candidates, wire)
	}
	result.CannotInstall = cannotInstall(u.installer.Available())
	result.Installing = u.installingNow()
	return result
}

func cannotInstall(err error) *rpc.UpdateCannotInstall {
	if err == nil {
		return nil
	}
	var unavailable *selfinstall.UnavailableError
	if !errors.As(err, &unavailable) {
		return &rpc.UpdateCannotInstall{Message: err.Error()}
	}
	return &rpc.UpdateCannotInstall{
		Reason:  string(unavailable.Reason),
		Message: unavailable.Error(),
		Dir:     unavailable.Dir,
		Hint:    unavailable.Hint(),
	}
}

func (u *Updater) installingNow() *rpc.UpdateInstalling {
	u.installingMu.Lock()
	ours := u.installing
	u.installingMu.Unlock()
	if ours != nil {
		copied := *ours
		return &copied
	}
	if u.installer.Busy() {
		return &rpc.UpdateInstalling{}
	}
	return nil
}

// updateFailed is a server.update that did not replace the executable.
type updateFailed struct {
	reason  string
	message string
}

func (e *updateFailed) Error() string { return e.message }

// install runs the whole of a server.update under one budget, from the
// request's arrival: the answer comes within it, but for a replacement on
// Windows, which is not cut short once begun (see selfinstall.Install).
// installed reads the version on disk.
func (u *Updater) install(ctx context.Context, version string, installed func(context.Context) string, log *slog.Logger) error {
	ctx, cancel := context.WithTimeout(u.base, u.timeout)
	defer cancel()
	if err := u.installer.Available(); err != nil {
		return refusedAsUnavailable(err)
	}
	// The cached answer is enough: the question is whether version is still
	// on offer, so that no client can make this process install a release it
	// would not offer — an older one, or one already on disk. The installer
	// compares with the disk again under its lock, which is what holds
	// against another install finishing meanwhile.
	cand, ok := findCandidate(release.NewerThan(u.checker.Status(ctx).Candidates, installed(ctx)), version)
	if !ok {
		return &updateFailed{rpc.UpdateFailedReleaseGone, version + " is no longer offered as an update here; check again for what is."}
	}
	if cand.Unavailable != nil {
		reason := rpc.UpdateFailedNoAsset
		if cand.Unavailable.Reason == release.ReasonNoChecksums {
			reason = rpc.UpdateFailedNoChecksums
		}
		return &updateFailed{reason, cand.Unavailable.Message}
	}

	startedAt := u.now()
	u.installingMu.Lock()
	if ours := u.installing; ours != nil {
		u.installingMu.Unlock()
		return &updateFailed{rpc.UpdateFailedAlreadyInstalling, "An update to " + ours.Version + " is already being installed."}
	}
	u.installing = &rpc.UpdateInstalling{Version: cand.Version, Channel: string(cand.Channel), StartedAt: &startedAt}
	u.installingMu.Unlock()
	defer func() {
		u.installingMu.Lock()
		u.installing = nil
		u.installingMu.Unlock()
	}()

	err := u.installer.Install(ctx, selfinstall.Release{
		Version:      cand.Version,
		AssetName:    cand.Asset.Name,
		AssetURL:     cand.Asset.URL,
		ChecksumsURL: cand.Asset.ChecksumsURL,
	})
	if err != nil {
		log.Warn("installing an update failed", "version", cand.Version, "error", err)
		return u.installFailure(ctx, err)
	}
	return nil
}

func findCandidate(candidates []release.Candidate, version string) (release.Candidate, bool) {
	for _, c := range candidates {
		if c.Version == version {
			return c, true
		}
	}
	return release.Candidate{}, false
}

func refusedAsUnavailable(err error) error {
	var unavailable *selfinstall.UnavailableError
	if errors.As(err, &unavailable) {
		return &updateFailed{rpc.UpdateFailedNotInstallable, unavailable.Error()}
	}
	return err
}

// installFailure maps what Install returned onto the reasons of
// CodeUpdateFailed; selfinstall's failures and the reasons share their names.
func (u *Updater) installFailure(ctx context.Context, err error) error {
	switch {
	case errors.Is(err, selfinstall.ErrBusy):
		return &updateFailed{rpc.UpdateFailedAlreadyInstalling, "Another Pockode on this machine is already installing an update."}
	case errors.Is(err, selfinstall.ErrNotNewer):
		return &updateFailed{rpc.UpdateFailedReleaseGone, "Another update finished first: " + err.Error() + "."}
	}
	var failed *selfinstall.InstallError
	if !errors.As(err, &failed) {
		return refusedAsUnavailable(err)
	}
	if failed.Failure == selfinstall.FailureInterrupted {
		// The install's own context is detached from the connection, so only
		// its deadline or Close stops it — asked of the context, since the
		// step that failed need not have wrapped the context's error.
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &updateFailed{rpc.UpdateFailedTimeout, fmt.Sprintf("The update did not finish within %v and was stopped: %v", u.timeout, err)}
		}
		return &updateFailed{"", err.Error()}
	}
	return &updateFailed{string(failed.Failure), err.Error()}
}
