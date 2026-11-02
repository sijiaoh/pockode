package codex

import "github.com/pockode/server/cliupdate"

// UpdateCLI is Codex as cliupdate updates it: `codex update`, which knows
// whether it was installed by npm, bun, Homebrew or the standalone installer.
// A missing one is installed with the standalone installer, the one Codex's
// README gives (github.com/openai/codex, scripts/install/).
func UpdateCLI() cliupdate.CLI {
	return cliupdate.CLI{
		Binary:  Binary,
		Package: "@openai/codex",
		Installer: cliupdate.Installer{
			Unix: cliupdate.Script{
				URL:         "https://chatgpt.com/codex/install.sh",
				Shell:       []string{"sh"},
				Env:         nonInteractive,
				Downloaders: cliupdate.CurlOrWget,
			},
			Windows: cliupdate.Script{
				URL:   "https://chatgpt.com/codex/install.ps1",
				Shell: cliupdate.PowerShell,
				Env:   nonInteractive,
			},
		},
	}
}

// nonInteractive keeps both installers from asking. Without it they ask on
// /dev/tty, not stdin, whenever the server has a terminal — whether to remove
// an npm or Homebrew install they found, whether to start Codex — and the
// install waits on a question nobody sees until its budget runs out. It is
// what Codex's own standalone update sets (codex-rs/tui/src/update_action.rs).
// With no --release (CODEX_RELEASE) they install the latest release, the
// channel `codex update` follows.
var nonInteractive = []string{"CODEX_NON_INTERACTIVE=1"}
