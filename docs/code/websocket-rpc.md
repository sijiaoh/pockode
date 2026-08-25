# WebSocket JSON-RPC

Pockode's frontend-backend communication is based on the JSON-RPC 2.0 protocol over WebSocket. This document explains the design decisions and implementation mechanisms of this communication system.

## Why WebSocket

```
Mobile App ──WebSocket──▶ Relay Server ──WebSocket──▶ User PC (behind NAT)
```

Pockode needs to traverse NAT to access the development environment on the user's PC. Since hosts behind NAT cannot be directly accessed from outside, the PC must proactively establish a persistent connection to the Relay server. WebSocket natively supports full-duplex communication and server push, making it the natural choice for this scenario.

**Unified WebSocket**: Since real-time communication requires WebSocket, all communication is unified using WebSocket JSON-RPC, avoiding the need to maintain two separate protocols.

## Why JSON-RPC 2.0

1. **Simple protocol**: Only three message types: Request, Response, and Notification
2. **Mature ecosystem**: Go uses `sourcegraph/jsonrpc2`, TypeScript uses `json-rpc-2.0`
3. **Bidirectional peer-to-peer**: Unlike REST's client-server model, JSON-RPC allows bidirectional calls, enabling servers to proactively send notifications

## Namespace Design

Method names are organized using the `namespace.method` format, solving two problems:

1. **Avoid naming conflicts**: Methods from different functional modules are isolated in their respective namespaces
2. **Distinguish scope**: Clearly indicates whether a method is at the worktree level or app level

### Scope Classification

| Namespace | Scope | Handler |
|-----------|-------|---------|
| `chat.*` | worktree | `ws/rpc_chat.go` |
| `session.*` | worktree | `ws/rpc_session.go` |
| `file.*` | worktree | `ws/rpc_file.go` |
| `git.*` | worktree | `ws/rpc_git.go` |
| `fs.*` | worktree | `ws/rpc_fs.go` |
| `worktree.*` | app | `ws/rpc_worktree.go` |
| `command.*` | app | `ws/rpc_command.go` |
| `settings.*` | app | `ws/rpc_settings.go` |
| `work.*` | app | `ws/rpc_work.go` |
| `agent_role.*` | app | `ws/rpc_agent_role.go` |

- **Worktree scope**: Operations that depend on the current working directory (files, Git, etc.)
- **App scope**: Global operations across worktrees (settings, project management, etc.)

### Frontend Implementation Pattern

```typescript
// web/src/lib/rpc/git.ts
export function createGitActions(
  getClient: () => JSONRPCRequester<void> | null,
): GitActions {
  const requireClient = (): JSONRPCRequester<void> => {
    const client = getClient();
    if (!client) throw new Error("Not connected");
    return client;
  };

  return {
    getStatus: async () => requireClient().request("git.status", {}),
    stage: async (paths) => { await requireClient().request("git.add", { paths }); },
    // ...
  };
}
```

Each namespace corresponds to a `createXxxActions` factory function. These actions are combined into the unified `useWSStore`.

## Message Format

Follows standard JSON-RPC 2.0; Pockode has no custom extensions.

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "git.status",
  "params": {}
}
```

### Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "files": [...] }
}
```

### Notification (Server → Client)

```json
{
  "jsonrpc": "2.0",
  "method": "git.changed",
  "params": { "id": "g-abc123" }
}
```

> Notifications have no `id` field—this is the key difference from Requests.

## Subscription Pattern

For data that requires real-time updates, Pockode uses a subscription pattern rather than polling.

### Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Subscription Lifecycle                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Client                                Server                               │
│     │                                     │                                  │
│     │   *.subscribe { params }            │                                  │
│     │ ────────────────────────────────▶   │  Create subscription             │
│     │                                     │  Return initial state            │
│     │   Response { id, initial }          │                                  │
│     │ ◀────────────────────────────────   │                                  │
│     │                                     │                                  │
│     │                                     │  ┌──────────────────────────┐    │
│     │   *.changed { id, ... }             │  │ Watcher detects change   │    │
│     │ ◀────────────────────────────────   │  │ and sends notification   │    │
│     │                                     │  └──────────────────────────┘    │
│     │   *.changed { id, ... }             │                                  │
│     │ ◀────────────────────────────────   │  (Multiple notifications)        │
│     │                                     │                                  │
│     │   *.unsubscribe { id }              │                                  │
│     │ ────────────────────────────────▶   │  Cleanup subscription            │
│     │                                     │                                  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

1. **Subscribe**: Client calls `*.subscribe`, server returns subscription ID and initial data
2. **Notify**: Server sends `*.changed` notification when changes are detected
3. **Unsubscribe**: Client calls `*.unsubscribe` to release resources

### Method Naming Convention

| Purpose | Pattern | Example |
|---------|---------|---------|
| Subscribe | `*.subscribe` | `git.subscribe` |
| Unsubscribe | `*.unsubscribe` | `git.unsubscribe` |
| Change notification | `*.changed` | `git.changed` |

### Backend Implementation

`BaseWatcher` provides common subscription management logic:

```go
// server/watch/base.go
type Subscription struct {
    ID       string
    Notifier Notifier
}

type BaseWatcher struct {
    subscriptions map[string]*Subscription
    // ...
}

func (b *BaseWatcher) NotifyAll(method string, makeParams func(sub *Subscription) any) int {
    for _, sub := range subs {
        params := makeParams(sub)
        sub.Notifier.Notify(ctx, Notification{Method: method, Params: params})
    }
}
```

Various Watcher types (`GitWatcher`, `FSWatcher`, `ChatMessagesWatcher`, etc.) inherit from `BaseWatcher` and only need to implement detection logic:

```go
// server/watch/git.go
func (w *GitWatcher) notifySubscribers() {
    w.NotifyAll("git.changed", func(sub *Subscription) any {
        return map[string]any{"id": sub.ID}
    })
}
```

### Frontend Subscription Management

The `useSubscription` hook encapsulates the complete subscription lifecycle:

```typescript
// web/src/hooks/useSubscription.ts
export function useSubscription<TNotification, TInitial>(
  subscribe: (callback) => Promise<{ id: string; initial?: TInitial }>,
  unsubscribe: (id: string) => Promise<void>,
  onNotification: (params: TNotification) => void,
  options: SubscriptionOptions<TInitial>,
) {
  // Handles: connection state, worktree changes, race conditions, cleanup
}
```

Key design points:
- **Generation counter**: Prevents race conditions in asynchronous operations
- **Worktree switch handling**: Automatically resubscribes when worktree changes (since the server cleans up subscriptions for the old worktree)
- **Connection state**: Triggers reset on disconnect, automatically recovers on reconnect

### Reconnection Recovery

During `reconnecting` state, `useSubscription` preserves existing data while invalidating subscription IDs. When the connection is restored:

1. **Subscriptions are re-established**: Each subscription hook automatically calls its subscribe function
2. **Initial data is refreshed**: The server returns current state via `initial` in the subscribe response
3. **`onSubscribed` callback fires**: Hooks use this to update their state with fresh data

This pattern ensures:
- **No data loss**: Cached data remains visible during brief disconnections
- **Eventual consistency**: Full state is restored when connection recovers
- **No manual intervention**: Recovery is automatic and transparent

#### Subscription Types and Their Recovery

| Subscription | Returns Initial Data | Recovery Strategy |
|--------------|---------------------|-------------------|
| `session.list.subscribe` | ✅ Full list | `onSubscribed` replaces state |
| `work.list.subscribe` | ✅ Full list | `onSubscribed` replaces state |
| `work.detail.subscribe` | ✅ Full details | `onSubscribed` replaces state |
| `settings.subscribe` | ✅ Full settings | `onSubscribed` replaces state |
| `agent_role.list.subscribe` | ✅ Full list | `onSubscribed` replaces state |
| `chat.messages.subscribe` | ✅ Full history | `onSubscribed` replaces state |
| `git.diff.subscribe` | ✅ Diff data | `onSubscribed` updates state |
| `fs.subscribe` | ❌ ID only | `onSubscribed` triggers refresh |
| `git.subscribe` | ❌ ID only | `onSubscribed` triggers refresh |

For subscriptions that don't return initial data, hooks pass their refresh callback to `onSubscribed`, ensuring the latest state is fetched immediately after reconnection.

## Authentication Flow

The first request after WebSocket connection must be `auth`:

```
Client                              Server
  │                                    │
  │   ws://host/ws                     │
  ├───────────────────────────────────▶│   WebSocket handshake
  │◀───────────────────────────────────┤
  │                                    │
  │   auth { token, worktree? }        │
  ├───────────────────────────────────▶│   Validate token
  │                                    │   Bind to worktree
  │   { version, title, work_dir }     │
  │◀───────────────────────────────────┤
  │                                    │
  │   (Authenticated - can send other requests)
```

- Token uses constant-time comparison to prevent timing attacks
- Optionally specify worktree; uses main worktree if not specified
- Authentication response includes version number for detecting client/server version mismatch

For where the server's token comes from (`--auth-token` / `POCKODE_AUTH_TOKEN`) and the overall trust model, see [Authentication](authentication.md).

### Binding a Worktree vs. Disconnect

`auth` and `worktree.switch` both acquire a worktree reference (`Manager.Get`) and
then bind it to the connection, but they run on their own goroutines
(`jsonrpc2.AsyncHandler`) and can race the connection's `cleanup` when the client
disconnects mid-handler — a common case for a flaky mobile network. If the bind
completed *after* cleanup had already torn the connection down, two things went
wrong: the worktree reference was never released (its FS/git watchers, git polling,
and process manager kept running until the process exited — a slow leak that
accumulates under repeated reconnects), and subscribing on the now-nil state map
panicked and orphaned the new watcher subscription.

The fix funnels every state mutation through `rpcConnState.bindWorktree`, which
holds the connection lock while it checks a `closed` flag (set first thing by
`cleanup`), swaps `state.worktree`, and subscribes the notifier as one atomic step.
When `closed` is already set the bind is refused and the caller releases the
reference it acquired, so nothing leaks. `trackSubscription` mirrors this: after
`closed` it immediately unsubscribes rather than storing into a map that will never
be cleaned up. The no-op check (already bound to this worktree) compares worktree
*pointers*, not names, so a stale instance left over from a force-shutdown +
same-name recreate is replaced by the live one instead of being silently reused.

Code: `server/ws/rpc.go` (`bindWorktree`, `trackSubscription`, `cleanup`),
`server/ws/rpc_worktree.go` (`handleWorktreeSwitch`); regression coverage in
`server/ws/rpc_lifecycle_test.go`.

### Handlers Wait for Connection State

The same connection state races again at the opposite end of its life — setup
rather than teardown. `jsonrpc2.NewConn` starts its read loop before it returns,
while `HandleStream` only wires the state (`setConn`, which installs the notifier
and the subscriptions map) once `NewConn` has returned. A request arriving in that
window is dispatched against a half-built state.

Two things then go wrong, neither of them gracefully. `handleAuth` would call
`bindWorktree` while the notifier is still `nil`, subscribing that nil to the
worktree; `cleanup` later unsubscribes the *real* notifier, so the nil entry is
unreachable, outlives the connection, and panics the next watcher that notifies
that worktree. `trackSubscription` would write to a still-`nil` map and panic
immediately — recovered, but the recover only logs, so the client gets no reply
at all and waits out its full 30-second timeout.

`rpcConnState.ready` closes this window: `setConn` closes the channel and `Handle`
waits on it before touching anything. One gate covers the whole class of
"half-built state" bugs, which is why it is preferred over nil-checking each field
as it is added. It cannot deadlock — `setConn` follows `NewConn` with nothing in
between that can block or panic — and `Handle` runs on its own `AsyncHandler`
goroutine, so waiting there never stalls the read loop.

Over a direct WebSocket the window is narrow, since the client still has to finish
its handshake. Over a relay tunnel it is the common case: the cloud's first message
is usually already buffered in the `VirtualStream` before `HandleStream` runs, so
the read loop has work the instant it starts. See
[relay-system.md](relay-system.md#recovering-end-to-end).

Code: `server/ws/rpc.go` (`setConn`, `waitReady`); regression coverage in
`server/ws/rpc_lifecycle_test.go`
(`TestRPCMethodHandler_HandleWaitsForConnectionState`).

## Connection Management

### Connection Status

```typescript
type ConnectionStatus =
  | "connecting"   // WebSocket connecting
  | "connected"    // Authenticated and ready
  | "disconnected" // Intentionally closed (no auto-reconnect)
  | "reconnecting" // Connection lost, retrying with backoff
  | "auth_failed"  // Server rejected the token
  | "error";       // No token to connect with (needs user intervention)
```

**Key distinction**: `disconnected` indicates an intentional disconnect (user action), while `reconnecting` indicates an unexpected connection loss that triggers automatic recovery.

Besides the intentional `disconnected`, `auth_failed` and `error` are the only
states that stop retrying, so both are deliberately narrow. `error` means there is
no token to retry *with*; a connection that merely keeps failing stays in
`reconnecting` indefinitely rather than escalating to either of them.

### Auto-Reconnect

Retries run for as long as the tab is open, with exponential backoff:

```typescript
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
```

**Why unbounded rather than a fixed attempt count**: a relay tunnel can be dead for
~20s before the server's keepalive even notices, and the server then reconnects on
its own backoff. Any fixed budget of a few quick attempts expires before the tunnel
can possibly be back, so every outage ended on a dead page that only a manual
refresh cleared. Backoff keeps the cost of a long outage at two attempts a minute
while a brief blip still recovers in about a second. The full arithmetic is in
[relay-system.md](relay-system.md#recovering-end-to-end).

**Reconnection behavior**:
- Connection loss sets status to `reconnecting` (not `disconnected`)
- UI remains stable during `reconnecting` state (no page refresh or data clearing)
- Subscriptions are invalidated but data is preserved
- On successful reconnect, subscriptions are automatically re-established
- `connect()` clears any armed retry timer first, so calling it manually during
  `reconnecting` cannot leave a second socket opening a moment later
- Only the socket that is still the current one may touch the store. `close()`
  *starts* a handshake rather than finishing one, and against a dead relay that
  drags on for seconds — while `reconnectWebSocket()` opens the replacement just
  100ms after asking for the close — so a superseded socket routinely outlives
  its successor's setup. `onclose` therefore returns immediately for a socket
  that is no longer current; without that check it would strip the live
  connection of its RPC client and subscriptions and demote it to
  `reconnecting`, leaving a healthy socket that nothing can reach and that
  `disconnect()` can no longer close. `disconnect()` does its own subscription
  cleanup for the same reason, rather than relying on `onclose` to pass by later.

**A timed-out `auth` is not an auth failure.** The cloud can accept the browser's
WebSocket while the tunnel behind it is dead, so `auth` goes out and nothing
answers. The stakes are high for getting this wrong: `auth_failed` is terminal, it
makes `AppShell` log the user out, and on the worktree-retry path it also discards
their selected worktree — all for what may be a passing network fault. So the store
distinguishes by error code:
a genuine rejection always carries a real (negative) JSON-RPC code, while every way
a request can die on this side of the wire carries `DefaultErrorCode` (0) — the
client-side timeout and the rejection an in-flight request gets when its socket
closes under it (both in [Request Timeout](#request-timeout)), and a send onto a
socket that is not open, which json-rpc-2.0 catches and turns into a code-0 response
carrying the thrown message. Only a real code counts as a rejection; everything else
falls back to the normal reconnect path.

### UI During Reconnection

When the connection enters `reconnecting` state, a non-intrusive banner is displayed at the top of the screen to inform users. The rest of the UI remains functional with cached data, avoiding disruptive full-page loading states.

The exception is a reconnect with nothing on screen yet — the app was opened while
the server was unreachable. There is no previous view to preserve and no terminal
state to fall into any more, so `AppShell` treats "reconnecting and nothing
rendered" as the cue to say the server is unreachable and that retries are running,
rather than showing a loading spinner indefinitely.

### Request Timeout

All RPC requests have a default 30-second timeout:

```typescript
const RPC_TIMEOUT_MS = 30000;
```

That clock is the fallback, not the normal way a doomed request ends. A request's
answer can only arrive on the socket it left by, so `onclose` rejects everything
still pending rather than let a known-dead request sit out its remaining seconds.
`disconnect()` has to make that call itself as well — for the same reason it does
its own subscription cleanup, the `onclose` that follows it arrives for a socket
that is no longer current and returns early (see
[Auto-Reconnect](#auto-reconnect)).

**A timeout is not a failure the caller may retry blindly.** The server is likely
still working on the request, so a retry stacks a second copy of that work on top
of the first: with react-query's default budget one slow response becomes four,
each re-running the whole thing. `isRPCTimeout` exists so callers can tell "we
stopped waiting" from "this failed", and `useContents` — the one query that can
carry megabytes of file content — uses it to skip the retry. What marks a timeout
is its message, not an error code of its own: code 0 is already spoken for above,
and taking a second meaning would cost more than it buys. The message is supplied
through the timeout's own error factory rather than left to json-rpc-2.0, so what
`isRPCTimeout` matches on is not a library default that an upgrade could reword.

## Code Paths

| Component | Path |
|-----------|------|
| Server RPC handler | `server/ws/rpc.go` |
| Server method handlers | `server/ws/rpc_*.go` |
| Server WebSocket adapter | `server/ws/stream.go` |
| Server watchers | `server/watch/*.go` |
| Client store | `web/src/lib/wsStore.ts` |
| Client actions | `web/src/lib/rpc/*.ts` |
| Subscription hook | `web/src/hooks/useSubscription.ts` |

## Extension Guide

### Adding New RPC Methods

1. **Define parameter and return types**
   - Go: `server/rpc/types.go`
   - TypeScript: `web/src/types/*.ts`

2. **Implement backend handler**
   - Add handler in the corresponding `server/ws/rpc_*.go`
   - Register in the `Handle` switch in `rpc.go`

3. **Add frontend action**
   - Add method in `web/src/lib/rpc/*.ts`
   - If its result is cached with react-query and scoped to a worktree, register the query key in `WORKTREE_DEPENDENT_QUERY_KEYS` (see [frontend-state.md](frontend-state.md#server-cache-vs-store))

### Adding New Subscription Types

1. **Create Watcher**
   - Inherit from `BaseWatcher`
   - Implement detection logic and `Subscribe` method

2. **Register Watcher**
   - Initialize in `RPCHandler` or `Worktree`
   - Add subscribe/unsubscribe methods in RPC handler

3. **Add frontend callback map and subscription methods**
   - Add callback map in `wsStore.ts`
   - Handle notification in `watchNotificationHandlers`
   - Expose subscribe/unsubscribe methods

4. **Create business hook**
   - Use `useSubscription` to encapsulate subscription logic
