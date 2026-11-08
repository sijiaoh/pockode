package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/internal/release"
	"github.com/pockode/server/internal/restarttest"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/selfinstall"
)

// fakeReleaseChecker answers with whatever status it was given, and counts
// which of the two entry points was asked: Recheck is the one that may reach
// the release feed.
type fakeReleaseChecker struct {
	statusMu sync.Mutex
	status   release.Status
	statuses int
	rechecks int
}

func (f *fakeReleaseChecker) set(st release.Status) {
	f.statusMu.Lock()
	defer f.statusMu.Unlock()
	f.status = st
}

func (f *fakeReleaseChecker) Status(context.Context) release.Status {
	f.statusMu.Lock()
	defer f.statusMu.Unlock()
	f.statuses++
	return f.status
}

func (f *fakeReleaseChecker) Recheck(context.Context) release.Status {
	f.statusMu.Lock()
	defer f.statusMu.Unlock()
	f.rechecks++
	return f.status
}

// fakeInstaller installs nothing; install, when set, decides how an install
// ends.
type fakeInstaller struct {
	stateMu   sync.Mutex
	available error
	busy      bool
	install   func(ctx context.Context, rel selfinstall.Release) error
	installed []selfinstall.Release
}

func (f *fakeInstaller) Available() error {
	f.stateMu.Lock()
	defer f.stateMu.Unlock()
	return f.available
}

func (f *fakeInstaller) Busy() bool {
	f.stateMu.Lock()
	defer f.stateMu.Unlock()
	return f.busy
}

func (*fakeInstaller) Close() {}

func (f *fakeInstaller) Install(ctx context.Context, rel selfinstall.Release) error {
	f.stateMu.Lock()
	f.installed = append(f.installed, rel)
	install := f.install
	f.stateMu.Unlock()
	if install == nil {
		return nil
	}
	return install(ctx, rel)
}

func candidate(channel release.Channel, version string) release.Candidate {
	tag := "v" + version
	return release.Candidate{
		Channel:  channel,
		Version:  version,
		NotesURL: "https://example.test/notes/" + tag,
		Asset: &release.Asset{
			Name:         "pockode-test-arch",
			URL:          "https://example.test/" + tag + "/pockode-test-arch",
			ChecksumsURL: "https://example.test/" + tag + "/checksums.txt",
		},
	}
}

var checkedAt = time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)

// published is a check that found a latest 0.25.0 and an alpha 0.26.0-alpha.1.
func published() release.Status {
	return release.Status{
		Candidates: []release.Candidate{
			candidate(release.ChannelLatest, "0.25.0"),
			candidate(release.ChannelAlpha, "0.26.0-alpha.1"),
		},
		Latest:    "0.25.0",
		CheckedAt: checkedAt,
	}
}

func updateCheck(t *testing.T, env *testEnv, params any) rpc.ServerUpdateCheckResult {
	t.Helper()
	resp := env.call("server.update_check", params)
	if resp.Error != nil {
		t.Fatalf("server.update_check failed: %s", resp.Error.Message)
	}
	var result rpc.ServerUpdateCheckResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal server.update_check result: %v", err)
	}
	return result
}

func versions(cands []rpc.UpdateCandidate) []string {
	var out []string
	for _, c := range cands {
		out = append(out, c.Channel+" "+c.Version)
	}
	return out
}

func TestHandler_ServerUpdateCheck(t *testing.T) {
	t.Run("offers the candidates newer than the installed version", func(t *testing.T) {
		for _, tc := range []struct {
			installed string
			want      string
		}{
			{"0.24.0", "[latest 0.25.0 alpha 0.26.0-alpha.1]"},
			// Already on disk: a restart, not an update.
			{"0.25.0", "[alpha 0.26.0-alpha.1]"},
			{"0.26.0-alpha.1", "[]"},
			// A development build on disk sets no floor.
			{"dev", "[latest 0.25.0 alpha 0.26.0-alpha.1]"},
		} {
			t.Run(tc.installed, func(t *testing.T) {
				env := newTestEnv(t, &mockAgent{})
				env.releases.set(published())
				restarttest.Install(t, tc.installed)

				got := updateCheck(t, env, nil)
				if s := fmt.Sprint(versions(got.Candidates)); s != tc.want {
					t.Errorf("candidates = %s, want %s", s, tc.want)
				}
			})
		}
	})

	t.Run("latest_version stays when latest is no candidate", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		env.releases.set(published())
		restarttest.Install(t, "0.25.0")

		if got := updateCheck(t, env, nil); got.LatestVersion != "0.25.0" {
			t.Errorf("latest_version = %q with 0.25.0 installed, want 0.25.0 still", got.LatestVersion)
		}
	})

	t.Run("an unreadable installed file sets no floor", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		env.releases.set(published())
		restarttest.Break(t, "boom")

		if got := updateCheck(t, env, nil); len(got.Candidates) != 2 {
			t.Errorf("candidates = %v, want both", versions(got.Candidates))
		}
	})

	t.Run("describes each candidate", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		st := published()
		st.Candidates[1].Asset = nil
		st.Candidates[1].Unavailable = &release.Unavailable{Reason: release.ReasonNoAsset, Message: "no build here"}
		env.releases.set(st)
		restarttest.Install(t, "0.24.0")

		got := updateCheck(t, env, nil)
		latest := rpc.UpdateCandidate{Channel: "latest", Version: "0.25.0", NotesURL: "https://example.test/notes/v0.25.0"}
		if len(got.Candidates) != 2 || got.Candidates[0] != latest {
			t.Fatalf("candidates = %+v, want %+v first", got.Candidates, latest)
		}
		if u := got.Candidates[1].Unavailable; u == nil || *u != (rpc.UpdateUnavailable{Reason: rpc.UpdateUnavailableNoAsset, Message: "no build here"}) {
			t.Errorf("alpha unavailable = %+v, want no_asset with its message", u)
		}
		if got.CheckedAt == nil || !got.CheckedAt.Equal(checkedAt) {
			t.Errorf("checked_at = %v, want %v", got.CheckedAt, checkedAt)
		}
		if got.CheckError != nil || got.CannotInstall != nil || got.Installing != nil {
			t.Errorf("result = %+v, want no error, no reason and no install", got)
		}
		if got.LatestVersion != "0.25.0" {
			t.Errorf("latest_version = %q, want 0.25.0", got.LatestVersion)
		}
		if got.Platform != release.Platform() || got.Asset != release.HostAsset() {
			t.Errorf("platform, asset = %q, %q", got.Platform, got.Asset)
		}
	})

	t.Run("before any answer: no checked_at, no error, an empty list", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		restarttest.Install(t, "0.24.0")

		resp := env.call("server.update_check", nil)
		if resp.Error != nil {
			t.Fatal(resp.Error.Message)
		}
		var raw map[string]json.RawMessage
		json.Unmarshal(resp.Result, &raw)
		if string(raw["candidates"]) != "[]" {
			t.Errorf("candidates = %s, want [] (never null)", raw["candidates"])
		}
		for _, key := range []string{"checked_at", "check_error"} {
			if _, ok := raw[key]; ok {
				t.Errorf("%s present before any check answered", key)
			}
		}
	})

	t.Run("a failed check keeps the last answer beside its error", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		st := published()
		st.Err = errors.New("github unreachable")
		env.releases.set(st)
		restarttest.Install(t, "0.24.0")

		got := updateCheck(t, env, nil)
		if got.CheckError == nil || *got.CheckError != (rpc.UpdateCheckError{Reason: rpc.UpdateCheckUnavailable, Message: "github unreachable"}) {
			t.Errorf("check_error = %+v, want unavailable with the error", got.CheckError)
		}
		if len(got.Candidates) != 2 || got.CheckedAt == nil {
			t.Errorf("result = %+v, want the last good answer too", got)
		}
	})

	t.Run("a development build", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		env.releases.set(release.Status{Err: release.ErrDevBuild})
		env.installer.available = &selfinstall.UnavailableError{Reason: selfinstall.ReasonDevBuild}
		restarttest.Install(t, "dev")

		got := updateCheck(t, env, nil)
		if got.CheckError == nil || got.CheckError.Reason != rpc.UpdateCheckDevBuild {
			t.Errorf("check_error = %+v, want dev_build", got.CheckError)
		}
		if got.CannotInstall == nil || got.CannotInstall.Reason != rpc.CannotInstallDevBuild {
			t.Errorf("cannot_install = %+v, want dev_build", got.CannotInstall)
		}
	})

	t.Run("only force asks the release feed", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		restarttest.Install(t, "0.24.0")

		updateCheck(t, env, nil)
		updateCheck(t, env, rpc.ServerUpdateCheckParams{})
		if env.releases.rechecks != 0 || env.releases.statuses != 2 {
			t.Fatalf("recheck %d, status %d; want the known answer twice", env.releases.rechecks, env.releases.statuses)
		}
		updateCheck(t, env, rpc.ServerUpdateCheckParams{Force: true})
		if env.releases.rechecks != 1 {
			t.Errorf("force did not recheck")
		}
	})

	t.Run("why nothing can be installed here", func(t *testing.T) {
		notWritable := &selfinstall.UnavailableError{Reason: selfinstall.ReasonNotWritable, Dir: "/usr/local/bin", Err: errors.New("permission denied")}
		for _, tc := range []struct {
			name string
			err  error
			want rpc.UpdateCannotInstall
		}{
			{"not writable", notWritable, rpc.UpdateCannotInstall{
				Reason: rpc.CannotInstallNotWritable, Message: notWritable.Error(), Dir: "/usr/local/bin", Hint: notWritable.Hint(),
			}},
			{"container", &selfinstall.UnavailableError{Reason: selfinstall.ReasonContainer}, rpc.UpdateCannotInstall{
				Reason: rpc.CannotInstallContainer, Message: (&selfinstall.UnavailableError{Reason: selfinstall.ReasonContainer}).Error(),
			}},
			{"could not find out", errors.New("find the executable: gone"), rpc.UpdateCannotInstall{
				Message: "find the executable: gone",
			}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				env := newTestEnv(t, &mockAgent{})
				env.releases.set(published())
				env.installer.available = tc.err
				restarttest.Install(t, "0.24.0")

				got := updateCheck(t, env, nil)
				if got.CannotInstall == nil || *got.CannotInstall != tc.want {
					t.Errorf("cannot_install = %+v, want %+v", got.CannotInstall, tc.want)
				}
				// The candidates stay: the user can still install from a terminal.
				if len(got.Candidates) != 2 {
					t.Errorf("candidates = %v, want both still listed", versions(got.Candidates))
				}
			})
		}
		if notWritable.Hint() == "" {
			t.Error("not_writable has no hint")
		}
	})

	t.Run("another process installing is reported without details", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		env.installer.busy = true
		restarttest.Install(t, "0.24.0")

		got := updateCheck(t, env, nil)
		if got.Installing == nil || *got.Installing != (rpc.UpdateInstalling{}) {
			t.Errorf("installing = %+v, want busy with no details", got.Installing)
		}
	})
}

func updateFailure(t *testing.T, resp rpcResponse) (reason, message string) {
	t.Helper()
	if resp.Error == nil {
		t.Fatal("server.update succeeded, want a failure")
	}
	if resp.Error.Code != rpc.CodeUpdateFailed {
		t.Fatalf("server.update error code = %d, want %d (%s)", resp.Error.Code, rpc.CodeUpdateFailed, resp.Error.Message)
	}
	var data rpc.UpdateFailedData
	if resp.Error.Data == nil || json.Unmarshal(*resp.Error.Data, &data) != nil {
		t.Fatalf("server.update failure carries no data: %+v", resp.Error)
	}
	return data.Reason, resp.Error.Message
}

func TestHandler_ServerUpdate(t *testing.T) {
	t.Run("installs the candidate's own asset, and restarts nothing", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		env.releases.set(published())
		restarttest.Install(t, "0.24.0")

		resp := env.call("server.update", rpc.ServerUpdateParams{Version: "0.26.0-alpha.1"})
		if resp.Error != nil {
			t.Fatalf("server.update failed: %s", resp.Error.Message)
		}
		if string(resp.Result) != "{}" {
			t.Errorf("result = %s, want {}", resp.Result)
		}
		want := selfinstall.Release{
			Version:      "0.26.0-alpha.1",
			AssetName:    "pockode-test-arch",
			AssetURL:     "https://example.test/v0.26.0-alpha.1/pockode-test-arch",
			ChecksumsURL: "https://example.test/v0.26.0-alpha.1/checksums.txt",
		}
		if len(env.installer.installed) != 1 || env.installer.installed[0] != want {
			t.Errorf("installed %+v, want %+v", env.installer.installed, want)
		}
		if env.restarter.Pending() {
			t.Error("an install requested a restart")
		}
	})

	t.Run("refuses what is not on offer, without installing", func(t *testing.T) {
		unavailable := func(reason release.UnavailableReason) release.Status {
			st := published()
			st.Candidates[0].Asset = nil
			st.Candidates[0].Unavailable = &release.Unavailable{Reason: reason, Message: "Release v0.25.0 lacks it."}
			return st
		}
		for _, tc := range []struct {
			name      string
			status    release.Status
			available error
			busy      bool
			version   string
			want      string
		}{
			{name: "not a candidate", status: published(), version: "0.23.0", want: rpc.UpdateFailedReleaseGone},
			{name: "already installed", status: published(), version: "0.24.0", want: rpc.UpdateFailedReleaseGone},
			{name: "no longer published", status: release.Status{CheckedAt: checkedAt}, version: "0.25.0", want: rpc.UpdateFailedReleaseGone},
			{name: "no asset", status: unavailable(release.ReasonNoAsset), version: "0.25.0", want: rpc.UpdateFailedNoAsset},
			{name: "no checksums", status: unavailable(release.ReasonNoChecksums), version: "0.25.0", want: rpc.UpdateFailedNoChecksums},
			{name: "cannot install here", status: published(), version: "0.25.0", want: rpc.UpdateFailedNotInstallable,
				available: &selfinstall.UnavailableError{Reason: selfinstall.ReasonContainer}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				env := newTestEnv(t, &mockAgent{})
				env.releases.set(tc.status)
				env.installer.available = tc.available
				restarttest.Install(t, "0.24.0")

				reason, message := updateFailure(t, env.call("server.update", rpc.ServerUpdateParams{Version: tc.version}))
				if reason != tc.want || message == "" {
					t.Errorf("reason = %q (%q), want %q with a message", reason, message, tc.want)
				}
				if len(env.installer.installed) != 0 {
					t.Error("installed anyway")
				}
			})
		}
	})

	t.Run("invalid params", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		for _, params := range []any{nil, rpc.ServerUpdateParams{}} {
			if resp := env.call("server.update", params); resp.Error == nil || resp.Error.Code != -32602 {
				t.Errorf("server.update %v = %+v, want invalid params", params, resp.Error)
			}
		}
	})

	t.Run("each install failure keeps its reason and message", func(t *testing.T) {
		for _, tc := range []struct {
			err  error
			want string
		}{
			{&selfinstall.InstallError{Failure: selfinstall.FailureDownload, Err: errors.New("dial tcp: no route")}, rpc.UpdateFailedDownload},
			{&selfinstall.InstallError{Failure: selfinstall.FailureNoAsset, Err: errors.New("checksums.txt does not list it")}, rpc.UpdateFailedNoAsset},
			{&selfinstall.InstallError{Failure: selfinstall.FailureNoChecksums, Err: errors.New("404")}, rpc.UpdateFailedNoChecksums},
			{&selfinstall.InstallError{Failure: selfinstall.FailureChecksumMismatch, Err: errors.New("sha256 differs")}, rpc.UpdateFailedChecksumMismatch},
			{&selfinstall.InstallError{Failure: selfinstall.FailureNotRunnable, Err: errors.New("exec format error")}, rpc.UpdateFailedNotRunnable},
			{&selfinstall.InstallError{Failure: selfinstall.FailureReplace, Err: errors.New("access denied")}, rpc.UpdateFailedReplace},
			{&selfinstall.InstallError{Failure: selfinstall.FailureRestore, Err: errors.New("the old file is at X")}, rpc.UpdateFailedRestore},
			{selfinstall.ErrBusy, rpc.UpdateFailedAlreadyInstalling},
			// Another install finished between the check and the lock.
			{fmt.Errorf("%w: 0.26.0-alpha.1 is installed", selfinstall.ErrNotNewer), rpc.UpdateFailedReleaseGone},
			{&selfinstall.UnavailableError{Reason: selfinstall.ReasonNotWritable, Dir: "/opt", Err: errors.New("denied")}, rpc.UpdateFailedNotInstallable},
			{errors.New("read the executable: gone"), ""},
		} {
			t.Run(fmt.Sprint(tc.want, " ", tc.err), func(t *testing.T) {
				env := newTestEnv(t, &mockAgent{})
				env.releases.set(published())
				env.installer.install = func(context.Context, selfinstall.Release) error { return tc.err }
				restarttest.Install(t, "0.24.0")

				reason, message := updateFailure(t, env.call("server.update", rpc.ServerUpdateParams{Version: "0.25.0"}))
				if reason != tc.want {
					t.Errorf("reason = %q, want %q", reason, tc.want)
				}
				if tc.want != rpc.UpdateFailedAlreadyInstalling && !strings.Contains(message, tc.err.Error()) {
					t.Errorf("message = %q, want it to carry %q", message, tc.err.Error())
				}
			})
		}
	})

	t.Run("an install under way is reported, and a second is refused", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		env.releases.set(published())
		restarttest.Install(t, "0.24.0")
		started, finish := make(chan struct{}), make(chan struct{})
		env.installer.install = func(context.Context, selfinstall.Release) error {
			close(started)
			<-finish
			return nil
		}

		first := env.send("server.update", rpc.ServerUpdateParams{Version: "0.25.0"})
		<-started
		// The lock this install holds makes Busy true too; this process's
		// own install is still told with its details.
		env.installer.stateMu.Lock()
		env.installer.busy = true
		env.installer.stateMu.Unlock()

		got := updateCheck(t, env, nil)
		if i := got.Installing; i == nil || i.Version != "0.25.0" || i.Channel != "latest" || i.StartedAt == nil {
			t.Errorf("installing = %+v, want 0.25.0 (latest) with its start", i)
		}
		reason, _ := updateFailure(t, env.call("server.update", rpc.ServerUpdateParams{Version: "0.26.0-alpha.1"}))
		if reason != rpc.UpdateFailedAlreadyInstalling {
			t.Errorf("second install: reason = %q, want %q", reason, rpc.UpdateFailedAlreadyInstalling)
		}

		close(finish)
		if resp := env.awaitResponse(first); resp.Error != nil {
			t.Fatalf("first install failed: %s", resp.Error.Message)
		}
		env.installer.stateMu.Lock()
		env.installer.busy = false // the lock went with the install
		env.installer.stateMu.Unlock()
		if got := updateCheck(t, env, nil); got.Installing != nil {
			t.Errorf("installing = %+v after it ended", got.Installing)
		}
	})
}

// The install belongs to the process: a client that goes away does not stop
// it, and only its own budget does — which is a timeout however the step that
// noticed wrapped it.
func TestUpdater_InstallOutlivesTheRequest(t *testing.T) {
	checker := &fakeReleaseChecker{status: published()}
	installer := &fakeInstaller{}
	u := NewUpdater(checker, installer)
	u.timeout = 50 * time.Millisecond
	installer.install = func(ctx context.Context, rel selfinstall.Release) error {
		<-ctx.Done()
		return &selfinstall.InstallError{Failure: selfinstall.FailureInterrupted, Err: errors.New("unexpected EOF")}
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	installed := func(context.Context) string { return "0.24.0" }
	err := u.install(ctx, "0.25.0", installed, slog.New(slog.DiscardHandler))
	if time.Since(start) < u.timeout {
		t.Error("the install stopped with the request's context")
	}
	var failed *updateFailed
	if !errors.As(err, &failed) || failed.reason != rpc.UpdateFailedTimeout {
		t.Errorf("err = %v, want a timeout", err)
	}
}

// On shutdown, Close ends an install short of its replacement at once, so
// that its request answers instead of holding the connections; that is not
// a timeout.
func TestUpdater_CloseStopsAnInstall(t *testing.T) {
	installer := &fakeInstaller{}
	u := NewUpdater(&fakeReleaseChecker{status: published()}, installer)
	started := make(chan struct{})
	installer.install = func(ctx context.Context, rel selfinstall.Release) error {
		close(started)
		<-ctx.Done()
		return &selfinstall.InstallError{Failure: selfinstall.FailureInterrupted, Err: ctx.Err()}
	}

	done := make(chan error, 1)
	installed := func(context.Context) string { return "0.24.0" }
	go func() { done <- u.install(context.Background(), "0.25.0", installed, slog.New(slog.DiscardHandler)) }()
	<-started
	u.Close()

	select {
	case err := <-done:
		var failed *updateFailed
		if !errors.As(err, &failed) || failed.reason != "" {
			t.Errorf("err = %v, want a failure without a reason", err)
		}
	case <-time.After(opTimeout):
		t.Fatal("Close did not stop the install")
	}
}
