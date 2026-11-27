package claude

import (
	"regexp"
	"strconv"
	"strings"
)

// failedBashExitLine is the first line of a Bash result the command failed
// with, measured on claude 2.1.330: `Exit code N`, then the output. The CLI
// reports no exit status as a figure — tool_use_result on a failure is the
// string "Error: " plus that same text — so this line is the only place it is.
var failedBashExitLine = regexp.MustCompile(`^Exit code (-?\d+)$`)

// reportedExitCode is the exit status of a Bash call that failed, read off the
// first line of its result; nil for any other call, and for a failure that did
// not come from the command exiting — a refused call (`<tool_use_error>`), a
// denial — or whose wording does not match exactly. Nothing is guessed: a CLI
// that rephrased the line leaves the row without a code rather than with a
// wrong one.
func reportedExitCode(toolName string, isError bool, result string) *int {
	if toolName != "Bash" || !isError {
		return nil
	}
	first, _, _ := strings.Cut(result, "\n")
	m := failedBashExitLine.FindStringSubmatch(first)
	if m == nil {
		return nil
	}
	code, err := strconv.Atoi(m[1])
	if err != nil {
		return nil
	}
	return &code
}
