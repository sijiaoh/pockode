package projection

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// countingDirReader is a DirReader that counts its history reads.
type countingDirReader struct {
	session.DirReader
	reads atomic.Int32
}

func (r *countingDirReader) GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	r.reads.Add(1)
	return r.DirReader.GetHistory(ctx, sessionID)
}

// foldsOverStore is a Folds source over a store's directory, as a worktree
// that is not loaded is read, with the store standing in for whatever else
// writes it.
func foldsOverStore(t *testing.T) (*session.FileStore, string, *countingDirReader, *Folds) {
	t.Helper()
	dir := t.TempDir()
	store, err := session.NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	createSession(t, store, "s")
	for _, line := range liveLines {
		appendLine(t, store, "s", line)
	}
	return store, dir, &countingDirReader{DirReader: session.NewDirReader(dir)}, NewFolds(time.Hour)
}

func foldedPage(t *testing.T, src Source) Page {
	t.Helper()
	page, err := src.Page(context.Background(), "s", session.NoHistorySeq, 0)
	if err != nil {
		t.Fatal(err)
	}
	return page
}

func filePage(t *testing.T, store *session.FileStore) Page {
	t.Helper()
	records, err := store.GetHistory(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	page, err := Fold(records, session.AgentTypeClaude).Page(session.NoHistorySeq, 0)
	if err != nil {
		t.Fatal(err)
	}
	return page
}

// TestFolds_KeepsAFoldOnlyWhileTheFileStays: pages of an unchanged history
// read the file once, and a history changed underneath — appended to, or
// rewritten into a file of the same size and time — is folded again rather
// than served stale.
func TestFolds_KeepsAFoldOnlyWhileTheFileStays(t *testing.T) {
	store, dir, r, f := foldsOverStore(t)
	src := f.Source(r)
	check := func(when string, wantReads int32) {
		t.Helper()
		if got, want := foldedPage(t, src), filePage(t, store); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: served\n  %+v\nwant\n  %+v", when, got, want)
		}
		if got := r.reads.Load(); got != wantReads {
			t.Errorf("%s: history read %d times, want %d", when, got, wantReads)
		}
	}

	check("first page", 1)
	check("again", 1)
	if _, err := src.State(context.Background(), "s"); err != nil {
		t.Fatal(err)
	}
	check("after a state read", 1)

	appendLine(t, store, "s", `T2|{"type":"text","content":"written elsewhere"}`)
	check("appended to", 2)
	check("appended to, again", 2)

	// Same length, same modification time: only the file is another.
	path := filepath.Join(dir, "sessions", "s", "history.jsonl")
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	records, err := store.GetHistory(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	last := len(records) - 1
	records[last] = bytes.Replace(records[last], []byte("written elsewhere"), []byte("WRITTEN ELSEWHERE"), 1)
	if err := store.WriteHistory(context.Background(), "s", records); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() != before.Size() {
		t.Fatalf("rewritten history is %d bytes, %d before: the case is not the one meant", after.Size(), before.Size())
	}
	check("rewritten", 3)
}

// TestFolds_LetsGoOnceUnread: a fold is kept until it has gone unread for the
// linger, and a Folds with no linger keeps nothing.
func TestFolds_LetsGoOnceUnread(t *testing.T) {
	store, _, r, f := foldsOverStore(t)
	src := f.Source(r)
	foldedPage(t, src)
	expireFolds(f)
	f.entriesMu.Lock()
	kept := len(f.entries)
	f.entriesMu.Unlock()
	if kept != 0 {
		t.Fatalf("%d folds kept once unread for the linger", kept)
	}
	if got, want := foldedPage(t, src), filePage(t, store); !reflect.DeepEqual(got, want) {
		t.Errorf("read again: served\n  %+v\nwant\n  %+v", got, want)
	}
	if got := r.reads.Load(); got != 2 {
		t.Errorf("history read %d times, want twice: once before letting go, once after", got)
	}

	none := NewFolds(0).Source(r)
	foldedPage(t, none)
	foldedPage(t, none)
	if got := r.reads.Load(); got != 4 {
		t.Errorf("with no linger: history read %d times in all, want 4", got)
	}
}

// TestFolds_ADeletedSession: a session deleted underneath is not found, kept
// fold or not.
func TestFolds_ADeletedSession(t *testing.T) {
	store, _, r, f := foldsOverStore(t)
	src := f.Source(r)
	foldedPage(t, src)
	if err := store.Delete(context.Background(), "s"); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Page(context.Background(), "s", session.NoHistorySeq, 0); !errors.Is(err, session.ErrSessionNotFound) {
		t.Errorf("deleted session paged: %v, want ErrSessionNotFound", err)
	}
}

// expireFolds ends every kept fold's linger now, as its timer would once it
// ran out.
func expireFolds(f *Folds) {
	f.entriesMu.Lock()
	entries := make(map[string]*foldEntry, len(f.entries))
	for file, e := range f.entries {
		e.until = time.Time{}
		entries[file] = e
	}
	f.entriesMu.Unlock()
	for file, e := range entries {
		f.expire(file, e)
	}
}

// TestFolds_ReadsRacingWrites: pages read while the history is written
// underneath, and while the linger lets the fold go, are each some version of
// the file, and the page read once the writes are done is the file's.
func TestFolds_ReadsRacingWrites(t *testing.T) {
	store, _, r, f := foldsOverStore(t)
	src := f.Source(r)
	var wg sync.WaitGroup
	done := make(chan struct{})
	for range 4 {
		wg.Go(func() {
			for {
				select {
				case <-done:
					return
				default:
				}
				if _, err := src.Page(context.Background(), "s", session.NoHistorySeq, 0); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	wg.Go(func() {
		for {
			select {
			case <-done:
				return
			default:
				expireFolds(f)
			}
		}
	})
	for i := range 50 {
		appendLine(t, store, "s", fmt.Sprintf(`T2|{"type":"text","content":"line %d"}`, i))
	}
	close(done)
	wg.Wait()
	if got, want := foldedPage(t, src), filePage(t, store); !reflect.DeepEqual(got, want) {
		t.Errorf("after the writes: served\n  %+v\nwant\n  %+v", got, want)
	}
}
