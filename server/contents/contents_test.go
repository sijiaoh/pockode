package contents

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ValidatePath guards every file operation the client can reach, and ws/rpc_git.go
// runs it over paths it then hands to git — whose own validatePath must reach the
// same verdict. Both now delegate to filepath.IsLocal, so they agree by
// construction; this pins down what that contract admits.
func TestValidatePath(t *testing.T) {
	workDir := filepath.Join(string(filepath.Separator)+"repo", "project")

	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{"empty means the work directory itself", "", false},
		{"plain file", "file.txt", false},
		{"nested file", "dir/file.txt", false},
		{"dotfile", ".gitignore", false},
		// A leading ".." is only an escape when the whole segment is "..".
		// git.validatePath has always accepted this one; ValidatePath used to
		// reject it, so the same file was listable but not stageable.
		{"file whose name starts with dots", "..foo", false},
		{"traversal", "../secret", true},
		{"traversal after normalization", "dir/../../secret", true},
		{"absolute", "/etc/passwd", true},
		// The work directory is spelled "", never "." — the containment check
		// keeps the two from becoming interchangeable spellings.
		{"dot", ".", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidatePath(workDir, tt.path); (err != nil) != tt.wantErr {
				t.Errorf("ValidatePath(%q, %q) error = %v, wantErr %v", workDir, tt.path, err, tt.wantErr)
			}
		})
	}
}

// A path Windows resolves to a device rather than to a file under workDir is no
// more "inside" the work directory than an absolute path is. Elsewhere these are
// ordinary names and must keep working, so both answers are asserted.
func TestValidatePath_ReservedDeviceNames(t *testing.T) {
	workDir := filepath.Join(string(filepath.Separator)+"repo", "project")
	wantErr := runtime.GOOS == "windows"

	for _, path := range []string{"NUL", "COM1", "aux", "dir/CON"} {
		t.Run(path, func(t *testing.T) {
			if err := ValidatePath(workDir, path); (err != nil) != wantErr {
				t.Errorf("ValidatePath(%q, %q) error = %v, wantErr %v", workDir, path, err, wantErr)
			}
		})
	}
}

func TestWriteFile(t *testing.T) {
	t.Run("creates new file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "newfile.txt"
		content := "hello world"

		err := WriteFile(workDir, path, content)
		if err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, path))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != content {
			t.Errorf("got content %q, want %q", string(data), content)
		}
	})

	t.Run("updates existing file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "existing.txt"

		if err := os.WriteFile(filepath.Join(workDir, path), []byte("old"), 0644); err != nil {
			t.Fatalf("failed to create existing file: %v", err)
		}

		newContent := "new content"
		err := WriteFile(workDir, path, newContent)
		if err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, path))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != newContent {
			t.Errorf("got content %q, want %q", string(data), newContent)
		}
	})

	t.Run("creates parent directories", func(t *testing.T) {
		workDir := t.TempDir()
		path := "nested/deep/file.txt"
		content := "nested content"

		err := WriteFile(workDir, path, content)
		if err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, path))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != content {
			t.Errorf("got content %q, want %q", string(data), content)
		}
	})

	t.Run("returns error for empty path", func(t *testing.T) {
		workDir := t.TempDir()

		err := WriteFile(workDir, "", "content")
		if err == nil {
			t.Fatal("expected error for empty path")
		}
	})

	t.Run("returns error for path traversal", func(t *testing.T) {
		workDir := t.TempDir()

		err := WriteFile(workDir, "../outside.txt", "content")
		if err == nil {
			t.Fatal("expected error for path traversal")
		}
	})

	t.Run("creates empty file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "empty.txt"

		err := WriteFile(workDir, path, "")
		if err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}

		info, err := os.Stat(filepath.Join(workDir, path))
		if err != nil {
			t.Fatalf("failed to stat file: %v", err)
		}
		if info.Size() != 0 {
			t.Errorf("got size %d, want 0", info.Size())
		}
	})
}

func TestDeleteFile(t *testing.T) {
	t.Run("deletes existing file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "to-delete.txt"

		if err := os.WriteFile(filepath.Join(workDir, path), []byte("content"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		err := DeleteFile(workDir, path)
		if err != nil {
			t.Fatalf("DeleteFile failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, path)); !os.IsNotExist(err) {
			t.Error("expected file to be deleted")
		}
	})

	t.Run("returns error for empty path", func(t *testing.T) {
		workDir := t.TempDir()

		err := DeleteFile(workDir, "")
		if err == nil {
			t.Fatal("expected error for empty path")
		}
	})

	t.Run("returns error for path traversal", func(t *testing.T) {
		workDir := t.TempDir()

		err := DeleteFile(workDir, "../outside.txt")
		if err == nil {
			t.Fatal("expected error for path traversal")
		}
	})

	t.Run("returns error for non-existent file", func(t *testing.T) {
		workDir := t.TempDir()

		err := DeleteFile(workDir, "nonexistent.txt")
		if err == nil {
			t.Fatal("expected error for non-existent file")
		}
	})

	t.Run("deletes empty directory", func(t *testing.T) {
		workDir := t.TempDir()
		dirPath := "subdir"

		if err := os.Mkdir(filepath.Join(workDir, dirPath), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		err := DeleteFile(workDir, dirPath)
		if err != nil {
			t.Fatalf("DeleteFile failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, dirPath)); !os.IsNotExist(err) {
			t.Error("expected directory to be deleted")
		}
	})

	t.Run("deletes file in nested directory", func(t *testing.T) {
		workDir := t.TempDir()
		path := "nested/deep/file.txt"

		fullPath := filepath.Join(workDir, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			t.Fatalf("failed to create directories: %v", err)
		}
		if err := os.WriteFile(fullPath, []byte("content"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		err := DeleteFile(workDir, path)
		if err != nil {
			t.Fatalf("DeleteFile failed: %v", err)
		}

		if _, err := os.Stat(fullPath); !os.IsNotExist(err) {
			t.Error("expected file to be deleted")
		}
	})
}

func TestDelete(t *testing.T) {
	t.Run("deletes file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "file.txt"

		if err := os.WriteFile(filepath.Join(workDir, path), []byte("content"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		err := Delete(workDir, path)
		if err != nil {
			t.Fatalf("Delete failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, path)); !os.IsNotExist(err) {
			t.Error("expected file to be deleted")
		}
	})

	t.Run("deletes empty directory", func(t *testing.T) {
		workDir := t.TempDir()
		path := "emptydir"

		if err := os.Mkdir(filepath.Join(workDir, path), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		err := Delete(workDir, path)
		if err != nil {
			t.Fatalf("Delete failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, path)); !os.IsNotExist(err) {
			t.Error("expected directory to be deleted")
		}
	})

	t.Run("deletes directory with contents recursively", func(t *testing.T) {
		workDir := t.TempDir()
		path := "parent"

		parentDir := filepath.Join(workDir, path)
		if err := os.MkdirAll(filepath.Join(parentDir, "child", "grandchild"), 0755); err != nil {
			t.Fatalf("failed to create directories: %v", err)
		}
		if err := os.WriteFile(filepath.Join(parentDir, "file1.txt"), []byte("1"), 0644); err != nil {
			t.Fatalf("failed to create file1: %v", err)
		}
		if err := os.WriteFile(filepath.Join(parentDir, "child", "file2.txt"), []byte("2"), 0644); err != nil {
			t.Fatalf("failed to create file2: %v", err)
		}
		if err := os.WriteFile(filepath.Join(parentDir, "child", "grandchild", "file3.txt"), []byte("3"), 0644); err != nil {
			t.Fatalf("failed to create file3: %v", err)
		}

		err := Delete(workDir, path)
		if err != nil {
			t.Fatalf("Delete failed: %v", err)
		}

		if _, err := os.Stat(parentDir); !os.IsNotExist(err) {
			t.Error("expected directory to be deleted")
		}
	})

	t.Run("returns error for empty path", func(t *testing.T) {
		workDir := t.TempDir()

		err := Delete(workDir, "")
		if err == nil {
			t.Fatal("expected error for empty path")
		}
	})

	t.Run("returns error for path traversal", func(t *testing.T) {
		workDir := t.TempDir()

		err := Delete(workDir, "../outside")
		if err == nil {
			t.Fatal("expected error for path traversal")
		}
	})

	t.Run("returns error for absolute path", func(t *testing.T) {
		workDir := t.TempDir()

		// Asserted on the reason, not just on "some error": an anchored path
		// that slips past validation is joined onto workDir and then fails as
		// not-found, which looks identical from the outside.
		err := Delete(workDir, "/absolute/path")
		if !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("Delete(%q) error = %v, want ErrInvalidPath", "/absolute/path", err)
		}
	})

	t.Run("returns error for non-existent path", func(t *testing.T) {
		workDir := t.TempDir()

		err := Delete(workDir, "nonexistent")
		if err == nil {
			t.Fatal("expected error for non-existent path")
		}
	})
}
