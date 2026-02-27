# Frontend Integration

How the Project system is integrated into the React frontend: state management, real-time sync, and UI.

## State Management

### Zustand Stores

Two Zustand stores hold entity state:

| Store | State | File |
|---|---|---|
| `useWorkStore` | `works: Work[]`, `isLoading`, `error` | `web/src/lib/workStore.ts` |
| `useAgentRoleStore` | `roles: AgentRole[]`, `isLoading`, `error` | `web/src/lib/agentRoleStore.ts` |

Both stores expose the same action pattern:

- `set[Items]` — Replace entire list (used for initial load and sync)
- `update[Items]` — Apply a transform function to the list (used for incremental updates)
- `setError` — Set error state
- `reset` — Reset to initial loading state

### RPC Action Creators

Mutation operations are defined as RPC action creators, injected into `wsStore.actions`:

**Work** (`web/src/lib/rpc/work.ts`):
`createWork`, `updateWork`, `deleteWork`, `startWork`, `stopWork`

**AgentRole** (`web/src/lib/rpc/agentRole.ts`):
`createAgentRole`, `updateAgentRole`, `deleteAgentRole`, `resetAgentRoleDefaults`

Each creator takes a `getClient` thunk that returns the JSON-RPC requester. The creator calls `requireClient()` to throw if not connected, then delegates to `client.request()`.

### Subscription Wiring in wsStore

`wsStore` (`web/src/lib/wsStore.ts`) owns the WebSocket connection and exposes subscribe/unsubscribe methods:

- `workListSubscribe` / `workListUnsubscribe` — `work.list.*` RPCs, callbacks in `workListWatchCallbacks` map
- `workDetailSubscribe` / `workDetailUnsubscribe` — `work.detail.*` RPCs, callbacks in `workDetailWatchCallbacks` map
- `agentRoleListSubscribe` / `agentRoleListUnsubscribe` — `agent_role.list.*` RPCs, callbacks in `agentRoleListWatchCallbacks` map

Incoming notifications are routed by method name in `handleNotification()`:

- `work.list.changed` → dispatches to the callback registered for that subscription ID
- `work.detail.changed` → same pattern
- `agent_role.list.changed` → same pattern

On WebSocket close, `clearWatchSubscriptions()` clears all callback maps (including Work and AgentRole). When the connection is re-established, `useSubscription` detects the `connected` status change and resubscribes automatically.

Work and AgentRole subscriptions set `resubscribeOnWorktreeChange: false`. Their callback maps are cleared by `clearWatchSubscriptions()` on worktree switch, but since the server preserves these subscriptions across switches, the hooks resubscribe only on reconnect.

## Real-Time Sync

### useSubscription Hook

Both subscription hooks use the generic `useSubscription` hook (`web/src/hooks/useSubscription.ts`), which manages the full lifecycle:

1. **Subscribe** — On mount (when `enabled && connected`), calls the subscribe function, stores the subscription ID, and invokes `onSubscribed` with initial data
2. **Receive notifications** — Routes incremental changes through the notification callback
3. **Unsubscribe** — On unmount, disable, or disconnect, unsubscribes and calls `onReset`
4. **Race condition handling** — Uses a generation counter to discard stale responses
5. **Worktree change** — If `resubscribeOnWorktreeChange` is true, invalidates and resubscribes on worktree switch

### Notification Handling

Both `useWorkSubscription` and `useAgentRoleSubscription` follow the same update pattern:

| Operation | Behavior |
|---|---|
| `sync` | Replace entire store (full snapshot from server) |
| `create` | Append to list; deduplicate if item already exists (race between subscribe and initial fetch) |
| `update` | Replace item by ID |
| `delete` | Remove item by ID |

## UI Structure

### Navigation Flow

```
ProjectTab
  ├── "Stories"         → WorkListOverlay
  │                         └── (tap task) → WorkDetailOverlay
  │                                            └── (tap task) → WorkDetailOverlay
  │                                            └── "Open Chat" → Chat session
  └── "Agent Roles"     → AgentRoleListOverlay
                             └── (tap role) → AgentRoleDetailOverlay
```

`ProjectTab` is the sidebar entry point. It renders two buttons that open their respective overlay screens via callbacks (`onOpenWorkList`, `onOpenAgentRoleList`).

### WorkListOverlay

Activates both `useWorkSubscription` and `useAgentRoleSubscription`.

**Display logic:**

1. Stories are extracted from `works` (items with `type === "story"`)
2. Stories are grouped by status in this order: **in_progress → needs_input → stopped → open → done → closed**
3. Each group is a collapsible section (`StatusGroup`); `closed` group is collapsed by default
4. Each group header shows: collapse toggle, status icon, status label, count badge
5. Each story row shows: status icon, title, task progress (`doneTasks/totalTasks tasks`)
6. A "New Story" button at the top opens an inline creation form (title + role selector)

**Task progress:** Tasks are indexed by `parent_id` into a `Map<string, Work[]>`. For each story, done count is tasks with status `done` or `closed`.

### WorkDetailOverlay

Shows the detail view for a single work item (story or task). Sections:

- **Parent link** — If the item is a task, shows a tappable link to the parent story
- **Title** — Inline-editable (tap pencil icon to enter edit mode)
- **Status** — Read-only badge
- **Role** — Inline-editable select (tap to switch role)
- **Description** — Inline-editable textarea with Markdown rendering
- **Tasks** (story only) — List of child tasks with status icons, "Chat" shortcut, and inline task creation
- **Comments** — Loaded via `work.detail.subscribe` (real-time)
- **Delete** — Confirmation dialog; hidden for `closed` items

**Bottom action bar:**
- `status === "open"` or `"stopped"` → **Start/Restart** button (calls `startWork` RPC)
- `status === "in_progress"` or `"needs_input"` → **Stop** button (calls `stopWork` RPC)
- `session_id` exists → **Open Chat** button (navigates to chat session)

### AgentRoleListOverlay

Activates `useAgentRoleSubscription`. Lists all roles with a delete button per row. Bottom area has an inline "Add Role" form (name only; `role_prompt` is set to empty string).

### AgentRoleDetailOverlay

Shows detail for a single agent role:
- **Name** — Inline-editable
- **Role Prompt** — Inline-editable textarea with Markdown rendering
- **Delete** — Confirmation dialog
