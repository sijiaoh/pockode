package filestore

import (
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/pockode/server/internal/unwritabletest"
)

func TestWriteFileAtomic_ReplacesContentAndLeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "index.json")

	if err := WriteFileAtomic(path, []byte("first"), 0644); err != nil {
		t.Fatalf("WriteFileAtomic failed: %v", err)
	}
	if err := WriteFileAtomic(path, []byte("second"), 0644); err != nil {
		t.Fatalf("WriteFileAtomic failed: %v", err)
	}

	data, err := ReadFileLocked(path)
	if err != nil {
		t.Fatalf("ReadFileLocked failed: %v", err)
	}
	if string(data) != "second" {
		t.Errorf("expected %q, got %q", "second", data)
	}

	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("expected temp file to be gone after a successful write")
	}
}

// The point of the temp-file dance: when the filesystem refuses the write (a
// full disk being the case that started all this), the previous file must
// survive whole rather than be left truncated. Only the closing rename ever
// touches path, so any failure before it must be harmless; a read-only
// directory stands in for ENOSPC to fail one of them without needing a full
// filesystem.
func TestWriteFileAtomic_FailedWriteKeepsPreviousContents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "index.json")

	// Write once first so the lock file exists: opening it must not be what
	// fails, or the test would never reach the write itself.
	if err := WriteFileAtomic(path, []byte("original"), 0644); err != nil {
		t.Fatalf("WriteFileAtomic failed: %v", err)
	}

	unwritabletest.Make(t, dir)

	if err := WriteFileAtomic(path, []byte("replacement"), 0644); err == nil {
		t.Fatal("expected an error when the directory is not writable")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after failed write: %v", err)
	}
	if string(data) != "original" {
		t.Errorf("expected the previous contents to survive, got %q", data)
	}
}

// Each update sees the previous one's result: concurrent read-modify-writes
// lose nothing, and an update that declines to write leaves the file alone.
func TestUpdateFileAtomic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "counter")

	const writers = 20
	var wg sync.WaitGroup
	for range writers {
		wg.Go(func() {
			err := UpdateFileAtomic(path, 0600, func(data []byte) ([]byte, error) {
				n := 0
				if data != nil {
					n, _ = strconv.Atoi(string(data))
				}
				return []byte(strconv.Itoa(n + 1)), nil
			})
			if err != nil {
				t.Errorf("UpdateFileAtomic: %v", err)
			}
		})
	}
	wg.Wait()

	if err := UpdateFileAtomic(path, 0600, func([]byte) ([]byte, error) { return nil, nil }); err != nil {
		t.Fatalf("UpdateFileAtomic: %v", err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != strconv.Itoa(writers) {
		t.Errorf("counter = %q, %v; want %d", data, err, writers)
	}
}

func TestReadFileLocked_MissingFile(t *testing.T) {
	dir := t.TempDir()

	for _, path := range []string{
		filepath.Join(dir, "absent.json"),
		filepath.Join(dir, "absent-dir", "absent.json"),
	} {
		data, err := ReadFileLocked(path)
		if err != nil {
			t.Fatalf("ReadFileLocked(%s) failed: %v", path, err)
		}
		if data != nil {
			t.Errorf("ReadFileLocked(%s): expected nil data, got %q", path, data)
		}
	}
}

func TestReadJSONOrQuarantine(t *testing.T) {
	type payload struct {
		Name string `json:"name"`
	}

	t.Run("missing file reports not found", func(t *testing.T) {
		dir := t.TempDir()
		for _, path := range []string{
			filepath.Join(dir, "absent.json"),
			filepath.Join(dir, "absent-dir", "absent.json"),
		} {
			var v payload
			found, err := ReadJSONOrQuarantine(path, "test", &v)
			if err != nil {
				t.Fatalf("ReadJSONOrQuarantine(%s): unexpected error: %v", path, err)
			}
			if found {
				t.Errorf("ReadJSONOrQuarantine(%s): expected found=false", path)
			}
		}
	})

	t.Run("valid file is decoded", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "store.json")
		if err := os.WriteFile(path, []byte(`{"name":"ok"}`), 0644); err != nil {
			t.Fatalf("write: %v", err)
		}

		var v payload
		found, err := ReadJSONOrQuarantine(path, "test", &v)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !found || v.Name != "ok" {
			t.Errorf("found=%v value=%+v, want found=true name=ok", found, v)
		}
	})

	t.Run("truncated file is quarantined and reported not found", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "store.json")
		if err := os.WriteFile(path, []byte(`{"name":"tru`), 0644); err != nil {
			t.Fatalf("write: %v", err)
		}

		var v payload
		found, err := ReadJSONOrQuarantine(path, "test", &v)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if found {
			t.Error("expected found=false for a corrupt file")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Error("expected the corrupt file to be moved aside")
		}
		// The backup must keep the damaged bytes: it exists so the user can
		// recover what was left by hand.
		backup, err := os.ReadFile(path + ".corrupt")
		if err != nil {
			t.Fatalf("read backup: %v", err)
		}
		if string(backup) != `{"name":"tru` {
			t.Errorf("expected the backup to keep the original bytes, got %q", backup)
		}
	})
}
