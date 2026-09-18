# Project API

The Project system exposes two API layers:

- **MCP (Model Context Protocol)** — Used by AI agents (Claude) via stdio subprocess. Sensitive fields (body, role_prompt) excluded from list operations to resist prompt injection.
- **WebSocket RPC** — Used by the React client. Full CRUD with real-time subscriptions.

## MCP Tools

The MCP server runs as a stdio JSON-RPC 2.0 subprocess, spawned per Claude session via `--mcp-config`. The subprocess is a **thin proxy**: it owns no state and forwards every tool call over HTTP to the running main server, which executes it in-process against the shared `work.Store` and `agentrole.Store` (the same stores the WebSocket layer uses). See [work-system](../code/work-system.md#mcp-server-architecture) for why.

**Process model**: The main Pockode binary has an `mcp` subcommand (`pockode mcp --data-dir <dir>`) that starts the stdio loop. Claude spawns it as a child process. `<dir>` is always the **main** data dir — the only place `server.json` is written — even when the session runs in a named worktree, so every agent reaches the same single server and its shared `work.Store` (see [work-system](../code/work-system.md#mcp-server-architecture)).

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
| `work_wait` | `id` | `reason` | Confirmation string |
| `work_reopen` | `id` | — | Confirmation string |
| `step_done` | `id` | — | Confirmation string |
| `work_comment_add` | `work_id`, `body` | — | Confirmation string with comment ID |
| `work_comment_list` | `work_id` | — | JSON array of `{id, work_id, body, created_at}` |
| `work_comment_update` | `id`, `body` | — | Updated comment as `{id, work_id, body, created_at}` |
| `agent_role_list` | — | — | JSON array of `{id, name}` |
| `agent_role_get` | `id` | — | `{id, name, role_prompt}` |
| `agent_role_reset_defaults` | — | — | Confirmation string |

### Security: Prompt Injection Prevention

`work_list` deliberately excludes `body` from its response. Work bodies contain user-authored instructions that could include adversarial prompts, so a listing that carried them would let every unrelated item in the project speak into the agent's context on a call it made to find one item. The summary it returns instead (shape in the table above) is metadata only, so listing is safe; reading a body has to be the deliberate act of naming that item, which is what `work_get` is. The narrowing lives in one place — `workSummary` / `newWorkSummary` in `server/mcp/executor.go`, which `work_get`'s reply also builds on, so the detail is the summary plus `body` by construction. (It is named apart from the WebSocket layer's `WorkListItem` below on purpose: that one is the web list's row and carries fields only the UI needs.)

Similarly, `agent_role_list` excludes `role_prompt` — use `agent_role_get` to retrieve it for a specific role.

### Behavior Notes

- **`work_create`**: Requires `agent_role_id` (validated to exist). Stories are top-level; tasks require `parent_id`.
- **`work_start`**: Requires the work item to have an `agent_role_id`. Atomically transitions to `active` and attaches a session ID via `Store.Claim` (a fresh UUIDv7, or the existing session on restart), then creates the session and sends the kickoff via `WorkStartHandler` (in-process).
- **`step_done`**: Calls `Store.StepDone()`. Work items advance to the next configured step, or close when no steps remain. Use `work_wait`, not `step_done`, to pause while child work is still open.
- **`work_needs_input`**: Calls `Operations.NeedsInput()`. The work stays `active` and records that it is waiting on the user, with the agent's `reason` shown verbatim on the detail page.
- **`work_wait`**: Calls `Operations.Wait()`. The same wait, cleared by a child closing instead of by a person; its optional `reason` is shown the same way. Unlike `work_needs_input` it can be **refused**: a child closing is the only thing that ends this wait, so a work with no child running would wait forever, and the error names which children could be started instead ([workflow-engine](workflow-engine.md#wait)).
- **`work_reopen`**: Calls `Operations.ReopenWork()`. Transitions `closed → active`. Use when you need to add more child work items or continue working on a completed item.
- **Accepted statuses**: `step_done` / `work_wait` / `work_needs_input` only require that the work is started and not closed, so a stale `stopped` never blocks the agent. Two of them have a second condition that is about the work's *children* rather than its status: `step_done` is refused when it would close a work whose subtasks are still running, and `work_wait` when none of them is. `work_start` is the one with a different rule: it also accepts `open`, but rejects a work that is already `active` — including one that is waiting, for which the user is offered Stop rather than Restart. See [workflow-engine](workflow-engine.md#status-transitions).
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
| `work.stop` | `WorkStopParams` | `{}` | Stop a work item (any started, unclosed work → stopped) |
| `work.reopen` | `WorkReopenParams` | `{}` | Reopen a closed work item (closed → active) |
| `work.comment.list` | `WorkCommentListParams` | `{comments: Comment[]}` | List comments on a work item |
| `work.comment.update` | `WorkCommentUpdateParams` | `Comment` | Update a comment's body |
| `work.detail.subscribe` | `WorkDetailSubscribeParams` | `{work, comments, usage, activity, children, parent?}` | Subscribe to a single work item + comments + the token usage of its subtree ([why usage is here and not on `Work`](../code/work-system.md#usage-aggregation)) and the two relations its page draws ([why they are not read off the list](../code/work-system.md#the-list-holds-rows-the-detail-page-holds-the-item)) |
| `work.detail.unsubscribe` | `{id}` | `{}` | Unsubscribe from work detail |
| `work.list.subscribe` | `SubscribeParams` | `{items: WorkListItem[], not_running_hidden?}` | Subscribe + get the **`Current` segment**, which holds no closed work ([what a row carries](#work-list-rows-vs-work-detail), [why it is a segment](#the-list-is-two-segments)) |
| `work.list.archive` | `WorkListArchiveParams` | `{items: WorkListItem[], next_cursor?, has_more?}` | One page of closed work, served against an open list subscription |
| `work.list.earlier` | `{id}` | `{items: WorkListItem[]}` | The `Current` segment again with the *Not running* cap lifted |
| `work.list.unsubscribe` | `{id}` | `{}` | Unsubscribe |

#### Agent Role

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `agent_role.create` | `AgentRoleCreateParams` | `AgentRole` | Create a role |
| `agent_role.update` | `AgentRoleUpdateParams` | `{}` | Update fields |
| `agent_role.delete` | `AgentRoleDeleteParams` | `{}` | Delete (with referential integrity check) |
| `agent_role.reset_defaults` | — | `{}` | Delete all roles and recreate defaults |
| `agent_role.list.subscribe` | `SubscribeParams` | `{items: AgentRole[]}` | Subscribe + get current snapshot |
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
WorkDetailSubscribeParams { id, work_id }
WorkListArchiveParams     { id, cursor?, limit? }   // id names the subscription, not a fresh query
WorkListItem              { id, type, parent_id?, agent_role_id?, title, status, activity, wait?, session_id?, worktree?, updated_at }

SubscribeParams           { id }   // the whole of a subscribe with no other arguments

AgentRoleCreateParams   { name, role_prompt, steps? }
AgentRoleUpdateParams   { id, name?, role_prompt?, steps?, agent_type?, model?, effort? }
AgentRoleDeleteParams   { id }
```

Defined in `server/rpc/types.go`.

### The List Is Two Segments

`work.list.subscribe` does not answer with every work item. It answers with the
`Current` segment — the rows that screen draws plus everything those rows make
claims about — and never with closed work, which is fetched a page at a time
through `work.list.archive`. `not_running_hidden` says how many rows of the one
unbounded group the server held back, so the group's heading can still show the
whole group's count rather than the number of rows that arrived.

Both paging methods take the **subscription's** id rather than repeating a
query, and both refuse an unknown id, a malformed cursor and a negative limit as
`InvalidParams` — which a client answers by subscribing afresh, not by offering
a Retry. The design is [list-paging-ui.md](../list-paging-ui.md); the mechanics
are [code/subscription-system.md](../code/subscription-system.md#paging-and-pushing-on-one-list).

### Work List Rows vs Work Detail

`work.list.subscribe` carries `WorkListItem`, not the whole `Work`. Every
subscriber holds the whole project's list, and a change to any one work item
pushes that item's row to all of them, so a row carries only what drawing a row
needs:

| Field | Why the list needs it |
|-------|----------------------|
| `id` | identity |
| `type` | story rows group task rows beneath them |
| `parent_id` | builds that tree; also walks a work up to its root |
| `agent_role_id` | the role name shown on the row |
| `title`, `status` | the row itself |
| `activity` | the row's glyph, and which group it is in — the one thing a row draws that a client cannot compute, since the list spans worktrees and a client holds turn state only for the one it has open ([lifecycle-ui](../lifecycle-ui.md) §1.3). It is also what the Project tab's attention dot is read off, and what the server's own `Current` cut consults so that a row needing a person is never held back |
| `wait` | what an active work is waiting for; the agent's stated reason belongs to the detail, where there is room to show it |
| `session_id` | the row's **Chat** shortcut |
| `worktree` | the row's worktree badge (the list spans every worktree) |
| `updated_at` | orders the closed group |

`body`, `current_step` and `created_at` are **detail-only**: no row renders them,
and `body` is unbounded user-authored prose — editing one work item's body would
otherwise push the whole of it to every subscriber, including the clients looking
at a different work item. A client that needs them subscribes to `work.detail`,
which carries the full `Work`.

The narrowing lives in one place, `rpc.NewWorkListItem`, so that what a row
carries is decided once rather than at each producer. `rpc.NewSessionListItem`
does the same for the session list, for the same reason.

Nothing on the session side reads this list to find out which of its sessions
belong to work. Both of a session's subscriptions carry the relation themselves,
derived from `Work.SessionID` and stored on neither side:

| Where | Field | Why it is there |
|-------|-------|-----------------|
| `SessionListItem` | `work_id` | the row's link to the work page, and what `exclude_work_sessions` drops rows by |
| `SessionDetail` (`session.detail.subscribe`) | `work_id` | the open session's own link — the filter above hides exactly the sessions that have one, so the open session often has no row to read it off |

Why the relation is resolved on this side rather than inverted out of the work
list by the client is in
[code/subscription-system.md](../code/subscription-system.md#which-sessions-belong-to-work).

### `work.start` Atomicity

`work.start` performs a two-phase operation:

1. **Claim**: `Store.Claim` atomically transitions to `active` and attaches a session ID under the store mutex — a fresh UUIDv7 for a fresh start, or the existing session ID on restart (any work that already owns a session, so the chat history survives). Deciding restart and session under the lock prevents concurrent claims from racing.
2. **Session creation**: Calls `WorkStarter.HandleWorkStart()` to create the Claude session and send the kickoff (or restart) message.

If step 2 fails, `Operations.StartWork` calls `Store.RollbackStart` with the sessionID it claimed — fresh starts revert to `open` (clears sessionID); restarts revert to `stopped` (preserves sessionID).

### `agent_role.update` Engine Fields

`agent_type`, `model` and `effort` follow the same "absent = unchanged" rule as
the other optional fields, with two additions:

- **Send `agent_type` alone when switching agents.** The server clears `model`
  and `effort` as part of that write; sending the trio would race its own reset.
- **An unavailable combination is rejected**, not silently reset. The error
  comes back as JSON-RPC `InvalidParams` and its message is the store's own,
  naming the offending id and the agent it was judged against — `invalid agent
  role: model "gpt-5.6-sol" is not available for agent "claude"` — so it can be
  shown to the user as-is. See
  [Engine Fields](data-model.md#engine-fields) for why a role is stricter than a
  session here.

`agent_role.create` takes no engine fields: a new role follows the global
defaults — agent type, and the model and effort set for it — which is the right
starting point.

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

1. Client generates the subscription `id`, registers its local callback under it, then calls `*.list.subscribe` with that id.
2. Server registers a `Subscription` under the client's id (with the connection's `Notifier`), then reads the current list. Registration comes **before** the list read, so no event between the two is missed — and because the id was the client's to begin with, such an event is routed to a callback that already exists ([why](../code/subscription-system.md#why-nothing-is-lost-while-a-subscription-is-being-opened)).
3. Server returns `{items}` — the initial snapshot alone; the reply carries no id.
4. Client calls `*.list.unsubscribe` with the same `id` to stop receiving notifications.

### Notification Format

**Incremental** (method: `work.list.changed` or `agent_role.list.changed`):

For `create` and `update`, the item is included — a `WorkListItem` row for
`work.list.changed`, the full object for `agent_role.list.changed`:
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
