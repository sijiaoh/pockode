package filestore

import (
	"bytes"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const (
	// blockedWindow is how long a contended acquisition must stay pending
	// before we accept that it is genuinely blocked. An uncontended
	// acquisition completes in microseconds.
	blockedWindow = 200 * time.Millisecond
	// grantTimeout bounds an acquisition we expect to succeed, so a broken
	// implementation fails the test instead of hanging it.
	grantTimeout = 10 * time.Second
)

func TestLockSemantics(t *testing.T) {
	tests := []struct {
		name        string
		held        bool // true: exclusive, false: shared
		wanted      bool
		wantBlocked bool
	}{
		{name: "exclusive blocks exclusive", held: true, wanted: true, wantBlocked: true},
		{name: "exclusive blocks shared", held: true, wanted: false, wantBlocked: true},
		{name: "shared blocks exclusive", held: false, wanted: true, wantBlocked: true},
		{name: "shared allows shared", held: false, wanted: false, wantBlocked: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "index.json.lock")

			first, err := acquireLock(path, tt.held)
			if err != nil {
				t.Fatalf("acquire first lock: %v", err)
			}

			pending := acquireAsync(t, path, tt.wanted)
			if tt.wantBlocked {
				requireBlocked(t, pending)
				// Only now, with the incompatible lock gone, may the waiter proceed.
				first.release()
			}

			awaitGrant(t, pending).release()

			if !tt.wantBlocked {
				// Compatible locks coexist: the first one is still held here.
				first.release()
			}
		})
	}
}

// acquisition carries the outcome of a lock attempt made from another goroutine.
type acquisition struct {
	lock *fileLock
	err  error
}

// acquireAsync starts acquiring the lock in a goroutine. It returns only once
// that goroutine is running, so that requireBlocked cannot be satisfied by a
// goroutine the scheduler simply never got around to starting.
func acquireAsync(t *testing.T, path string, exclusive bool) <-chan acquisition {
	t.Helper()

	started := make(chan struct{})
	result := make(chan acquisition, 1)
	go func() {
		close(started)
		lock, err := acquireLock(path, exclusive)
		result <- acquisition{lock: lock, err: err}
	}()
	<-started
	return result
}

// requireBlocked fails the test unless the acquisition is still pending after
// blockedWindow.
func requireBlocked(t *testing.T, pending <-chan acquisition) {
	t.Helper()

	select {
	case got := <-pending:
		if got.err != nil {
			t.Fatalf("acquisition failed: %v", got.err)
		}
		got.lock.release()
		t.Fatal("lock was granted while an incompatible lock was held")
	case <-time.After(blockedWindow):
	}
}

// awaitGrant waits for the acquisition to succeed and returns the lock.
func awaitGrant(t *testing.T, pending <-chan acquisition) *fileLock {
	t.Helper()

	select {
	case got := <-pending:
		if got.err != nil {
			t.Fatalf("acquisition failed: %v", got.err)
		}
		return got.lock
	case <-time.After(grantTimeout):
		t.Fatal("lock was never granted")
		return nil
	}
}

// TestConcurrentReadWrite asserts the end-to-end guarantee the lock exists for:
// a reader never observes a partially written index. Each writer writes a
// distinct byte repeated to a size large enough that an unsynchronized write
// would be visible in pieces.
func TestConcurrentReadWrite(t *testing.T) {
	f, err := New(Config{Path: filepath.Join(t.TempDir(), "index.json"), Label: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	const (
		writers    = 4
		iterations = 10
		payloadLen = 16 * 1024
	)

	var wg sync.WaitGroup
	for w := range writers {
		payload := bytes.Repeat([]byte{byte('a' + w)}, payloadLen)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range iterations {
				if err := f.Write(payload); err != nil {
					t.Errorf("Write: %v", err)
					return
				}
			}
		}()
	}

	for range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range iterations {
				data, err := f.Read()
				if err != nil {
					t.Errorf("Read: %v", err)
					return
				}
				if data == nil {
					continue // no write has landed yet
				}
				if len(data) != payloadLen || bytes.Count(data, data[:1]) != payloadLen {
					t.Errorf("read a torn index: len=%d", len(data))
					return
				}
			}
		}()
	}

	wg.Wait()

	if gen := f.SnapshotGen(); gen != writers*iterations {
		t.Errorf("SnapshotGen() = %d, want %d", gen, writers*iterations)
	}
}

func TestReadMissingFile(t *testing.T) {
	f, err := New(Config{Path: filepath.Join(t.TempDir(), "index.json"), Label: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	data, err := f.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if data != nil {
		t.Errorf("Read() = %q, want nil for a missing file", data)
	}
}
