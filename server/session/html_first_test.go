package session

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The guidance is a draft until the first message is delivered and fixed from
// then on; a write of the value the session already has costs nothing.
func TestFileStore_SetHTMLFirst(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())
	created, err := store.Create(ctx, "s1", CreateSpec{})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if created.HTMLFirst || created.Started {
		t.Fatalf("a new session must be an unstarted ordinary chat, got %+v", created)
	}

	listener := &countingListener{}
	store.AddOnChangeListener(listener)

	if err := store.SetHTMLFirst(ctx, "s1", true); err != nil {
		t.Fatalf("SetHTMLFirst failed: %v", err)
	}
	if meta, _, _ := store.Get("s1"); !meta.HTMLFirst {
		t.Error("expected html_first to be set")
	}
	if listener.count != 1 {
		t.Errorf("a switch must be announced once, got %d notifications", listener.count)
	}

	if err := store.SetHTMLFirst(ctx, "s1", true); err != nil {
		t.Fatalf("SetHTMLFirst failed: %v", err)
	}
	if listener.count != 1 {
		t.Errorf("writing the same value must not notify, got %d notifications", listener.count)
	}

	started, err := store.MarkStarted(ctx, "s1")
	if err != nil {
		t.Fatalf("MarkStarted failed: %v", err)
	}
	if !started.Started || !started.HTMLFirst {
		t.Errorf("MarkStarted must return the session as it stands, got %+v", started)
	}

	for _, value := range []bool{false, true} {
		if err := store.SetHTMLFirst(ctx, "s1", value); !errors.Is(err, ErrSessionStarted) {
			t.Errorf("SetHTMLFirst(%v) on a started session = %v, want ErrSessionStarted", value, err)
		}
	}
	if meta, _, _ := store.Get("s1"); !meta.HTMLFirst {
		t.Error("a refused switch must leave the value alone")
	}

	if err := store.SetHTMLFirst(ctx, "missing", true); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("expected ErrSessionNotFound, got %v", err)
	}
}

func TestFileStore_MarkStarted_IsIdempotent(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())
	if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if _, err := store.MarkStarted(ctx, "s1"); err != nil {
		t.Fatalf("MarkStarted failed: %v", err)
	}

	listener := &countingListener{}
	store.AddOnChangeListener(listener)
	if _, err := store.MarkStarted(ctx, "s1"); err != nil {
		t.Fatalf("MarkStarted failed: %v", err)
	}
	if listener.count != 0 {
		t.Errorf("every message marks the session; only the first may write, got %d notifications", listener.count)
	}

	if _, err := store.MarkStarted(ctx, "missing"); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("expected ErrSessionNotFound, got %v", err)
	}
}

// A fork's copied history was told under the source's guidance, so the fork
// keeps it and cannot be switched.
func TestFileStore_ForkCopiesHTMLFirstAndIsStarted(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())
	if _, err := store.Create(ctx, "source", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if err := store.SetHTMLFirst(ctx, "source", true); err != nil {
		t.Fatalf("SetHTMLFirst failed: %v", err)
	}
	source, _, _ := store.Get("source")

	fork, err := store.CreateFork(ctx, "fork", ForkSpec{Source: source})
	if err != nil {
		t.Fatalf("CreateFork failed: %v", err)
	}
	if !fork.HTMLFirst {
		t.Error("expected the fork to copy html_first")
	}
	if !fork.Started {
		t.Error("expected the fork to be started from birth")
	}
	if err := store.SetHTMLFirst(ctx, "fork", false); !errors.Is(err, ErrSessionStarted) {
		t.Errorf("switching a fork = %v, want ErrSessionStarted", err)
	}
}

// Started is younger than Activated: a session that ran under an earlier build
// has started even though nothing ever wrote the field.
func TestFileStore_MigratesActivatedToStarted(t *testing.T) {
	dir := t.TempDir()
	sessionsDir := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	index := `{"sessions":[{"id":"ran","activated":true},{"id":"fresh","activated":false}]}`
	if err := os.WriteFile(filepath.Join(sessionsDir, "index.json"), []byte(index), 0644); err != nil {
		t.Fatal(err)
	}

	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if ran, _, _ := store.Get("ran"); !ran.Started {
		t.Error("expected an activated session to read as started")
	}
	if fresh, _, _ := store.Get("fresh"); fresh.Started {
		t.Error("expected an unactivated session to stay unstarted")
	}
}
