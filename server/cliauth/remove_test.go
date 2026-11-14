package cliauth_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliauth/cliauthtest"
	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/session"
)

type removeFixture struct {
	t        *testing.T
	profiles *cliprofile.Store
	provider *cliauthtest.Provider
	s        *cliauth.Service
	work     cliprofile.Profile
	workDir  string
	// signsOut is whether a removal signs out here: not where profiles
	// cannot be used (Windows without Developer Mode).
	signsOut bool
}

func newRemoveFixture(t *testing.T) *removeFixture {
	profiles := cliprofile.NewStore(t.TempDir())
	work := mustAddProfile(t, profiles, session.AgentTypeClaude, "Work")
	dir, err := profiles.Dir(session.AgentTypeClaude, work.ID)
	if err != nil {
		t.Fatal(err)
	}
	// What a sign-in leaves behind, standing in for the whole directory.
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}})
	s := cliauth.NewService(slog.Default(), profiles)
	s.Register(session.AgentTypeClaude, provider)
	t.Cleanup(s.Close)
	return &removeFixture{t: t, profiles: profiles, provider: provider, s: s, work: work, workDir: dir,
		signsOut: profiles.Availability().Available}
}

func (f *removeFixture) remove(release func(context.Context) error) error {
	return f.s.RemoveProfile(context.Background(), session.AgentTypeClaude, f.work.ID, release)
}

// requireKept checks that a refused removal changed nothing: the profile is
// listed, its directory is there, and it was never signed out.
func (f *removeFixture) requireKept() {
	f.t.Helper()
	if err := f.profiles.Check(session.AgentTypeClaude, cliprofile.Select(f.work.ID)); err != nil {
		f.t.Errorf("profile no longer listed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.workDir, ".credentials.json")); err != nil {
		f.t.Errorf("profile directory touched: %v", err)
	}
	if slices.Contains(f.provider.Profiles(), f.work.ID) {
		f.t.Errorf("provider ran as the profile (%q); a refused removal must not sign it out", f.provider.Profiles())
	}
}

func noRelease(context.Context) error { return nil }

// Removing releases this server's CLIs on the profile first, then signs it
// out while it is still listed, and only then takes it off the list and
// deletes its directory.
func TestRemoveProfile(t *testing.T) {
	f := newRemoveFixture(t)
	released := false
	err := f.remove(func(context.Context) error {
		released = true
		if len(f.provider.Profiles()) != 0 {
			t.Error("signed out before this server's CLIs were released")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("RemoveProfile: %v", err)
	}
	if !released {
		t.Error("release was never called")
	}
	want := []string{f.work.ID}
	if !f.signsOut {
		want = nil
	}
	if got := f.provider.Profiles(); !slices.Equal(got, want) {
		t.Errorf("provider ran as %q, want %q (one sign-out of the profile)", got, want)
	}
	if err := f.profiles.Check(session.AgentTypeClaude, cliprofile.Select(f.work.ID)); !errors.Is(err, cliprofile.ErrNotFound) {
		t.Errorf("profile still listed: %v", err)
	}
	if _, err := os.Stat(f.workDir); !os.IsNotExist(err) {
		t.Errorf("profile directory still there: %v", err)
	}
}

func TestRemoveProfile_RefusesTheDefaultAndTheCurrentProfile(t *testing.T) {
	f := newRemoveFixture(t)
	release := func(context.Context) error {
		t.Error("release called for a removal that is refused")
		return nil
	}
	if err := f.s.RemoveProfile(context.Background(), session.AgentTypeClaude, "", release); !errors.Is(err, cliauth.ErrRemoveDefault) {
		t.Errorf("default profile: got %v, want ErrRemoveDefault", err)
	}
	if err := f.s.SwitchProfile(session.AgentTypeClaude, f.work.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.remove(release); !errors.Is(err, cliauth.ErrRemoveCurrent) {
		t.Errorf("current profile: got %v, want ErrRemoveCurrent", err)
	}
	f.requireKept()
}

// A session mid-turn on the profile keeps it: what release reports is
// returned before the profile is signed out or anything is removed.
func TestRemoveProfile_RefusedWhileInUse(t *testing.T) {
	f := newRemoveFixture(t)
	inUse := errors.New("1 session is mid-turn")
	if err := f.remove(func(context.Context) error { return inUse }); !errors.Is(err, inUse) {
		t.Fatalf("got %v, want release's error", err)
	}
	f.requireKept()
}

// A release still waiting for CLIs to exit when the budget runs out keeps the
// profile, and the removal ends within the budget rather than when the
// connection does — the client stops waiting long before that.
func TestRemoveProfile_ReleaseTimesOut(t *testing.T) {
	f := newRemoveFixture(t)
	f.s.SetReleaseTimeout(50 * time.Millisecond)
	err := f.remove(func(ctx context.Context) error {
		<-ctx.Done()
		return fmt.Errorf("release profile in worktree %q: %w", "", ctx.Err())
	})
	if !errors.Is(err, cliauth.ErrReleaseTimedOut) {
		t.Fatalf("got %v, want ErrReleaseTimedOut", err)
	}
	f.requireKept()
}

// A failed sign-out keeps the profile: deleting the directory anyway would
// leave the Keychain item Claude Code keeps on macOS out of anyone's reach.
func TestRemoveProfile_SignOutFails(t *testing.T) {
	f := newRemoveFixture(t)
	if !f.signsOut {
		// Nothing is signed out where profiles cannot be used, so there is
		// no failure to refuse on; TestRemoveProfile covers that case.
		if err := f.remove(noRelease); err != nil {
			t.Fatalf("RemoveProfile: %v", err)
		}
		return
	}
	f.provider.Set(cliauthtest.State{
		Status:    cliauth.Status{State: cliauth.StateSignedIn},
		LogoutErr: errors.New("keychain locked"),
	})
	err := f.remove(noRelease)
	if !errors.Is(err, cliauth.ErrSignOutFailed) {
		t.Fatalf("got %v, want ErrSignOutFailed", err)
	}
	if err := f.profiles.Check(session.AgentTypeClaude, cliprofile.Select(f.work.ID)); err != nil {
		t.Errorf("profile no longer listed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.workDir, ".credentials.json")); err != nil {
		t.Errorf("profile directory touched: %v", err)
	}
}

// A sign-in holds the CLI and, to this profile, writes into its directory:
// the removal is refused, whichever profile it is for, and says which.
func TestRemoveProfile_RefusedWhileSigningIn(t *testing.T) {
	for _, tt := range []struct {
		name    string
		profile func(f *removeFixture) cliprofile.Selector
	}{
		{"this profile", func(f *removeFixture) cliprofile.Selector { return cliprofile.Select(f.work.ID) }},
		{"another profile", func(*removeFixture) cliprofile.Selector { return cliprofile.Select("") }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newRemoveFixture(t)
			login, err := f.s.StartLogin(session.AgentTypeClaude, "", tt.profile(f))
			if err != nil {
				t.Fatal(err)
			}
			awaitLogin(t, f.s, inPhase(cliauth.LoginWaiting))

			release := func(context.Context) error {
				t.Error("release called while a sign-in runs")
				return nil
			}
			if err := f.remove(release); !errors.Is(err, cliauth.ErrLoginInProgress) {
				t.Errorf("got %v, want ErrLoginInProgress", err)
			}
			if _, err := f.s.CancelLogin(login.ID); err != nil {
				t.Fatal(err)
			}
			// The sign-in ran as the profile; nothing else may have.
			if got := f.provider.Profiles(); len(got) != 1 {
				t.Errorf("provider ran as %q, want the sign-in alone", got)
			}
			if err := f.profiles.Check(session.AgentTypeClaude, cliprofile.Select(f.work.ID)); err != nil {
				t.Errorf("profile no longer listed: %v", err)
			}

			if err := f.remove(noRelease); err != nil {
				t.Errorf("once the sign-in is cancelled: %v", err)
			}
		})
	}
}

// While a removal runs, nothing on this server can start using the profile
// again: a switch to it, a sign-in to it, a second removal.
func TestRemoveProfile_BlocksWhatWouldUseTheProfile(t *testing.T) {
	f := newRemoveFixture(t)
	inRelease := make(chan struct{})
	proceed := make(chan struct{})
	removed := make(chan error, 1)
	go func() {
		removed <- f.remove(func(context.Context) error {
			close(inRelease)
			<-proceed
			return nil
		})
	}()
	<-inRelease

	if err := f.s.SwitchProfile(session.AgentTypeClaude, f.work.ID); !errors.Is(err, cliauth.ErrProfileRemoving) {
		t.Errorf("switch: got %v, want ErrProfileRemoving", err)
	}
	if _, err := f.s.StartLogin(session.AgentTypeClaude, "", cliprofile.Select(f.work.ID)); !errors.Is(err, cliauth.ErrProfileRemoving) {
		t.Errorf("sign-in: got %v, want ErrProfileRemoving", err)
	}
	if err := f.remove(noRelease); !errors.Is(err, cliauth.ErrProfileRemoving) {
		t.Errorf("second removal: got %v, want ErrProfileRemoving", err)
	}
	// Other profiles are not held up.
	if err := f.s.SwitchProfile(session.AgentTypeClaude, ""); err != nil {
		t.Errorf("switch to the default profile: %v", err)
	}

	close(proceed)
	if err := <-removed; err != nil {
		t.Fatalf("RemoveProfile: %v", err)
	}
	if err := f.s.SwitchProfile(session.AgentTypeClaude, f.work.ID); !errors.Is(err, cliprofile.ErrNotFound) {
		t.Errorf("switch after the removal: got %v, want ErrNotFound", err)
	}
}
