package attachments

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
)

func TestResolve(t *testing.T) {
	dataDir := t.TempDir()
	store := NewStore(dataDir, "sess")
	id, err := store.Put([]byte("hello"), ".txt")
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "secret"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	got, err := Resolve(dataDir, "sess", id)
	if err != nil {
		t.Fatalf("Resolve(stored id): %v", err)
	}
	if want := filepath.Join(Dir(dataDir, "sess"), id); got != want {
		t.Errorf("Resolve = %q, want %q", got, want)
	}

	// An id is a name the store handed out, never a path: none of these may
	// reach a file, whatever is or is not behind them.
	for _, bad := range []string{"", "missing", "../../../secret", "../sess/" + id, id + ".lock", "."} {
		if _, err := Resolve(dataDir, "sess", bad); err != ErrNotFound {
			t.Errorf("Resolve(%q) error = %v, want ErrNotFound", bad, err)
		}
	}
	// Another session's attachment is not this one's.
	if _, err := Resolve(dataDir, "other", id); err != ErrNotFound {
		t.Errorf("Resolve from another session error = %v, want ErrNotFound", err)
	}
}

func TestUploadExtension(t *testing.T) {
	tests := map[string]string{
		"report.PDF":         ".pdf",
		"shot.png":           ".png",
		"archive.tar.gz":     ".gz",
		"Makefile":           "",
		".env":               ".env",
		"x.lock":             "",
		"weird.p d f":        "",
		"name.ext-with-dash": "",
		"long.abcdefghijk":   "",
		"ok.abcdefghij":      ".abcdefghij",
	}
	for name, want := range tests {
		if got := UploadExtension(name); got != want {
			t.Errorf("UploadExtension(%q) = %q, want %q", name, got, want)
		}
	}
}

// storedFiles lists every regular file under a session's attachment directory,
// spool included, so a test can see that a failed write left nothing behind.
func storedFiles(t *testing.T, dataDir string) []string {
	t.Helper()
	var files []string
	err := filepath.WalkDir(Dir(dataDir, "sess"), func(path string, d fs.DirEntry, err error) error {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if !d.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestPutStream(t *testing.T) {
	t.Run("stores the content under its hash, once however often it arrives", func(t *testing.T) {
		dataDir := t.TempDir()
		store := NewStore(dataDir, "sess")

		first, err := store.PutStream(strings.NewReader("clip"), ".mov", 4)
		if err != nil {
			t.Fatalf("PutStream: %v", err)
		}
		second, err := store.PutStream(strings.NewReader("clip"), ".mov", 4)
		if err != nil {
			t.Fatalf("PutStream again: %v", err)
		}
		// The same id Put hands out for the same bytes.
		viaPut, err := store.Put([]byte("clip"), ".mov")
		if err != nil {
			t.Fatalf("Put: %v", err)
		}

		if first != second || first.ID != viaPut || first.Size != 4 {
			t.Errorf("stored %+v then %+v, Put gave %q", first, second, viaPut)
		}
		files := storedFiles(t, dataDir)
		if len(files) != 1 {
			t.Fatalf("files = %v, want one", files)
		}
		if data, _ := os.ReadFile(files[0]); string(data) != "clip" {
			t.Errorf("stored %q", data)
		}
		if path, err := Resolve(dataDir, "sess", first.ID); err != nil || path != files[0] {
			t.Errorf("Resolve = %q, %v", path, err)
		}
	})

	t.Run("takes content exactly at the limit", func(t *testing.T) {
		stored, err := NewStore(t.TempDir(), "sess").PutStream(strings.NewReader("1234"), "", 4)
		if err != nil || stored.Size != 4 {
			t.Errorf("stored %+v, error %v", stored, err)
		}
	})

	// Two uploads of one file racing each other — a client retrying a request
	// it thought had failed — end as one file under one id, with no spool left.
	t.Run("settles identical concurrent uploads on one file", func(t *testing.T) {
		dataDir := t.TempDir()
		store := NewStore(dataDir, "sess")
		const n = 8
		ids := make(chan string, n)
		errs := make(chan error, n)
		var wg sync.WaitGroup
		for range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				stored, err := store.PutStream(strings.NewReader(strings.Repeat("v", 1<<16)), ".mp4", 1<<16)
				if err != nil {
					errs <- err
					return
				}
				ids <- stored.ID
			}()
		}
		wg.Wait()
		close(ids)
		close(errs)
		for err := range errs {
			t.Errorf("PutStream: %v", err)
		}
		seen := map[string]bool{}
		for id := range ids {
			seen[id] = true
		}
		if len(seen) != 1 {
			t.Errorf("ids = %v, want one", seen)
		}
		if files := storedFiles(t, dataDir); len(files) != 1 {
			t.Errorf("files = %v, want one", files)
		}
	})

	// The id is handed out the moment PutStream returns, so content that did
	// not arrive whole must leave nothing a later request could find.
	t.Run("leaves nothing behind when the content is over the limit", func(t *testing.T) {
		dataDir := t.TempDir()
		_, err := NewStore(dataDir, "sess").PutStream(strings.NewReader("12345"), "", 4)
		if !errors.Is(err, ErrTooLarge) {
			t.Fatalf("error = %v, want ErrTooLarge", err)
		}
		if files := storedFiles(t, dataDir); len(files) != 0 {
			t.Errorf("left %v", files)
		}
	})

	t.Run("leaves nothing behind when the source fails mid-stream", func(t *testing.T) {
		dataDir := t.TempDir()
		reset := errors.New("connection reset")
		src := io.MultiReader(strings.NewReader("half a clip"), iotest.ErrReader(reset))

		_, err := NewStore(dataDir, "sess").PutStream(src, ".mov", 1<<20)

		if !errors.Is(err, ErrIncomplete) || !errors.Is(err, reset) {
			t.Fatalf("error = %v, want ErrIncomplete wrapping the source's", err)
		}
		if files := storedFiles(t, dataDir); len(files) != 0 {
			t.Errorf("left %v", files)
		}
	})

	t.Run("refuses on a disabled store", func(t *testing.T) {
		if _, err := (Store{}).PutStream(strings.NewReader("x"), "", 1); !errors.Is(err, ErrDisabled) {
			t.Errorf("error = %v, want ErrDisabled", err)
		}
	})
}

// A spool a crash left behind is no attachment: no id reaches it and a fork
// does not inherit it.
func TestSpoolIsNotAnAttachment(t *testing.T) {
	dataDir := t.TempDir()
	store := NewStore(dataDir, "sess")
	id, err := store.Put([]byte("kept"), "")
	if err != nil {
		t.Fatal(err)
	}
	incoming := filepath.Join(Dir(dataDir, "sess"), incomingDir)
	if err := os.WriteFile(filepath.Join(incoming, "leftover"), []byte("half"), 0644); err != nil {
		t.Fatal(err)
	}

	for _, bad := range []string{incomingDir, incomingDir + "/leftover", "leftover"} {
		if _, err := Resolve(dataDir, "sess", bad); err != ErrNotFound {
			t.Errorf("Resolve(%q) error = %v, want ErrNotFound", bad, err)
		}
	}

	if err := Clone(dataDir, "sess", "fork"); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	entries, err := os.ReadDir(Dir(dataDir, "fork"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != id {
		t.Errorf("fork holds %v, want only %s", entries, id)
	}
}
