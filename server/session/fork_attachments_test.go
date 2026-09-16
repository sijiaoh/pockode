package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/attachments"
)

// A fork is handed the source's history records verbatim, and those records
// name attachments by id alone — an id that resolves inside the session's own
// directory. Without its own copy the fork's transcript would show an image it
// cannot fetch.
func TestCreateForkCopiesAttachments(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	if _, err := store.Create(ctx, "source", CreateSpec{}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	id, err := attachments.NewStore(dataDir, "source").Put([]byte("image bytes"), "")
	if err != nil {
		t.Fatalf("Put: %v", err)
	}

	source, _, err := store.Get("source")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, err := store.CreateFork(ctx, "fork", ForkSpec{Source: source}); err != nil {
		t.Fatalf("CreateFork: %v", err)
	}

	copied, err := os.ReadFile(filepath.Join(attachments.Dir(dataDir, "fork"), id))
	if err != nil {
		t.Fatalf("read the fork's attachment: %v", err)
	}
	if string(copied) != "image bytes" {
		t.Errorf("got %q, want the source's content", copied)
	}

	// Deleting the source must not take the fork's copy with it, which is the
	// whole reason the content is cloned rather than looked up in the source.
	if err := store.Delete(ctx, "source"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.ReadFile(filepath.Join(attachments.Dir(dataDir, "fork"), id)); err != nil {
		t.Errorf("the fork lost its attachment with the source: %v", err)
	}
}

// A source with nothing stored is the common case and must not fail the fork.
func TestCreateForkWithoutAttachments(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	if _, err := store.Create(ctx, "source", CreateSpec{}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	source, _, err := store.Get("source")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, err := store.CreateFork(ctx, "fork", ForkSpec{Source: source}); err != nil {
		t.Fatalf("CreateFork: %v", err)
	}
}
