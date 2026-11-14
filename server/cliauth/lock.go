package cliauth

import (
	"context"
	"fmt"
	"time"

	"github.com/pockode/server/session"
)

// cliLock is one CLI's lock, taken around everything that runs one of its auth
// commands. Its state is guarded by Service.loginsMu.
//
// A command — a status read or a sign-out — holds one profile of the CLI. A
// sign-out and a sign-in rewrite the profile's credential file, and so may a
// status read: Claude refreshes expired credentials when asked for its status.
// Nothing inside a CLI coordinates two of its own processes doing that, so a
// read racing a sign-out could write back the credentials it just removed. Two
// profiles keep their credentials apart (their own directories, their own
// Keychain items), so commands on different profiles run side by side: a
// screen reading every profile of Codex would otherwise wait out one 3–12s
// read after another.
//
// A sign-in or an update holds the whole CLI. An update replaces the binary
// every profile runs; a CLI signs in one profile at a time, and while it does,
// every profile reads as StateSigningIn (see busyStatus).
//
// Waiting for it can be given up on — a caller whose client has gone must not
// stay queued behind a sign-out — so waiters watch changed rather than block
// on a sync.Mutex.
type cliLock struct {
	// exclusive is held by a sign-in or an update.
	exclusive bool
	// profiles are the profiles a command is running for.
	profiles map[string]bool
	// changed is closed, and replaced, whenever the lock is released or the
	// CLI becomes busy: what waits for the lock has to learn that a sign-in or
	// an update now holds it for minutes, rather than wait for it.
	changed chan struct{}
}

func newCLILock() *cliLock {
	return &cliLock{profiles: make(map[string]bool), changed: make(chan struct{})}
}

// signal wakes everything waiting on l. Callers hold loginsMu.
func (l *cliLock) signal() {
	close(l.changed)
	l.changed = make(chan struct{})
}

// lockWaitTimeout bounds how long a call waits for another command on the same
// CLI to finish. The caller's own context is the connection's and ends only when
// the client goes away, so without it a Codex read queued behind a Codex
// sign-out could take both of their 45s budgets — past the point where the
// client has stopped waiting. 20s on top of the longest budget (45s) keeps a
// reply within the 75s the client gives agent-starting requests; see
// docs/code/cli-auth.md.
const lockWaitTimeout = 20 * time.Second

// lockUntilDone takes all of agentType for a sign-in or an update, waiting
// until ctx is done. lockWaitTimeout is not for them: that bounds a request
// someone is waiting on, and each has a deadline of its own. Queued behind a
// slow Codex read, one would otherwise fail as "another command was running".
func (s *Service) lockUntilDone(ctx context.Context, agentType session.AgentType) (unlock func(), err error) {
	l := s.locks[agentType]
	for {
		s.loginsMu.Lock()
		if !l.exclusive && len(l.profiles) == 0 {
			l.exclusive = true
			s.loginsMu.Unlock()
			return func() {
				s.loginsMu.Lock()
				l.exclusive = false
				l.signal()
				s.loginsMu.Unlock()
			}, nil
		}
		changed := l.changed
		s.loginsMu.Unlock()

		select {
		case <-changed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// lockUnlessBusy takes profileID of agentType for a command, or gives up after
// lockWaitTimeout or when ctx is done, whichever comes first — unless a
// sign-in or an update is running on the CLI, or starts while this waits: that
// holds the lock for minutes, so the status it leaves the CLI in is returned
// instead, and no lock.
func (s *Service) lockUnlessBusy(ctx context.Context, agentType session.AgentType, profileID string) (unlock func(), busy *Status, err error) {
	l := s.locks[agentType]
	timer := time.NewTimer(lockWaitTimeout)
	defer timer.Stop()
	for {
		s.loginsMu.Lock()
		if busy := s.busyStatus(agentType); busy != nil {
			s.loginsMu.Unlock()
			return nil, busy, nil
		}
		if !l.exclusive && !l.profiles[profileID] {
			l.profiles[profileID] = true
			s.loginsMu.Unlock()
			return func() {
				s.loginsMu.Lock()
				delete(l.profiles, profileID)
				l.signal()
				s.loginsMu.Unlock()
			}, nil, nil
		}
		changed := l.changed
		s.loginsMu.Unlock()

		select {
		case <-changed:
		case <-timer.C:
			return nil, nil, lockTimeoutError(agentType)
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		}
	}
}

func lockTimeoutError(agentType session.AgentType) error {
	return fmt.Errorf("another %s sign-in command was still running after %s; try again", agentType, lockWaitTimeout)
}

// busyStatus is agentType's status while a sign-in or an update holds it, or
// nil. A sign-in makes every profile of the CLI busy, so the status names the
// profile it is for in LoginProfileID. Callers hold loginsMu.
func (s *Service) busyStatus(agentType session.AgentType) *Status {
	if id := s.updating[agentType]; id != "" {
		return &Status{State: StateUpdating, UpdateID: id}
	}
	if f := s.runningLogin(agentType); f != nil {
		return &Status{State: StateSigningIn, LoginID: f.login.ID, LoginProfileID: f.login.ProfileID}
	}
	return nil
}

// markBusy wakes whatever waits for agentType's lock, which a sign-in or an
// update has just taken over. Callers hold loginsMu.
func (s *Service) markBusy(agentType session.AgentType) {
	s.locks[agentType].signal()
}
