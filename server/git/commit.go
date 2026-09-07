package git

import (
	"fmt"
	"strings"
)

// CreateCommit records what is staged in the root repository.
//
// Only the root index: git.add stages a submodule's file in that submodule's
// own index, and a root commit leaves those entries exactly where they were.
// The panel names the files it leaves behind rather than turning one tap into a
// commit per repository — see docs/git-ui.md.
//
// amend replaces the previous commit instead of adding one, which is both how a
// message is corrected and how the last commit absorbs the current index.
func CreateCommit(dir, message string, amend bool) error {
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("commit message is empty")
	}

	args := []string{"commit"}
	if amend {
		args = append(args, "--amend")
	}
	// The message is the value of -m, so git reads it as a message however it
	// starts, and nothing here passes through a shell.
	args = append(args, "-m", message)

	// Hooks stay in force and their verdict is passed up: a commit-msg hook
	// rejecting a message is something the user has to see, not something to
	// route around with --no-verify.
	return execGitVerbose(dir, args...)
}
