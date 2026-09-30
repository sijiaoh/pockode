package codex

import "github.com/pockode/server/cliupdate"

// UpdateCLI is Codex as cliupdate updates it: `codex update`, which knows
// whether it was installed by npm, bun or Homebrew.
func UpdateCLI() cliupdate.CLI {
	return cliupdate.CLI{
		Binary:  Binary,
		Package: "@openai/codex",
	}
}
