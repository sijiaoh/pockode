package authsession

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newStore(t *testing.T, dir, password string) *Store {
	t.Helper()
	s, err := NewStore(dir, password)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

// Every other test hands NewStore a directory that already exists, so nothing
// else covers the very first run — where a failure would mean the server never
// starts on a fresh install.
func TestNewStoreCreatesMissingDataDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "does", "not", "exist")
	s, err := NewStore(dir, "hunter2")
	if err != nil {
		t.Fatalf("NewStore on a missing data dir: %v", err)
	}
	if _, err := s.Issue(); err != nil {
		t.Fatalf("Issue: %v", err)
	}
}

func TestIssuedTokenValidates(t *testing.T) {
	s := newStore(t, t.TempDir(), "hunter2")

	token, err := s.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if !s.Validate(token) {
		t.Error("Validate(issued token) = false, want true")
	}
	if s.Validate(token + "x") {
		t.Error("Validate(unknown token) = true, want false")
	}
	if s.Validate("") {
		t.Error("Validate(\"\") = true, want false")
	}
}

// The token is the only thing the browser keeps, so what lands on disk must not
// be usable as one.
func TestTokenIsNotStoredVerbatim(t *testing.T) {
	dir := t.TempDir()
	s := newStore(t, dir, "hunter2")
	token, err := s.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "sessions.json"))
	if err != nil {
		t.Fatalf("read sessions.json: %v", err)
	}
	if strings.Contains(string(raw), token) {
		t.Errorf("sessions.json contains the token verbatim:\n%s", raw)
	}
	if strings.Contains(string(raw), "hunter2") {
		t.Errorf("sessions.json contains the password verbatim:\n%s", raw)
	}
}

func TestSessionsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	token, err := newStore(t, dir, "hunter2").Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if !newStore(t, dir, "hunter2").Validate(token) {
		t.Error("session did not survive a restart with the same password")
	}
}

// Changing the password must log every client out; otherwise "change the
// password to kick someone off" silently does nothing.
func TestPasswordChangeInvalidatesSessions(t *testing.T) {
	dir := t.TempDir()
	token, err := newStore(t, dir, "hunter2").Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if newStore(t, dir, "different").Validate(token) {
		t.Error("session survived a password change, want it invalidated")
	}
}

// A fingerprint this build will not compute takes the same path as a changed
// password rather than being trusted or left to hang the only route into the
// server.
func TestUnusableFingerprintInvalidatesSessions(t *testing.T) {
	tests := []struct {
		name  string
		field string
		value any
	}{
		{"unrecognised KDF", "algo", "argon2id-from-the-future"},
		// Startup blocks on the derivation, so a count nobody can afford to run
		// must be refused rather than obeyed.
		{"absurd iteration count", "iterations", 1_000_000_000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			s := newStore(t, dir, "hunter2")
			token, err := s.Issue()
			if err != nil {
				t.Fatalf("Issue: %v", err)
			}

			path := filepath.Join(dir, "sessions.json")
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			var f map[string]any
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			f["password_hash"].(map[string]any)[tt.field] = tt.value
			patched, _ := json.Marshal(f)
			if err := os.WriteFile(path, patched, 0600); err != nil {
				t.Fatalf("write: %v", err)
			}

			if newStore(t, dir, "hunter2").Validate(token) {
				t.Error("session survived an unusable fingerprint, want it invalidated")
			}
		})
	}
}

func TestExpiredSessionIsRejectedAndDropped(t *testing.T) {
	dir := t.TempDir()
	s := newStore(t, dir, "hunter2")
	token, err := s.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	s.mu.Lock()
	s.data.Sessions[0].LastUsedAt = time.Now().Add(-IdleTTL - time.Minute)
	s.mu.Unlock()

	if s.Validate(token) {
		t.Error("Validate(expired token) = true, want false")
	}
	s.mu.Lock()
	n := len(s.data.Sessions)
	s.mu.Unlock()
	if n != 0 {
		t.Errorf("expired session still held, got %d sessions", n)
	}
}

// The cap evicts by least recent *use*, not by age. Keeping the first-issued
// token in daily use while a never-touched newer one survives is the case that
// tells the two rules apart, and it is the one a user would actually hit.
func TestIssueEvictsLeastRecentlyUsedBeyondCap(t *testing.T) {
	s := newStore(t, t.TempDir(), "hunter2")

	inDailyUse, err := s.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	idle, err := s.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	var newest string
	for i := 2; i < maxSessions+1; i++ {
		if !s.Validate(inDailyUse) {
			t.Fatalf("the session in use was evicted at %d", i)
		}
		if newest, err = s.Issue(); err != nil {
			t.Fatalf("Issue: %v", err)
		}
	}

	if !s.Validate(inDailyUse) {
		t.Error("the session in daily use was evicted, want it kept")
	}
	if s.Validate(idle) {
		t.Error("the least recently used session survived the cap, want it evicted")
	}
	if !s.Validate(newest) {
		t.Error("newest session was evicted, want it kept")
	}
	s.mu.Lock()
	n := len(s.data.Sessions)
	s.mu.Unlock()
	if n != maxSessions {
		t.Errorf("held %d sessions, want %d", n, maxSessions)
	}
}
