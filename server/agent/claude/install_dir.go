package claude

import (
	"os"
	"path/filepath"

	"github.com/pockode/server/agent"
)

func init() { agent.RegisterInstallDir(Binary, installDir) }

// installDir is where Claude Code's native installer (`claude install`, which
// https://claude.ai/install.sh and install.ps1 run) puts the claude launcher:
// ~/.local/bin, %USERPROFILE%\.local\bin on Windows — os.UserHomeDir reads
// USERPROFILE there.
func installDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "bin")
}
