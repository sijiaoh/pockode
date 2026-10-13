package apiroute

import "testing"

func TestIsAPI(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"/api", true},
		{"/api/ping", true},
		{"/api/nested/thing", true},
		{"/ws", true},
		{"/health", true},
		{"/", false},
		{"/s/session-id", false},
		{"/assets/app.js", false},
		// Only the exact paths belong to the API; the SPA owns look-alikes.
		{"/wsx", false},
		{"/healthz", false},
		{"/apifoo", true}, // documented consequence of the /api prefix match
	}

	for _, tt := range tests {
		if got := IsAPI(tt.path); got != tt.want {
			t.Errorf("IsAPI(%q) = %v, want %v", tt.path, got, tt.want)
		}
	}
}

func TestIsLocalOnly(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		// Where: mcp.APIPath. Spelled out rather than imported so that
		// package mcp is free to depend on routing and not the reverse;
		// mcp's own TestAPIPathStaysLocalOnly pins the two together.
		{"/api/mcp/tools/call", true},
		{"/api/mcp/", true},
		{"/api/ping", false},
		{"/api", false},
		{"/", false},
	}

	for _, tt := range tests {
		if got := IsLocalOnly(tt.path); got != tt.want {
			t.Errorf("IsLocalOnly(%q) = %v, want %v", tt.path, got, tt.want)
		}
	}
}

func TestIsRaw(t *testing.T) {
	for path, want := range map[string]bool{
		"/api/raw/cap/a.txt": true,
		"/api/raw/":          true,
		"/api/raw":           true,
		"/api/rawx":          false,
		"/api/files/raw":     false,
	} {
		if got := IsRaw(path); got != want {
			t.Errorf("IsRaw(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestLoggablePathMasksTheCapability(t *testing.T) {
	for path, want := range map[string]string{
		"/api/raw/secret/site/a.css": "/api/raw/<capability>/site/a.css",
		"/api/raw/secret":            "/api/raw/<capability>",
		"/api/ping":                  "/api/ping",
	} {
		if got := LoggablePath(path); got != want {
			t.Errorf("LoggablePath(%q) = %q, want %q", path, got, want)
		}
	}
}
