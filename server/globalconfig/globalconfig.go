// Package globalconfig provides global configuration management for ~/.pockode/.
// Unlike the project-level .pockode/ directory, global config is shared across
// all workspaces and stores user-wide settings like auth tokens and relay credentials.
package globalconfig

import (
	"os"
	"path/filepath"
	"sync"
)

const defaultDirName = ".pockode"

var (
	homeDirMu   sync.Mutex
	homeDir     string
	homeDirErr  error
	homeDirInit bool
)

// Dir returns the global config directory path (~/.pockode or POCKODE_HOME).
// The directory is created with 0700 permissions if it doesn't exist.
func Dir() (string, error) {
	homeDirMu.Lock()
	defer homeDirMu.Unlock()

	if !homeDirInit {
		homeDir, homeDirErr = resolveDir()
		homeDirInit = true
	}
	return homeDir, homeDirErr
}

func resolveDir() (string, error) {
	// Allow override via environment variable (useful for testing)
	if dir := os.Getenv("POCKODE_HOME"); dir != "" {
		absDir, err := filepath.Abs(dir)
		if err != nil {
			return "", err
		}
		if err := os.MkdirAll(absDir, 0700); err != nil {
			return "", err
		}
		return absDir, nil
	}

	userHome, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	dir := filepath.Join(userHome, defaultDirName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}

	return dir, nil
}

// ResetDir resets the cached directory (for testing purposes only).
func ResetDir() {
	homeDirMu.Lock()
	defer homeDirMu.Unlock()
	homeDirInit = false
	homeDir = ""
	homeDirErr = nil
}

// writeFileAtomic writes data to path atomically using write-temp-fsync-rename.
// This prevents file corruption if the process crashes mid-write.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	tmpPath := path + ".tmp"

	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}

	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return err
	}

	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return err
	}

	if err := f.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}

	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}

	return nil
}
