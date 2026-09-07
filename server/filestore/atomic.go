package filestore

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
)

const (
	filePerm = 0644
	dirPerm  = 0755
)

// ReadFileLocked reads path under a shared flock, so a concurrent
// WriteFileAtomic never exposes a half-written file. Returns nil, nil when the
// file (or its directory) does not exist.
func ReadFileLocked(path string) ([]byte, error) {
	var data []byte
	err := withFlock(path, syscall.LOCK_SH, func() error {
		var err error
		data, err = os.ReadFile(path)
		return err
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

// WriteFileAtomic replaces path's contents with data so that a crash or power
// loss leaves either the previous file or the new one, never a truncated mix:
// the data is written to a temp file, fsynced so the bytes are on disk before
// anything points at them, then renamed over path. perm applies to the file
// actually created, as with os.WriteFile — pass 0600 for anything secret, since
// the replacement never inherits the old file's mode.
//
// Writers are serialized (and readers excluded) across processes by an
// exclusive flock on "<path>.lock".
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), dirPerm); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}
	return withFlock(path, syscall.LOCK_EX, func() error {
		return writeAtomic(path, data, perm)
	})
}

// ReadJSONOrQuarantine reads path and unmarshals it into v. It reports false
// when there is nothing to load — either the file does not exist, or it failed
// to parse and was quarantined, so a file damaged by a crash degrades the store
// to empty instead of making it permanently unloadable. label names the store
// in the log message.
//
// v is left in an unspecified state when the result is false: a failed
// json.Unmarshal may already have written part of the file into it, so callers
// must fall back to their own empty value rather than use v.
func ReadJSONOrQuarantine(path, label string, v any) (bool, error) {
	var found bool

	// Reading and quarantining happen under a single exclusive lock: with two
	// locks, a writer could slip a valid file in between them and we would
	// quarantine that good file over a parse failure we already had in hand.
	err := withFlock(path, syscall.LOCK_EX, func() error {
		data, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}

		if err := json.Unmarshal(data, v); err != nil {
			backup, backupErr := quarantineLocked(path)
			if backupErr != nil {
				return fmt.Errorf("%s file %s is corrupt (%w) and could not be quarantined: %w", label, path, err, backupErr)
			}
			slog.Error("store file is corrupt, starting from empty",
				"label", label, "path", path, "backup", backup, "error", err)
			return nil
		}

		found = true
		return nil
	})
	// A missing file is handled above; this catches the missing *directory*,
	// where withFlock already fails creating the lock file.
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return found, nil
}

// quarantineLocked renames a file that failed to parse to "<path>.corrupt" so
// a store can fall back to an empty state without destroying data the user may
// still want to recover by hand. Returns the backup path. An earlier backup at
// that name is replaced — it was already unreadable. The caller must hold the
// exclusive lock on path.
func quarantineLocked(path string) (string, error) {
	backup := path + ".corrupt"
	if err := os.Rename(path, backup); err != nil {
		return "", err
	}
	return backup, nil
}

func writeAtomic(path string, data []byte, perm os.FileMode) error {
	tmpPath := path + ".tmp"

	tmpF, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}

	// O_CREATE only applies perm to a file it creates: a temp file left behind
	// by an earlier crash would otherwise keep its old, possibly wider mode.
	if err := tmpF.Chmod(perm); err != nil {
		tmpF.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("chmod temp file: %w", err)
	}

	if _, err := tmpF.Write(data); err != nil {
		tmpF.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmpF.Sync(); err != nil {
		tmpF.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("fsync temp file: %w", err)
	}
	if err := tmpF.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", err)
	}

	// The parent directory is deliberately not fsynced: a rename lost to a
	// power failure rolls back to the previous valid file, never a corrupt one,
	// and the extra fsync adds a second full disk round-trip to every index
	// write (measured on a slow disk: ~150ms → ~220ms).
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename temp file: %w", err)
	}
	return nil
}

func withFlock(path string, how int, fn func() error) error {
	lockF, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, filePerm)
	if err != nil {
		return fmt.Errorf("open lock file: %w", err)
	}
	defer lockF.Close()

	if err := syscall.Flock(int(lockF.Fd()), how); err != nil {
		return fmt.Errorf("flock: %w", err)
	}
	defer syscall.Flock(int(lockF.Fd()), syscall.LOCK_UN)

	return fn()
}
