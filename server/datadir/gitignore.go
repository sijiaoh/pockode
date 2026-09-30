// Package datadir holds what Pockode keeps in a project's default data
// directory, <work>/.pockode, beyond the stores that live there.
package datadir

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/pockode/server/filestore"
)

// gitignoreMarker is the first line of the file for as long as Pockode owns it.
// Deleting it is how a user takes the file over: from then on Pockode leaves
// it alone, so an edit survives the next start.
const gitignoreMarker = "# Managed by Pockode: delete this line to edit this file yourself."

// gitignoreContent keeps the data directory out of the project's git status
// without the user editing their own .gitignore. Everything is ignored —
// sessions, tokens, logs, this file itself — except the agent-role index,
// which a team may want to commit so that everyone shares the same roles.
//
// The patterns are anchored with a leading slash so they only ever describe
// this directory's own top level: a worktree's data under worktrees/ is
// ignored as a whole, agent-roles/ and all.
//
// The header's claims about the outer ignore files follow from git's
// precedence: a .gitignore deeper in the tree overrides every rule above it,
// so an outer file can only exclude .pockode as a whole, which stops git from
// descending into it and reading this file at all.
const gitignoreContent = gitignoreMarker + `
# While the line above is here, Pockode rewrites this file on every start and
# local edits are lost. Once it is gone, Pockode never touches this file again,
# and later changes to these rules no longer reach it. To hand the file back,
# delete it: Pockode writes a fresh one on its next start.
#
# Pockode's runtime data stays out of git; only the agent-role index is left
# for you to commit.
#
# Your project's .gitignore and .git/info/exclude cannot override single rules
# here, because this file is closer to the paths and takes precedence. They can
# ignore the whole directory (".pockode/"), agent-role index included. To commit
# a file ignored here, add it with "git add -f"; git keeps tracking it after that.
/*
!/agent-roles/
/agent-roles/*
!/agent-roles/index.json
`

// EnsureGitignore brings dir/.gitignore to exactly the content this build
// defines, so a change to the rules reaches existing installs on their next
// start — unless the user has taken the file over by removing its first-line
// marker, in which case it is left as it is. A missing file is created. dir
// must already exist: it is created by fsperm.RestrictDir, and letting the
// write create it would skip the restriction.
//
// Only call it for the default data directory. A --data path can be anything,
// the project root included, and a "/*" dropped into a directory Pockode does
// not own would hide the user's whole tree from git.
func EnsureGitignore(dir string) error {
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("data directory: %w", err)
	}
	path := filepath.Join(dir, ".gitignore")
	// The write replaces the file by rename, so an unlocked read sees either
	// the old file or the new one, never part of one.
	current, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err == nil && (bytes.Equal(current, []byte(gitignoreContent)) || !isManaged(current)) {
		return nil
	}
	// Atomic and locked: two servers starting over the same project write the
	// same bytes, and git never reads a half-written file.
	if err := filestore.WriteFileAtomic(path, []byte(gitignoreContent), 0644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// isManaged reports whether the file still opens with the marker. A byte-order
// mark, trailing whitespace and a CRLF line ending are forgiven: an editor that
// adds or normalizes them has not been told to take the file over, and git
// reads the file the same either way.
func isManaged(content []byte) bool {
	content = bytes.TrimPrefix(content, []byte("\ufeff"))
	first, _, _ := bytes.Cut(content, []byte("\n"))
	line := string(bytes.TrimRight(first, " \t\r"))
	return line == gitignoreMarker
}
