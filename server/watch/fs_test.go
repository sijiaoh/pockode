package watch

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
