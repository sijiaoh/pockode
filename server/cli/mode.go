package cli

import (
	"os"
	"path/filepath"
)

// Mode represents the server running mode.
type Mode string

const (
	// ModeSingle is the traditional single workspace mode.
	// Server runs in the current directory with .pockode as data dir.
	ModeSingle Mode = "single"

	// ModeManager is the multi-workspace manager mode.
	// Server manages multiple workspaces from ~/.pockode/workspaces.json.
	ModeManager Mode = "manager"
)

// HasLegacyPockodeDir checks if workDir has a .pockode directory.
func HasLegacyPockodeDir(workDir string) bool {
	pockodeDir := filepath.Join(workDir, ".pockode")
	info, err := os.Stat(pockodeDir)
	if err != nil {
		return false
	}
	return info.IsDir()
}

func ModeDescription(mode Mode) string {
	switch mode {
	case ModeSingle:
		return "Single Workspace"
	case ModeManager:
		return "Multi-Workspace Manager"
	default:
		return string(mode)
	}
}

func ModeTip(mode Mode) string {
	switch mode {
	case ModeSingle:
		return "Use 'pockode manager start' to enable multi-workspace mode"
	case ModeManager:
		return "Use 'pockode workspace add' to register workspaces"
	default:
		return ""
	}
}
