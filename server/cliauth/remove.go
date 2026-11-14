package cliauth

import (
	"context"
	"errors"
	"fmt"

	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/session"
)

// Why RemoveProfile refused. Nothing was changed: the profile is still listed,
// still signed in as it was, and its directory is untouched.
var (
	// ErrRemoveDefault is the default profile, which is the CLI's own directory
	// and is never stored.
	ErrRemoveDefault = errors.New("the default profile cannot be removed")
	// ErrRemoveCurrent is the current profile: the sessions of every Pockode
	// process would start their next CLI as it.
	ErrRemoveCurrent = errors.New("the current profile cannot be removed; switch to another profile first")
	// ErrProfileRemoving is a profile this server is removing right now. A
	// second removal, a switch to it and a sign-in to it are refused with it.
	ErrProfileRemoving = errors.New("the profile is being removed")
	// ErrSignOutFailed is a sign-out that failed before the removal: removing
	// the directory anyway would leave whatever the CLI keeps outside it —
	// Claude Code's Keychain item on macOS — where nothing can reach it again.
	ErrSignOutFailed = errors.New("the profile could not be signed out, so it was kept")
	// ErrReleaseTimedOut is a release that did not return in time — CLIs that
	// were told to stop still exiting. The ones stopped stay stopped; a later
	// removal has only to wait out what is left of them.
	ErrReleaseTimedOut = errors.New("the CLIs running as the profile did not exit in time, so it was kept; try again")
)

// refusal is a sentinel error with a message of its own, so the message can
// name the case while errors.Is still finds the sentinel.
type refusal struct {
	sentinel error
	message  string
}

func (r *refusal) Error() string { return r.message }
func (r *refusal) Unwrap() error { return r.sentinel }

// SwitchProfile makes id agentType's current profile ("" the default one),
// unless this server is removing it.
//
// It goes through here rather than straight to the store because of that
// check: a removal decides the profile is not current and then stops the CLIs
// running as it, and a switch landing in between would start new ones.
func (s *Service) SwitchProfile(agentType session.AgentType, id string) error {
	if _, ok := s.providers[agentType]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	s.switchMu.Lock()
	defer s.switchMu.Unlock()
	s.loginsMu.Lock()
	removing := s.removing[agentType][id]
	s.loginsMu.Unlock()
	if removing {
		return removingError(agentType)
	}
	return s.profiles.SetCurrent(agentType, id)
}

// RemoveProfile signs the profile id of agentType out and removes it, its
// directory with it — or refuses, changing nothing.
//
// In order:
//
//  1. The profile is marked as being removed, and refused if it is current
//     (ErrRemoveCurrent). From here until the end no switch to it and no
//     sign-in to it can start on this server (ErrProfileRemoving).
//  2. Its lock is taken, as a sign-out takes it, so that no status read or
//     sign-out runs as it meanwhile. A sign-in or an update of the CLI refuses
//     the removal (ErrLoginInProgress, ErrUpdating): either holds the CLI for
//     minutes, and a sign-in writes into this very directory.
//  3. release stops this server's CLIs running as the profile. An error from
//     it is returned as it is, before anything else has changed: a session
//     mid-turn on the profile keeps it, signed in, until the user tries again.
//     Waiting for the lock and release share lockWaitTimeout, counted from
//     when the wait starts; a release still running then is refused
//     (ErrReleaseTimedOut). That keeps a removal within what a sign-out takes
//     — 20s for the lock and the sign-out's own budget — and so within the
//     time the client waits (docs/code/cli-auth.md#timeouts).
//  4. The profile is signed out (ErrSignOutFailed otherwise). After release,
//     so that a refusal there leaves the profile signed in, and so that no
//     CLI of this server still running as it can write back the credentials.
//  5. cliprofile.Store.Remove: the list first, then the directory.
//
// release must not hold the profile list's lock (see
// worktree.Manager.ReleaseProfile); it runs with none of the Service's locks
// held but the profile's own.
//
// Where profiles cannot be used (cliprofile.Availability), step 4 is skipped:
// no CLI can run as the profile here to sign it out, and the only place a
// CLI keeps credentials outside the directory is the macOS Keychain, on a
// system where profiles can always be used.
func (s *Service) RemoveProfile(ctx context.Context, agentType session.AgentType, id string, release func(context.Context) error) error {
	p, ok := s.providers[agentType]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	if id == "" {
		return ErrRemoveDefault
	}
	if err := s.profiles.Check(agentType, cliprofile.Select(id)); err != nil {
		return err
	}
	ctx, end, err := s.beginCommand(ctx)
	if err != nil {
		return err
	}
	defer end()

	done, err := s.beginRemove(agentType, id)
	if err != nil {
		return err
	}
	defer done()

	releaseCtx, cancelRelease := context.WithTimeout(ctx, s.releaseTimeout)
	defer cancelRelease()
	unlock, busy, err := s.lockUnlessBusy(ctx, agentType, id)
	if err != nil {
		return err
	}
	if busy != nil {
		return removeBusyError(agentType, id, busy)
	}
	defer unlock()
	// Again, now that nothing on this server can remove it: a removal that
	// ended while this one was starting would otherwise read here as a
	// sign-out failing for a profile that is no longer there.
	if err := s.profiles.Check(agentType, cliprofile.Select(id)); err != nil {
		return err
	}

	if err := release(releaseCtx); err != nil {
		if ctx.Err() == nil && errors.Is(err, context.DeadlineExceeded) {
			s.log.Warn("AI CLIs running as a profile being removed did not exit in time", "cli", agentType, "profile", id, "error", err)
			return ErrReleaseTimedOut
		}
		return err
	}

	if a := s.profiles.Availability(); a.Available {
		if _, err := p.Logout(ctx, id); err != nil {
			s.log.Warn("AI CLI sign-out before removing a profile failed", "cli", agentType, "profile", id, "error", err)
			return &refusal{ErrSignOutFailed, fmt.Sprintf("%s: %v", ErrSignOutFailed, err)}
		}
	} else {
		s.log.Info("not signing out a profile before removing it: profiles cannot be used here", "cli", agentType, "profile", id, "reason", a.Reason)
	}

	if err := s.profiles.Remove(agentType, id); err != nil {
		return err
	}
	s.log.Info("AI CLI profile removed", "cli", agentType, "profile", id)
	return nil
}

// beginRemove marks id as being removed, unless it is current or already
// being removed. done takes the mark off.
func (s *Service) beginRemove(agentType session.AgentType, id string) (done func(), err error) {
	s.switchMu.Lock()
	defer s.switchMu.Unlock()

	s.loginsMu.Lock()
	if s.removing[agentType][id] {
		s.loginsMu.Unlock()
		return nil, removingError(agentType)
	}
	if s.removing[agentType] == nil {
		s.removing[agentType] = make(map[string]bool)
	}
	s.removing[agentType][id] = true
	s.loginsMu.Unlock()
	done = func() {
		s.loginsMu.Lock()
		delete(s.removing[agentType], id)
		s.loginsMu.Unlock()
	}

	// Read with the mark set and switchMu held: a switch to the profile has
	// either been written already, and is read here, or will see the mark.
	list, err := s.profiles.Load(agentType)
	if err != nil {
		done()
		return nil, err
	}
	if list.Current == id {
		done()
		return nil, ErrRemoveCurrent
	}
	return done, nil
}

func removingError(agentType session.AgentType) error {
	return &refusal{ErrProfileRemoving, fmt.Sprintf("this %s profile is being removed", agentType)}
}

func removeBusyError(agentType session.AgentType, id string, busy *Status) error {
	switch {
	case busy.State == StateUpdating:
		return updatingError(agentType)
	case busy.LoginProfileID == id:
		return &refusal{ErrLoginInProgress, fmt.Sprintf("a sign-in to this %s profile is in progress; cancel it before removing the profile", agentType)}
	default:
		return &refusal{ErrLoginInProgress, fmt.Sprintf("a sign-in to another %s profile is in progress; finish or cancel it before removing this one", agentType)}
	}
}
