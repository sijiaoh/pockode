package worktree

import (
	"context"
	"fmt"
	"sync"

	"github.com/pockode/server/chat"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
)

// Worktree holds all resources (session store, watchers, processes) for a single worktree.
type Worktree struct {
	Name                string
	WorkDir             string
	SessionStore        session.Store
	FSWatcher           *watch.FSWatcher
	GitWatcher          *watch.GitWatcher
	GitDiffWatcher      *watch.GitDiffWatcher
	SessionListWatcher  *watch.SessionListWatcher
	ChatMessagesWatcher *watch.ChatMessagesWatcher
	ProcessManager      *process.Manager
	ChatClient          *chat.Client

	watchers []watch.Watcher // for unified lifecycle management

	mu          sync.Mutex // protects subscribers only
	refCount    int        // protected by Manager.mu, not Worktree.mu
	subscribers map[watch.Notifier]struct{}
}

func (w *Worktree) Subscribe(notifier watch.Notifier) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.subscribers[notifier] = struct{}{}
}

func (w *Worktree) Unsubscribe(notifier watch.Notifier) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.subscribers, notifier)
}

func (w *Worktree) NotifyAll(ctx context.Context, method string, params any) {
	w.mu.Lock()
	notifiers := make([]watch.Notifier, 0, len(w.subscribers))
	for notifier := range w.subscribers {
		notifiers = append(notifiers, notifier)
	}
	w.mu.Unlock()

	n := watch.Notification{Method: method, Params: params}
	for _, notifier := range notifiers {
		notifier.Notify(ctx, n)
	}
}

func (w *Worktree) SubscriberCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.subscribers)
}

func (w *Worktree) Start() error {
	for i, watcher := range w.watchers {
		if err := watcher.Start(); err != nil {
			// Rollback: stop already started watchers
			for j := i - 1; j >= 0; j-- {
				w.watchers[j].Stop()
			}
			return fmt.Errorf("start watcher: %w", err)
		}
	}
	return nil
}

func (w *Worktree) Stop() {
	for _, watcher := range w.watchers {
		watcher.Stop()
	}
	w.ProcessManager.Shutdown()
}
