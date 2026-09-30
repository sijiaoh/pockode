package claude

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUpdateChannel(t *testing.T) {
	tests := []struct {
		name string
		// settings is the file's content; empty is no file.
		settings string
		want     string
	}{
		{"no settings file", "", "latest"},
		{"not set", `{"model":"opus"}`, "latest"},
		{"stable", `{"autoUpdatesChannel":"stable"}`, "stable"},
		{"latest", `{"autoUpdatesChannel":"latest"}`, "latest"},
		// A channel the CLI does not have is one it would not install from.
		{"unknown channel", `{"autoUpdatesChannel":"nightly"}`, "latest"},
		{"unreadable settings", `{`, "latest"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			if tt.settings != "" {
				if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(tt.settings), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if got := updateChannel(dir); got != tt.want {
				t.Errorf("updateChannel = %q, want %q", got, tt.want)
			}
		})
	}
}
