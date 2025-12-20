package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	handler := newHandler("test-token", "/tmp")
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("got status %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "ok" {
		t.Errorf("got body %q, want %q", rec.Body.String(), "ok")
	}
}

func TestPingEndpoint(t *testing.T) {
	const token = "test-token"
	handler := newHandler(token, "/tmp")

	t.Run("returns pong with valid token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusOK)
		}
		if rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("got content-type %q, want %q", rec.Header().Get("Content-Type"), "application/json")
		}
		want := `{"message":"pong"}`
		if rec.Body.String() != want {
			t.Errorf("got body %q, want %q", rec.Body.String(), want)
		}
	})

	t.Run("rejects without token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})
}
