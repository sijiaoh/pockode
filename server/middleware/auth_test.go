package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuth(t *testing.T) {
	const validToken = "test-token"

	handler := Auth(validToken)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))

	tests := []struct {
		name       string
		path       string
		cookie     *http.Cookie
		wantStatus int
	}{
		{
			name:       "health bypasses auth",
			path:       "/health",
			cookie:     nil,
			wantStatus: http.StatusOK,
		},
		{
			name:       "ws bypasses auth",
			path:       "/ws",
			cookie:     nil,
			wantStatus: http.StatusOK,
		},
		{
			name:       "login bypasses auth",
			path:       "/api/login",
			cookie:     nil,
			wantStatus: http.StatusOK,
		},
		{
			name:       "logout bypasses auth",
			path:       "/api/logout",
			cookie:     nil,
			wantStatus: http.StatusOK,
		},
		{
			name:       "missing cookie",
			path:       "/api/ping",
			cookie:     nil,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid token in cookie",
			path:       "/api/ping",
			cookie:     &http.Cookie{Name: CookieName, Value: "wrong-token"},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "valid token in cookie",
			path:       "/api/ping",
			cookie:     &http.Cookie{Name: CookieName, Value: validToken},
			wantStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			if tt.cookie != nil {
				req.AddCookie(tt.cookie)
			}

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("got status %d, want %d", rec.Code, tt.wantStatus)
			}
		})
	}
}
