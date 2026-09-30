package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
)

// versionTimeout bounds `<cli> --version`, which prints a constant and reaches
// nothing; a CLI that takes longer is one whose version is not worth waiting for.
const versionTimeout = 10 * time.Second

// versionPattern finds the version in what `--version` prints: "2.1.283 (Claude
// Code)" and "codex-cli 0.153.0" as of the versions this was written against.
var versionPattern = regexp.MustCompile(`\d+\.\d+[0-9A-Za-z.+-]*`)

// Version runs `<name> --version` and returns the version number it printed.
// A CLI that is not installed is a *BinaryNotFoundError, as with Run.
func Version(ctx context.Context, log *slog.Logger, name string) (string, error) {
	timedOut := fmt.Errorf("%s --version did not finish in time (limit %s)", name, versionTimeout)
	ctx, cancel := context.WithTimeoutCause(ctx, versionTimeout, timedOut)
	defer cancel()

	res, err := Run(ctx, log, name, "", "--version")
	// The caller's own deadline may be the one that ran out; only this one is
	// worth naming the limit of.
	if err != nil && errors.Is(context.Cause(ctx), timedOut) {
		return "", fmt.Errorf("%w: %w", timedOut, err)
	}
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("%s --version exited with status %d: %s", name, res.ExitCode, LastLine(res.Stderr))
	}
	v := parseVersion(res.Stdout)
	if v == "" {
		return "", fmt.Errorf("%s --version printed no version: %q", name, LastLine(res.Stdout))
	}
	return v, nil
}

// parseVersion picks the version number out of what a CLI's `--version`
// printed, or returns "" when there is none.
func parseVersion(out string) string {
	return versionPattern.FindString(out)
}

// LastLine is the last non-blank line of a CLI's output, trimmed. A CLI that
// fails says why on its last line, after whatever progress it printed first,
// which makes this the part worth showing a user.
func LastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
