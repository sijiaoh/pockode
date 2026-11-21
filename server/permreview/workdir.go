package permreview

import (
	"os"
	"path/filepath"
)

// DefaultWorkDir is the directory permission reviewers' CLIs run in
// (process.Manager.SetPermissionReviewerWorkDir): an empty one of Pockode's
// own, under the OS user's configuration directory beside cli-profiles.json,
// so that it is outside every project and none of them can put instruction
// files, settings or hooks where a reviewer would read them. One for every
// Pockode server of the OS user: a reviewer keeps nothing there, and what it
// is told about — the main session's working directory and project root —
// travels in the review message, not in where it runs.
//
// It stays the same from one launch to the next. Claude files a
// conversation's transcript by the directory it ran in, so each reviewer's
// stays in one place (and is found from elsewhere too: resuming or forking by
// id works from any directory, claude 2.1.325).
func DefaultWorkDir() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "pockode", "permission-reviewer"), nil
}
