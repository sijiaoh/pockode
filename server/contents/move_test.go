package contents

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/internal/symlinktest"
)

func TestMove(t *testing.T) {
	// Files are given as slash paths relative to workDir; a trailing slash
	// makes a directory.
	setup := func(t *testing.T, paths ...string) string {
		t.Helper()
		workDir := t.TempDir()
		for _, p := range paths {
			full := filepath.Join(workDir, filepath.FromSlash(p))
			if p[len(p)-1] == '/' {
				if err := os.MkdirAll(full, 0755); err != nil {
					t.Fatal(err)
				}
				continue
			}
			if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(p), 0644); err != nil {
				t.Fatal(err)
			}
		}
		return workDir
	}
	assertContent := func(t *testing.T, workDir, p, want string) {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(workDir, filepath.FromSlash(p)))
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		if string(data) != want {
			t.Errorf("%s: got %q, want %q", p, data, want)
		}
	}
	assertGone := func(t *testing.T, workDir, p string) {
		t.Helper()
		if _, err := os.Lstat(filepath.Join(workDir, filepath.FromSlash(p))); !os.IsNotExist(err) {
			t.Errorf("%s still exists (err %v)", p, err)
		}
	}

	t.Run("moves a file into another directory and returns its new path", func(t *testing.T) {
		workDir := setup(t, "docs/a.md", "archive/")

		got, err := Move(workDir, "docs/a.md", "archive")
		if err != nil {
			t.Fatalf("Move failed: %v", err)
		}
		if got != "archive/a.md" {
			t.Errorf("got path %q, want %q", got, "archive/a.md")
		}
		assertContent(t, workDir, "archive/a.md", "docs/a.md")
		assertGone(t, workDir, "docs/a.md")
	})

	t.Run("moves a directory with everything in it", func(t *testing.T) {
		workDir := setup(t, "src/lib/util.go", "src/lib/deep/x.go", "pkg/")

		got, err := Move(workDir, "src/lib", "pkg")
		if err != nil {
			t.Fatalf("Move failed: %v", err)
		}
		if got != "pkg/lib" {
			t.Errorf("got path %q, want %q", got, "pkg/lib")
		}
		assertContent(t, workDir, "pkg/lib/util.go", "src/lib/util.go")
		assertContent(t, workDir, "pkg/lib/deep/x.go", "src/lib/deep/x.go")
		assertGone(t, workDir, "src/lib")
	})

	t.Run("moves into the work directory itself", func(t *testing.T) {
		workDir := setup(t, "docs/sub/a.md")

		got, err := Move(workDir, "docs/sub/a.md", "")
		if err != nil {
			t.Fatalf("Move failed: %v", err)
		}
		if got != "a.md" {
			t.Errorf("got path %q, want %q", got, "a.md")
		}
		assertContent(t, workDir, "a.md", "docs/sub/a.md")
	})

	// However either path is spelled, what is reported is the clean path the
	// tree lists, so the client can find the entry by it.
	t.Run("accepts a trailing slash or a dot segment", func(t *testing.T) {
		workDir := setup(t, "docs/sub/a.md", "out/")

		got, err := Move(workDir, "docs/sub/", "./out/")
		if err != nil {
			t.Fatalf("Move failed: %v", err)
		}
		if got != "out/sub" {
			t.Errorf("got path %q, want %q", got, "out/sub")
		}
		assertContent(t, workDir, "out/sub/a.md", "docs/sub/a.md")
	})

	// The requested state already holds, as with renaming to the same name.
	t.Run("does nothing for the directory the entry is already in", func(t *testing.T) {
		workDir := setup(t, "docs/a.md", "top.md")

		for _, c := range []struct{ path, dest, want string }{
			{"docs/a.md", "docs", "docs/a.md"},
			{"docs/a.md", "docs/", "docs/a.md"},
			{"top.md", "", "top.md"},
			{"docs", "", "docs"},
		} {
			got, err := Move(workDir, c.path, c.dest)
			if err != nil {
				t.Errorf("%s into %q: %v", c.path, c.dest, err)
				continue
			}
			if got != c.want {
				t.Errorf("%s into %q: got path %q, want %q", c.path, c.dest, got, c.want)
			}
		}
		assertContent(t, workDir, "docs/a.md", "docs/a.md")
		assertContent(t, workDir, "top.md", "top.md")
	})

	t.Run("reports a missing source", func(t *testing.T) {
		workDir := setup(t, "dest/", "file.md")

		for _, p := range []string{"ghost.md", "file.md/below"} {
			if _, err := Move(workDir, p, "dest"); !errors.Is(err, ErrNotFound) {
				t.Errorf("%s: got error %v, want ErrNotFound", p, err)
			}
		}
	})

	t.Run("reports a missing destination without touching the source", func(t *testing.T) {
		workDir := setup(t, "a.md", "file.md")

		for _, dest := range []string{"nowhere", "file.md/below"} {
			_, err := Move(workDir, "a.md", dest)
			if !errors.Is(err, ErrDestinationNotFound) {
				t.Errorf("%s: got error %v, want ErrDestinationNotFound", dest, err)
			}
		}
		assertContent(t, workDir, "a.md", "a.md")
		assertGone(t, workDir, "nowhere")
	})

	t.Run("refuses a destination that is a file", func(t *testing.T) {
		workDir := setup(t, "a.md", "b.md")

		if _, err := Move(workDir, "a.md", "b.md"); !errors.Is(err, ErrNotADirectory) {
			t.Fatalf("got error %v, want ErrNotADirectory", err)
		}
		assertContent(t, workDir, "a.md", "a.md")
		assertContent(t, workDir, "b.md", "b.md")
	})

	t.Run("refuses to move a directory into itself or beneath itself", func(t *testing.T) {
		workDir := setup(t, "docs/sub/deeper/x.md")

		for _, dest := range []string{"docs", "docs/sub", "docs/sub/deeper"} {
			if _, err := Move(workDir, "docs", dest); !errors.Is(err, ErrIntoItself) {
				t.Errorf("%s: got error %v, want ErrIntoItself", dest, err)
			}
		}
		assertContent(t, workDir, "docs/sub/deeper/x.md", "docs/sub/deeper/x.md")
	})

	// The case the identity walk exists for: on a case-insensitive file
	// system no string comparison sees "Docs/sub" as beneath "docs".
	t.Run("refuses into itself under another capitalisation", func(t *testing.T) {
		workDir := setup(t, "docs/sub/")
		if _, err := os.Lstat(filepath.Join(workDir, "DOCS")); err != nil {
			t.Skip("the file system is case-sensitive, so DOCS is another name")
		}

		if _, err := Move(workDir, "docs", "Docs/sub"); !errors.Is(err, ErrIntoItself) {
			t.Fatalf("got error %v, want ErrIntoItself", err)
		}
	})

	// A sibling whose name merely starts with the source's is not beneath it.
	t.Run("moves a directory into a sibling sharing its name as a prefix", func(t *testing.T) {
		workDir := setup(t, "docs/a.md", "docs2/")

		if _, err := Move(workDir, "docs", "docs2"); err != nil {
			t.Fatalf("Move failed: %v", err)
		}
		assertContent(t, workDir, "docs2/docs/a.md", "docs/a.md")
	})

	// rename(2) would replace the destination silently; refusing it is this
	// method's own guard.
	t.Run("refuses a taken name without touching either entry", func(t *testing.T) {
		workDir := setup(t, "docs/a.md", "archive/a.md", "dirs/x/", "other/x/keep.md")

		_, err := Move(workDir, "docs/a.md", "archive")
		if !errors.Is(err, ErrExists) {
			t.Fatalf("got error %v, want ErrExists", err)
		}
		// The sentence file.create and file.rename send, which the web UI
		// matches on.
		if err.Error() != "archive/a.md already exists" {
			t.Errorf("got message %q, want %q", err.Error(), "archive/a.md already exists")
		}
		assertContent(t, workDir, "docs/a.md", "docs/a.md")
		assertContent(t, workDir, "archive/a.md", "archive/a.md")

		// An empty directory is replaced by rename(2) on unix all the same.
		if _, err := Move(workDir, "other/x", "dirs"); !errors.Is(err, ErrExists) {
			t.Fatalf("directory: got error %v, want ErrExists", err)
		}
		assertContent(t, workDir, "other/x/keep.md", "other/x/keep.md")
	})

	t.Run("rejects paths that escape the work directory", func(t *testing.T) {
		workDir := setup(t, "a.md", "dest/")

		for _, c := range []struct{ path, dest string }{
			{"", "dest"},
			{".", "dest"},
			{"../escape.md", "dest"},
			{"/etc/passwd", "dest"},
			{"a.md", ".."},
			{"a.md", "../elsewhere"},
			{"a.md", "/tmp"},
		} {
			if _, err := Move(workDir, c.path, c.dest); !errors.Is(err, ErrInvalidPath) {
				t.Errorf("%q into %q: got error %v, want ErrInvalidPath", c.path, c.dest, err)
			}
		}
		assertContent(t, workDir, "a.md", "a.md")
	})

	t.Run("refuses a link that leads out of the work directory", func(t *testing.T) {
		workDir := setup(t, "a.md")
		outside := t.TempDir()
		if err := os.WriteFile(filepath.Join(outside, "secret.md"), []byte("secret"), 0644); err != nil {
			t.Fatal(err)
		}
		symlinktest.Make(t, outside, filepath.Join(workDir, "out"))

		// Into a directory outside, by way of the link.
		if _, err := Move(workDir, "a.md", "out"); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("into a link out: got error %v, want ErrInvalidPath", err)
		}
		assertContent(t, workDir, "a.md", "a.md")
		assertGone(t, outside, "a.md")

		// Out of a directory outside, by way of the link — refused the same
		// way whether or not the name exists there, so the answer cannot be
		// used to probe what is outside.
		for _, p := range []string{"out/secret.md", "out/ghost.md"} {
			if _, err := Move(workDir, p, ""); !errors.Is(err, ErrInvalidPath) {
				t.Errorf("%s: got error %v, want ErrInvalidPath", p, err)
			}
		}
		assertContent(t, outside, "secret.md", "secret")
		assertGone(t, workDir, "secret.md")
	})

	t.Run("moves a link as a link and follows one that stays inside", func(t *testing.T) {
		workDir := setup(t, "real/", "a.md", "dest/", "tree/sub/", "via/x.md")
		outside := filepath.Join(t.TempDir(), "target.md")
		if err := os.WriteFile(outside, []byte("outside"), 0644); err != nil {
			t.Fatal(err)
		}
		symlinktest.Make(t, outside, filepath.Join(workDir, "link.md"))
		symlinktest.Make(t, filepath.Join(workDir, "real"), filepath.Join(workDir, "alias"))
		// Dangling on purpose: a Stat-based check would call the name free.
		symlinktest.Make(t, filepath.Join(workDir, "gone"), filepath.Join(workDir, "dest", "a.md"))

		if _, err := Move(workDir, "link.md", "dest"); err != nil {
			t.Fatalf("moving a link: %v", err)
		}
		if info, err := os.Lstat(filepath.Join(workDir, "dest", "link.md")); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Errorf("dest/link.md is not the link (info %v, err %v)", info, err)
		}
		if data, err := os.ReadFile(outside); err != nil || string(data) != "outside" {
			t.Errorf("the link's target was touched: %q, %v", data, err)
		}

		if _, err := Move(workDir, "a.md", "dest"); !errors.Is(err, ErrExists) {
			t.Errorf("onto a dangling link: got error %v, want ErrExists", err)
		}

		got, err := Move(workDir, "a.md", "alias")
		if err != nil {
			t.Fatalf("into a link that stays inside: %v", err)
		}
		if got != "alias/a.md" {
			t.Errorf("got path %q, want %q", got, "alias/a.md")
		}
		assertContent(t, workDir, "real/a.md", "a.md")

		// The link names the directory itself, so this is into itself too.
		if _, err := Move(workDir, "real", "alias"); !errors.Is(err, ErrIntoItself) {
			t.Errorf("into a link to itself: got error %v, want ErrIntoItself", err)
		}

		// And one naming a directory beneath it.
		symlinktest.Make(t, filepath.Join(workDir, "tree", "sub"), filepath.Join(workDir, "deep"))
		if _, err := Move(workDir, "tree", "deep"); !errors.Is(err, ErrIntoItself) {
			t.Errorf("into a link beneath itself: got error %v, want ErrIntoItself", err)
		}

		// Out of a directory reached through a link that stays inside.
		symlinktest.Make(t, filepath.Join(workDir, "via"), filepath.Join(workDir, "door"))
		if _, err := Move(workDir, "door/x.md", "dest"); err != nil {
			t.Fatalf("out of a link that stays inside: %v", err)
		}
		assertContent(t, workDir, "dest/x.md", "via/x.md")
		assertGone(t, workDir, "via/x.md")
	})
}
