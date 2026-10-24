//go:build !windows

package filetransfer

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pockode/server/internal/fifotest"
)

// Unix only rather than skipped on Windows: there a file mode carries no
// executable bit, chmod cannot make a file unreadable, and no fifo can be in a
// work directory.
func TestDownloadFolderUnix(t *testing.T) {
	t.Run("keeps the executable bit", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "bin/run.sh", []byte("#!/bin/sh"))
		if err := os.Chmod(filepath.Join(workDir, "bin", "run.sh"), 0755); err != nil {
			t.Fatal(err)
		}

		entries := readArchive(t, h, "path=bin")
		if got := entries["bin/run.sh"].mode.Perm(); got != 0755 {
			t.Errorf("got mode %v, want 0755", got)
		}
	})

	t.Run("refuses a name with a backslash before streaming", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, `d/up\..\..\evil`, []byte("x"))

		rec := downloadFolder(t, h, "path=d")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("got status %d, want 400 (body %q)", rec.Code, rec.Body.String())
		}
		if resp := decodeError(t, rec); resp.Code != CodeInvalidPath {
			t.Errorf("got code %q, want %q", resp.Code, CodeInvalidPath)
		}
	})

	t.Run("refuses a folder whose own name has a backslash", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, `..\..\evil/a.txt`, []byte("x"))

		rec := downloadFolder(t, h, "path="+url.QueryEscape(`..\..\evil`))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("got status %d, want 400 (body %q)", rec.Code, rec.Body.String())
		}
		if resp := decodeError(t, rec); resp.Code != CodeInvalidPath {
			t.Errorf("got code %q, want %q", resp.Code, CodeInvalidPath)
		}
	})

	t.Run("leaves out a fifo without blocking on it", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "d/a.txt", []byte("a"))
		fifotest.Make(t, filepath.Join(workDir, "d"), "pipe")

		done := make(chan struct{})
		go func() {
			defer close(done)
			downloadFolder(t, h, "path=d")
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("download blocked on the fifo")
		}
		assertNames(t, readArchive(t, h, "path=d"), "d/", "d/a.txt")
	})

	t.Run("refuses an unreadable file before streaming", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root reads a file whatever its mode")
		}
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "d/locked.txt", []byte("x"))
		if err := os.Chmod(filepath.Join(workDir, "d", "locked.txt"), 0); err != nil {
			t.Fatal(err)
		}

		rec := downloadFolder(t, h, "path=d")
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("got status %d, want 500 (body %q)", rec.Code, rec.Body.String())
		}
		if resp := decodeError(t, rec); resp.Code != CodeInternal {
			t.Errorf("got code %q, want %q", resp.Code, CodeInternal)
		}
	})
}
