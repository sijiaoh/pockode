//go:build !windows

package filestore

import (
	"os"
	"path/filepath"
	"testing"
)

// A crash can leave a temp file behind; its mode must not become the mode of
// the file the next write publishes.
//
// The assertion is unix-only because the mode is: Windows maps the perm
// argument to the read-only attribute alone, and 0600 has the write bit set,
// so nothing about it is observable there. What keeps a secret out of reach on
// Windows is the restricted directory the file inherits from, asserted by the
// packages that write credentials (internal/fsperm, serverinfo, relay).
func TestWriteFileAtomic_AppliesPermOverLeftoverTempFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secret.json")
	if err := os.WriteFile(path+".tmp", []byte("stale"), 0644); err != nil {
		t.Fatalf("write leftover temp file: %v", err)
	}

	if err := WriteFileAtomic(path, []byte("secret"), 0600); err != nil {
		t.Fatalf("WriteFileAtomic failed: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("expected mode 0600, got %04o", info.Mode().Perm())
	}
}
