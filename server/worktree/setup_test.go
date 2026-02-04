package worktree

import (
	"os"
	"path/filepath"
	"runtime"
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

	err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err != nil {
		t.Errorf("expected nil error when no hook exists, got: %v", err)
	}
}

func TestRunSetupHook_Success(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell scripts not supported on Windows")
	}

	dataDir := t.TempDir()
	mainDir := t.TempDir()
	worktreeDir := t.TempDir()

	markerFile := filepath.Join(worktreeDir, "hook-ran.txt")
	hookScript := `#!/bin/bash
echo "MAIN=$POCKODE_MAIN_DIR" > "` + markerFile + `"
echo "PATH=$POCKODE_WORKTREE_PATH" >> "` + markerFile + `"
echo "NAME=$POCKODE_WORKTREE_NAME" >> "` + markerFile + `"
`
	hookPath := filepath.Join(dataDir, "worktree-setup.sh")
	if err := os.WriteFile(hookPath, []byte(hookScript), 0644); err != nil {
		t.Fatal(err)
	}

	err := RunSetupHook(dataDir, mainDir, worktreeDir, "my-feature")
	if err != nil {
		t.Errorf("expected nil error, got: %v", err)
	}

	content, err := os.ReadFile(markerFile)
	if err != nil {
		t.Fatalf("hook did not create marker file: %v", err)
	}

	expected := "MAIN=" + mainDir + "\nPATH=" + worktreeDir + "\nNAME=my-feature\n"
	if string(content) != expected {
		t.Errorf("marker file content mismatch\ngot:\n%s\nwant:\n%s", content, expected)
	}
}

func TestRunSetupHook_ScriptFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell scripts not supported on Windows")
	}

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

	err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err == nil {
		t.Error("expected error when script fails, got nil")
	}
}

func TestRunSetupHook_ScriptFailsWithOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell scripts not supported on Windows")
	}

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

	err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err == nil {
		t.Fatal("expected error when script fails")
	}

	if !strings.Contains(err.Error(), "npm ERR! missing dependency") {
		t.Errorf("error should contain script output, got: %v", err)
	}
}

func TestRunSetupHook_WorksInWorktreeDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell scripts not supported on Windows")
	}

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

	err := RunSetupHook(dataDir, mainDir, worktreeDir, "test-wt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	createdFile := filepath.Join(worktreeDir, "created-in-cwd.txt")
	if _, err := os.Stat(createdFile); os.IsNotExist(err) {
		t.Error("hook did not run in worktree directory")
	}
}
