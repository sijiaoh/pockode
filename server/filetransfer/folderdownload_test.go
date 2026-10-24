package filetransfer

import (
	"archive/zip"
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/pockode/server/internal/symlinktest"
)

func downloadFolder(t *testing.T, h *Handler, query string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/files/download-folder?"+query, nil)
	rec := httptest.NewRecorder()
	h.DownloadFolder(rec, req)
	return rec
}

// archived is one entry of a downloaded archive.
type archived struct {
	mode    fs.FileMode
	content string
}

// readArchive downloads query and returns the archive's entries by name.
func readArchive(t *testing.T, h *Handler, query string) map[string]archived {
	t.Helper()
	rec := downloadFolder(t, h, query)
	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	body := rec.Body.Bytes()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("response is not a zip archive: %v", err)
	}
	entries := map[string]archived{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("failed to open %s in the archive: %v", f.Name, err)
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("failed to read %s in the archive: %v", f.Name, err)
		}
		entries[f.Name] = archived{mode: f.Mode(), content: string(content)}
	}
	return entries
}

func names(entries map[string]archived) []string {
	list := make([]string, 0, len(entries))
	for name := range entries {
		list = append(list, name)
	}
	slices.Sort(list)
	return list
}

func assertNames(t *testing.T, entries map[string]archived, want ...string) {
	t.Helper()
	slices.Sort(want)
	if got := names(entries); !slices.Equal(got, want) {
		t.Errorf("archive holds %q, want %q", got, want)
	}
}

func TestDownloadFolder(t *testing.T) {
	t.Run("archives the folder under a top-level folder of its name", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "docs/readme.md", []byte("hello"))
		writeFile(t, workDir, "docs/guide/intro.md", []byte("intro"))
		writeFile(t, workDir, "docs/empty.txt", nil)
		if err := os.MkdirAll(filepath.Join(workDir, "docs", "blank"), 0755); err != nil {
			t.Fatal(err)
		}
		writeFile(t, workDir, "outside.txt", []byte("not asked for"))

		rec := downloadFolder(t, h, "path=docs")
		if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename=docs.zip` {
			t.Errorf("got Content-Disposition %q", got)
		}
		if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
			t.Errorf("got Content-Type %q", got)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("got Cache-Control %q", got)
		}

		entries := readArchive(t, h, "path=docs")
		assertNames(t, entries,
			"docs/", "docs/blank/", "docs/empty.txt", "docs/guide/", "docs/guide/intro.md", "docs/readme.md")
		if got := entries["docs/guide/intro.md"].content; got != "intro" {
			t.Errorf("got intro.md %q, want %q", got, "intro")
		}
		if !entries["docs/blank/"].mode.IsDir() {
			t.Errorf("docs/blank/ is not a directory entry: %v", entries["docs/blank/"].mode)
		}
	})

	t.Run("names the work directory's archive after the work directory", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "a.txt", []byte("a"))
		base := filepath.Base(workDir)

		entries := readArchive(t, h, "")
		assertNames(t, entries, base+"/", base+"/a.txt")
	})

	t.Run("archives everything Files shows, secrets and Pockode's own data included", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		nested := filepath.Join(workDir, "worktrees", "other")
		h.resolver = resolver{dirs: map[string]string{"": workDir, "other": nested}}
		h.dataDir = filepath.Join(workDir, ".pockode")
		writeFile(t, workDir, "src/main.go", []byte("package main"))
		writeFile(t, workDir, ".env", []byte("SECRET=1"))
		writeFile(t, workDir, ".git/config", []byte("[core]"))
		writeFile(t, workDir, ".github/workflows/ci.yml", []byte("on: push"))
		writeFile(t, workDir, ".pockode/sessions.json", []byte("{}"))
		writeFile(t, nested, ".git", []byte("gitdir: elsewhere"))
		writeFile(t, nested, "main.go", []byte("other"))
		base := filepath.Base(workDir)

		entries := readArchive(t, h, "")
		assertNames(t, entries,
			base+"/", base+"/src/", base+"/src/main.go",
			base+"/.env",
			base+"/.git/", base+"/.git/config",
			base+"/.github/", base+"/.github/workflows/", base+"/.github/workflows/ci.yml",
			base+"/.pockode/", base+"/.pockode/sessions.json",
			base+"/worktrees/", base+"/worktrees/other/", base+"/worktrees/other/.git", base+"/worktrees/other/main.go")
		if got := entries[base+"/.env"].content; got != "SECRET=1" {
			t.Errorf("got .env %q, want %q", got, "SECRET=1")
		}
	})

	t.Run("downloads a worktree's folder", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		other := t.TempDir()
		h.resolver = resolver{dirs: map[string]string{"": workDir, "feature": other}}
		writeFile(t, other, "lib/x.go", []byte("x"))

		entries := readArchive(t, h, "worktree=feature&path=lib")
		assertNames(t, entries, "lib/", "lib/x.go")
	})

	t.Run("refuses before streaming", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "a.txt", []byte("a"))
		tests := []struct {
			name   string
			query  string
			status int
			code   string
		}{
			{"a missing folder", "path=missing", http.StatusNotFound, CodeNotFound},
			{"a file", "path=a.txt", http.StatusBadRequest, CodeNotADirectory},
			{"a path out of the work directory", "path=../x", http.StatusBadRequest, CodeInvalidPath},
			{"an unknown worktree", "worktree=nope", http.StatusNotFound, CodeWorktreeUnknown},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				rec := downloadFolder(t, h, tt.query)
				if rec.Code != tt.status {
					t.Fatalf("got status %d, want %d (body %q)", rec.Code, tt.status, rec.Body.String())
				}
				if got := decodeError(t, rec).Code; got != tt.code {
					t.Errorf("got code %q, want %q", got, tt.code)
				}
			})
		}
	})

	t.Run("refuses a folder over the limits with the limit", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "big/a.bin", bytes.Repeat([]byte("x"), 60))
		writeFile(t, workDir, "big/b.bin", bytes.Repeat([]byte("x"), 60))

		h.maxFolderDownload = 100
		rec := downloadFolder(t, h, "path=big")
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("got status %d, want 413 (body %q)", rec.Code, rec.Body.String())
		}
		if resp := decodeError(t, rec); resp.Code != CodeTooLarge || resp.Limit != 100 {
			t.Errorf("got code %q limit %d, want %q 100", resp.Code, resp.Limit, CodeTooLarge)
		}

		h.maxFolderDownload = MaxFolderDownloadSize
		h.maxFolderDownloadEntries = 1
		rec = downloadFolder(t, h, "path=big")
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("got status %d, want 413 (body %q)", rec.Code, rec.Body.String())
		}
		if resp := decodeError(t, rec); resp.Code != CodeTooManyEntries || resp.Limit != 1 {
			t.Errorf("got code %q limit %d, want %q 1", resp.Code, resp.Limit, CodeTooManyEntries)
		}
	})

	t.Run("archives a file as it is when the archive reaches it", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "d/gone.txt", []byte("gone"))
		writeFile(t, workDir, "d/kept.txt", []byte("before"))
		h.folderSurveyed = func() {
			os.Remove(filepath.Join(workDir, "d", "gone.txt"))
			writeFile(t, workDir, "d/kept.txt", []byte("after"))
		}

		entries := readArchive(t, h, "path=d")
		assertNames(t, entries, "d/", "d/kept.txt")
		if got := entries["d/kept.txt"].content; got != "after" {
			t.Errorf("got kept.txt %q, want %q", got, "after")
		}
	})

	// Past the first byte there is no status left to answer with: the
	// download has to fail where the client can see it, never end as an
	// archive that is well-formed and incomplete.
	t.Run("aborts the response on a failure once the archive has started", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "d/a.txt", []byte("a"))
		writeFile(t, workDir, "d/b.txt", []byte("b"))
		h.maxFolderDownload = 2
		h.folderSurveyed = func() {
			writeFile(t, workDir, "d/b.txt", []byte("grown"))
		}
		srv := httptest.NewServer(http.HandlerFunc(h.DownloadFolder))
		defer srv.Close()

		resp, err := http.Get(srv.URL + "/?path=d")
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("got status %d, want the archive to have started", resp.StatusCode)
		}
		if _, err := io.ReadAll(resp.Body); err == nil {
			t.Fatal("the response ended cleanly; want it aborted")
		}
	})
}

func TestDownloadFolderSymlinks(t *testing.T) {
	h, workDir := newTestHandler(t)
	outside := t.TempDir()
	writeFile(t, outside, "secret.txt", []byte("secret"))
	writeFile(t, workDir, "d/real/file.txt", []byte("real"))
	writeFile(t, workDir, "pkg/index.js", []byte("js"))
	symlinktest.Make(t, filepath.Join(outside, "secret.txt"), filepath.Join(workDir, "d", "out"))
	symlinktest.Make(t, "real", filepath.Join(workDir, "d", "alias"))
	symlinktest.Make(t, filepath.Join(workDir, "pkg"), filepath.Join(workDir, "linked"))
	symlinktest.Make(t, outside, filepath.Join(workDir, "away"))

	t.Run("archives links as links without following them", func(t *testing.T) {
		entries := readArchive(t, h, "path=d")
		assertNames(t, entries, "d/", "d/alias", "d/out", "d/real/", "d/real/file.txt")
		for name, target := range map[string]string{
			"d/alias": "real",
			"d/out":   filepath.ToSlash(filepath.Join(outside, "secret.txt")),
		} {
			e := entries[name]
			if e.mode&fs.ModeSymlink == 0 {
				t.Errorf("%s has mode %v, want a symlink", name, e.mode)
			}
			if e.content != target {
				t.Errorf("%s holds %q, want its target %q", name, e.content, target)
			}
		}
	})

	t.Run("follows a link named as the folder within the work directory", func(t *testing.T) {
		entries := readArchive(t, h, "path=linked")
		assertNames(t, entries, "linked/", "linked/index.js")
	})

	t.Run("refuses a link named as the folder out of the work directory", func(t *testing.T) {
		rec := downloadFolder(t, h, "path=away")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("got status %d, want 400 (body %q)", rec.Code, rec.Body.String())
		}
		if got := decodeError(t, rec).Code; got != CodeInvalidPath {
			t.Errorf("got code %q, want %q", got, CodeInvalidPath)
		}
	})
}
