// Package authsession issues and validates the credential a browser keeps on
// behalf of a logged-in user.
//
// The password is typed once and exchanged for a session token; only the token
// is stored by the frontend. That is what makes logging in revocable and
// expirable — a password in localStorage is neither, and it is the user's own
// secret, which they may well have typed somewhere else too.
//
// What lands on disk is therefore: a fingerprint of the password (so that
// changing it invalidates every session issued under the old one) and the
// SHA-256 of each live token. Plain SHA-256 rather than a slow KDF is
// deliberate: a token is 256 bits from crypto/rand, so there is nothing to
// brute-force, and a per-request KDF would cost hundreds of milliseconds to
// defend against an attack that cannot happen.
package authsession

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"log/slog"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/pockode/server/filestore"
	"github.com/pockode/server/internal/fsperm"
)

const (
	// IdleTTL is how long a session survives without being used. It is the only
	// expiry: a session in daily use is never asked for the password again,
	// which is the whole point of issuing it.
	IdleTTL = 30 * 24 * time.Hour
	// maxSessions caps the file. Every origin a user reaches the same server
	// through (LAN http://ip:port and the relay's https://... are different
	// origins, with separate localStorage) holds one, so the ceiling is for
	// runaway growth, not for normal use.
	maxSessions = 50
	// touchInterval is how stale last_used_at may get on disk. Every use
	// advances it in memory; writing each one through would mean a file rewrite
	// per request, and the only thing a lost update can cost is a session
	// expiring up to an hour early after a month of disuse.
	touchInterval = time.Hour
	tokenLen      = 32
)

type record struct {
	Hash       string    `json:"hash"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at"`
}

type file struct {
	PasswordHash *passwordHash `json:"password_hash"`
	Sessions     []record      `json:"sessions"`
}

// Store is the set of live sessions for one server (or one cluster), persisted
// in <dataDir>/sessions.json.
type Store struct {
	path string

	mu        sync.Mutex
	data      file
	lastWrite time.Time
	// unsaved records that the in-memory set has moved on from the file: a
	// last_used_at advanced, or an expired session was dropped. Both are
	// allowed to fall behind (see touchInterval), and this is what Flush needs
	// to know whether there is anything to catch up on.
	unsaved bool
}

// NewStore loads the sessions of previous runs and keeps them only if password
// still hashes to the fingerprint they were issued under. A password that has
// changed — or a file written by a KDF this build does not know — drops every
// session, so that changing the password really does log the old clients out.
//
// A damaged file is quarantined and treated as empty (see
// filestore.ReadJSONOrQuarantine): the cost is that everyone logs in again,
// which is the same recovery the user gets by deleting the file.
func NewStore(dataDir, password string) (*Store, error) {
	s := &Store{path: filepath.Join(dataDir, "sessions.json")}
	// Nothing else can reach s yet, but the lock keeps the "...Locked" suffixes
	// below honest rather than making this the one place they do not mean it.
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, err := filestore.ReadJSONOrQuarantine(s.path, "sessions", &s.data); err != nil {
		return nil, err
	}

	if !s.data.PasswordHash.matches(password) {
		hash, err := derivePasswordHash(password)
		if err != nil {
			return nil, err
		}
		s.data = file{PasswordHash: hash}
		if err := s.save(); err != nil {
			return nil, err
		}
		return s, nil
	}

	s.pruneLocked(time.Now())
	if s.unsaved {
		if err := s.save(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Issue returns a new session token. Only its hash is kept, so this is the one
// moment the token exists here — a caller that loses it must issue another.
func (s *Store) Issue() (string, error) {
	b := make([]byte, tokenLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)

	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	// pruneLocked filters in place, so the rollback below needs a copy rather
	// than the slice header.
	prev, prevUnsaved := slices.Clone(s.data.Sessions), s.unsaved

	s.pruneLocked(now)
	if len(s.data.Sessions) >= maxSessions {
		// Evicted by least recently used, not by age. The session created first
		// may well be the phone in daily use, while one made last week has sat
		// untouched since; only LastUsedAt tells them apart, and it is the one
		// the user would notice losing.
		slices.SortFunc(s.data.Sessions, func(a, b record) int {
			return a.LastUsedAt.Compare(b.LastUsedAt)
		})
		s.data.Sessions = s.data.Sessions[len(s.data.Sessions)-maxSessions+1:]
	}
	s.data.Sessions = append(s.data.Sessions, record{
		Hash:       hashToken(token),
		CreatedAt:  now,
		LastUsedAt: now,
	})

	if err := s.save(); err != nil {
		// Leave memory exactly as it was. A half-applied issue — a token no
		// caller received, evictions that never reached disk — would have the
		// two disagree in ways that only surface at some later validate.
		s.data.Sessions, s.unsaved = prev, prevUnsaved
		return "", err
	}
	return token, nil
}

// Validate reports whether token names a live session, and marks it used.
func (s *Store) Validate(token string) bool {
	if token == "" {
		return false
	}
	want := hashToken(token)
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()

	s.pruneLocked(now)

	found := false
	for i := range s.data.Sessions {
		if subtle.ConstantTimeCompare([]byte(s.data.Sessions[i].Hash), []byte(want)) == 1 {
			s.data.Sessions[i].LastUsedAt = now
			found = true
			break
		}
	}
	if !found {
		return false
	}

	s.unsaved = true
	if now.Sub(s.lastWrite) >= touchInterval {
		if err := s.save(); err != nil {
			// The session stays valid in memory; all a lost touch can cost is
			// an earlier expiry, so this is reported rather than returned —
			// the caller asked whether the credential is good, and it is.
			slog.Warn("could not record session use", "path", s.path, "error", err)
		}
	}
	return true
}

// Flush writes the last_used_at values that touchInterval held back, so that a
// clean shutdown does not cost a session up to an hour of its idle window.
func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.unsaved {
		return nil
	}
	return s.save()
}

// pruneLocked drops expired sessions.
func (s *Store) pruneLocked(now time.Time) {
	kept := s.data.Sessions[:0]
	for _, r := range s.data.Sessions {
		if now.Sub(r.LastUsedAt) < IdleTTL {
			kept = append(kept, r)
		}
	}
	if len(kept) != len(s.data.Sessions) {
		s.unsaved = true
	}
	s.data.Sessions = kept
}

// save writes the whole file. The data directory is restricted first because
// that, not the 0600, is what protects the file on Windows — see
// internal/fsperm.
func (s *Store) save() error {
	if err := fsperm.RestrictDir(filepath.Dir(s.path)); err != nil {
		return err
	}
	data, err := filestore.MarshalIndex(&s.data)
	if err != nil {
		return err
	}
	if err := filestore.WriteFileAtomic(s.path, data, 0600); err != nil {
		return err
	}
	s.lastWrite = time.Now()
	s.unsaved = false
	return nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
