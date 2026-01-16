package worktree

import (
	"context"
	"fmt"
	"sync"

	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
	"github.com/sourcegraph/jsonrpc2"
)

// Worktree holds all resources (session store, watchers, processes) for a single worktree.
type Worktree struct {
	Name           string
	WorkDir        string
	SessionStore   session.Store
	FSWatcher      *watch.FSWatcher
	GitWatcher     *watch.GitWatcher
	ProcessManager *process.Manager

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
// This is the single source of truth for connection cleanup - any new
// resources that need cleanup when a connection leaves should be added here.
func (w *Worktree) UnsubscribeConnection(conn *jsonrpc2.Conn, connID string) {
	w.ProcessManager.UnsubscribeConn(conn)
	w.FSWatcher.CleanupConnection(connID)
	w.GitWatcher.CleanupConnection(connID)
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
	if err := w.FSWatcher.Start(); err != nil {
		return fmt.Errorf("start fs watcher: %w", err)
	}

	if err := w.GitWatcher.Start(); err != nil {
		w.FSWatcher.Stop()
		return fmt.Errorf("start git watcher: %w", err)
	}

	return nil
}

func (w *Worktree) Stop() {
	w.GitWatcher.Stop()
	w.FSWatcher.Stop()
	w.ProcessManager.Shutdown()
}
