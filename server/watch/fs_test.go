package watch

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/pockode/server/internal/symlinktest"
)

// Subscribers name paths with `/` (the form contents.GetContents hands out)
// while filesystem events arrive native, so the two have to be reconciled
// before they meet as map keys. Getting that wrong is silent — the client
// simply never hears about the file again — which is why this goes through the
// real watcher rather than re-deriving the key in the test.
func TestFSWatcher_NotifiesSubscribers(t *testing.T) {
	tests := []struct {
		name string
		// subscribed is the path a client subscribes to, always slash-separated.
		subscribed string
		// changed is the file that changes, relative to the work directory and
		// spelled with the platform's own separator.
		changed   []string
		wantNotif bool
	}{
		{"file in a subdirectory", "src/foo.ts", []string{"src", "foo.ts"}, true},
		{"directory hears about its children", "src", []string{"src", "foo.ts"}, true},
		{"work directory root hears about its children", "", []string{"foo.ts"}, true},
		{"file at the root", "foo.ts", []string{"foo.ts"}, true},
		{"unrelated file", "src/foo.ts", []string{"src", "bar.ts"}, false},
		{"grandchild does not reach the grandparent", "", []string{"src", "foo.ts"}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			workDir := t.TempDir()
			if err := os.MkdirAll(filepath.Join(workDir, "src"), 0755); err != nil {
				t.Fatalf("MkdirAll() failed: %v", err)
			}
			for _, name := range []string{filepath.Join("src", "foo.ts"), filepath.Join("src", "bar.ts"), "foo.ts"} {
				if err := os.WriteFile(filepath.Join(workDir, name), []byte("x"), 0644); err != nil {
					t.Fatalf("WriteFile(%q) failed: %v", name, err)
				}
			}

			w := NewFSWatcher(workDir)
			if err := w.Start(); err != nil {
				t.Fatalf("Start() failed: %v", err)
			}
			defer w.Stop()

			notifier := &recordingNotifier{notified: make(chan struct{}, 1)}
			if err := w.Subscribe("client-1", tt.subscribed, notifier); err != nil {
				t.Fatalf("Subscribe(%q) failed: %v", tt.subscribed, err)
			}

			w.handleEvent(fsnotify.Event{
				Name: filepath.Join(append([]string{workDir}, tt.changed...)...),
				Op:   fsnotify.Write,
			})

			// Notification is debounced by debounceInterval. Waiting well past it
			// keeps the positive cases off a loaded machine's timing edge; the
			// negative cases only have to outlast the debounce, and every one of
			// them pays the wait in full.
			deadline := 20 * debounceInterval
			if !tt.wantNotif {
				deadline = 5 * debounceInterval
			}

			select {
			case <-notifier.notified:
				if !tt.wantNotif {
					t.Errorf("subscriber of %q was notified about %v, want no notification", tt.subscribed, tt.changed)
				}
			case <-time.After(deadline):
				if tt.wantNotif {
					t.Errorf("subscriber of %q was not notified about %v", tt.subscribed, tt.changed)
				}
			}
		})
	}
}

// Coalescing is per subscription, not per changed path: a batch of different
// files changing in an open directory is one re-read of it.
func TestFSWatcher_BatchOfChangesNotifiesOnce(t *testing.T) {
	workDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workDir, "src"), 0755); err != nil {
		t.Fatalf("MkdirAll() failed: %v", err)
	}

	// Not Start()ed: the event loop would hand real events to the debouncer
	// from outside the bubble, and a timer the bubble owns must not be touched
	// from there. Events are fed by hand from inside it instead, so the debounce
	// timers count fake time. The fsnotify watcher is created outside, because
	// its reader sits in a syscall, which synctest does not count as blocked.
	w := NewFSWatcher(workDir)
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("fsnotify.NewWatcher() failed: %v", err)
	}
	w.watcher = fsw
	defer w.Stop()

	dirSub, fileSub := &countingNotifier{}, &countingNotifier{}
	if err := w.Subscribe("dir", "src", dirSub); err != nil {
		t.Fatalf("Subscribe(src) failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "src", "file-0.ts"), []byte("x"), 0644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}
	if err := w.Subscribe("file", "src/file-0.ts", fileSub); err != nil {
		t.Fatalf("Subscribe(src/file-0.ts) failed: %v", err)
	}

	synctest.Test(t, func(t *testing.T) {
		for i := range 200 {
			w.handleEvent(fsnotify.Event{
				Name: filepath.Join(workDir, "src", fmt.Sprintf("file-%d.ts", i)),
				Op:   fsnotify.Create,
			})
		}
		time.Sleep(2 * debounceMaxWait)
		synctest.Wait()
	})

	if n := dirSub.count.Load(); n != 1 {
		t.Errorf("directory subscriber got %d notifications for one batch, want 1", n)
	}
	if n := fileSub.count.Load(); n != 1 {
		t.Errorf("file subscriber got %d notifications, want 1", n)
	}
}

type countingNotifier struct {
	count atomic.Int32
}

func (n *countingNotifier) Notify(context.Context, Notification) error {
	n.count.Add(1)
	return nil
}

type recordingNotifier struct {
	notified chan struct{}
}

func (n *recordingNotifier) Notify(context.Context, Notification) error {
	select {
	case n.notified <- struct{}{}:
	default:
	}
	return nil
}

// An entry that leads nowhere must not stop its directory from being watched:
// kqueue opens every entry of a watched directory, and a dangling link there
// used to fail the whole watch, leaving the tree silently stale. A loop fails
// it still, and so does lose the events of names after a broken link; both
// directories are watched all the same (pollDirs).
func TestFSWatcher_WatchesADirectoryWithBrokenLinks(t *testing.T) {
	workDir := t.TempDir()
	symlinktest.Make(t, "gone.txt", filepath.Join(workDir, "broken"))
	symlinktest.Make(t, "loop2", filepath.Join(workDir, "loop1"))
	symlinktest.Make(t, "loop1", filepath.Join(workDir, "loop2"))

	w := NewFSWatcher(workDir)
	if err := w.Start(); err != nil {
		t.Fatalf("Start() failed: %v", err)
	}
	defer w.Stop()

	notifier := &recordingNotifier{notified: make(chan struct{}, 1)}
	if err := w.Subscribe("client-1", "", notifier); err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "new.txt"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	select {
	case <-notifier.notified:
	case <-time.After(5 * time.Second):
		t.Error("no notification for a file created next to a broken link")
	}
}

// Watching follows links only inside the work directory, as file.get does:
// otherwise a client could learn when files outside change. The refusal
// names no host path.
func TestFSWatcher_RefusesALinkOut(t *testing.T) {
	workDir := t.TempDir()
	outside := t.TempDir()
	symlinktest.Make(t, outside, filepath.Join(workDir, "odir"))

	w := NewFSWatcher(workDir)
	if err := w.Start(); err != nil {
		t.Fatalf("Start() failed: %v", err)
	}
	defer w.Stop()

	for _, p := range []string{"odir", "odir/x"} {
		err := w.Subscribe("client-"+p, p, &recordingNotifier{notified: make(chan struct{}, 1)})
		if err == nil {
			t.Errorf("Subscribe(%s) succeeded, want a refusal", p)
			continue
		}
		if strings.Contains(err.Error(), outside) || strings.Contains(err.Error(), workDir) {
			t.Errorf("Subscribe(%s): %q names a host path", p, err)
		}
	}
}

// A polled directory's change goes through the same debounce as fsnotify's
// events: on kqueue both see one change, and the subscription still hears of
// it once. A poll on its own notifies as well.
func TestFSWatcher_PollIsDebouncedWithEvents(t *testing.T) {
	workDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workDir, "src"), 0755); err != nil {
		t.Fatalf("MkdirAll() failed: %v", err)
	}
	// A loop is what makes kqueue refuse the directory and poll it alone.
	symlinktest.Make(t, "loop2", filepath.Join(workDir, "src", "loop1"))
	symlinktest.Make(t, "loop1", filepath.Join(workDir, "src", "loop2"))

	// Not Start()ed, for the reason TestFSWatcher_BatchOfChangesNotifiesOnce
	// gives; the poll is driven by hand instead of by its ticker.
	w := NewFSWatcher(workDir)
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("fsnotify.NewWatcher() failed: %v", err)
	}
	w.watcher = fsw
	defer w.Stop()

	sub := &countingNotifier{}
	if err := w.Subscribe("dir", "src", sub); err != nil {
		t.Fatalf("Subscribe(src) failed: %v", err)
	}
	// Polled on every platform here, not only where pollDirs is set.
	w.pathMu.Lock()
	if w.polled["src"] == nil {
		w.polled["src"] = &polledDir{real: "src", modTime: w.modTime("src")}
	}
	w.pathMu.Unlock()

	// The directory's time is also set by hand, each create a day apart, so a
	// filesystem with coarse timestamps still shows the poll a change.
	stamp := time.Now()
	create := func(name string) {
		t.Helper()
		dir := filepath.Join(workDir, "src")
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0644); err != nil {
			t.Fatalf("WriteFile(%s) failed: %v", name, err)
		}
		stamp = stamp.Add(24 * time.Hour)
		if err := os.Chtimes(dir, stamp, stamp); err != nil {
			t.Fatalf("Chtimes failed: %v", err)
		}
	}

	synctest.Test(t, func(t *testing.T) {
		create("a.ts")
		w.handleEvent(fsnotify.Event{Name: filepath.Join(workDir, "src", "a.ts"), Op: fsnotify.Create})
		w.pollOnce()
		time.Sleep(2 * debounceMaxWait)
		synctest.Wait()
		if n := sub.count.Load(); n != 1 {
			t.Errorf("event and poll of one change: %d notifications, want 1", n)
		}

		create("b.ts")
		w.pollOnce()
		time.Sleep(2 * debounceMaxWait)
		synctest.Wait()
		if n := sub.count.Load(); n != 2 {
			t.Errorf("after a change only the poll saw: %d notifications, want 2", n)
		}
	})
}
