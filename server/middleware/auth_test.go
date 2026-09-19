package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeSessions accepts exactly one session token.
type fakeSessions struct{ valid string }

func (f fakeSessions) Validate(token string) bool { return token != "" && token == f.valid }

func TestAuth(t *testing.T) {
	const password = "test-password"
	const sessionToken = "test-session-token"

	handler := Auth(password, fakeSessions{valid: sessionToken})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))

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
