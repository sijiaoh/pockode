package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHasLegacyPockodeDir(t *testing.T) {
	tests := []struct {
		name     string
		setup    func(dir string)
		expected bool
	}{
		{
			name:     "no .pockode directory",
			setup:    func(dir string) {},
			expected: false,
		},
		{
			name: "has .pockode directory",
			setup: func(dir string) {
				if err := os.Mkdir(filepath.Join(dir, ".pockode"), 0755); err != nil {
					panic(err)
				}
			},
			expected: true,
		},
		{
			name: ".pockode is a file not directory",
			setup: func(dir string) {
				f, err := os.Create(filepath.Join(dir, ".pockode"))
				if err != nil {
					panic(err)
				}
				f.Close()
			},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			tt.setup(dir)

			got := HasLegacyPockodeDir(dir)
			if got != tt.expected {
				t.Errorf("HasLegacyPockodeDir() = %v, want %v", got, tt.expected)
			}
		})
	}
}

func TestHasLegacyPockodeDir_NonExistentPath(t *testing.T) {
	got := HasLegacyPockodeDir("/nonexistent/path/that/does/not/exist")
	if got {
		t.Error("HasLegacyPockodeDir should return false for non-existent path")
	}
}

func TestModeDescription(t *testing.T) {
	tests := []struct {
		mode     Mode
		expected string
	}{
		{ModeSingle, "Single Workspace"},
		{ModeManager, "Multi-Workspace Manager"},
		{Mode("unknown"), "unknown"},
	}

	for _, tt := range tests {
		t.Run(string(tt.mode), func(t *testing.T) {
			got := ModeDescription(tt.mode)
			if got != tt.expected {
				t.Errorf("ModeDescription(%v) = %q, want %q", tt.mode, got, tt.expected)
			}
		})
	}
}

func TestModeTip(t *testing.T) {
	tests := []struct {
		mode     Mode
		expected string
	}{
		{ModeSingle, "Use 'pockode manager start' to enable multi-workspace mode"},
		{ModeManager, "Use 'pockode workspace add' to register workspaces"},
		{Mode("unknown"), ""},
	}

	for _, tt := range tests {
		t.Run(string(tt.mode), func(t *testing.T) {
			got := ModeTip(tt.mode)
			if got != tt.expected {
				t.Errorf("ModeTip(%v) = %q, want %q", tt.mode, got, tt.expected)
			}
		})
	}
}
