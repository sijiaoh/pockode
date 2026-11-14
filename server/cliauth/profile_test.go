package cliauth_test

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"testing"
	"time"

	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliauth/cliauthtest"
	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/session"
)

// Each command runs as the profile it names, or the current one, and says
// which one that was.
func TestProfileSelection(t *testing.T) {
	profiles := cliprofile.NewStore(t.TempDir())
	work, err := profiles.Add(session.AgentTypeClaude, "Work")
	if err != nil {
		t.Fatal(err)
	}
	provider := cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}})
	s := cliauth.NewService(slog.Default(), profiles)
	s.Register(session.AgentTypeClaude, provider)
	t.Cleanup(s.Close)
	ctx := context.Background()

	statuses, err := s.Statuses(ctx, session.AgentTypeClaude, cliprofile.Select(work.ID))
	if err != nil || statuses[0].ProfileID != work.ID {
		t.Errorf("named profile: Statuses = %+v, %v; want it read for %s", statuses, err, work.ID)
	}
	// The default profile is current: Work was only added.
	statuses, err = s.Statuses(ctx, session.AgentTypeClaude, cliprofile.SelectCurrent())
	if err != nil || statuses[0].ProfileID != "" {
		t.Errorf("current profile: Statuses = %+v, %v; want it read for the default", statuses, err)
	}
	if _, err := s.Statuses(ctx, "", cliprofile.Select(work.ID)); !errors.Is(err, cliauth.ErrProfileWithoutAgent) {
		t.Errorf("profile without its CLI: got %v, want ErrProfileWithoutAgent", err)
	}

	st, err := s.Logout(ctx, session.AgentTypeClaude, cliprofile.Select(work.ID))
	if err != nil || st.ProfileID != work.ID {
		t.Errorf("Logout = %+v, %v; want it for %s", st, err, work.ID)
	}

	login, err := s.StartLogin(session.AgentTypeClaude, "", cliprofile.Select(work.ID))
	if err != nil || login.ProfileID != work.ID {
		t.Fatalf("StartLogin = %+v, %v; want it for %s", login, err, work.ID)
	}
	awaitLogin(t, s, inPhase(cliauth.LoginWaiting))
	// A CLI signs in one profile at a time: asking again for the same one
	// lands in the running sign-in, asking for another is refused.
	if again, err := s.StartLogin(session.AgentTypeClaude, "", cliprofile.Select(work.ID)); err != nil || again.ID != login.ID {
		t.Errorf("same profile again: StartLogin = %+v, %v; want the running sign-in", again, err)
	}
	if _, err := s.StartLogin(session.AgentTypeClaude, "", cliprofile.SelectCurrent()); !errors.Is(err, cliauth.ErrLoginInProgress) {
		t.Errorf("another profile: got %v, want ErrLoginInProgress", err)
	}

	want := []string{work.ID, "", work.ID, work.ID}
	if got := provider.Profiles(); !slices.Equal(got, want) {
		t.Errorf("provider ran as %q, want %q (status, status, sign-out, sign-in)", got, want)
	}
}

// A profile ID comes from a client: one the CLI does not have is refused
// before anything runs, rather than starting the CLI in a directory of its
// choosing.
func TestUnknownProfileIsRefused(t *testing.T) {
	provider := cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}})
	s := cliauth.NewService(slog.Default(), cliprofile.NewStore(t.TempDir()))
	s.Register(session.AgentTypeClaude, provider)
	t.Cleanup(s.Close)
	ctx := context.Background()

	for _, id := range []string{"0198f3c2-0000-7000-8000-000000000000", "../../etc", "not-an-id"} {
		sel := cliprofile.Select(id)
		if _, err := s.Statuses(ctx, session.AgentTypeClaude, sel); !errors.Is(err, cliprofile.ErrNotFound) {
			t.Errorf("Statuses(%q): got %v, want ErrNotFound", id, err)
		}
		if _, err := s.ProfileStatuses(ctx, session.AgentTypeClaude, []string{"", id}); !errors.Is(err, cliprofile.ErrNotFound) {
			t.Errorf("ProfileStatuses(%q): got %v, want ErrNotFound", id, err)
		}
		if _, err := s.Logout(ctx, session.AgentTypeClaude, sel); !errors.Is(err, cliprofile.ErrNotFound) {
			t.Errorf("Logout(%q): got %v, want ErrNotFound", id, err)
		}
		if _, err := s.StartLogin(session.AgentTypeClaude, "", sel); !errors.Is(err, cliprofile.ErrNotFound) {
			t.Errorf("StartLogin(%q): got %v, want ErrNotFound", id, err)
		}
	}
	if got := provider.Profiles(); len(got) != 0 {
		t.Errorf("provider ran as %q; want nothing run", got)
	}
}

func TestEveryProfileStatuses(t *testing.T) {
	profiles := cliprofile.NewStore(t.TempDir())
	work := mustAddProfile(t, profiles, session.AgentTypeClaude, "Work")
	home := mustAddProfile(t, profiles, session.AgentTypeClaude, "Home")
	codexWork := mustAddProfile(t, profiles, session.AgentTypeCodex, "Work")
	s := cliauth.NewService(slog.Default(), profiles)
	s.Register(session.AgentTypeClaude, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}}))
	s.Register(session.AgentTypeCodex, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedOut}}))
	t.Cleanup(s.Close)
	ctx := context.Background()

	type row struct {
		agent   session.AgentType
		profile string
	}
	rows := func(statuses []cliauth.Status) []row {
		var got []row
		for _, st := range statuses {
			got = append(got, row{st.Agent, st.ProfileID})
		}
		return got
	}

	statuses, err := s.EveryProfileStatuses(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []row{{"claude", ""}, {"claude", work.ID}, {"claude", home.ID}, {"codex", ""}, {"codex", codexWork.ID}}
	if got := rows(statuses); !slices.Equal(got, want) {
		t.Errorf("every CLI: got %v, want %v", got, want)
	}

	statuses, err = s.EveryProfileStatuses(ctx, session.AgentTypeCodex)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := rows(statuses), want[3:]; !slices.Equal(got, want) {
		t.Errorf("codex: got %v, want %v", got, want)
	}

	// In the order asked, which need not be the stored one.
	statuses, err = s.ProfileStatuses(ctx, session.AgentTypeClaude, []string{home.ID, ""})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := rows(statuses), []row{{"claude", home.ID}, {"claude", ""}}; !slices.Equal(got, want) {
		t.Errorf("ProfileStatuses: got %v, want %v", got, want)
	}
	if _, err := s.ProfileStatuses(ctx, "", []string{""}); !errors.Is(err, cliauth.ErrProfileWithoutAgent) {
		t.Errorf("ProfileStatuses without a CLI: got %v, want ErrProfileWithoutAgent", err)
	}
	if _, err := s.EveryProfileStatuses(ctx, "gemini"); !errors.Is(err, cliauth.ErrUnknownAgent) {
		t.Errorf("unknown CLI: got %v, want ErrUnknownAgent", err)
	}
}

// Each read of a CLI's profiles runs at once: one Codex read takes 3–12s, and
// a screen listing several profiles must not wait them out one after another.
func TestEveryProfileStatuses_ReadsConcurrently(t *testing.T) {
	profiles := cliprofile.NewStore(t.TempDir())
	mustAddProfile(t, profiles, session.AgentTypeClaude, "Work")
	mustAddProfile(t, profiles, session.AgentTypeClaude, "Home")
	p := blockingProvider{
		Provider: cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}}),
		entered:  make(chan struct{}),
		release:  make(chan struct{}),
	}
	s := cliauth.NewService(slog.Default(), profiles)
	s.Register(session.AgentTypeClaude, p)
	t.Cleanup(s.Close)

	done := make(chan []cliauth.Status)
	go func() {
		statuses, err := s.EveryProfileStatuses(context.Background(), session.AgentTypeClaude)
		if err != nil {
			t.Errorf("EveryProfileStatuses: %v", err)
		}
		done <- statuses
	}()
	for i := range 3 {
		select {
		case <-p.entered:
		case <-time.After(5 * time.Second):
			t.Fatalf("only %d of 3 profiles were being read at once", i)
		}
	}
	close(p.release)
	for _, st := range <-done {
		if st.State != cliauth.StateSignedIn {
			t.Errorf("got %+v, want signed in", st)
		}
	}
}

// While one profile signs in every profile of the CLI reads as signing in, and
// each says which profile the sign-in is for, so a client can tell the one
// signing in from the ones waiting for it.
func TestStatusesDuringSignIn_NameTheProfileSigningIn(t *testing.T) {
	profiles := cliprofile.NewStore(t.TempDir())
	work := mustAddProfile(t, profiles, session.AgentTypeClaude, "Work")
	s := cliauth.NewService(slog.Default(), profiles)
	s.Register(session.AgentTypeClaude, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedOut}}))
	t.Cleanup(s.Close)

	login, err := s.StartLogin(session.AgentTypeClaude, "", cliprofile.Select(work.ID))
	if err != nil {
		t.Fatal(err)
	}
	awaitLogin(t, s, inPhase(cliauth.LoginWaiting))

	statuses, err := s.EveryProfileStatuses(context.Background(), session.AgentTypeClaude)
	if err != nil {
		t.Fatal(err)
	}
	for i, wantProfile := range []string{"", work.ID} {
		st := statuses[i]
		if st.ProfileID != wantProfile || st.State != cliauth.StateSigningIn || st.LoginID != login.ID || st.LoginProfileID != work.ID {
			t.Errorf("profile %q: got %+v, want signing_in by sign-in %s for %s", wantProfile, st, login.ID, work.ID)
		}
	}
}

func mustAddProfile(t *testing.T, s *cliprofile.Store, agent session.AgentType, name string) cliprofile.Profile {
	t.Helper()
	p, err := s.Add(agent, name)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
