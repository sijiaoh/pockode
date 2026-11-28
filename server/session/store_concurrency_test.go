package session

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/filestore"
)

// holdNextIndexWrite makes the store's next index write wait until the
// returned release is called; entered is closed once that write has started.
func holdNextIndexWrite(t *testing.T, store *FileStore) (entered <-chan struct{}, release func()) {
	t.Helper()
	started := make(chan struct{})
	gate := make(chan struct{})
	var once sync.Once
	release = sync.OnceFunc(func() { close(gate) })
	t.Cleanup(release)

	store.writeMu.Lock()
	store.writeIndex = func(path string, data []byte, perm os.FileMode) error {
		held := false
		once.Do(func() { held = true })
		if held {
			close(started)
			<-gate
		}
		return filestore.WriteFileAtomic(path, data, perm)
	}
	store.writeMu.Unlock()
	return started, release
}

// readWithin runs read on another goroutine and fails the test if it has not
// returned within a generous bound — a reader stuck behind a write.
func readWithin(t *testing.T, read func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		read()
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a reader waited for the index write to finish")
	}
}

// A slow disk must not stall every RPC: List and Get answer while a durable
// write is still on its way to the disk, and they answer with the state from
// before it, since a durable change is not the store's until it is written.
func TestFileStore_ReadersDoNotWaitForAnIndexWrite(t *testing.T) {
	store := reopen(t, t.TempDir())
	if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	entered, release := holdNextIndexWrite(t, store)

	updated := make(chan error, 1)
	go func() { updated <- store.Update(ctx, "s1", "Renamed") }()
	<-entered

	var list []SessionMeta
	var meta SessionMeta
	var found bool
	readWithin(t, func() {
		list, _ = store.List()
		meta, found, _ = store.Get("s1")
	})
	if len(list) != 1 || !found {
		t.Fatalf("during the write: List = %d sessions, Get found = %v; want the one session", len(list), found)
	}
	if meta.Title != "New Chat" {
		t.Errorf("Title during the write = %q, want the title from before it", meta.Title)
	}

	release()
	if err := <-updated; err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if got := mustGet(t, store, "s1").Title; got != "Renamed" {
		t.Errorf("Title after the write = %q, want %q", got, "Renamed")
	}
}

// A session is no longer handed out once its files have started to go: a
// caller holding it could write into the directory being removed and leave
// an orphan behind.
func TestFileStore_DeletedSessionIsUnlistedBeforeTheIndexIsWritten(t *testing.T) {
	store := reopen(t, t.TempDir())
	if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	entered, release := holdNextIndexWrite(t, store)

	deleted := make(chan error, 1)
	go func() { deleted <- store.Delete(ctx, "s1") }()
	<-entered

	var list []SessionMeta
	var found bool
	readWithin(t, func() {
		list, _ = store.List()
		_, found, _ = store.Get("s1")
	})
	if len(list) != 0 || found {
		t.Errorf("while the delete is written: List = %d sessions, Get found = %v; want none", len(list), found)
	}

	release()
	if err := <-deleted; err != nil {
		t.Fatalf("Delete failed: %v", err)
	}
}

// A durable write the disk refuses is not left for the next change: a session
// that goes quiet would keep it in memory until Close.
func TestFileStore_FailedDurableWriteIsRetried(t *testing.T) {
	dir := t.TempDir()
	store := reopen(t, dir)
	store.flushDelay = 10 * time.Millisecond
	if _, err := store.Create(ctx, "s1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	// A directory where the temp file goes makes every write fail.
	blocker := store.indexPath() + ".tmp"
	if err := os.Mkdir(blocker, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := store.Update(ctx, "s1", "Renamed"); err == nil {
		t.Fatal("Update succeeded with the index unwritable")
	}
	time.Sleep(50 * time.Millisecond)
	if err := os.Remove(blocker); err != nil {
		t.Fatalf("remove: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for mustGet(t, NewDirReader(dir), "s1").Title != "Renamed" {
		if time.Now().After(deadline) {
			t.Fatal("the refused write was never retried")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Readers and writers of every kind run at once; under -race this holds that
// nothing a reader is handed — the nested blockers, questions and cost
// included — is shared with a writer.
func TestFileStore_ConcurrentReadsAndWrites(t *testing.T) {
	store := reopen(t, t.TempDir())
	store.flushDelay = time.Millisecond
	const sessions = 4
	for i := range sessions {
		if _, err := store.Create(ctx, fmt.Sprintf("s%d", i), CreateSpec{}); err != nil {
			t.Fatalf("Create failed: %v", err)
		}
	}

	var wg sync.WaitGroup
	for i := range sessions {
		id := fmt.Sprintf("s%d", i)
		wg.Go(func() {
			for n := range 20 {
				question := postedQuestion("q", at(n))
				cost := 0.01
				mustSucceed(t, store.Touch(ctx, id))
				mustSucceed(t, store.SetUnread(ctx, id, n%2 == 0))
				mustSucceed(t, store.Update(ctx, id, fmt.Sprintf("title %d", n)))
				mustSucceed(t, store.AddUsage(ctx, id, UsageReport{AddedCostUSD: &cost}))
				for _, in := range []TurnInput{
					{Signal: SignalPrompt, At: at(n)},
					{Signal: SignalPermissionRaised, RequestID: "r", At: at(n)},
					{Signal: SignalQuestionPosted, Question: &question, At: at(n)},
					{Signal: SignalQuestionResolved, RequestID: "q", At: at(n)},
					{Signal: SignalProcessEnded, At: at(n)},
				} {
					_, err := store.ApplyTurn(ctx, id, in)
					mustSucceed(t, err)
				}
			}
		})
	}
	// Created and deleted alongside, so the list itself changes length too.
	wg.Go(func() {
		for n := range 20 {
			id := fmt.Sprintf("churn%d", n)
			_, err := store.Create(ctx, id, CreateSpec{})
			mustSucceed(t, err)
			mustSucceed(t, store.Delete(ctx, id))
		}
	})

	done := make(chan struct{})
	var readers sync.WaitGroup
	for range 4 {
		readers.Go(func() {
			for {
				select {
				case <-done:
					return
				default:
				}
				list, err := store.List()
				mustSucceed(t, err)
				for _, meta := range list {
					readNested(meta)
				}
				if meta, found, err := store.Get("s0"); err != nil || !found {
					t.Errorf("Get(s0) = found %v, err %v", found, err)
				} else {
					readNested(meta)
				}
				runtime.Gosched()
			}
		})
	}

	wg.Wait()
	close(done)
	readers.Wait()
}

func readNested(meta SessionMeta) {
	for _, b := range meta.Turn.Blockers {
		_ = b.RequestID
	}
	for _, q := range meta.Turn.Unanswered {
		_ = q.RequestID
	}
	if meta.Usage.CostUSD != nil {
		_ = *meta.Usage.CostUSD
	}
}

func mustSucceed(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Error(err)
	}
}
