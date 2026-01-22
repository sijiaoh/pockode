package watch

// Watcher defines the common interface for all watchers.
// Subscribe is not included as each watcher has different parameter and return
// types based on what it monitors.
type Watcher interface {
	Start() error
	Stop()
	Unsubscribe(id string)
	CleanupConnection(connID string)
}

var (
	_ Watcher = (*FSWatcher)(nil)
	_ Watcher = (*GitWatcher)(nil)
	_ Watcher = (*GitDiffWatcher)(nil)
	_ Watcher = (*WorktreeWatcher)(nil)
	_ Watcher = (*SessionListWatcher)(nil)
)
