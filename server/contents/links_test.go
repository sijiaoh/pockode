package contents

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/internal/fifotest"
	"github.com/pockode/server/internal/symlinktest"
)

// linkFixture is a work directory with one link of every kind beside a
// directory outside it, which holds a file the tests must never reach.
type linkFixture struct {
	work, outside string
}

func newLinkFixture(t *testing.T) linkFixture {
	t.Helper()
	f := linkFixture{work: t.TempDir(), outside: t.TempDir()}
	write := func(dir, name, content string) {
		full := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write(f.work, "real.txt", "real")
	write(f.work, "dir/inner.txt", "inner")
	write(f.outside, "secret.txt", "secret")

	link := func(target, name string) {
		symlinktest.Make(t, target, filepath.Join(f.work, filepath.FromSlash(name)))
	}
	link("real.txt", "flink")
	link("dir", "dlink")
	link(filepath.Join(f.work, "real.txt"), "abs")
	link(".", "self")
	link("gone.txt", "broken")
	link("loop2", "loop1")
	link("loop1", "loop2")
	link(filepath.Join(f.outside, "secret.txt"), "ofile")
	link(filepath.Join(f.outside, "missing.txt"), "omissing")
	link(f.outside, "odir")
	link("../"+filepath.Base(f.outside)+"/secret.txt", "orel")
	return f
}

func (f linkFixture) assertSecretIntact(t *testing.T) {
	t.Helper()
	entries, err := os.ReadDir(f.outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "secret.txt" {
		t.Errorf("the directory outside changed: %v", entries)
	}
	if b, err := os.ReadFile(filepath.Join(f.outside, "secret.txt")); err != nil || string(b) != "secret" {
		t.Errorf("the file outside changed: %q, %v", b, err)
	}
}

// assertNoHostPath checks that what a client would read names nothing on the
// host: the refusal is about the project, and the host's layout is not the
// client's business.
func (f linkFixture) assertNoHostPath(t *testing.T, err error) {
	t.Helper()
	msg := PublicMessage(err)
	for _, host := range []string{f.work, f.outside, os.TempDir()} {
		if strings.Contains(msg, host) {
			t.Errorf("message %q names the host path %s", msg, host)
		}
	}
}

func TestListingClassifiesLinks(t *testing.T) {
	f := newLinkFixture(t)

	result, err := GetContents(f.work, "")
	if err != nil {
		t.Fatalf("GetContents failed: %v", err)
	}
	got := map[string]Entry{}
	for _, e := range result.Entries {
		got[e.Name] = e
	}

	tests := []struct {
		name     string
		typ      EntryType
		state    LinkState
		resolved string // "-" for none
	}{
		{"flink", TypeFile, LinkOK, "real.txt"},
		{"dlink", TypeDir, LinkOK, "dir"},
		{"abs", TypeFile, LinkOK, "real.txt"},
		{"self", TypeDir, LinkCycle, ""},
		{"broken", TypeLink, LinkBroken, "-"},
		{"loop1", TypeLink, LinkLoop, "-"},
		{"ofile", TypeLink, LinkOutside, "-"},
		// Outside whether or not the target exists: anything else would
		// make listings a probe of the host's file system.
		{"omissing", TypeLink, LinkOutside, "-"},
		{"odir", TypeLink, LinkOutside, "-"},
		{"orel", TypeLink, LinkOutside, "-"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, ok := got[tt.name]
			if !ok {
				t.Fatalf("%s is not listed", tt.name)
			}
			if e.Type != tt.typ {
				t.Errorf("type = %q, want %q", e.Type, tt.typ)
			}
			if e.Link == nil {
				t.Fatal("link is not set")
			}
			if e.Link.State != tt.state {
				t.Errorf("state = %q, want %q", e.Link.State, tt.state)
			}
			if e.Link.Target == "" {
				t.Error("target is empty")
			}
			switch {
			case tt.resolved == "-" && e.Link.Resolved != nil:
				t.Errorf("resolved = %q, want none", *e.Link.Resolved)
			case tt.resolved != "-" && (e.Link.Resolved == nil || *e.Link.Resolved != tt.resolved):
				t.Errorf("resolved = %v, want %q", e.Link.Resolved, tt.resolved)
			}
		})
	}

	if e := got["real.txt"]; e.Link != nil {
		t.Errorf("a regular file carries a link: %+v", e.Link)
	}
}

// An absolute target may spell the work directory another way (macOS: /var
// is /private/var). Only the work directory's own spellings — as given, and
// resolved — count as inside: one through some other link elsewhere would
// have to be looked up out there to be known, which the walk never does.
func TestAbsoluteTargetsAreMeasuredAgainstTheWorkDirectorysSpellings(t *testing.T) {
	work := t.TempDir()
	if err := os.WriteFile(filepath.Join(work, "real.txt"), []byte("real"), 0644); err != nil {
		t.Fatal(err)
	}
	spelled := filepath.Join(t.TempDir(), "spelled")
	symlinktest.Make(t, work, spelled)
	symlinktest.Make(t, filepath.Join(spelled, "real.txt"), filepath.Join(work, "via"))
	real, err := filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatal(err)
	}
	symlinktest.Make(t, filepath.Join(real, "real.txt"), filepath.Join(work, "evaluated"))

	tests := []struct {
		workDir, name string
		want          LinkState
	}{
		{work, "evaluated", LinkOK},
		{work, "via", LinkOutside},
		// Opened as spelled, spelled is the work directory as given.
		{spelled, "via", LinkOK},
		{spelled, "evaluated", LinkOK},
	}
	for _, tt := range tests {
		result, err := GetContents(tt.workDir, tt.name)
		if err != nil {
			t.Fatalf("GetContents(%s, %s) failed: %v", tt.workDir, tt.name, err)
		}
		var got LinkState
		switch {
		case result.File != nil && result.File.Link != nil:
			got = result.File.Link.State
		case result.Link != nil:
			got = result.Link.Link.State
		}
		if got != tt.want {
			t.Errorf("GetContents(%s, %s): state %q, want %q", tt.workDir, tt.name, got, tt.want)
		}
	}
}

// A directory link is a cycle when its target is, or contains, a directory the
// listed path has already passed through — decided per listing, since the
// same link leads somewhere new through one path and back through another.
func TestListingMarksCycles(t *testing.T) {
	work := t.TempDir()
	for _, d := range []string{"a/b", "b", "web/node_modules/@p", "packages/shared"} {
		if err := os.MkdirAll(filepath.Join(work, filepath.FromSlash(d)), 0755); err != nil {
			t.Fatal(err)
		}
	}
	symlinktest.Make(t, "..", filepath.Join(work, "a", "b", "up"))
	symlinktest.Make(t, filepath.Join("..", "b"), filepath.Join(work, "a", "l1"))
	symlinktest.Make(t, filepath.Join("..", "a"), filepath.Join(work, "b", "l2"))
	symlinktest.Make(t, filepath.Join("..", "..", "..", "packages", "shared"), filepath.Join(work, "web", "node_modules", "@p", "shared"))

	tests := []struct {
		dir, name string
		want      LinkState
	}{
		{"a/b", "up", LinkCycle},
		{"a", "l1", LinkOK},
		// Through a/l1 the listing has passed through b, and l2 leads to a,
		// which contains it.
		{"a/l1", "l2", LinkCycle},
		{"b", "l2", LinkOK},
		{"web/node_modules/@p", "shared", LinkOK},
	}
	for _, tt := range tests {
		t.Run(tt.dir+"/"+tt.name, func(t *testing.T) {
			result, err := GetContents(work, tt.dir)
			if err != nil {
				t.Fatalf("GetContents failed: %v", err)
			}
			for _, e := range result.Entries {
				if e.Name != tt.name {
					continue
				}
				if e.Link == nil || e.Link.State != tt.want {
					t.Errorf("link = %+v, want %q", e.Link, tt.want)
				}
				if e.Type != TypeDir {
					t.Errorf("type = %q, want dir", e.Type)
				}
				if want := tt.dir + "/" + tt.name; e.Path != want {
					t.Errorf("path = %q, want %q", e.Path, want)
				}
				return
			}
			t.Errorf("%s is not listed", tt.name)
		})
	}
}

func TestGetContentsThroughLinks(t *testing.T) {
	f := newLinkFixture(t)

	t.Run("a file link opens its target and says it is a link", func(t *testing.T) {
		result, err := GetContents(f.work, "flink")
		if err != nil {
			t.Fatalf("GetContents failed: %v", err)
		}
		if result.File == nil || result.File.Content != "real" {
			t.Fatalf("got %+v, want real.txt's content", result)
		}
		if result.File.Path != "flink" || result.File.Link == nil || result.File.Link.State != LinkOK {
			t.Errorf("file = %+v, want path flink with an ok link", result.File)
		}
	})

	t.Run("a directory link lists the target under the link's path", func(t *testing.T) {
		result, err := GetContents(f.work, "dlink")
		if err != nil {
			t.Fatalf("GetContents failed: %v", err)
		}
		if len(result.Entries) != 1 || result.Entries[0].Path != "dlink/inner.txt" {
			t.Errorf("entries = %+v, want dlink/inner.txt", result.Entries)
		}
	})

	t.Run("a link on the way inside is followed", func(t *testing.T) {
		result, err := GetContents(f.work, "dlink/inner.txt")
		if err != nil || result.File == nil || result.File.Content != "inner" {
			t.Errorf("got %+v, %v", result, err)
		}
	})

	for name, want := range map[string]LinkState{
		"broken":   LinkBroken,
		"loop1":    LinkLoop,
		"ofile":    LinkOutside,
		"omissing": LinkOutside,
		"odir":     LinkOutside,
		"orel":     LinkOutside,
	} {
		t.Run(name+" is answered with the link, not its content", func(t *testing.T) {
			result, err := GetContents(f.work, name)
			if err != nil {
				t.Fatalf("GetContents failed: %v", err)
			}
			if result.File != nil || result.Entries != nil || result.Link == nil {
				t.Fatalf("got %+v, want a link result", result)
			}
			if result.Link.Type != TypeLink || result.Link.Path != name || result.Link.Link.State != want {
				t.Errorf("link result = %+v (%+v), want state %q", result.Link, result.Link.Link, want)
			}
		})
	}

	t.Run("a link on the way out is refused, whether or not the name exists there", func(t *testing.T) {
		for _, p := range []string{"odir/secret.txt", "odir/missing.txt"} {
			_, err := GetContents(f.work, p)
			if !errors.Is(err, ErrInvalidPath) {
				t.Errorf("GetContents(%s) = %v, want ErrInvalidPath", p, err)
			}
			if want := `"` + p + `" leads outside the project`; PublicMessage(err) != want {
				t.Errorf("message = %q, want %q", PublicMessage(err), want)
			}
			f.assertNoHostPath(t, err)
		}
	})

	t.Run("a loop on the way is refused without naming the host", func(t *testing.T) {
		_, err := GetContents(f.work, "loop1/x")
		if !errors.Is(err, ErrInvalidPath) {
			t.Errorf("got %v, want ErrInvalidPath", err)
		}
		f.assertNoHostPath(t, err)
	})
}

func TestWritesStayInside(t *testing.T) {
	t.Run("write through a file link inside writes the target and keeps the link", func(t *testing.T) {
		f := newLinkFixture(t)
		if err := WriteFile(f.work, "flink", "new"); err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}
		if b, _ := os.ReadFile(filepath.Join(f.work, "real.txt")); string(b) != "new" {
			t.Errorf("real.txt = %q, want new", b)
		}
		if info, err := os.Lstat(filepath.Join(f.work, "flink")); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Errorf("flink is no longer a link: %v, %v", info, err)
		}
	})

	t.Run("write and create beneath a directory link inside", func(t *testing.T) {
		f := newLinkFixture(t)
		if err := WriteFile(f.work, "dlink/new/a.txt", "a"); err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}
		if err := Create(f.work, "dlink/b.txt", false); err != nil {
			t.Fatalf("Create failed: %v", err)
		}
		for _, p := range []string{"dir/new/a.txt", "dir/b.txt"} {
			if _, err := os.Stat(filepath.Join(f.work, filepath.FromSlash(p))); err != nil {
				t.Errorf("%s was not written: %v", p, err)
			}
		}
	})

	refusals := []struct {
		name string
		op   func(work string) error
	}{
		{"write through a file link out", func(w string) error { return WriteFile(w, "ofile", "x") }},
		{"write through a relative link out", func(w string) error { return WriteFile(w, "orel", "x") }},
		{"write a new file through a directory link out", func(w string) error { return WriteFile(w, "odir/new.txt", "x") }},
		{"overwrite through a directory link out", func(w string) error { return WriteFile(w, "odir/secret.txt", "x") }},
		{"create parents through a directory link out", func(w string) error { return WriteFile(w, "odir/sub/new.txt", "x") }},
		{"write through a broken link", func(w string) error { return WriteFile(w, "broken", "x") }},
		{"create through a directory link out", func(w string) error { return Create(w, "odir/new.txt", false) }},
		{"create a directory through a directory link out", func(w string) error { return Create(w, "odir/new", true) }},
		{"delete through a directory link out", func(w string) error { return Delete(w, "odir/secret.txt") }},
		{"rename through a directory link out", func(w string) error { return Rename(w, "odir/secret.txt", "renamed.txt") }},
	}
	for _, tt := range refusals {
		t.Run(tt.name+" is refused", func(t *testing.T) {
			f := newLinkFixture(t)
			err := tt.op(f.work)
			if !errors.Is(err, ErrInvalidPath) {
				t.Errorf("got %v, want ErrInvalidPath", err)
			}
			f.assertNoHostPath(t, err)
			f.assertSecretIntact(t)
			if _, err := os.Stat(filepath.Join(f.work, "gone.txt")); err == nil {
				t.Error("created the broken link's target")
			}
		})
	}

	t.Run("create on a name a link holds is refused as taken", func(t *testing.T) {
		f := newLinkFixture(t)
		for _, name := range []string{"ofile", "broken", "dlink", "flink"} {
			if err := Create(f.work, name, false); !errors.Is(err, ErrExists) {
				t.Errorf("Create(%s) = %v, want ErrExists", name, err)
			}
		}
		f.assertSecretIntact(t)
	})
}

func TestDeleteRemovesTheLinkItself(t *testing.T) {
	f := newLinkFixture(t)
	for _, name := range []string{"broken", "loop1", "ofile", "odir", "dlink"} {
		if err := Delete(f.work, name); err != nil {
			t.Errorf("Delete(%s) failed: %v", name, err)
		}
		if _, err := os.Lstat(filepath.Join(f.work, name)); !os.IsNotExist(err) {
			t.Errorf("%s is still there: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(f.work, "dir", "inner.txt")); err != nil {
		t.Errorf("deleting dlink touched its target: %v", err)
	}
	f.assertSecretIntact(t)
}

// A link to something that is neither a file nor a folder is listed and
// answered as such, never opened: opening a fifo blocks the request for good.
func TestLinkToAFifoIsUnsupported(t *testing.T) {
	work := t.TempDir()
	fifotest.Make(t, work, "pipe")
	symlinktest.Make(t, "pipe", filepath.Join(work, "plink"))

	result, err := GetContents(work, "plink")
	if err != nil {
		t.Fatalf("GetContents failed: %v", err)
	}
	if result.Link == nil || result.Link.Link.State != LinkUnsupported {
		t.Errorf("got %+v, want an unsupported link result", result)
	}
	if err := WriteFile(work, "plink", "x"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("WriteFile = %v, want ErrInvalidPath", err)
	}
}

// Only an ASCII separator splits a path: 港 (U+6E2F) and į (U+012F) end in the
// byte '/', and reading them a byte at a time once sent a delete of "aįb/x"
// to "a/b/x".
func TestNonASCIINamesAreOneComponent(t *testing.T) {
	work := t.TempDir()
	for _, p := range []string{"aįb/x", "a/b/x", "港/x"} {
		full := filepath.Join(work, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(p), 0644); err != nil {
			t.Fatal(err)
		}
	}

	if result, err := GetContents(work, "港/x"); err != nil || result.File == nil || result.File.Content != "港/x" {
		t.Errorf("GetContents(港/x) = %+v, %v", result, err)
	}
	if err := WriteFile(work, "港/new.txt", "n"); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "港", "new.txt")); err != nil {
		t.Errorf("not written beneath 港: %v", err)
	}
	if err := Delete(work, "aįb/x"); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "aįb", "x")); !os.IsNotExist(err) {
		t.Errorf("aįb/x is still there: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "a", "b", "x")); err != nil {
		t.Errorf("deleted a/b/x instead: %v", err)
	}
}

// A ".." in an absolute target applies after the links before it, as the
// kernel applies it: "/w/l/../secret" with l a link out is outside, not the
// project's own secret.
func TestAbsoluteTargetDotDotFollowsLinksFirst(t *testing.T) {
	f := newLinkFixture(t)
	if err := os.WriteFile(filepath.Join(f.work, "secret"), []byte("mine"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(f.outside, "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	symlinktest.Make(t, filepath.Join(f.outside, "sub"), filepath.Join(f.work, "l"))
	symlinktest.Make(t, strings.Join([]string{f.work, "l", "..", "secret"}, string(filepath.Separator)), filepath.Join(f.work, "x"))

	result, err := GetContents(f.work, "x")
	if err != nil {
		t.Fatalf("GetContents failed: %v", err)
	}
	if result.Link == nil || result.Link.Link.State != LinkOutside {
		t.Errorf("got %+v, want an outside link result", result)
	}
	if err := WriteFile(f.work, "x", "x"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("WriteFile = %v, want ErrInvalidPath", err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.work, "secret")); string(b) != "mine" {
		t.Errorf("wrote a file the link does not name: %q", b)
	}
	if err := os.Remove(filepath.Join(f.outside, "sub")); err != nil {
		t.Fatal(err)
	}
	f.assertSecretIntact(t)
}

// A cycle is told by identity: on a case-insensitive file system "../A" is
// the directory a, which the listing has passed through.
func TestCycleIsMatchedByIdentity(t *testing.T) {
	work := t.TempDir()
	if err := os.Mkdir(filepath.Join(work, "a"), 0755); err != nil {
		t.Fatal(err)
	}
	symlinktest.Make(t, filepath.Join("..", "A"), filepath.Join(work, "a", "up"))
	// Where names are case-sensitive, A is simply not there.
	want := LinkBroken
	if _, err := os.Stat(filepath.Join(work, "A")); err == nil {
		want = LinkCycle
	}

	result, err := GetContents(work, "a")
	if err != nil {
		t.Fatalf("GetContents failed: %v", err)
	}
	if len(result.Entries) != 1 || result.Entries[0].Link == nil || result.Entries[0].Link.State != want {
		t.Errorf("entries = %+v, want up as %q", result.Entries, want)
	}
}
