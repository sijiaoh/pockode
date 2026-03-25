# Watcher

The watcher system is a real-time subscription/notification engine that pushes state changes from backend to frontend over WebSocket. It eliminates frontend polling — clients subscribe to specific resources and receive JSON-RPC notifications when those resources change.

## Architecture

```
Event Source (fsnotify / git poll / store mutation)
  → Watcher (detects change)
    → Subscription.Notifier.Notify()
      → JSONRPCNotifier (ws/notifier.go)
        → JSON-RPC notification over WebSocket
          → Frontend callback map (by subscription ID)
            → React component update
```

## Core Abstractions

`server/watch/` — All types below are in this package.

### Watcher Interface

```go
type Watcher interface {
    Start() error
    Stop()
    Unsubscribe(id string)
}
```

### BaseWatcher

Shared subscription management: ID generation (with type-specific prefix), thread-safe subscription map, context/cancel for lifecycle. Most watchers embed this.

### Notifier

```go
type Notifier interface {
    Notify(ctx context.Context, n Notification) error
}

type Notification struct {
    Method string  // e.g. "fs.changed", "git.changed"
    Params any     // includes subscription ID for client-side routing
}
```

`ws/notifier.go` provides `JSONRPCNotifier` that bridges to `jsonrpc2.Conn.Notify()`.

## Watcher Implementations

### Detection Strategies

| Strategy | Watchers | Mechanism |
|----------|----------|-----------|
| OS-level | FSWatcher | `fsnotify` library, 100ms debounce |
| Polling | GitWatcher, GitDiffWatcher, WorktreeWatcher | 3s interval, state hash comparison |
| Event-driven | SessionList, ChatMessages, WorkList, WorkDetail, Settings, AgentRoleList | Store `OnChangeListener` callbacks via async channels |

### OS-Level: FSWatcher

`watch/fs.go` — Watches file paths using `fsnotify`. Reference-counted: multiple subscriptions to the same path share one OS watch. Notifies both the changed path and its parent directory. Debounced at 100ms to coalesce rapid changes.

### Polling-Based

| Watcher | File | What it polls | Notification |
|---------|------|---------------|--------------|
| GitWatcher | `watch/git.go` | `git rev-parse HEAD` + `git status --porcelain=v1` | `git.changed` |
| GitDiffWatcher | `watch/git_diff.go` | `git diff` for specific file (staged or unstaged) | `git.diff.changed` (includes diff content) |
| WorktreeWatcher | `watch/worktree.go` | `git worktree list --porcelain` | `worktree.changed` |

All skip polling when there are no subscribers.

### Event-Driven

These watchers implement store listener interfaces and use async buffered channels to avoid blocking store mutexes.

| Watcher | File | Listener Interface | Notification |
|---------|------|--------------------|--------------|
| SessionListWatcher | `watch/session_list.go` | `session.OnChangeListener` | `session.list.changed` |
| ChatMessagesWatcher | `watch/chat_messages.go` | `process.ChatMessageListener` | `chat.<event-type>` |
| WorkListWatcher | `watch/work_list.go` | `work.OnChangeListener` | `work.list.changed` |
| WorkDetailWatcher | `watch/work_detail.go` | `work.OnChangeListener` + `work.OnCommentChangeListener` | `work.detail.changed` |
| SettingsWatcher | `watch/settings.go` | `settings.OnChangeListener` | `settings.changed` |
| AgentRoleListWatcher | `watch/agent_role_list.go` | `agentrole.OnChangeListener` | `agent_role.list.changed` |

**Backpressure:** Event channels have fixed capacity (16–256). When full, events are dropped and a `dirty` flag is set. The next delivered event triggers a full sync instead of an incremental update, ensuring clients converge to correct state.

**WorkDetailWatcher** is filtered — it only notifies subscribers watching the affected `work_id`, not all subscribers.

## Subscription Lifecycle

### Backend

1. Client sends subscribe RPC (e.g. `fs.subscribe`)
2. Server creates `JSONRPCNotifier` from the connection
3. Watcher's `Subscribe()` registers subscription, returns ID + initial data
4. Subscription tracked in `rpcState` for cleanup on disconnect
5. Watcher sends notifications via the notifier when changes occur
6. Client sends unsubscribe RPC — watcher removes subscription
7. On disconnect: all tracked subscriptions auto-unsubscribed

### Frontend

`web/src/lib/wsStore.ts` — Module-level `Map<string, callback>` per watcher type.

1. Component calls `actions.fsSubscribe(path, callback)` → sends RPC, stores callback by subscription ID
2. WebSocket `onmessage` routes notifications by method name → looks up callback by subscription ID → invokes it
3. On unmount or unsubscribe: callback removed, unsubscribe RPC sent
4. On disconnect: `clearWatchSubscriptions()` clears all callback maps; `useSubscription` hook resubscribes on reconnect

## Worktree Integration

`server/worktree/worktree.go` — Each `Worktree` instance owns its watchers:

- FSWatcher, GitWatcher, GitDiffWatcher (worktree-specific paths)
- SessionListWatcher, ChatMessagesWatcher (worktree-specific sessions)

Manager-level watchers (WorkList, WorkDetail, Settings, AgentRoleList, Worktree) are shared across all connections.

Watchers start with the worktree and stop on cleanup. Worktrees are reference-counted and idle-cleaned after 30 seconds.

## Key Files

| File | Role |
|------|------|
| `server/watch/watcher.go` | Watcher interface |
| `server/watch/base.go` | BaseWatcher, Subscription |
| `server/watch/notifier.go` | Notifier interface, Notification struct |
| `server/watch/fs.go` | FSWatcher (fsnotify) |
| `server/watch/git.go` | GitWatcher (polling) |
| `server/watch/git_diff.go` | GitDiffWatcher (polling with content) |
| `server/watch/session_list.go` | SessionListWatcher |
| `server/watch/chat_messages.go` | ChatMessagesWatcher |
| `server/watch/work_list.go` | WorkListWatcher |
| `server/watch/work_detail.go` | WorkDetailWatcher (filtered) |
| `server/ws/notifier.go` | JSONRPCNotifier (WebSocket adapter) |
| `server/worktree/worktree.go` | Watcher lifecycle ownership |
| `web/src/lib/wsStore.ts` | Frontend subscription management |
