package worktree

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitSetupHook_CreatesFile(t *testing.T) {
	dataDir := t.TempDir()

	err := InitSetupHook(dataDir)
	if err != nil {
		t.Fatalf("InitSetupHook failed: %v", err)
	}

	hookPath := filepath.Join(dataDir, "worktree-setup.sh")
	content, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatalf("failed to read hook file: %v", err)
	}

	if !strings.HasPrefix(string(content), "#!/bin/bash") {
		t.Error("hook file should start with shebang")
	}
}

func TestInitSetupHook_DoesNotOverwrite(t *testing.T) {
	dataDir := t.TempDir()
	hookPath := filepath.Join(dataDir, "worktree-setup.sh")

	customContent := "#!/bin/bash\necho custom\n"
	if err := os.WriteFile(hookPath, []byte(customContent), 0644); err != nil {
		t.Fatal(err)
	}

	err := InitSetupHook(dataDir)
	if err != nil {
		t.Fatalf("InitSetupHook failed: %v", err)
	}

	content, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatal(err)
	}

	if string(content) != customContent {
		t.Error("InitSetupHook should not overwrite existing file")
	}
}

func TestInitSetupHook_CreatesDataDir(t *testing.T) {
	tmpDir := t.TempDir()
	dataDir := filepath.Join(tmpDir, "nested", "data")

	err := InitSetupHook(dataDir)
	if err != nil {
		t.Fatalf("InitSetupHook failed: %v", err)
	}

	hookPath := filepath.Join(dataDir, "worktree-setup.sh")
	if _, err := os.Stat(hookPath); os.IsNotExist(err) {
		t.Error("hook file should be created")
	}
}

func TestRunSetupHook_NoScript(t *testing.T) {
	dataDir := t.TempDir()
	mainDir := t.TempDir()
	worktreeDir := t.TempDir()

	_, err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err != nil {
		t.Errorf("expected nil error when no hook exists, got: %v", err)
	}
}

// writeHook installs a setup hook and returns the data directory holding it.
func writeHook(t *testing.T, script string) string {
	t.Helper()
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "worktree-setup.sh"), []byte(script), 0644); err != nil {
		t.Fatal(err)
	}
	return dataDir
}

// stubMissingShell makes shell lookup fail, which is the supported state on a
// Windows machine without Git for Windows.
func stubMissingShell(t *testing.T, reason string) {
	t.Helper()
	original := hookShell
	t.Cleanup(func() { hookShell = original })
	hookShell = func() (string, error) { return "", errors.New(reason) }
}

// Windows has no bash of its own, so the hook may be unrunnable there. Creating
// the worktree must still succeed, the hook must not be run some other way, and
// the skip must come back to the caller — a worktree that quietly missed its
// setup is indistinguishable from a prepared one.
func TestRunSetupHook_SkippedWhenShellUnavailable(t *testing.T) {
	dataDir := writeHook(t, "#!/bin/bash\ntouch hook-ran.txt\n")
	mainDir := t.TempDir()
	worktreeDir := t.TempDir()

	stubMissingShell(t, "no bash found")

	skipped, err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err != nil {
		t.Fatalf("missing shell must not fail worktree creation, got: %v", err)
	}
	if skipped == nil {
		t.Fatal("skipping the hook must be reported to the caller, got nil")
	}
	if !strings.Contains(skipped.Reason, "no bash found") {
		t.Errorf("reason should carry the lookup failure, got: %q", skipped.Reason)
	}
	if !strings.Contains(skipped.Hint, "worktree-setup.sh") {
		t.Errorf("hint should name the hook file to delete, got: %q", skipped.Hint)
	}

	if _, err := os.Stat(filepath.Join(worktreeDir, "hook-ran.txt")); !os.IsNotExist(err) {
		t.Error("hook must not run when no shell is available")
	}
}

func TestRunSetupHook_NoSkipReportedWhenHookRuns(t *testing.T) {
	requireHookShell(t)

	dataDir := writeHook(t, "#!/bin/bash\nexit 0\n")

	skipped, err := RunSetupHook(dataDir, t.TempDir(), t.TempDir(), "test-wt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if skipped != nil {
		t.Errorf("hook ran, nothing was skipped, got: %+v", skipped)
	}
}

func TestCheckSetupHook(t *testing.T) {
	t.Run("reports the skip before any worktree is created", func(t *testing.T) {
		dataDir := writeHook(t, "#!/bin/bash\nexit 0\n")
		stubMissingShell(t, "no bash found")

		skipped := CheckSetupHook(dataDir)
		if skipped == nil {
			t.Fatal("expected a skip while no shell is available")
		}
		if !strings.Contains(skipped.Reason, "no bash found") {
			t.Errorf("reason should carry the lookup failure, got: %q", skipped.Reason)
		}
	})

	t.Run("nothing to skip without a hook", func(t *testing.T) {
		stubMissingShell(t, "no bash found")

		if skipped := CheckSetupHook(t.TempDir()); skipped != nil {
			t.Errorf("no hook means nothing is skipped, got: %+v", skipped)
		}
	})

	t.Run("nothing to skip once a shell exists", func(t *testing.T) {
		requireHookShell(t)
		dataDir := writeHook(t, "#!/bin/bash\nexit 0\n")

		if skipped := CheckSetupHook(dataDir); skipped != nil {
			t.Errorf("hook is runnable, got: %+v", skipped)
		}
	})
}

func TestRunSetupHook_Success(t *testing.T) {
	requireHookShell(t)

	dataDir := t.TempDir()
	mainDir := t.TempDir()
	worktreeDir := t.TempDir()

	// The script is bash on both platforms, so paths embedded in it must use
	// forward slashes — a native Windows path would have its separators eaten as
	// escape characters. This is the same reason RunSetupHook hands the hook
	// forward-slash paths, which is what the expectation below asserts.
	markerFile := filepath.Join(worktreeDir, "hook-ran.txt")
	hookScript := `#!/bin/bash
echo "MAIN=$POCKODE_MAIN_DIR" > "` + filepath.ToSlash(markerFile) + `"
echo "PATH=$POCKODE_WORKTREE_PATH" >> "` + filepath.ToSlash(markerFile) + `"
echo "NAME=$POCKODE_WORKTREE_NAME" >> "` + filepath.ToSlash(markerFile) + `"
`
	hookPath := filepath.Join(dataDir, "worktree-setup.sh")
	if err := os.WriteFile(hookPath, []byte(hookScript), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := RunSetupHook(dataDir, mainDir, worktreeDir, "my-feature")
	if err != nil {
		t.Errorf("expected nil error, got: %v", err)
	}

	content, err := os.ReadFile(markerFile)
	if err != nil {
		t.Fatalf("hook did not create marker file: %v", err)
	}

	expected := "MAIN=" + filepath.ToSlash(mainDir) + "\nPATH=" + filepath.ToSlash(worktreeDir) + "\nNAME=my-feature\n"
	if string(content) != expected {
		t.Errorf("marker file content mismatch\ngot:\n%s\nwant:\n%s", content, expected)
	}
}

func TestRunSetupHook_ScriptFails(t *testing.T) {
	requireHookShell(t)

	dataDir := t.TempDir()
	mainDir := t.TempDir()
	worktreeDir := t.TempDir()

	hookScript := `#!/bin/bash
exit 1
`
	hookPath := filepath.Join(dataDir, "worktree-setup.sh")
	if err := os.WriteFile(hookPath, []byte(hookScript), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err == nil {
		t.Error("expected error when script fails, got nil")
	}
}

func TestRunSetupHook_ScriptFailsWithOutput(t *testing.T) {
	requireHookShell(t)

	dataDir := t.TempDir()
	mainDir := t.TempDir()
	worktreeDir := t.TempDir()

	hookScript := `#!/bin/bash
echo "npm ERR! missing dependency"
exit 1
`
	hookPath := filepath.Join(dataDir, "worktree-setup.sh")
	if err := os.WriteFile(hookPath, []byte(hookScript), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err == nil {
		t.Fatal("expected error when script fails")
	}

	if !strings.Contains(err.Error(), "npm ERR! missing dependency") {
		t.Errorf("error should contain script output, got: %v", err)
	}
}

func TestRunSetupHook_WorksInWorktreeDir(t *testing.T) {
	requireHookShell(t)

	dataDir := t.TempDir()
	mainDir := t.TempDir()
	worktreeDir := t.TempDir()

	hookScript := `#!/bin/bash
touch created-in-cwd.txt
`
	hookPath := filepath.Join(dataDir, "worktree-setup.sh")
	if err := os.WriteFile(hookPath, []byte(hookScript), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	createdFile := filepath.Join(worktreeDir, "created-in-cwd.txt")
	if _, err := os.Stat(createdFile); os.IsNotExist(err) {
		t.Error("hook did not run in worktree directory")
	}
}

// requireHookShell skips tests that need to actually execute the hook. On unix
// bash is part of the base system; on Windows it arrives with Git for Windows,
// which is optional. Having no shell is a supported state — RunSetupHook skips
// the hook rather than failing — and that path is covered unconditionally by
// TestRunSetupHook_SkippedWhenShellUnavailable, so these tests only assert what
// happens once a shell exists.
func requireHookShell(t *testing.T) {
	t.Helper()
	if _, err := hookShell(); err != nil {
		t.Skipf("no shell available to run the hook: %v", err)
	}
}
