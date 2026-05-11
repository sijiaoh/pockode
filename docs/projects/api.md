# Project API

The Project system exposes two API layers:

- **MCP (Model Context Protocol)** — Used by AI agents (Claude) via stdio subprocess. Sensitive fields (body, role_prompt) excluded from list operations to resist prompt injection.
- **WebSocket RPC** — Used by the React client. Full CRUD with real-time subscriptions.

## MCP Tools

The MCP server runs as a stdio JSON-RPC 2.0 subprocess, spawned per Claude session via `--mcp-config`. Each process gets its own `Server` instance with access to `work.Store` and `agentrole.Store`.

**Process model**: The main Pockode binary has an `mcp` subcommand (`pockode mcp --data-dir <dir>`) that starts the stdio loop. Claude spawns it as a child process.

### Tool Reference

| Tool | Required Params | Optional Params | Returns |
|------|----------------|-----------------|---------|
| `work_list` | — | `parent_id` | JSON array of `{id, type, parent_id?, agent_role_id?, status, title}` |
| `work_get` | `id` | — | `{id, type, parent_id?, agent_role_id?, status, title, body?}` |
| `work_create` | `type`, `title`, `agent_role_id` | `parent_id`, `body` | Confirmation string with ID |
| `work_update` | `id` | `title`, `body`, `agent_role_id` | Confirmation string |
| `work_delete` | `id` | — | Confirmation string |
| `work_start` | `id` | — | Confirmation string with session ID |
| `work_needs_input` | `id`, `reason` | — | Confirmation string |
| `work_reopen` | `id` | — | Confirmation string |
| `step_done` | `id` | — | Confirmation string |
| `work_comment_add` | `work_id`, `body` | — | Confirmation string with comment ID |
| `work_comment_list` | `work_id` | — | JSON array of `{id, work_id, body, created_at}` |
| `work_comment_update` | `id`, `body` | — | Updated comment as `{id, work_id, body, created_at}` |
| `agent_role_list` | — | — | JSON array of `{id, name}` |
| `agent_role_get` | `id` | — | `{id, name, role_prompt}` |
| `agent_role_reset_defaults` | — | — | Confirmation string |

### Security: Prompt Injection Prevention

`work_list` deliberately excludes `body` from its response. Work bodies contain user-authored instructions that could include adversarial prompts. By returning only metadata (id, type, status, title), listing is safe. The agent must call `work_get` to read a specific item's body, limiting exposure to one item at a time.

Similarly, `agent_role_list` excludes `role_prompt` — use `agent_role_get` to retrieve it for a specific role.

### Behavior Notes

- **`work_create`**: Requires `agent_role_id` (validated to exist). Stories are top-level; tasks require `parent_id`.
- **`work_start`**: Requires the work item to have an `agent_role_id`. Generates a UUIDv7 session ID, transitions to `in_progress` and attaches the session ID via `Store.Start`. The main server detects this state change via fsnotify (`AutoResumer` Trigger C) and handles session creation.
- **`step_done`**: Calls `Store.StepDone()`. Tasks advance to the next configured step, or transition `in_progress → closed` when no steps remain. Stories transition `in_progress → waiting` while they have pending child work, or `in_progress → closed` when no pending children remain.
- **`work_needs_input`**: Calls `Store.MarkNeedsInput()`. Transitions `in_progress → needs_input`.
- **`work_reopen`**: Calls `Store.Reopen()`. Transitions `closed → in_progress`. Use when you need to add more child work items or continue working on a completed item.
- **`work_update`**: Uses pointer fields (`*string`) to distinguish "not provided" from "set to empty". Only updates data fields (title, body, agent_role_id).

## WebSocket RPC

All methods use JSON-RPC 2.0 over WebSocket. Work and agent_role methods are **app-level** (no worktree binding required).

### Method Reference

#### Work

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `work.create` | `WorkCreateParams` | `Work` (full object) | Create a work item |
| `work.update` | `WorkUpdateParams` | `{}` | Update data fields (pointer semantics) |
| `work.delete` | `WorkDeleteParams` | `{}` | Delete a work item (cascade-deletes children and sessions) |
| `work.start` | `WorkStartParams` | `Work` (full object) | Atomic claim + session creation |
| `work.stop` | `WorkStopParams` | `{}` | Stop a work item (in_progress/needs_input → stopped) |
| `work.reopen` | `WorkReopenParams` | `{}` | Reopen a closed work item (closed → in_progress) |
| `work.comment.list` | `WorkCommentListParams` | `{comments: Comment[]}` | List comments on a work item |
| `work.comment.update` | `WorkCommentUpdateParams` | `Comment` | Update a comment's body |
| `work.detail.subscribe` | `WorkDetailSubscribeParams` | `{id, work, comments}` | Subscribe to a single work item + comments |
| `work.detail.unsubscribe` | `{id}` | `{}` | Unsubscribe from work detail |
| `work.list.subscribe` | — | `{id, items: Work[]}` | Subscribe + get current snapshot |
| `work.list.unsubscribe` | `{id}` | `{}` | Unsubscribe |

#### Agent Role

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `agent_role.create` | `AgentRoleCreateParams` | `AgentRole` | Create a role |
| `agent_role.update` | `AgentRoleUpdateParams` | `{}` | Update fields |
| `agent_role.delete` | `AgentRoleDeleteParams` | `{}` | Delete (with referential integrity check) |
| `agent_role.reset_defaults` | — | `{}` | Delete all roles and recreate defaults |
| `agent_role.list.subscribe` | — | `{id, items: AgentRole[]}` | Subscribe + get current snapshot |
| `agent_role.list.unsubscribe` | `{id}` | `{}` | Unsubscribe |

### Wire Types

```
WorkCreateParams          { type, title, agent_role_id, parent_id?, body? }
WorkUpdateParams          { id, title?, body?, agent_role_id? }
WorkDeleteParams          { id }
WorkStartParams           { id }
WorkStopParams            { id }
WorkReopenParams          { id }
WorkCommentListParams     { work_id }
WorkCommentUpdateParams   { id, body }
WorkDetailSubscribeParams { work_id }

AgentRoleCreateParams   { name, role_prompt }
AgentRoleUpdateParams   { id, name?, role_prompt? }
AgentRoleDeleteParams   { id }
```

Defined in `server/rpc/types.go`.

### `work.start` Atomicity

`work.start` performs a two-phase operation:

1. **Claim**: Atomically transitions to `in_progress` and attaches a new UUIDv7 session ID via `Store.Start`. The store's mutex prevents concurrent claims.
2. **Session creation**: Calls `WorkStarter.HandleWorkStart()` to create the Claude session and send the kickoff (or restart) message.

If step 2 fails, the handler calls `Store.RollbackStart` — fresh starts revert to `open` (clears sessionID); restarts revert to `stopped` (preserves sessionID).

### `agent_role.delete` Referential Integrity

Before deleting an agent role, the handler scans all work items. If any work item references the role (`agent_role_id` match), the delete is rejected with an error indicating how many items reference it.

## Real-time Subscription System

Both `work.list` and `agent_role.list` support subscriptions for real-time updates.

### Pattern

```
Store (mutation)
  → OnChangeListener callback (non-blocking)
    → eventCh (buffered channel, capacity 64)
      → eventLoop goroutine
        → NotifyAll → each Subscription's Notifier
          → JSON-RPC notification to WebSocket client
```

### Subscribe/Unsubscribe Flow

1. Client calls `*.list.subscribe` → server registers a `Subscription` (with the connection's `Notifier`), then reads the current list.
2. Subscription is registered **before** the list read — this guarantees no events are missed between the read and the registration.
3. Server returns `{id, items}` — the subscription ID and the initial snapshot.
4. Client calls `*.list.unsubscribe` with the `id` to stop receiving notifications.

### Notification Format

**Incremental** (method: `work.list.changed` or `agent_role.list.changed`):

For `create` and `update`, the full object is included:
```json
{ "id": "<sub-id>", "operation": "create", "work": {...} }
```

For `delete`, only the deleted item's ID:
```json
{ "id": "<sub-id>", "operation": "delete", "workId": "<id>" }
```

For `agent_role.list.changed`, the fields are `role` / `roleId` instead of `work` / `workId`.

**Full sync** (after event drop):
```json
{ "id": "<sub-id>", "operation": "sync", "works": [...] }
```

### Backpressure Handling

The event channel has capacity 64. When it's full:

1. The event is dropped and a `dirty` flag (`atomic.Bool`) is set.
2. On the next successfully delivered event, the watcher checks `dirty.Swap(false)`.
3. If dirty was set, instead of sending the incremental change, the watcher sends a **full sync** notification with the complete current list.

This ensures clients always converge to the correct state, even under burst conditions.
