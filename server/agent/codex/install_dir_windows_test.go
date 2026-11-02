//go:build windows

package codex

import (
	"path/filepath"
	"testing"
)

func setDefaultInstallDirEnv(t *testing.T) string {
	local := t.TempDir()
	t.Setenv("LOCALAPPDATA", local)
	return filepath.Join(local, "Programs", "OpenAI", "Codex", "bin")
}
