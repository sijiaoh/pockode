//go:build !windows

package selfinstall

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// renameBudget is unused on unix: rename(2) replaces the target whoever has it
// open, so there is nothing to wait out.
const renameBudget = 0

// replace renames staged over target in one step. The running process keeps
// the old file, which the kernel keeps until the last process using it exits.
// Returns the path staged ended up at, for the caller to discard on failure.
func replace(staged, target string, _ time.Duration) (string, error) {
	if err := os.Rename(staged, target); err != nil {
		return staged, fail(FailureReplace, "put the new version in place of %s: %w", target, err)
	}
	return "", nil
}

// containerMarkers are files container runtimes put at the root of every
// container: Docker's and Podman's. Pockode's own image is built without a
// version and is refused as a dev build first; this is for a release
// executable someone put in an image of their own.
var containerMarkers = []string{"/.dockerenv", "/run/.containerenv"}

func inContainer() bool {
	// Kubernetes sets this in every pod, whatever the runtime: containerd and
	// CRI-O leave neither marker file.
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		return true
	}
	for _, m := range containerMarkers {
		if _, err := os.Stat(m); err == nil {
			return true
		}
	}
	return false
}

// notWritableHint is what to do about an executable in a directory this
// process cannot write to — usually /usr/local/bin, installed with sudo.
// install.sh asks for sudo itself when it is given a directory the user cannot
// write to, and installs into ~/.local/bin, which needs none, by default.
func notWritableHint(dir string) string {
	return fmt.Sprintf("Update from a terminal with `curl -fsSL https://pockode.com/install.sh | sh -s -- --install-dir %s` and restart from here, "+
		"or install into ~/.local/bin with `curl -fsSL https://pockode.com/install.sh | sh` and start Pockode from there, so later updates work from here.", shellQuote(dir))
}

// shellSafe is what a path may consist of to be pasted into a shell as it is.
var shellSafe = regexp.MustCompile(`^[A-Za-z0-9/._+-]+$`)

// shellQuote makes dir safe to paste as one shell word: a hint the user is
// meant to copy must not break on a directory with a space in it.
func shellQuote(dir string) string {
	if shellSafe.MatchString(dir) {
		return dir
	}
	return "'" + strings.ReplaceAll(dir, "'", `'\''`) + "'"
}
