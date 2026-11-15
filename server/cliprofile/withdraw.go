package cliprofile

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/pockode/server/session"
)

// local is what this process alone knows of its profiles, kept in memory: the
// ones it is removing, and the one-shot CLIs it is running as each.
type local struct {
	mu sync.Mutex
	// withdrawn are the profiles being removed by this process (Withdraw).
	withdrawn map[session.AgentType]map[string]bool
	// holds counts the one-shot CLIs running as each profile
	// (LaunchOneShot).
	holds map[session.AgentType]map[string]int
	// released is closed, and replaced, whenever a hold ends.
	released chan struct{}
}

// Withdraw marks agent's profile id as being removed by this process, until
// restore is called; ok is false if it already is. While it is withdrawn, this
// server reads it as current nowhere — Resolve picks the default profile in
// its place, as it will once the profile is off the list — so a session
// stopped for the removal, or started during it, starts as the default one,
// and no one-shot starts as it. The stored choice is not touched: a removal
// that is refused restores it, and leaves the profile current as it was.
//
// Explicit selections (Select) are not affected: the sign-out a removal runs
// is one of them.
func (s *Store) Withdraw(agent session.AgentType, id string) (restore func(), ok bool) {
	if s == nil {
		return func() {}, true
	}
	s.local.mu.Lock()
	defer s.local.mu.Unlock()
	if s.local.withdrawn[agent][id] {
		return nil, false
	}
	if s.local.withdrawn == nil {
		s.local.withdrawn = make(map[session.AgentType]map[string]bool)
	}
	if s.local.withdrawn[agent] == nil {
		s.local.withdrawn[agent] = make(map[string]bool)
	}
	s.local.withdrawn[agent][id] = true
	return func() {
		s.local.mu.Lock()
		delete(s.local.withdrawn[agent], id)
		s.local.mu.Unlock()
	}, true
}

// Withdrawn reports whether this process is removing agent's profile id.
func (s *Store) Withdrawn(agent session.AgentType, id string) bool {
	if s == nil {
		return false
	}
	s.local.mu.Lock()
	defer s.local.mu.Unlock()
	return s.local.withdrawn[agent][id]
}

// LaunchOneShot is Launch for a short-lived CLI run as the current profile,
// held until release is called, which the caller does once the CLI has
// exited. A removal of the profile by this process waits for its holds to end
// (WaitUnheld) before the directory goes. A profile withdrawn meanwhile, or
// removed by another process between resolving it and preparing it, is not
// started as: the current profile is resolved again, the default one by then.
func (s *Store) LaunchOneShot(agent session.AgentType) (l Launch, release func(), err error) {
	// A profile withdrawn between resolving and holding it is resolved again
	// without counting as a try: that reads the default profile, or the profile
	// itself if the removal was refused meanwhile, which can then be held.
	notFound := map[string]error{}
	for {
		id, err := s.Resolve(agent, SelectCurrent())
		if err != nil {
			return Launch{}, nil, err
		}
		if err := notFound[id]; err != nil {
			return Launch{}, nil, err
		}
		release, ok := s.hold(agent, id)
		if !ok {
			continue
		}
		l, err := s.Launch(agent, Select(id))
		if id != "" && errors.Is(err, ErrNotFound) {
			release()
			notFound[id] = err
			continue
		}
		if err != nil {
			release()
			return Launch{}, nil, err
		}
		return l, release, nil
	}
}

// hold counts one CLI of this process running as agent's profile id, unless
// it is withdrawn. The default profile is never removed, and not counted.
func (s *Store) hold(agent session.AgentType, id string) (release func(), ok bool) {
	if s == nil || id == "" {
		return func() {}, true
	}
	s.local.mu.Lock()
	defer s.local.mu.Unlock()
	if s.local.withdrawn[agent][id] {
		return nil, false
	}
	if s.local.holds == nil {
		s.local.holds = make(map[session.AgentType]map[string]int)
	}
	if s.local.holds[agent] == nil {
		s.local.holds[agent] = make(map[string]int)
	}
	s.local.holds[agent][id]++
	var once sync.Once
	return func() {
		once.Do(func() {
			s.local.mu.Lock()
			defer s.local.mu.Unlock()
			if s.local.holds[agent][id]--; s.local.holds[agent][id] == 0 {
				delete(s.local.holds[agent], id)
			}
			if s.local.released != nil {
				close(s.local.released)
				s.local.released = nil
			}
		})
	}, true
}

// WaitUnheld waits until no one-shot CLI of this process runs as agent's
// profile id, or ctx ends. Called once the profile is withdrawn, after which
// no new hold can be taken on it.
func (s *Store) WaitUnheld(ctx context.Context, agent session.AgentType, id string) error {
	if s == nil {
		return nil
	}
	for {
		s.local.mu.Lock()
		if s.local.holds[agent][id] == 0 {
			s.local.mu.Unlock()
			return nil
		}
		if s.local.released == nil {
			s.local.released = make(chan struct{})
		}
		released := s.local.released
		s.local.mu.Unlock()
		select {
		case <-released:
		case <-ctx.Done():
			return fmt.Errorf("wait for one-shot %s CLIs running as profile %q: %w", agent, id, ctx.Err())
		}
	}
}
