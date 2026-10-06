package attachments

import (
	"os"
	"path/filepath"
	"testing"
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
