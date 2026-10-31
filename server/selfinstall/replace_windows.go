package selfinstall

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/pockode/server/filestore"
)

// renameBudget is how long each rename of an install is retried for. A file
// just written is opened by Windows Defender to scan it, for seconds on an
// executable of tens of megabytes, and refuses to be moved meanwhile.
const renameBudget = 30 * time.Second

// replace moves the running target aside and staged into its place. Windows
// does not let a running executable be replaced or removed, but it does let it
// be renamed; the processes running it carry on from the new name, and Cleanup
// removes it at a later startup once none does.
//
// Between the two renames there is no executable at target: a restart, a
// cluster starting a node, or this process being killed then finds nothing to
// run. So the wait for Defender to let go of the new file comes first, on a
// rename of staged that touches nothing else, and the two that leave the gap
// follow back to back. They are still retried, in case a scanner opens the
// file again in between, which would only lengthen the gap.
//
// If staged cannot be moved into place, the old executable is moved back.
// Returns the path staged ended up at, for the caller to discard on failure.
func replace(staged, target string, budget time.Duration) (string, error) {
	ready := readyName(staged)
	if err := filestore.RenamePatiently(staged, ready, budget); err != nil {
		return staged, fail(FailureReplace, "the new version of %s is still held open, usually by antivirus scanning it: %w", target, err)
	}
	old := oldName(target, time.Now())
	if err := filestore.RenamePatiently(target, old, budget); err != nil {
		return ready, fail(FailureReplace, "move the running %s aside: %w", target, err)
	}
	err := filestore.RenamePatiently(ready, target, budget)
	if err == nil {
		return "", nil
	}
	if restoreErr := filestore.RenamePatiently(old, target, budget); restoreErr != nil {
		return ready, fail(FailureRestore, "put the new version in place of %s: %w; moving the old one back failed too (%v): it is at %s — rename it back to %s", target, err, restoreErr, old, target)
	}
	return ready, fail(FailureReplace, "put the new version in place of %s: %w", target, err)
}

// readyName is where a staged file goes once nothing holds it: still a staged
// name (Cleanup's), and still ending in .exe.
func readyName(staged string) string {
	ext := filepath.Ext(staged)
	return strings.TrimSuffix(staged, ext) + "-ready" + ext
}

// inContainer is false: Pockode is not published for Windows containers.
func inContainer() bool { return false }

// notWritableHint is what to do about an executable in a directory this
// process cannot write to, such as one under Program Files. install.ps1
// installs into %LOCALAPPDATA%\Programs\Pockode by default, which needs no
// administrator.
func notWritableHint(dir string) string {
	return fmt.Sprintf("Install into %%LOCALAPPDATA%%\\Programs\\Pockode with `irm https://pockode.com/install.ps1 | iex` and start Pockode from there, so updates work from here, "+
		"or replace %s from an administrator PowerShell after stopping Pockode.", dir)
}
