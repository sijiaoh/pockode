//go:build !windows

package codex

import (
	"path/filepath"
	"testing"
)

func setDefaultInstallDirEnv(t *testing.T) string {
	home := t.TempDir()
	t.Setenv("HOME", home)
	return filepath.Join(home, ".local", "bin")
}
