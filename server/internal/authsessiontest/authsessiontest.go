// Package authsessiontest provides an in-memory stand-in for authsession.Store,
// for the packages whose handlers only need a session store to branch on.
//
// The real store derives a password fingerprint on every construction — a few
// hundred milliseconds of PBKDF2 — which a package with a hundred test
// environments would pay once each for nothing: what is under test there is the
// handler's branching, and authsession tests the storage itself.
//
// It satisfies both ws.SessionStore and middleware.SessionValidator.
package authsessiontest

import (
	"fmt"
	"sync"
)

// Sessions issues predictable tokens and remembers exactly the ones it issued.
type Sessions struct {
	mu     sync.Mutex
	issued map[string]bool
	n      int
}

func New() *Sessions {
	return &Sessions{issued: make(map[string]bool)}
}

func (s *Sessions) Issue() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	token := fmt.Sprintf("session-token-%d", s.n)
	s.issued[token] = true
	return token, nil
}

func (s *Sessions) Validate(token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.issued[token]
}
