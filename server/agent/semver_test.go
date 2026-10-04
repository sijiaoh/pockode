package agent_test

import (
	"testing"

	"github.com/pockode/server/agent"
)

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"2.1.285", "2.1.283", 1},
		{"2.1.283", "2.1.285", -1},
		{"0.159.2", "0.159.2", 0},
		// Numerically, not as text.
		{"0.100.0", "0.99.0", 1},
		{"1.2", "1.2.0", 0},
		// A pre-release comes before its release, and after the one before it.
		{"0.161.0-alpha.3", "0.161.0", -1},
		{"0.161.0-alpha.3", "0.160.0", 1},
		{"0.161.0-alpha.10", "0.161.0-alpha.3", 1},
		{"1.0.0-alpha.1", "1.0.0-alpha", 1},
		{"1.0.0-beta", "1.0.0-alpha", 1},
		{"1.0.0-alpha", "1.0.0-1", 1},
		{"1.0.0+build.1", "1.0.0", 0},
	}
	for _, tt := range tests {
		got, err := agent.CompareVersions(tt.a, tt.b)
		if err != nil {
			t.Errorf("CompareVersions(%q, %q): %v", tt.a, tt.b, err)
			continue
		}
		if got != tt.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}

	if _, err := agent.CompareVersions("latest", "1.0.0"); err == nil {
		t.Error("CompareVersions accepted a version without numbers")
	}
}
