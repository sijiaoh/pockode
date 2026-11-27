package claude

import (
	"fmt"
	"testing"
)

// errorResultLine is a user frame carrying one failed tool_result.
func errorResultLine(id, content string) string {
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":%q,"content":%q,"is_error":true}]}}`, id, content)
}

// The failures below are the shapes claude 2.1.330 writes for Bash.
func TestToolResult_CarriesTheExitCodeOfAFailedBashCall(t *testing.T) {
	code := func(n int) *int { return &n }
	for _, tt := range []struct {
		name    string
		tool    string
		content string
		isError bool
		want    *int
	}{
		{"a command that exited 1", "Bash", "Exit code 1\nFAIL src/foo.test.ts", true, code(1)},
		{"a command killed by a signal", "Bash", "Exit code 137\n", true, code(137)},
		{"a negative status", "Bash", "Exit code -1", true, code(-1)},
		{"a call the CLI refused", "Bash", "<tool_use_error>Error: No such tool available: Bash</tool_use_error>", true, nil},
		{"a call the user denied", "Bash", "The user doesn't want to proceed with this tool use.", true, nil},
		// Strict: the line is the whole of the first line, or nothing.
		{"the words mid-line", "Bash", "make: Exit code 2", true, nil},
		{"more on the first line", "Bash", "Exit code 2 (killed)", true, nil},
		{"a status too large for an int", "Bash", "Exit code 99999999999999999999", true, nil},
		{"a successful command printing the words", "Bash", "Exit code 3", false, nil},
		{"another tool's failure in the same words", "mcp__shell__run", "Exit code 3", true, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var line string
			if tt.isError {
				line = errorResultLine("toolu_1", tt.content)
			} else {
				line = fmt.Sprintf(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":%q}]}}`, tt.content)
			}
			results := toolResults(parseTestTurns(t, toolUseLine("toolu_1", tt.tool), line))
			if len(results) != 1 {
				t.Fatalf("expected one result, got %#v", results)
			}
			got := results[0].ToRecord().ExitCode
			switch {
			case tt.want == nil && got != nil:
				t.Errorf("exit_code = %d, want none", *got)
			case tt.want != nil && got == nil:
				t.Errorf("exit_code = none, want %d", *tt.want)
			case tt.want != nil && *got != *tt.want:
				t.Errorf("exit_code = %d, want %d", *got, *tt.want)
			}
			// The output keeps the line: the body shows the result verbatim.
			if results[0].ToolResult != tt.content {
				t.Errorf("ToolResult = %q, want %q", results[0].ToolResult, tt.content)
			}
		})
	}
}
