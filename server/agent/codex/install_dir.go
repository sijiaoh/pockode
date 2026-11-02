package codex

import (
	"os"

	"github.com/pockode/server/agent"
)

func init() { agent.RegisterInstallDir(Binary, installDir) }

// installDir is where Codex's standalone installer puts the codex launcher.
// From the installer scripts themselves (https://chatgpt.com/codex/install.sh
// and install.ps1): CODEX_INSTALL_DIR when set, otherwise the platform default
// of defaultInstallDir. The override is honoured because the installers honour
// it: with it set, that is where codex was put.
func installDir() string {
	if dir := os.Getenv("CODEX_INSTALL_DIR"); dir != "" {
		return dir
	}
	return defaultInstallDir()
}
