package filetransfer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/internal/fifotest"
	"github.com/pockode/server/internal/symlinktest"
)

// folderEntry is one part of a folder upload: a file at a path relative to the
// folder, or, with dir set, a directory declaration.
type folderEntry struct {
	path    string
	content []byte
	dir     bool
}

func newFolderUploadRequest(t *testing.T, query string, entries ...folderEntry) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, e := range entries {
		if e.dir {
			if err := writer.WriteField(folderDirField, e.path); err != nil {
				t.Fatalf("failed to write dir field %s: %v", e.path, err)
			}
			continue
		}
		part, err := writer.CreateFormFile("files", e.path)
		if err != nil {
			t.Fatalf("failed to create part %s: %v", e.path, err)
		}
		if _, err := part.Write(e.content); err != nil {
			t.Fatalf("failed to write part %s: %v", e.path, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("failed to close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/files/upload-folder?"+query, &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func uploadFolder(t *testing.T, h *Handler, query string, entries ...folderEntry) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.UploadFolder(rec, newFolderUploadRequest(t, query, entries...))
	return rec
}

func assertNotExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Errorf("%s exists after a failed upload (err %v)", path, err)
	}
}

func readString(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read %s: %v", path, err)
	}
	return string(data)
}

func TestUploadFolder(t *testing.T) {
	t.Run("stores the folder with its structure, empty directories included", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "assets/keep.txt", []byte("keep"))

		rec := uploadFolder(t, h, "path=assets&name=icons",
			folderEntry{path: "a.svg", content: []byte("a")},
			folderEntry{path: "deep/er/b.svg", content: []byte("bb")},
			folderEntry{path: "empty/inner", dir: true})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		var body folderUploadResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("failed to decode response %q: %v", rec.Body.String(), err)
		}
		if body.Folder != (UploadedFolder{Path: "assets/icons", Name: "icons"}) {
			t.Errorf("got folder %+v", body.Folder)
		}
		want := []UploadedFile{
			{Path: "assets/icons/a.svg", Name: "a.svg", Size: 1},
			{Path: "assets/icons/deep/er/b.svg", Name: "b.svg", Size: 2},
		}
		if len(body.Files) != len(want) {
			t.Fatalf("got files %+v, want %+v", body.Files, want)
		}
		for i, w := range want {
			if body.Files[i] != w {
				t.Errorf("got file %+v, want %+v", body.Files[i], w)
			}
		}
		if got := readString(t, filepath.Join(workDir, "assets/icons/deep/er/b.svg")); got != "bb" {
			t.Errorf("got content %q", got)
		}
		if info, err := os.Stat(filepath.Join(workDir, "assets/icons/empty/inner")); err != nil || !info.IsDir() {
			t.Errorf("empty directory not created: %v", err)
		}
	})

	t.Run("creates an empty folder from a request with no parts", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		rec := uploadFolder(t, h, "name=empty")

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if info, err := os.Stat(filepath.Join(workDir, "empty")); err != nil || !info.IsDir() {
			t.Errorf("folder not created: %v", err)
		}
	})

	// The security boundary: every component of an entry's path is a plain
	// name, so nothing in the payload can address anything outside the folder.
	t.Run("refuses an entry path that is not one name after another, and keeps nothing", func(t *testing.T) {
		for _, p := range []string{
			"../escape.txt",
			"a/../../escape.txt",
			"a/../b.txt",
			"/abs.txt",
			"a//b.txt",
			"a/",
			"./a.txt",
			"..",
			"",
			"...",
			"a./b.txt",
			"a/b.txt ",
			"nul\x00.txt",
			strings.Repeat("n", 256),
			strings.Repeat("a/", 2048) + "b.txt",
		} {
			for _, dir := range []bool{false, true} {
				h, workDir := newTestHandler(t)

				rec := uploadFolder(t, h, "name=up",
					folderEntry{path: "ok.txt", content: []byte("x")},
					folderEntry{path: p, content: []byte("x"), dir: dir})

				want := CodeInvalidPath
				// A NUL is not allowed in a header at all, so a filename
				// holding one never parses; only a dir field's value can
				// carry it as far as the path check.
				if strings.ContainsRune(p, 0) && !dir {
					want = CodeInvalidRequest
				}
				body := assertError(t, rec, http.StatusBadRequest, want)
				if len(body.Written) != 0 {
					t.Errorf("%q: reported %+v as written, but the folder is gone", p, body.Written)
				}
				assertNotExist(t, filepath.Join(workDir, "up"))
				assertNotExist(t, filepath.Join(workDir, "escape.txt"))
				assertNotExist(t, filepath.Join(filepath.Dir(workDir), "escape.txt"))
			}
		}
	})

	t.Run("refuses a folder name that is not a name", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		for _, name := range []string{"", ".", "..", "a/b", "../up"} {
			rec := uploadFolder(t, h, "name="+name, folderEntry{path: "a.txt", content: []byte("x")})
			assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
		}
		entries, err := os.ReadDir(workDir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Errorf("work directory gained %v", entries)
		}
	})

	t.Run("refuses a destination outside the work directory", func(t *testing.T) {
		h, _ := newTestHandler(t)

		rec := uploadFolder(t, h, "path=..&name=up", folderEntry{path: "a.txt", content: []byte("x")})

		assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
	})

	t.Run("refuses a destination that links out of the work directory", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		outside := t.TempDir()
		symlinktest.Make(t, outside, filepath.Join(workDir, "out"))

		rec := uploadFolder(t, h, "path=out&name=up", folderEntry{path: "a.txt", content: []byte("x")})

		assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
		assertNotExist(t, filepath.Join(outside, "up"))
	})

	// A pnpm workspace links packages into node_modules; a link that stays in
	// the project is a directory of the project.
	t.Run("follows a destination link that stays inside the work directory", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		if err := os.Mkdir(filepath.Join(workDir, "real"), 0755); err != nil {
			t.Fatal(err)
		}
		symlinktest.Make(t, filepath.Join(workDir, "real"), filepath.Join(workDir, "alias"))

		rec := uploadFolder(t, h, "path=alias&name=up", folderEntry{path: "a.txt", content: []byte("x")})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if got := readString(t, filepath.Join(workDir, "real/up/a.txt")); got != "x" {
			t.Errorf("got content %q", got)
		}
	})

	// Never merged, never replaced, never followed: the existing entry is left
	// exactly as it was, and the client is told to pick another name.
	// One subtest per kind, so a platform that cannot make a link still runs
	// the others.
	t.Run("refuses a name already taken by a folder, a file or a link", func(t *testing.T) {
		for _, tc := range []struct {
			name  string
			setup func(t *testing.T, workDir, outside string)
			check func(t *testing.T, workDir, outside string)
		}{
			{"dir", func(t *testing.T, workDir, _ string) {
				writeFile(t, workDir, "dir/old.txt", []byte("old"))
			}, func(t *testing.T, workDir, _ string) {
				if got := readString(t, filepath.Join(workDir, "dir/old.txt")); got != "old" {
					t.Errorf("existing folder was changed: %q", got)
				}
			}},
			{"file", func(t *testing.T, workDir, _ string) {
				writeFile(t, workDir, "file", []byte("old"))
			}, func(t *testing.T, workDir, _ string) {
				if got := readString(t, filepath.Join(workDir, "file")); got != "old" {
					t.Errorf("existing file was changed: %q", got)
				}
			}},
			{"link", func(t *testing.T, workDir, outside string) {
				symlinktest.Make(t, outside, filepath.Join(workDir, "link"))
			}, func(t *testing.T, _, outside string) {
				assertNotExist(t, filepath.Join(outside, "old.txt"))
			}},
			{"dangling", func(t *testing.T, workDir, outside string) {
				symlinktest.Make(t, filepath.Join(outside, "missing"), filepath.Join(workDir, "dangling"))
			}, func(t *testing.T, _, outside string) {
				assertNotExist(t, filepath.Join(outside, "missing"))
			}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				h, workDir := newTestHandler(t)
				outside := t.TempDir()
				tc.setup(t, workDir, outside)

				rec := uploadFolder(t, h, "name="+tc.name, folderEntry{path: "old.txt", content: []byte("new")})

				body := assertError(t, rec, http.StatusConflict, CodeConflict)
				if !strings.Contains(body.Error, tc.name) {
					t.Errorf("error %q does not name %s", body.Error, tc.name)
				}
				tc.check(t, workDir, outside)
			})
		}
	})

	// Only the file system knows whether it folds letter case, so the test
	// asks it: where it does, two spellings are one entry and are refused;
	// where it does not, they are two entries and both are stored.
	t.Run("treats names that differ only in case as the file system does", func(t *testing.T) {
		for _, merge := range []bool{false, true} {
			for _, pair := range [][2]string{{"README.md", "readme.md"}, {"Src/a.txt", "src/b.txt"}} {
				t.Run(fmt.Sprintf("merge=%t/%s", merge, pair[0]), func(t *testing.T) {
					h, workDir := newTestHandler(t)
					if merge {
						writeFile(t, workDir, "up/keep.txt", []byte("keep"))
					}
					writeFile(t, workDir, "Probe", nil)
					_, err := os.Lstat(filepath.Join(workDir, "probe"))
					folds := err == nil

					rec := uploadFolder(t, h, fmt.Sprintf("name=up&merge=%t", merge),
						folderEntry{path: pair[0], content: []byte("1")},
						folderEntry{path: pair[1], content: []byte("2")})

					if folds {
						assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
						return
					}
					if rec.Code != http.StatusOK {
						t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
					}
					for i, p := range pair {
						if got := readString(t, filepath.Join(workDir, "up", p)); got != fmt.Sprint(i+1) {
							t.Errorf("%s: got %q", p, got)
						}
					}
				})
			}
		}
	})

	t.Run("refuses an overwrite flag rather than merging", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "dir/a.txt", []byte("old"))

		rec := uploadFolder(t, h, "name=dir&overwrite=true", folderEntry{path: "a.txt", content: []byte("new")})

		assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
		if got := readString(t, filepath.Join(workDir, "dir/a.txt")); got != "old" {
			t.Errorf("existing file was changed: %q", got)
		}
	})

	t.Run("refuses an entry named twice or as both a file and a folder", func(t *testing.T) {
		for _, entries := range [][]folderEntry{
			{{path: "a.txt", content: []byte("1")}, {path: "a.txt", content: []byte("2")}},
			{{path: "a", content: []byte("1")}, {path: "a/b.txt", content: []byte("2")}},
			{{path: "a/b.txt", content: []byte("1")}, {path: "a", content: []byte("2")}},
			{{path: "a", content: []byte("1")}, {path: "a", dir: true}},
		} {
			h, workDir := newTestHandler(t)

			rec := uploadFolder(t, h, "name=up", entries...)

			assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
			assertNotExist(t, filepath.Join(workDir, "up"))
		}
	})

	t.Run("accepts a directory declared again or after its files", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		rec := uploadFolder(t, h, "name=up",
			folderEntry{path: "a/b.txt", content: []byte("x")},
			folderEntry{path: "a", dir: true},
			folderEntry{path: "a", dir: true})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if got := readString(t, filepath.Join(workDir, "up/a/b.txt")); got != "x" {
			t.Errorf("got content %q", got)
		}
	})

	t.Run("counts every file against one budget and keeps nothing over it", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		h.maxUpload = 10

		rec := uploadFolder(t, h, "name=up",
			folderEntry{path: "a.bin", content: bytes.Repeat([]byte("x"), 8)},
			folderEntry{path: "sub/b.bin", content: bytes.Repeat([]byte("y"), 3)})

		body := assertError(t, rec, http.StatusRequestEntityTooLarge, CodeTooLarge)
		if body.Limit != h.maxUpload {
			t.Errorf("got limit %d, want %d", body.Limit, h.maxUpload)
		}
		assertNotExist(t, filepath.Join(workDir, "up"))
	})

	t.Run("accepts a folder exactly at the limit", func(t *testing.T) {
		h, _ := newTestHandler(t)
		h.maxUpload = 10

		rec := uploadFolder(t, h, "name=up",
			folderEntry{path: "a.bin", content: bytes.Repeat([]byte("x"), 7)},
			folderEntry{path: "sub/b.bin", content: bytes.Repeat([]byte("y"), 3)})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
	})

	t.Run("removes the folder when the body ends mid-file", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		req := newFolderUploadRequest(t, "name=up",
			folderEntry{path: "first.txt", content: []byte("done")},
			folderEntry{path: "sub/a.bin", content: bytes.Repeat([]byte("x"), 64)})
		whole, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatalf("failed to read request body: %v", err)
		}
		// Past the closing delimiter and into the file's own bytes.
		req.Body = io.NopCloser(bytes.NewReader(whole[:len(whole)-100]))

		rec := httptest.NewRecorder()
		h.UploadFolder(rec, req)

		body := assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
		if !strings.Contains(body.Error, "up/sub/a.bin") {
			t.Errorf("error %q does not name the interrupted file", body.Error)
		}
		if len(body.Written) != 0 {
			t.Errorf("reported %+v as written, but the folder is gone", body.Written)
		}
		assertNotExist(t, filepath.Join(workDir, "up"))
	})

	// Cut just after a complete part's boundary, a body looks to the
	// multipart parser like one that ended; only the missing closing
	// delimiter tells that the parts after it never came.
	t.Run("removes the folder when the body ends after a whole part", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		req := newFolderUploadRequest(t, "name=up",
			folderEntry{path: "first.txt", content: []byte("done")},
			folderEntry{path: "second.txt", content: []byte("lost")})
		whole, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatalf("failed to read request body: %v", err)
		}
		cut := bytes.Index(whole, []byte("done")) + len("done\r\n")
		boundary := bytes.Index(whole[cut:], []byte("\r\n"))
		req.Body = io.NopCloser(bytes.NewReader(whole[:cut+boundary]))

		rec := httptest.NewRecorder()
		h.UploadFolder(rec, req)

		assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
		assertNotExist(t, filepath.Join(workDir, "up"))
	})

	t.Run("refuses a body that is not multipart without creating the folder", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		req := httptest.NewRequest(http.MethodPost, "/api/files/upload-folder?name=up", strings.NewReader("x"))
		req.Header.Set("Content-Type", "text/plain")
		rec := httptest.NewRecorder()
		h.UploadFolder(rec, req)

		assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
		assertNotExist(t, filepath.Join(workDir, "up"))
	})

	t.Run("reports a destination that is missing or is a file", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "file.txt", []byte("x"))

		assertError(t, uploadFolder(t, h, "path=nope&name=up"), http.StatusNotFound, CodeNotFound)
		assertError(t, uploadFolder(t, h, "path=file.txt&name=up"), http.StatusBadRequest, CodeNotADirectory)
	})

	t.Run("reports an unknown worktree", func(t *testing.T) {
		h, _ := newTestHandler(t)

		assertError(t, uploadFolder(t, h, "worktree=ghost&name=up"), http.StatusNotFound, CodeWorktreeUnknown)
	})

	t.Run("merges into an existing folder, replacing files and keeping the rest", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "up/same.txt", []byte("old"))
		writeFile(t, workDir, "up/sub/keep.txt", []byte("keep"))
		link := filepath.Join(workDir, "up/hard.txt")
		writeFile(t, workDir, "other.txt", []byte("old"))
		if err := os.Link(filepath.Join(workDir, "other.txt"), link); err != nil {
			t.Fatalf("failed to create hard link: %v", err)
		}

		rec := uploadFolder(t, h, "name=up&merge=true",
			folderEntry{path: "same.txt", content: []byte("new")},
			folderEntry{path: "hard.txt", content: []byte("new")},
			folderEntry{path: "sub/added.txt", content: []byte("added")})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		for rel, want := range map[string]string{
			"up/same.txt":      "new",
			"up/sub/keep.txt":  "keep",
			"up/sub/added.txt": "added",
			// Written in place, so a hard link still shares the new content.
			"other.txt": "new",
		} {
			if got := readString(t, filepath.Join(workDir, rel)); got != want {
				t.Errorf("got %s = %q, want %q", rel, got, want)
			}
		}
	})

	t.Run("merges into a folder that does not exist yet by creating it", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		rec := uploadFolder(t, h, "name=up&merge=true", folderEntry{path: "a.txt", content: []byte("x")})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if got := readString(t, filepath.Join(workDir, "up/a.txt")); got != "x" {
			t.Errorf("got content %q", got)
		}
	})

	t.Run("refuses to merge into a file", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "file", []byte("old"))

		rec := uploadFolder(t, h, "merge=true&name=file", folderEntry{path: "a.txt", content: []byte("x")})
		assertError(t, rec, http.StatusConflict, CodeConflict)
		if got := readString(t, filepath.Join(workDir, "file")); got != "old" {
			t.Errorf("existing file was changed: %q", got)
		}
	})

	t.Run("refuses to merge into a link", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		outside := t.TempDir()
		symlinktest.Make(t, outside, filepath.Join(workDir, "link"))

		rec := uploadFolder(t, h, "merge=true&name=link", folderEntry{path: "a.txt", content: []byte("x")})
		assertError(t, rec, http.StatusConflict, CodeConflict)
		assertNotExist(t, filepath.Join(outside, "a.txt"))
	})

	// The single-file upload's rule, applied inside the folder: only a regular
	// file is replaced, and nothing is written through a link.
	t.Run("refuses to replace anything but a regular file inside a merge", func(t *testing.T) {
		outside := t.TempDir()
		for _, tc := range []struct {
			name  string
			setup func(t *testing.T, folder string)
			entry string
		}{
			{"a directory at a file's path", func(t *testing.T, folder string) {
				writeFile(t, folder, "x/inner.txt", []byte("keep"))
			}, "x"},
			{"a file at a directory's path", func(t *testing.T, folder string) {
				writeFile(t, folder, "x", []byte("keep"))
			}, "x/new.txt"},
			{"a link at a file's path", func(t *testing.T, folder string) {
				symlinktest.Make(t, filepath.Join(outside, "target.txt"), filepath.Join(folder, "x"))
			}, "x"},
			{"a link out of the folder at a directory's path", func(t *testing.T, folder string) {
				symlinktest.Make(t, outside, filepath.Join(folder, "x"))
			}, "x/new.txt"},
			// Followed, it would store the file under y while reporting it
			// under x.
			{"a link inside the folder at a directory's path", func(t *testing.T, folder string) {
				if err := os.Mkdir(filepath.Join(folder, "y"), 0755); err != nil {
					t.Fatal(err)
				}
				symlinktest.Make(t, "y", filepath.Join(folder, "x"))
			}, "x/new.txt"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				h, workDir := newTestHandler(t)
				folder := filepath.Join(workDir, "up")
				if err := os.Mkdir(folder, 0755); err != nil {
					t.Fatal(err)
				}
				tc.setup(t, folder)

				rec := uploadFolder(t, h, "name=up&merge=true",
					folderEntry{path: "first.txt", content: []byte("1")},
					folderEntry{path: tc.entry, content: []byte("x")})

				body := assertError(t, rec, http.StatusConflict, CodeConflict)
				if !strings.Contains(body.Error, "up/x") {
					t.Errorf("error %q does not name up/x", body.Error)
				}
				// A merge is not undone: what it stored before is still there,
				// and the error says so.
				if len(body.Written) != 1 || body.Written[0].Path != "up/first.txt" {
					t.Errorf("got written %+v, want up/first.txt", body.Written)
				}
				assertNotExist(t, filepath.Join(outside, "target.txt"))
				assertNotExist(t, filepath.Join(outside, "new.txt"))
			})
		}
	})

	t.Run("keeps the user's files when a merge fails, removing only its own partial file", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		h.maxUpload = 4
		writeFile(t, workDir, "up/keep.txt", []byte("keep"))

		rec := uploadFolder(t, h, "name=up&merge=true", folderEntry{path: "big.bin", content: []byte("too large")})

		assertError(t, rec, http.StatusRequestEntityTooLarge, CodeTooLarge)
		if got := readString(t, filepath.Join(workDir, "up/keep.txt")); got != "keep" {
			t.Errorf("got keep.txt = %q", got)
		}
		assertNotExist(t, filepath.Join(workDir, "up/big.bin"))
	})

	t.Run("refuses a merge flag it cannot read", func(t *testing.T) {
		h, _ := newTestHandler(t)

		assertError(t, uploadFolder(t, h, "name=up&merge=yes"), http.StatusBadRequest, CodeInvalidRequest)
	})

	t.Run("refuses to replace a fifo in a merge without blocking on it", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		if err := os.Mkdir(filepath.Join(workDir, "up"), 0755); err != nil {
			t.Fatal(err)
		}
		fifotest.Make(t, filepath.Join(workDir, "up"), "pipe")

		req := newFolderUploadRequest(t, "name=up&merge=true", folderEntry{path: "pipe", content: []byte("x")})
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			rec := httptest.NewRecorder()
			h.UploadFolder(rec, req)
			done <- rec
		}()
		select {
		case rec := <-done:
			assertError(t, rec, http.StatusConflict, CodeConflict)
		case <-time.After(5 * time.Second):
			t.Fatal("upload blocked on the fifo")
		}
	})

	// Go's parser decodes filename* (RFC 2231) into filename, so an encoded
	// path reaches the same validation as a plain one.
	t.Run("validates a filename sent as filename*", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		rec := uploadFolderRaw(t, h, "name=up", `form-data; name="files"; filename*=UTF-8''..%2Fescape.txt`)

		assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
		assertNotExist(t, filepath.Join(workDir, "escape.txt"))
		assertNotExist(t, filepath.Join(workDir, "up"))
	})

	// Skipping a part whose header did not parse would answer 200 for a
	// folder missing that file.
	t.Run("refuses a part it cannot read rather than skipping it", func(t *testing.T) {
		for _, disposition := range []string{
			`form-data; name="files"; filename=a/b.txt`,
			`form-data; name="files"; filename="a"; filename="b"`,
			`form-data; name="other"`,
			`attachment; filename="a.txt"`,
		} {
			h, workDir := newTestHandler(t)

			rec := uploadFolderRaw(t, h, "name=up", disposition)

			assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
			assertNotExist(t, filepath.Join(workDir, "up"))
		}
	})

	t.Run("refuses more entries than one folder upload may create", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		entries := make([]folderEntry, MaxFolderEntries+1)
		for i := range entries {
			entries[i] = folderEntry{path: "d" + strconv.Itoa(i), dir: true}
		}

		rec := uploadFolder(t, h, "name=up", entries...)

		body := assertError(t, rec, http.StatusRequestEntityTooLarge, CodeTooManyEntries)
		if body.Limit != MaxFolderEntries {
			t.Errorf("got limit %d, want %d", body.Limit, MaxFolderEntries)
		}
		assertNotExist(t, filepath.Join(workDir, "up"))
	})

	t.Run("follows a destination link in the middle of the path", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		if err := os.MkdirAll(filepath.Join(workDir, "packages/shared/src"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(workDir, "node_modules"), 0755); err != nil {
			t.Fatal(err)
		}
		symlinktest.Make(t, filepath.Join("..", "packages", "shared"), filepath.Join(workDir, "node_modules/shared"))

		rec := uploadFolder(t, h, "path=node_modules/shared/src&name=up", folderEntry{path: "a.txt", content: []byte("x")})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if got := readString(t, filepath.Join(workDir, "packages/shared/src/up/a.txt")); got != "x" {
			t.Errorf("got content %q", got)
		}
	})
}

// uploadFolderRaw sends one part with the given Content-Disposition, for the
// headers multipart.Writer would not produce.
func uploadFolderRaw(t *testing.T, h *Handler, query, disposition string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", disposition)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("failed to create part: %v", err)
	}
	if _, err := part.Write([]byte("x")); err != nil {
		t.Fatalf("failed to write part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("failed to close multipart writer: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/files/upload-folder?"+query, &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	h.UploadFolder(rec, req)
	return rec
}
