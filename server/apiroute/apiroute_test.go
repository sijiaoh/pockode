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
