package middleware

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLoginHandler(t *testing.T) {
	const validToken = "test-token"

	t.Run("valid token sets cookie in dev mode", func(t *testing.T) {
		handler := LoginHandler(validToken, true)
		body, _ := json.Marshal(LoginRequest{Token: validToken})
		req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusOK)
		}

		cookies := rec.Result().Cookies()
		if len(cookies) == 0 {
			t.Fatal("expected cookie to be set")
		}

		cookie := cookies[0]
		if cookie.Name != CookieName {
			t.Errorf("got cookie name %q, want %q", cookie.Name, CookieName)
		}
		if cookie.Value != validToken {
			t.Errorf("got cookie value %q, want %q", cookie.Value, validToken)
		}
		if !cookie.HttpOnly {
			t.Error("cookie should be HttpOnly")
		}
		if cookie.SameSite != http.SameSiteStrictMode {
			t.Errorf("got SameSite %v, want %v", cookie.SameSite, http.SameSiteStrictMode)
		}
		if cookie.Secure {
			t.Error("cookie should not be Secure in dev mode")
		}
	})

	t.Run("valid token sets secure cookie in prod mode", func(t *testing.T) {
		handler := LoginHandler(validToken, false)
		body, _ := json.Marshal(LoginRequest{Token: validToken})
		req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		cookies := rec.Result().Cookies()
		if len(cookies) == 0 {
			t.Fatal("expected cookie to be set")
		}
		if !cookies[0].Secure {
			t.Error("cookie should be Secure in prod mode")
		}
	})

	t.Run("invalid token returns 401", func(t *testing.T) {
		handler := LoginHandler(validToken, true)
		body, _ := json.Marshal(LoginRequest{Token: "wrong-token"})
		req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})

	t.Run("invalid JSON returns 400", func(t *testing.T) {
		handler := LoginHandler(validToken, true)
		req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader([]byte("not json")))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusBadRequest)
		}
	})

	t.Run("GET method returns 405", func(t *testing.T) {
		handler := LoginHandler(validToken, true)
		req := httptest.NewRequest(http.MethodGet, "/api/login", nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusMethodNotAllowed)
		}
	})

	t.Run("empty token returns 401", func(t *testing.T) {
		handler := LoginHandler(validToken, true)
		body, _ := json.Marshal(LoginRequest{Token: ""})
		req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})
}

func TestLogoutHandler(t *testing.T) {
	t.Run("clears cookie in dev mode", func(t *testing.T) {
		handler := LogoutHandler(true)
		req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusOK)
		}

		cookies := rec.Result().Cookies()
		if len(cookies) == 0 {
			t.Fatal("expected cookie to be set")
		}

		cookie := cookies[0]
		if cookie.Name != CookieName {
			t.Errorf("got cookie name %q, want %q", cookie.Name, CookieName)
		}
		if cookie.MaxAge != -1 {
			t.Errorf("got MaxAge %d, want -1", cookie.MaxAge)
		}
		if cookie.Secure {
			t.Error("cookie should not be Secure in dev mode")
		}
	})

	t.Run("clears secure cookie in prod mode", func(t *testing.T) {
		handler := LogoutHandler(false)
		req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		cookies := rec.Result().Cookies()
		if len(cookies) == 0 {
			t.Fatal("expected cookie to be set")
		}
		if !cookies[0].Secure {
			t.Error("cookie should be Secure in prod mode")
		}
	})

	t.Run("GET method returns 405", func(t *testing.T) {
		handler := LogoutHandler(true)
		req := httptest.NewRequest(http.MethodGet, "/api/logout", nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusMethodNotAllowed)
		}
	})
}

func TestGetTokenFromCookie(t *testing.T) {
	t.Run("returns token from cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.AddCookie(&http.Cookie{Name: CookieName, Value: "test-token"})

		got := GetTokenFromCookie(req)
		if got != "test-token" {
			t.Errorf("got %q, want %q", got, "test-token")
		}
	})

	t.Run("returns empty string when no cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)

		got := GetTokenFromCookie(req)
		if got != "" {
			t.Errorf("got %q, want empty string", got)
		}
	})
}
