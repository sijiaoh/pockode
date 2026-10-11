package filetransfer

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

// commitFile commits one file to a fresh repository in the handler's work
// directory and returns the commit's hash.
func commitFile(t *testing.T, workDir, name string, data []byte) string {
	t.Helper()
	writeFile(t, workDir, name, data)
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=Test", "-c", "user.email=test@test.com"}, args...)...)
		cmd.Dir = workDir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init")
	git("add", ".")
	git("commit", "--no-gpg-sign", "-m", "initial")
	return git("rev-parse", "HEAD")
}

func gitFile(t *testing.T, h *Handler, query string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.GitFile(rec, httptest.NewRequest(http.MethodGet, "/api/git/show/file?"+query, nil))
	return rec
}

func TestGitFile(t *testing.T) {
	t.Run("streams the file as committed with the download endpoint's headers", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		hash := commitFile(t, workDir, "img/logo.png", []byte("committed"))
		// The working copy has moved on; the response is the commit's version.
		writeFile(t, workDir, "img/logo.png", []byte("edited"))

		rec := gitFile(t, h, "hash="+hash+"&path=img/logo.png")

		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		if rec.Body.String() != "committed" {
			t.Errorf("body = %q, want the committed bytes", rec.Body.String())
		}
		for header, want := range map[string]string{
			"Content-Type":           "application/octet-stream",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control":          "no-store",
			"Content-Length":         "9",
		} {
			if got := rec.Header().Get(header); got != want {
				t.Errorf("%s = %q, want %q", header, got, want)
			}
		}
	})

	t.Run("refuses what git.show.file refuses", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		hash := commitFile(t, workDir, "dir/a.png", []byte("a"))

		for _, tc := range []struct {
			query  string
			status int
			code   string
		}{
			{"path=dir/a.png", http.StatusBadRequest, CodeInvalidRequest},
			{"hash=" + hash, http.StatusBadRequest, CodeInvalidRequest},
			{"hash=zzzzzzz&path=dir/a.png", http.StatusBadRequest, CodeInvalidRequest},
			{"hash=" + hash + "&path=../a.png", http.StatusBadRequest, CodeInvalidRequest},
			{"hash=" + hash + "&path=missing.png", http.StatusNotFound, CodeNotFound},
			{"hash=" + hash + "&path=dir", http.StatusBadRequest, CodeNotAFile},
			{"hash=" + hash + "&path=dir/a.png&worktree=ghost", http.StatusNotFound, CodeWorktreeUnknown},
		} {
			t.Run(tc.query, func(t *testing.T) {
				assertError(t, gitFile(t, h, tc.query), tc.status, tc.code)
			})
		}
	})
}
