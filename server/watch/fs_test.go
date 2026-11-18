package watch

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/fsnotify/fsnotify"
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
