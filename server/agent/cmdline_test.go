package agent

import (
	"strings"
	"testing"
)

// The command line built here is only ever used on Windows, but the code that
// builds it is platform-independent so that these cases run on every leg of CI
// rather than on the Windows one alone.

func TestBatchCommandLine(t *testing.T) {
	const script = `C:\Users\dev\AppData\Roaming\npm\claude.cmd`

	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "no arguments",
			want: `"` + `"` + script + `"` + `"`,
		},
		{
			// The reason this file exists: cmd.exe reads an unquoted & as a
			// command separator, so the path has to arrive quoted or the CLI gets
			// `C:\a` and cmd tries to run the rest.
			name: "cmd metacharacters in a path are quoted",
			args: []string{"--mcp-config", `C:\a&b\.pockode\mcp-config.json`},
			want: `""` + script + `" "--mcp-config" "C:\a&b\.pockode\mcp-config.json""`,
		},
		{
			name: "every metacharacter a Windows path may contain",
			args: []string{`C:\a&b ^c (d) !e ,f;g=h\x.json`},
			want: `""` + script + `" "C:\a&b ^c (d) !e ,f;g=h\x.json""`,
		},
		{
			// cmd.exe closes the quote either way — it has no backslash escape —
			// but the CLI on the far side of the batch file's %* parses with
			// CommandLineToArgvW, where `\"` is an escaped quote and the argument
			// would run on into whatever follows.
			name: "a trailing backslash is doubled so it cannot escape the closing quote",
			args: []string{"--add-dir", `C:\a&b\sub\`},
			want: `""` + script + `" "--add-dir" "C:\a&b\sub\\""`,
		},
		{
			name: "a whole run of trailing backslashes is doubled",
			args: []string{`C:\a\\\`},
			want: `""` + script + `" "C:\a\\\\\\""`,
		},
		{
			// Only the run touching the closing quote matters; doubling the rest
			// would change the value.
			name: "backslashes inside the argument are left alone",
			args: []string{`C:\a\b\c.json`},
			want: `""` + script + `" "C:\a\b\c.json""`,
		},
		{
			// An unquoted empty argument would vanish from the command line
			// instead of arriving as "", shifting every argument after it.
			name: "an empty argument keeps its place",
			args: []string{"--mcp-config", ""},
			want: `""` + script + `" "--mcp-config" """`,
		},
		{
			// A lone % cannot start an expansion, so rejecting it would turn a
			// perfectly usable directory name into a failure.
			name: "a percent sign that opens nothing is left alone",
			args: []string{`C:\50% done\proj`},
			want: `""` + script + `" "C:\50% done\proj""`,
		},
		{
			name: "an undefined variable is not expanded by cmd, so it passes",
			args: []string{`C:\%POCKODE_NOT_A_REAL_VARIABLE%\proj`},
			want: `""` + script + `" "C:\%POCKODE_NOT_A_REAL_VARIABLE%\proj""`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := batchCommandLine(script, tt.args)
			if err != nil {
				t.Fatalf("batchCommandLine: %v", err)
			}
			if got != tt.want {
				t.Errorf("batchCommandLine\n got: %s\nwant: %s", got, tt.want)
			}
		})
	}
}

// TestBatchCommandLineRejectsUnquotableArguments covers the inputs quoting
// cannot make safe. Passing them through would hand the CLI a value it never
// asked for, so they have to fail loudly instead.
func TestBatchCommandLineRejectsUnquotableArguments(t *testing.T) {
	t.Setenv("POCKODE_TEST_CMDLINE_VAR", "expanded-value")

	tests := []struct {
		name    string
		arg     string
		wantIn  string
		wantVal string
	}{
		{
			name:   "double quote closes the quoted span",
			arg:    `C:\a"b\proj`,
			wantIn: `"\""`,
		},
		{
			name:   "newline ends the command line",
			arg:    "C:\\a\nb",
			wantIn: `"\n"`,
		},
		{
			name:    "a defined variable is expanded even inside quotes",
			arg:     `C:\%POCKODE_TEST_CMDLINE_VAR%\proj`,
			wantIn:  "%POCKODE_TEST_CMDLINE_VAR%",
			wantVal: "expanded-value",
		},
		{
			// Command extensions (which prepareCommandLine forces on) make
			// %NAME:~x,y% a substring expansion, so matching the whole span
			// against the environment would let it through.
			name:   "the substring form is caught even though the span is not a variable name",
			arg:    `C:\%POCKODE_TEST_CMDLINE_VAR:~0,3%\proj`,
			wantIn: "%POCKODE_TEST_CMDLINE_VAR:~0,3%",
		},
		{
			name:   "the substitution form is caught too",
			arg:    `C:\%POCKODE_TEST_CMDLINE_VAR:a=b%\proj`,
			wantIn: "%POCKODE_TEST_CMDLINE_VAR:a=b%",
		},
		{
			// cmd may read the closing % of one pair as the opening % of the next,
			// so scanning has to resume there rather than past it.
			name:   "the second of two adjacent pairs is still found",
			arg:    `C:\%POCKODE_NOT_A_REAL_VARIABLE%POCKODE_TEST_CMDLINE_VAR%\proj`,
			wantIn: "%POCKODE_TEST_CMDLINE_VAR%",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := batchCommandLine(`C:\npm\claude.cmd`, []string{"--mcp-config", tt.arg})
			if err == nil {
				t.Fatalf("batchCommandLine accepted %q", tt.arg)
			}
			if !strings.Contains(err.Error(), tt.wantIn) {
				t.Errorf("error does not name the offending character or variable\n got: %v\nwant it to contain: %s", err, tt.wantIn)
			}
			// Naming what the argument would have turned into is what makes the
			// error actionable; without it the user only knows we refused.
			if tt.wantVal != "" && !strings.Contains(err.Error(), tt.wantVal) {
				t.Errorf("error does not say what cmd.exe would have expanded it to\n got: %v\nwant it to contain: %s", err, tt.wantVal)
			}
		})
	}
}
