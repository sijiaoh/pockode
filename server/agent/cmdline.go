package agent

import (
	"fmt"
	"os"
	"strings"
)

// Quoting for the cmd.exe wrapper Windows uses to run .bat and .cmd files.
//
// A process receives its command line as one string on Windows and splits it
// itself. os/exec escapes for the CommandLineToArgvW rules almost everything
// uses, and documents the exception: cmd.exe — and therefore every batch file,
// because Windows runs one by handing the command line to cmd.exe — unquotes
// with rules of its own. npm installs the AI CLIs as `claude.cmd` / `codex.cmd`,
// so on Windows every argument we pass reaches the CLI through that second
// parser.
//
// The gap is not theoretical. syscall.EscapeArg only adds quotes when an
// argument contains a space or a tab, so a project path with a space in it is
// fine while `--mcp-config C:\a&b\.pockode\mcp-config.json` goes onto the
// command line verbatim: cmd.exe reads the `&` as a command separator, hands
// the CLI a truncated path, and runs the remainder as a command of its own.
// `^ | < > ( )` behave the same way. Go knows about this and chose to document
// it rather than fix it, so handling it is the caller's job.
//
// The remedy os/exec documents is to build the command line ourselves and pass
// it as SysProcAttr.CmdLine, which is what prepareCommandLine does on Windows.
// The string handling lives here rather than in command_windows.go on purpose:
// it is pure, and keeping it platform-independent means its tests run
// everywhere instead of only on the Windows CI leg.

// batchCommandLine builds the command string prepareCommandLine hands to
// cmd.exe after /c.
//
// The result carries an outer pair of quotes around the whole command, which is
// what the /s switch then strips back off. Without them cmd would instead strip
// the quotes around the script path and the closing quote of the last argument,
// leaving an unbalanced line where everything past that point parses outside
// quotes.
//
// Script and arguments are quoted differently because they are read by
// different numbers of parsers: cmd.exe consumes the script path itself, while
// the arguments carry on through the batch file's %* into the real executable.
func batchCommandLine(script string, args []string) (string, error) {
	quoted, err := quoteForCmd(script)
	if err != nil {
		return "", err
	}
	parts := []string{quoted}
	for _, arg := range args {
		q, err := quoteForCmdAndArgv(arg)
		if err != nil {
			return "", err
		}
		parts = append(parts, q)
	}
	return `"` + strings.Join(parts, " ") + `"`, nil
}

// quoteForCmdAndArgv quotes a value that crosses both parsers: cmd.exe on the
// way in, and the real executable's CommandLineToArgvW on the way out of the
// batch file's %*.
//
// The extra step over quoteForCmd is the trailing backslashes. cmd.exe has no
// backslash escape, so `"C:\dir\"` closes cleanly there — but the batch file
// forwards that text verbatim, and CommandLineToArgvW reads the `\"` as an
// escaped quote, leaving the argument open to swallow everything after it.
// Doubling the run before the closing quote is what that parser expects; cmd,
// which treats every backslash literally, is unaffected either way.
func quoteForCmdAndArgv(s string) (string, error) {
	if err := checkCmdSafe(s); err != nil {
		return "", err
	}
	trailing := len(s) - len(strings.TrimRight(s, `\`))
	return `"` + s + strings.Repeat(`\`, trailing) + `"`, nil
}

// quoteForCmd quotes a value that cmd.exe itself consumes and nothing else
// re-parses, which is what makes it treat `& ^ | < > ( )` and whitespace as
// part of the value instead of as syntax.
//
// It deliberately skips the trailing-backslash doubling quoteForCmdAndArgv
// does. Doubling would be wrong here — cmd would then look for a path with two
// separators on the end — and it is also unnecessary: the only caller is the
// script path, which prepareCommandLine has already established ends in .bat
// or .cmd.
func quoteForCmd(s string) (string, error) {
	if err := checkCmdSafe(s); err != nil {
		return "", err
	}
	return `"` + s + `"`, nil
}

// checkCmdSafe rejects what quoting cannot neutralise. Failing loudly is the
// point: passing these through would hand the CLI a value nobody asked for, and
// in the worst case run the tail of it as a command.
//
//   - A double quote closes the quoted span, putting the rest of the value back
//     into cmd's syntax. Newlines and NUL end the command line outright. None of
//     them can occur in a Windows path.
//   - %NAME% is expanded even inside quotes. Only a defined variable is a
//     hazard — cmd leaves %NAME% alone otherwise — so `C:\50% done` is fine and
//     is not rejected. Rust's fix for the same problem neutralises every % with
//     the `%%cd:~,%` substring trick instead of rejecting; that keeps more paths
//     working, but it is a trick whose behaviour we cannot verify here, and
//     getting it wrong means silently passing a wrong path rather than saying
//     so. A directory named after a defined environment variable is rare enough
//     that the loud failure is the better trade.
func checkCmdSafe(s string) error {
	// Paths are printed unquoted: %q would escape every separator in a Windows
	// path and leave the user comparing \\ against what they typed.
	if i := strings.IndexAny(s, "\"\r\n\x00"); i >= 0 {
		return fmt.Errorf("cannot pass %s through the cmd.exe wrapper Windows runs .bat and .cmd files with: it contains %q", s, s[i:i+1])
	}
	if span, name, ok := expandedVarIn(s); ok {
		// The value is only worth quoting for a plain %NAME%; for the substring
		// and substitution forms the variable's value is not what comes out.
		expansion := ""
		if span == "%"+name+"%" {
			expansion = ", which is " + os.Getenv(name) + " here"
		}
		return fmt.Errorf("cannot pass %s through the .cmd wrapper the CLI is installed as: cmd.exe expands the %s in it%s. Move the directory to a path without %s in it, or install the CLI as a native .exe", s, span, expansion, span)
	}
	return nil
}

// expandedVarIn returns the first %...% span in s that cmd.exe would expand,
// along with the environment variable it reads.
//
// The span is not always `%NAME%`: with command extensions on — and
// prepareCommandLine turns them on — `%NAME:~0,3%` takes a substring and
// `%NAME:a=b%` substitutes, so the name runs only up to the first colon.
// Matching the whole span against the environment would miss both.
//
// The environment consulted is our own, which is the one the child inherits:
// nothing here sets Cmd.Env.
func expandedVarIn(s string) (span, name string, ok bool) {
	for {
		start := strings.IndexByte(s, '%')
		if start < 0 {
			return "", "", false
		}
		rest := s[start+1:]
		end := strings.IndexByte(rest, '%')
		if end < 0 {
			return "", "", false
		}
		inner := rest[:end]
		candidate := inner
		if i := strings.IndexByte(candidate, ':'); i >= 0 {
			candidate = candidate[:i]
		}
		if candidate != "" {
			if _, defined := os.LookupEnv(candidate); defined {
				return "%" + inner + "%", candidate, true
			}
		}
		// Resume at the closing %, which cmd may equally read as the opening one
		// of the next pair: in `%A%B%` both `%A%` and `%B%` are candidates.
		s = rest[end:]
	}
}
