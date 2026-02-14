package worktree

import (
	"context"
	"fmt"
	"sync"

	"github.com/pockode/server/chat"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
	"github.com/sourcegraph/jsonrpc2"
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
	subscribers map[*jsonrpc2.Conn]struct{}
}

func (w *Worktree) Subscribe(conn *jsonrpc2.Conn) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.subscribers[conn] = struct{}{}
}

func (w *Worktree) Unsubscribe(conn *jsonrpc2.Conn) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.subscribers, conn)
}

// UnsubscribeConnection removes all subscriptions for a connection.
func (w *Worktree) UnsubscribeConnection(conn *jsonrpc2.Conn, connID string) {
	for _, watcher := range w.watchers {
		watcher.CleanupConnection(connID)
	}
	w.Unsubscribe(conn)
}

func (w *Worktree) NotifyAll(ctx context.Context, method string, params any) {
	w.mu.Lock()
	conns := make([]*jsonrpc2.Conn, 0, len(w.subscribers))
	for conn := range w.subscribers {
		conns = append(conns, conn)
	}
	w.mu.Unlock()

	for _, conn := range conns {
		conn.Notify(ctx, method, params)
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
