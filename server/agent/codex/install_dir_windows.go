//go:build windows

package codex

import (
	"os"
	"path/filepath"
)

// defaultInstallDir is install.ps1's default visible bin directory:
// %LOCALAPPDATA%\Programs\OpenAI\Codex\bin.
func defaultInstallDir() string {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return ""
	}
	return filepath.Join(local, "Programs", "OpenAI", "Codex", "bin")
}
