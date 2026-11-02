//go:build !windows

package codex

import (
	"os"
	"path/filepath"
)

// defaultInstallDir is install.sh's BIN_DIR default: ~/.local/bin.
func defaultInstallDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "bin")
}
