//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCommandPassesArgumentsThroughBatchWrapper is the regression this whole
// mechanism exists for.
//
// It reproduces the real shape: a .cmd wrapper that forwards %* to the actual
// executable, exactly as the shim npm generates for `claude` does, sitting in a
// project path full of the characters cmd.exe treats as syntax. Without the
// quoting, cmd splits the command line at the & and the wrapper never sees the
// rest of the path — it runs as a command instead.
func TestCommandPassesArgumentsThroughBatchWrapper(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	t.Setenv(roleEnv, roleArgv)

	// Every character here is legal in a Windows directory name and special to
	// cmd.exe: & separates commands, ^ escapes, ( ) group, ! is delayed
	// expansion, and the spaces would split the argument on their own.
	projectDir := filepath.Join(t.TempDir(), "a&b ^c (d) !e")
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		t.Fatalf("create project directory: %v", err)
	}

	wrapper := filepath.Join(projectDir, "claude.cmd")
	script := "@echo off\r\n\"" + exe + "\" %*\r\n"
	if err := os.WriteFile(wrapper, []byte(script), 0644); err != nil {
		t.Fatalf("write .cmd wrapper: %v", err)
	}

	configPath := filepath.Join(projectDir, ".pockode", "mcp-config.json")
	args := []string{
		"--mcp-config", configPath,
		// A trailing separator exercises the second parser specifically: cmd
		// closes the quote regardless, but CommandLineToArgvW would read the
		// `\"` as an escaped quote and run the argument on into nothing.
		"--add-dir", projectDir + `\`,
	}

	cmd, err := Command(wrapper, args...)
	if err != nil {
		t.Fatalf("Command: %v", err)
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("running the .cmd wrapper: %v", err)
	}
	assertArgvLines(t, string(out), args)
}

// TestCommandRoutesBatchFilesThroughCmd pins that the batch case really is
// handled here rather than left to the fallback inside CreateProcess: the
// switches on that command line are what keep an AutoRun script, cmd's
// conditional quote rule, and delayed expansion out of the picture.
func TestCommandRoutesBatchFilesThroughCmd(t *testing.T) {
	wrapper := filepath.Join(t.TempDir(), "claude.cmd")
	if err := os.WriteFile(wrapper, []byte("@echo off\r\n"), 0644); err != nil {
		t.Fatalf("write .cmd wrapper: %v", err)
	}

	cmd, err := Command(wrapper, "--mcp-config", `C:\a&b\x.json`)
	if err != nil {
		t.Fatalf("Command: %v", err)
	}

	if !strings.EqualFold(filepath.Base(cmd.Path), "cmd.exe") {
		t.Errorf("a .cmd wrapper should be run through cmd.exe, got %q", cmd.Path)
	}
	if cmd.SysProcAttr == nil || cmd.SysProcAttr.CmdLine == "" {
		t.Fatal("the command line was left for os/exec to build, so it is quoted for the wrong parser")
	}
	line := cmd.SysProcAttr.CmdLine
	for _, want := range []string{" /d ", " /e:on ", " /v:off ", " /s ", ` /c ""`, `"C:\a&b\x.json"`} {
		if !strings.Contains(line, want) {
			t.Errorf("command line is missing %q:\n%s", want, line)
		}
	}
}

// TestCommandRejectsUnquotableArgument pins that a value quoting cannot make
// safe reaches the caller as an error, rather than being swallowed into a Cmd
// that would go on to run with a different argument than it was given.
func TestCommandRejectsUnquotableArgument(t *testing.T) {
	t.Setenv("POCKODE_TEST_COMMAND_VAR", "expanded-value")

	wrapper := filepath.Join(t.TempDir(), "claude.cmd")
	if err := os.WriteFile(wrapper, []byte("@echo off\r\n"), 0644); err != nil {
		t.Fatalf("write .cmd wrapper: %v", err)
	}

	_, err := Command(wrapper, "--mcp-config", `C:\%POCKODE_TEST_COMMAND_VAR%\x.json`)
	if err == nil {
		t.Fatal("Command accepted an argument cmd.exe would have rewritten")
	}
	for _, want := range []string{wrapper, "%POCKODE_TEST_COMMAND_VAR%", "expanded-value"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error is missing %q:\n%v", want, err)
		}
	}
}

// TestCommandLeavesNativeExecutablesAlone is the other half of the batch case.
// A native claude.exe must not pick up a cmd.exe layer it does not need: that
// would add a process to the tree for nothing and, worse, hand os/exec's
// already-correct quoting to a parser it was not written for.
func TestCommandLeavesNativeExecutablesAlone(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}

	cmd, err := Command(exe, "--mcp-config", `C:\a&b\x.json`)
	if err != nil {
		t.Fatalf("Command: %v", err)
	}
	if cmd.Path != exe {
		t.Errorf("an .exe was rerouted: Path is %q, want %q", cmd.Path, exe)
	}
	if cmd.SysProcAttr != nil && cmd.SysProcAttr.CmdLine != "" {
		t.Errorf("an .exe should be left to os/exec to quote, got CmdLine %q", cmd.SysProcAttr.CmdLine)
	}
}

// TestCommandFallsBackToInstallDirectories covers the case PATH cannot: an
// installer appended its directory to the user PATH after pockode.exe started,
// so the CLI is present but not on the PATH this process inherited.
func TestCommandFallsBackToInstallDirectories(t *testing.T) {
	appData := t.TempDir()
	npmDir := filepath.Join(appData, "npm")
	if err := os.MkdirAll(npmDir, 0755); err != nil {
		t.Fatalf("create npm directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(npmDir, "pockode-fake-cli.cmd"), []byte("@echo off\r\n"), 0644); err != nil {
		t.Fatalf("write .cmd wrapper: %v", err)
	}

	t.Setenv("APPDATA", appData)
	t.Setenv("PATH", "")

	// The name is given without an extension, exactly as the agent packages
	// spell it; finding claude.cmd from `claude` is PATHEXT's job.
	got, err := lookupBinary("pockode-fake-cli")
	if err != nil {
		t.Fatalf("lookupBinary did not fall back to the npm install directory: %v", err)
	}
	if want := filepath.Join(npmDir, "pockode-fake-cli.cmd"); got != want {
		t.Errorf("lookupBinary returned %q, want %q", got, want)
	}
}
