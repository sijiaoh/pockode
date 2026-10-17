package filetransfer

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// shortName is the 8.3 alias of the existing file or directory at path,
// skipping the test when the volume makes none.
func shortName(t *testing.T, path string) string {
	t.Helper()
	long, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]uint16, windows.MAX_PATH)
	n, err := windows.GetShortPathName(long, &buf[0], uint32(len(buf)))
	if err != nil {
		t.Fatalf("GetShortPathName(%s): %v", path, err)
	}
	short := filepath.Base(windows.UTF16ToString(buf[:n]))
	if short == filepath.Base(path) {
		t.Skipf("no 8.3 name for %s: short names are disabled on this volume", path)
	}
	return short
}

func TestRawRootScopeRefusesDotfilesByTheirShortNames(t *testing.T) {
	f := newRawFixture(t)
	writeFile(t, f.workDir, "site/.env", []byte("SECRET=1"))
	writeFile(t, f.workDir, "site/index.html", []byte("site"))
	writeFile(t, f.workDir, ".hidden/index.html", []byte("index"))
	root := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeRoot})

	t.Run("as a file", func(t *testing.T) {
		// Short names do open, so the refusal below is the dot rule's.
		page := shortName(t, filepath.Join(f.workDir, "site", "index.html"))
		assertBody(t, f.get(t, RawPath(root, "site/"+page), nil), http.StatusOK, "site")

		alias := shortName(t, filepath.Join(f.workDir, "site", ".env"))
		rec := f.get(t, RawPath(root, "site/"+alias), nil)
		assertError(t, rec, http.StatusForbidden, CodeOutsideScope)
		if !strings.Contains(rec.Body.String(), "is outside this capability") {
			t.Errorf("refused for another reason: %s", rec.Body.String())
		}
	})

	t.Run("as a directory on the way", func(t *testing.T) {
		alias := shortName(t, filepath.Join(f.workDir, ".hidden"))
		rec := f.get(t, RawPath(root, alias+"/index.html"), nil)
		assertError(t, rec, http.StatusForbidden, CodeOutsideScope)
		if !strings.Contains(rec.Body.String(), "is outside this capability") {
			t.Errorf("refused for another reason: %s", rec.Body.String())
		}
	})
}
