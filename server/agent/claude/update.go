package claude

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/pockode/server/cliupdate"
)

// UpdateCLI is Claude Code as cliupdate updates it: `claude update`, which
// knows whether it is the native build, an npm install or a package manager's.
// A missing one is installed with the native installer, on the channel the
// user's settings name, so that the later `claude update` follows it too.
func UpdateCLI() cliupdate.CLI {
	return cliupdate.CLI{
		Binary:  Binary,
		Package: "@anthropic-ai/claude-code",
		Channel: func() string { return updateChannel(configDir()) },
		Installer: cliupdate.Installer{
			// install.sh is bash, not sh: it uses [[ ]] and BASH_REMATCH. It
			// refuses to run on Windows; install.ps1 is the one there.
			Unix: cliupdate.Script{
				URL:         "https://claude.ai/install.sh",
				Shell:       []string{"bash"},
				Args:        installTarget,
				Downloaders: cliupdate.CurlOrWget,
			},
			Windows: cliupdate.Script{
				URL:   "https://claude.ai/install.ps1",
				Shell: cliupdate.PowerShell,
				Args:  installTarget,
			},
		},
	}
}

// installTarget is the native installers' one argument, their TARGET: stable,
// latest or a version. It is handed on to `claude install`, which records it
// as the channel the install updates from.
func installTarget(channel string) []string { return []string{channel} }

// updateChannel is the release channel `claude update` installs from: the
// autoUpdatesChannel of the user's settings in dir, "latest" or "stable", and
// "latest" when it is not set (the CLI's default, and the npm dist-tag of the
// same name). Checking against another channel than the CLI's would offer an
// update the CLI then declines.
//
// Only the user's settings are read. The update runs outside any project (see
// cliupdate.NewService), so a project's settings do not decide it either.
func updateChannel(dir string) string {
	const fallback = "latest"
	if dir == "" {
		return fallback
	}
	data, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("could not read Claude Code settings for its update channel", "error", err)
		}
		return fallback
	}
	var settings struct {
		AutoUpdatesChannel string `json:"autoUpdatesChannel"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		slog.Warn("could not parse Claude Code settings for its update channel", "error", err)
		return fallback
	}
	switch settings.AutoUpdatesChannel {
	case "latest", "stable":
		return settings.AutoUpdatesChannel
	}
	return fallback
}

// configDir is where Claude Code keeps the user's settings: CLAUDE_CONFIG_DIR,
// or ~/.claude. Empty without a home: a relative ".claude" would be the
// server's working directory, a project's settings.
func configDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}
