package cliauth_test

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"testing"

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
