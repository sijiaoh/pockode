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

## Connection Management

### Connection Status

```typescript
type ConnectionStatus =
  | "connecting"   // WebSocket connecting
  | "connected"    // Authenticated and ready
  | "disconnected" // Intentionally closed (no auto-reconnect)
  | "reconnecting" // Connection lost, attempting to reconnect
  | "auth_failed"  // Token invalid
  | "error";       // Terminal state (no auto-reconnect)
```

**Key distinction**: `disconnected` indicates an intentional disconnect (user action), while `reconnecting` indicates an unexpected connection loss that triggers automatic recovery.

### Auto-Reconnect

Automatically retries after unexpected disconnect, up to 5 times with 3-second intervals:

```typescript
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 3000;
```

**Reconnection behavior**:
- Connection loss sets status to `reconnecting` (not `disconnected`)
- UI remains stable during `reconnecting` state (no page refresh or data clearing)
- Subscriptions are invalidated but data is preserved
- On successful reconnect, subscriptions are automatically re-established
- `auth_failed` and `error` states do not trigger reconnection and require user intervention

### UI During Reconnection

When the connection enters `reconnecting` state, a non-intrusive banner is displayed at the top of the screen to inform users. The rest of the UI remains functional with cached data, avoiding disruptive full-page loading states.

### Request Timeout

All RPC requests have a default 30-second timeout:

```typescript
const RPC_TIMEOUT_MS = 30000;
```

## Code Paths

| Component | Path |
|-----------|------|
| Server RPC handler | `server/ws/rpc.go` |
| Server method handlers | `server/ws/rpc_*.go` |
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
