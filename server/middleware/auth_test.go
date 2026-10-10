package middleware

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/pockode/server/authguard"
)

// fakeSessions accepts exactly one session token.
type fakeSessions struct{ valid string }

func (f fakeSessions) Validate(token string) bool { return token != "" && token == f.valid }

var okHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
})

func get(handler http.Handler, authHeader string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestAuth(t *testing.T) {
	const password = "test-password"
	const sessionToken = "test-session-token"

	handler := Auth(password, authguard.New(), fakeSessions{valid: sessionToken})(okHandler)

	tests := []struct {
		name       string
		path       string
		authHeader string
		wantStatus int
	}{
		{
			name:       "health bypasses auth",
			path:       "/health",
			authHeader: "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "ws bypasses auth",
			path:       "/ws",
			authHeader: "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "missing auth header",
			path:       "/api/ping",
			authHeader: "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid auth format",
			path:       "/api/ping",
			authHeader: "Basic token",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid credential",
			path:       "/api/ping",
			authHeader: "Bearer wrong-password",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "password",
			path:       "/api/ping",
			authHeader: "Bearer " + password,
			wantStatus: http.StatusOK,
		},
		{
			name:       "session token",
			path:       "/api/ping",
			authHeader: "Bearer " + sessionToken,
			wantStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("got status %d, want %d", rec.Code, tt.wantStatus)
			}
			// Every refusal reads the same, so a caller cannot learn from the
			// reply whether the header was missing, malformed or simply wrong.
			if tt.wantStatus == http.StatusUnauthorized && strings.TrimSpace(rec.Body.String()) != "Invalid credentials" {
				t.Errorf("got body %q, want %q", rec.Body.String(), "Invalid credentials")
			}
		})
	}
}

// While passwords are locked out even the right one is refused with a wait,
// but a session token is not a password and still gets through.
func TestAuth_LockedOutPasswordKeepsSessionTokens(t *testing.T) {
	const password = "test-password"
	const sessionToken = "test-session-token"
	handler := Auth(password, authguard.NewFrozen(), fakeSessions{valid: sessionToken})(okHandler)

	// A request with no bearer credential guessed no password.
	for range 10 {
		get(handler, "")
		get(handler, "Basic "+password)
	}
	// authguard tolerates 5 failures; the 6th starts a 1s lockout.
	for i := range 6 {
		if rec := get(handler, "Bearer wrong"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("wrong password %d: status %d, want %d", i+1, rec.Code, http.StatusUnauthorized)
		}
	}

	if rec := get(handler, "Bearer "+sessionToken); rec.Code != http.StatusOK {
		t.Errorf("session token while locked out: status %d, want %d", rec.Code, http.StatusOK)
	}
	rec := get(handler, "Bearer "+password)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("password while locked out: status %d, want %d", rec.Code, http.StatusTooManyRequests)
	}
	if secs, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || secs != 1 {
		t.Errorf("Retry-After = %q, want 1 (the 1s lockout, rounded up)", rec.Header().Get("Retry-After"))
	}
}
