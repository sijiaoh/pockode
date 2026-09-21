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

`Stop()` is synchronous: it returns only once the loops the watcher started via `Go` have exited (see [code/subscription-system.md](code/subscription-system.md#why-stop-waits-instead-of-just-cancelling)).

### BaseWatcher

Shared subscription management: a thread-safe subscription map keyed by the id the client chose (`AddSubscription` refuses an id already in use rather than displacing it), and goroutine lifecycle — `Go` starts a tracked loop, `CancelAndWait` cancels the context and waits for those loops. Most watchers embed this.

The server generates no subscription ids. Why the client names its own subscription — and what that buys during the window while one is being opened — is in [code/subscription-system.md](code/subscription-system.md#why-nothing-is-lost-while-a-subscription-is-being-opened).

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
| Event-driven | SessionList, SessionDetail, ChatMessages, WorkList, WorkDetail, Settings, AgentRoleList | Store `OnChangeListener` callbacks via async channels |

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
| SessionListWatcher | `watch/session_list.go` | `session.OnChangeListener`, plus work changes routed by the worktree manager | `session.list.changed` |
| SessionDetailWatcher | `watch/session_detail.go` | `session.OnChangeListener`, plus work changes routed by the worktree manager | `session.detail.changed` |
| ChatMessagesWatcher | `watch/chat_messages.go` | `process.ChatMessageListener` | `chat.<event-type>` |
| WorkListWatcher | `watch/work_list.go` | `work.OnChangeListener` + every worktree's `session.OnChangeListener` | `work.list.changed` |
| WorkDetailWatcher | `watch/work_detail.go` | `work.OnChangeListener` + `work.OnCommentChangeListener` + every worktree's `session.OnChangeListener` | `work.detail.changed` |
| SettingsWatcher | `watch/settings.go` | `settings.OnChangeListener` | `settings.changed` |
| AgentRoleListWatcher | `watch/agent_role_list.go` | `agentrole.OnChangeListener` | `agent_role.list.changed` |

**Backpressure:** Event channels have fixed capacity (16–256). When full, events are dropped and a `dirty` flag is set. The next delivered event triggers a full sync instead of an incremental update, ensuring clients converge to correct state.

**Filtered watchers:** WorkDetailWatcher and SessionDetailWatcher each notify only the subscribers watching the affected id, not all subscribers. Both key their subscriptions on `Subscription.Key` and deliver through `BaseWatcher.NotifyForKey`.

**A filter can also narrow a list.** `session.list.subscribe` takes `exclude_work_sessions`, which drops every session belonging to a work item — from the snapshot it returns and from every notification afterwards. It is kept on the subscription (`Subscription.Filter`) rather than beside the watcher, so it cannot outlive or go missing before the subscription it belongs to, and two subscribers of the same list can disagree about what belongs in it: the same change goes out to one as a row and to the other as a removal — once, and then as nothing at all, since the rows that follow cannot put back a row already retracted. Absent means "send everything", which is what this list always was. Why the server does this and not the client is in [code/subscription-system.md](code/subscription-system.md#which-sessions-belong-to-work).

**Two watchers also answer questions, not just push.** The session list, and the closed half of the work list, are too long to send whole. So `SessionListWatcher.Page` and `WorkListWatcher.Archive` each serve one page to the single subscriber that asked for it, and `WorkListWatcher.Earlier` serves the rows a cap held back. All three are reached by the subscription's id rather than by repeating its parameters, which is what keeps a page and the snapshot it extends from being pages of two different lists — and makes a subscription the server has dropped a refusal rather than a plausible wrong answer. Two rules they share: the session list's page is cut only *after* its filter has narrowed the list, and none of the three records its read as something that was broadcast, or it would suppress the push that would have told everyone else. The cursor, the two lists' opposite live-update rules and what the server only approximates are in [code/subscription-system.md](code/subscription-system.md#paging-and-pushing-on-one-list).

**Two watchers listen past their own store.** A work detail carries the token usage of the work item's whole subtree, and both the detail and every *row* carry the work's derived `activity` — usage changes when a session spends tokens, activity changes when its turn moves, and neither is an event the work store ever sees. So both watchers are registered, through the worktree manager, as change listeners on every worktree's session store: the detail re-sends the affected work item and every ancestor of it (usage is a subtree total), the list re-sends the one row whose work owns that session. Because a session is touched several times a turn without moving either value, both paths re-send only when what they would put on the wire actually differs from what was last sent. The general rules are in [code/subscription-system.md](code/subscription-system.md#why-a-watcher-sometimes-listens-to-a-second-store); what is aggregated is in [code/work-system.md](code/work-system.md#usage-aggregation), and where the activity comes from is [code/work-system.md](code/work-system.md#activity).

**And two listen the other way.** A session names the work item it runs (`work_id`) — on its list row and on its detail — and that relation moves without anything about the session moving: a work claims a session, or stops existing. So `SessionListWatcher` and `SessionDetailWatcher` both hear work changes, routed to them by the worktree manager rather than registered on the work store itself: that store is global and keeps its listeners for the life of the process, while worktrees are built and dropped as clients come and go, and a watcher registered there would outlive its worktree and hold it alive. The manager is already the one thing that knows which worktrees exist, and it skips the unloaded ones — nobody is subscribed to a worktree nobody has open. A work event that names *no* session names nothing to re-resolve and is dropped: a work losing its session comes with that session being deleted, and the session's own event is what says so.

**A session is split across two of them.** `SessionListWatcher` pushes rows — `rpc.SessionListItem` carries id, title, `work_id`, `updated_at`, `turn`, `unanswered_questions`, `unread`, `forked_from`, and nothing else. `unanswered_questions` is `len(turn.unanswered)` written out at the one place a row is built, so it cannot drift from the list it counts: a row only ever draws the number, and every surface that does should read one field rather than measure an array it otherwise ignores. `SessionDetailWatcher` pushes one session's `rpc.SessionDetail` — the whole of `session.SessionMeta`, which is where the settings (mode, agent type, model, effort, activated) and its token usage live, plus `work_id` — to whoever has it open. The `turn` is on both, and cannot disagree: both read it straight off the stored session, so the row and the detail are two narrowings of one record rather than two accounts of it. `work_id` is on both and cannot disagree either, for a different reason: it is stored on neither, and each side resolves it from `work.Work.SessionID`, which is the relation itself. Nothing on a row is volatile process state any more — the list used to carry a process state and a `needs_input` flag, and those were two lossy views of this one value arriving on their own schedule. A session removed from the store is reported as `deleted: true` rather than silently going quiet. Why the line falls there — and why `forked_from` on both sides is not a second source of truth — is in [code/subscription-system.md](code/subscription-system.md#why-a-session-is-two-subscriptions).

## Subscription Lifecycle

### Backend

1. Client sends subscribe RPC (e.g. `fs.subscribe`) carrying the subscription id it chose. The id is required; a request without one is rejected as invalid params
2. Server creates `JSONRPCNotifier` from the connection
3. Watcher's `Subscribe()` registers the subscription under that id, then reads the initial data. The reply carries the data only — never an id, since the client already has it
4. Subscription tracked in `rpcState` for cleanup on disconnect, keyed by **watcher + id** (an id is unique only within its watcher)
5. Watcher sends notifications via the notifier when changes occur
6. Client sends unsubscribe RPC — watcher removes subscription
7. On disconnect: all tracked subscriptions auto-unsubscribed

### Frontend

`web/src/lib/wsStore.ts` — Module-level `Map<string, callback>` per watcher type.

1. Component calls `actions.fsSubscribe(path, callback)` → `openSubscription` generates the subscription id, stores the callback under it, *then* sends the RPC. Registering first is what makes a change landing mid-subscribe deliverable
2. WebSocket `onmessage` routes notifications by method name → looks up callback by subscription ID → invokes it
3. On unmount or unsubscribe: callback removed, unsubscribe RPC sent
4. On worktree switch: `clearWorktreeWatchSubscriptions()` clears only the worktree-scoped maps (fs, git, git-diff, session list, session detail, chat). App-level maps (work list/detail, agent role list, settings, worktree) are kept, mirroring the Manager-level watchers the server preserves across switches (see Worktree Integration below)
5. On disconnect: `clearAllWatchSubscriptions()` clears all callback maps; `useSubscription` hook resubscribes on reconnect

## Worktree Integration

`server/worktree/worktree.go` — Each `Worktree` instance owns its watchers:

- FSWatcher, GitWatcher, GitDiffWatcher (worktree-specific paths)
- SessionListWatcher, SessionDetailWatcher, ChatMessagesWatcher (worktree-specific sessions)

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
| `server/watch/session_detail.go` | SessionDetailWatcher (filtered) |
| `server/watch/chat_messages.go` | ChatMessagesWatcher |
| `server/watch/work_list.go` | WorkListWatcher |
| `server/watch/work_detail.go` | WorkDetailWatcher (filtered) |
| `server/ws/notifier.go` | JSONRPCNotifier (WebSocket adapter) |
| `server/worktree/worktree.go` | Watcher lifecycle ownership |
| `web/src/lib/wsStore.ts` | Frontend subscription management |
