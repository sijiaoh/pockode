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
| `story_list` | — | — | JSON array of `{id, type, story_id?, agent_role_id?, status, title}` |
| `task_list` | `story_id` | — | same array, for that story's tasks |
| `work_get` | `id` | — | `{id, type, story_id?, agent_role_id?, status, title, body?, pending_questions?}` |
| `story_create` | `title`, `agent_role_id` | `body` | Confirmation string with ID |
| `task_create` | `story_id`, `title`, `agent_role_id` | `body` | Confirmation string with ID |
| `work_update` | `id` | `title`, `body`, `agent_role_id` | Confirmation string |
| `work_delete` | `id` | — | Confirmation string |
| `story_start` | `id` | `worktree`, `watch` | Confirmation string with session ID |
| `task_start` | `id` | — | Confirmation string with session ID |
| `story_wait` | `id` | — | Confirmation string |
| `work_reopen` | `id` | — | Confirmation string |
| `step_done` | `id` | — | Confirmation string |
| `work_comment_add` | `work_id`, `body` | — | Confirmation string with comment ID |
| `work_comment_list` | `work_id` | — | JSON array of `{id, work_id, body, created_at}` |
| `work_comment_update` | `id`, `body` | — | Updated comment as `{id, work_id, body, created_at}` |
| `agent_role_list` | — | — | JSON array of `{id, name}` |
| `agent_role_get` | `id` | — | `{id, name, role_prompt}` |
| `agent_role_reset_defaults` | — | — | Confirmation string |
| `question_post` | `question`, `header` | `options`, `multi_select` | Confirmation string with the `request_id` |
| `question_answer` | `request_id` | `answers`, `text`, `session_id` | Confirmation string |
| `question_cancel` | `request_id` | — | Confirmation string |

### Security: Prompt Injection Prevention

`story_list` and `task_list` deliberately exclude `body` from their response. Work bodies contain user-authored instructions that could include adversarial prompts, so a listing that carried them would let every unrelated item in the project speak into the agent's context on a call it made to find one item. The summary it returns instead (shape in the table above) is metadata only, so listing is safe; reading a body has to be the deliberate act of naming that item, which is what `work_get` is. The narrowing lives in one place — `workSummary` / `newWorkSummary` in `server/mcp/executor.go`, which `work_get`'s reply also builds on, so the detail is the summary plus `body` by construction. (It is named apart from the WebSocket layer's `WorkListItem` below on purpose: that one is the web list's row and carries fields only the UI needs.)

Similarly, `agent_role_list` excludes `role_prompt` — use `agent_role_get` to retrieve it for a specific role.

### Behavior Notes

- **`story_create` / `task_create`**: Both require `agent_role_id` (validated to exist). Which kind is created is decided by the tool the agent picked, not by an argument: `task_create` takes the `story_id`, `story_create` has nowhere to put one. There is no `type` to contradict it.
- **`story_list` / `task_list`**: The two listings partition the project. `task_list` requires its `story_id`: an empty one is what a story's own `story_id` is, so a listing that fell through would answer "which tasks?" with every story there is.
- **`story_start` / `task_start`**: Require the work item to have an `agent_role_id`. Atomically transitions to `active` and attaches a session ID via `Store.Claim` (a fresh UUIDv7, or the existing session on restart), then creates the session and sends the kickoff via `WorkStartHandler` (in-process). The optional `worktree` names the git worktree to run in, and is settled *before* that transition so the session starts in it: the name is pinned via `Store.SetWorktree`, then `Registry.EnsureWorktree` creates the worktree (branch = name) if it does not exist yet, through the same path the `worktree.create` RPC uses — setup hook included, and a skipped hook is reported in the confirmation string. Only `story_start` takes it, and it is still refused on a task named to it — an id is a string, and the agent can reach for the wrong tool — because a task runs in the worktree of the story it belongs to. `task_start` refuses the argument rather than ignoring it: what is not on a schema is answered with a sentence, not discarded in silence. Naming a *different* worktree for an already-started story fails the call too, rather than starting it where it already lives ([work-system](../code/work-system.md#worktree-binding)).
- **`story_start`'s `watch`**: A flag, not a session id — it makes the **calling session** the story's watcher, recorded by `Store.Claim` in the same write as the start, and refused (without starting the story) on a call with no caller session. The watcher is sent a message when the story closes, is stopped, or posts a question of its own; its tasks' news is not reported. The watch ends when the story closes (the closing write clears it), so a reopened story is unwatched until a later watched start. Omitting it leaves any existing watcher in place ([work-system](../code/work-system.md#a-storys-watcher)).
- **`step_done`**: Calls `Operations.StepDone()`. Work items advance to the next configured step, or close when no steps remain. Use `story_wait`, not `step_done`, to pause while child work is still open. An advance **withdraws the questions posted during the step** (reason `step_done`): the agent has moved past what it was asking about. The step that closes the work does not — closing retires the session, which withdraws them with reason `work_closed`.
- **`story_wait`**: Calls `Operations.Wait()`. A story's wait on its subtasks, cleared by one of them closing. It can be **refused**: a child closing is the only thing that ends this wait, so a work with no child running would wait forever, and the error names which children could be started instead ([workflow-engine](workflow-engine.md#wait)). A task's id is refused too, with only the ways out a task has — never `task_create`, which would be a third level.
- **`work_reopen`**: Calls `Operations.ReopenWork()`. Transitions `closed → active`, for a story or a task alike. Use when there is more to do on something that was finished — on a story, that includes giving it further tasks.
- **Accepted statuses**: `step_done` / `story_wait` only require that the work is started and not closed, so a stale `stopped` never blocks the agent. Both have a second condition that is about the work's *children* rather than its status: `step_done` is refused when it would close a work whose subtasks are still running, and `story_wait` when none of them is. `story_start` / `task_start` are the ones with a different rule: they also accept `open`, but reject a work that is already `active` — including one that is waiting, for which the user is offered Stop rather than Restart. See [workflow-engine](workflow-engine.md#status-transitions).
- **`work_update`**: Uses pointer fields (`*string`) to distinguish "not provided" from "set to empty". Only updates data fields (title, body, agent_role_id).
- **`question_answer`**: Answers a question **another** session posted, for the case where the answer is already known and the user need not be interrupted — a story answering its subtask ([work-system](../code/work-system.md#input-4-a-subtasks-question-reaches-its-story)). Any agent may answer any question except one its own session posted, which is a withdrawal (`question_cancel`) wearing the wrong name. The answer is recorded with who gave it and arrives in the asking session as a message that says so, so nothing there mistakes it for the user's. A question is named by the pair `(session_id, request_id)`, and `session_id` may be left out only while exactly one session is waiting on that id: refused when more than one is — a fork carries a question across with its id — and the refusal lists the candidates with the work running in each, since the work is the half an agent recognises. A `stopped` work is answered like any other and is woken by the answer, as it is by the user's ([work-system](../code/work-system.md#input-3-a-posted-question-was-answered)). It returns only once the answer has reached the asking agent, which may mean starting that agent's process first.

- **`question_post` / `question_cancel`**: The two tools that act on the **session the call came from** rather than on an id the model supplies, which is what the MCP caller identity is for ([agent-integration](../code/agent-integration.md#mcp-caller-identity)); a call that arrived without one is refused, because an agent started by hand has no chat to ask into. `question_post` returns immediately — the answer arrives later as an ordinary message — and posts exactly one question per call, so that declining one of several has a subject. It is refused on a **closed** work: nobody is coming back to that chat. `question_cancel` withdraws a question the same session posted, sends nothing to anyone, and is refused for a question that is already answered, declined or withdrawn — with what became of it in the error. There is deliberately **no tool that lists questions**: a list would only invite polling inside the turn the agent was told not to wait in. See [agent-integration](../code/agent-integration.md#posted-questions).

## WebSocket RPC

All methods use JSON-RPC 2.0 over WebSocket. Work and agent_role methods are **app-level** (no worktree binding required).

### Method Reference

#### Work

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `work.create` | `WorkCreateParams` | `WorkDetailItem` | Create a work item. `story_id` alone says which kind: a request cannot state a type that contradicts the story it named, because there is no type to state |
| `work.update` | `WorkUpdateParams` | `{}` | Update data fields (pointer semantics) |
| `work.delete` | `WorkDeleteParams` | `{}` | Delete a work item (cascade-deletes children and sessions) |
| `work.start` | `WorkStartParams` | `WorkDetailItem` | Atomic claim + session creation |
| `work.stop` | `WorkStopParams` | `{}` | Stop a work item (any started, unclosed work → stopped) |
| `work.reopen` | `WorkReopenParams` | `{}` | Reopen a closed work item (closed → active) |
| `work.detail.subscribe` | `WorkDetailSubscribeParams` | `{work, comments, usage, activity, pending_questions?, children, parent?}` | Subscribe to a single work item + comments + the token usage of it and its tasks ([why usage is here and not on `Work`](../code/work-system.md#usage-aggregation)) and the two relations its page draws ([why they are not read off the list](../code/work-system.md#the-list-holds-rows-the-detail-page-holds-the-item)) |
| `work.detail.unsubscribe` | `{id}` | `{}` | Unsubscribe from work detail |
| `work.list.subscribe` | `SubscribeParams` | `{items: WorkListItem[], stopped_hidden?, open_hidden?}` | Subscribe + get the **`Current` segment**, which holds no closed work ([what a row carries](#work-list-rows-vs-work-detail), [why it is a segment](#the-list-is-two-segments)) |
| `work.list.archive` | `WorkListArchiveParams` | `{items: WorkListItem[], next_cursor?, has_more?}` | One page of closed work, served against an open list subscription |
| `work.list.earlier` | `{id}` | `{items: WorkListItem[]}` | The `Current` segment again with both group caps lifted |
| `work.list.unsubscribe` | `{id}` | `{}` | Unsubscribe |

Comments are read-only over WebSocket: they arrive with
`work.detail.subscribe`, and no method adds or updates one. Writing one is an
agent reporting on its own work, so it belongs to the MCP surface
(`work_comment_add`, `work_comment_update`); a client that could edit one would
be rewriting an agent's words in a record that carries no author field, with
nothing left to tell the two apart ([frontend.md](frontend.md#workdetailoverlay)).

#### Agent Role

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `agent_role.create` | `AgentRoleCreateParams` | `AgentRole` | Create a role |
| `agent_role.update` | `AgentRoleUpdateParams` | `{}` | Update fields |
| `agent_role.delete` | `AgentRoleDeleteParams` | `{}` | Delete (with referential integrity check) |
| `agent_role.reset_defaults` | — | `{}` | Delete all roles and recreate defaults |
| `agent_role.list.subscribe` | `SubscribeParams` | `{items: AgentRole[], work_ref_counts: {[roleId]: number}}` | Subscribe + get current snapshot; `work_ref_counts` says how many work items name each role, and is refreshed whole by the `ref_counts` notification |
| `agent_role.list.unsubscribe` | `{id}` | `{}` | Unsubscribe |

### Wire Types

```
WorkCreateParams          { title, agent_role_id, story_id?, body? }   // story_id names a story → a task; absent → a story
WorkUpdateParams          { id, title?, body?, agent_role_id? }
WorkDeleteParams          { id }
WorkStartParams           { id }
WorkStopParams            { id }
WorkReopenParams          { id }
WorkDetailSubscribeParams { id, work_id }
WorkListArchiveParams     { id, cursor?, limit? }   // id names the subscription, not a fresh query
WorkListItem              { id, type, story_id?, agent_role_id?, title, status, activity, unanswered_questions?, wait?, session_id?, worktree?, updated_at }
WorkDetailItem            { id, type, story_id?, agent_role_id?, title, body?, status, wait?, nudge_count?, session_id?, current_step?, worktree?, watcher?, created_at, updated_at }   // the whole item, on work.detail only
PendingQuestion           { request_id, header, question, options?, multi_select?, asked_at }

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
through `work.list.archive`. `stopped_hidden` and `open_hidden` say how many
rows each of the two unbounded groups had held back, so each group's heading can
still show that whole group's count rather than the number of rows that arrived.
One number per group: the headings are separate, so the counts have to be.

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
| `type` | story rows group task rows beneath them. Derived by the server from `story_id` and sent because the row draws it; a client never sends one back |
| `story_id` | builds that tree, and is the story a task's worktree badge waits on ([`isWorktreeBound`](../code/work-system.md#displaying-a-works-worktree)) |
| `agent_role_id` | the role name shown on the row |
| `title`, `status` | the row itself |
| `unanswered_questions` | how many questions the work's agent has asked and nobody has answered — the second dimension of "needs you", beside `activity` rather than folded into it, since an agent can be running *and* waiting on an answer. A count only: the questions themselves are on the detail ([agent-integration](../code/agent-integration.md#posted-questions)) |
| `activity` | the row's glyph, and which group it is in — the one thing a row draws that a client cannot compute, since the list spans worktrees and a client holds turn state only for the one it has open ([lifecycle-ui](../lifecycle-ui.md) §1.3). It is also what the Project tab's attention dot is read off, and what the server's own `Current` cut consults so that a row needing a person is never held back |
| `wait` | what an active work is waiting for; the agent's stated reason belongs to the detail, where there is room to show it |
| `session_id` | the row's **Chat** shortcut |
| `worktree` | the row's worktree badge (the list spans every worktree) |
| `updated_at` | orders the closed group |

`body`, `current_step` and `created_at` are **detail-only**: no row renders them,
and `body` is unbounded user-authored prose — editing one work item's body would
otherwise push the whole of it to every subscriber, including the clients looking
at a different work item. A client that needs them subscribes to `work.detail`,
which carries the whole item as `WorkDetailItem`.

That item carries every stored field plus the same derived `type` a row does, so
a client asks a work item's kind the same way wherever it reads one, and
`rpc.NewWorkDetailItem` derives it in one place the way `NewWorkListItem` does
for a row.

The derivation stays on the wire and off the disk: the store marshals the domain
record straight into `index.json`, so a `type` on that record would be written
back beside the `story_id` it is derived from — the second copy of the fact the
two-level shape removed. That is why `WorkDetailItem` lists its fields instead of
embedding the record: a wire type is the only place the kind can be added without
it also being stored.

`work.create` and `work.start` answer with a `WorkDetailItem` too. They speak for
one item each, and it is the same item a detail reports, so it is reported the
same way: a caller that goes on to draw what it just created reads its kind off
the reply rather than deriving one of its own.

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

Before deleting an agent role, the handler scans all work items and counts the references with the same `work.CountRoleRefs` the list subscription's `work_ref_counts` is built from — one count, so the number a client draws on a row and the number that refuses the delete cannot disagree. The status is not filtered: a closed work item still blocks the delete ([why](../agent-roles-ui.md#5-deleting-lives-on-the-detail-page)).

The refusal message is **user-facing verbatim** — the client prints it as it stands, with no prefix of its own — which is why it is a capitalised sentence rather than a lowercase fragment like its neighbours, and why singular and plural are spelled out:

```
Can't delete: 1 work item still uses this role. Change its role, or delete it, first.
Can't delete: 3 work items still use this role. Change their role, or delete them, first.
```

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
3. Server returns the initial snapshot alone; the reply carries no id. `{items}` for `work.list`, `{items, work_ref_counts}` for `agent_role.list`.
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

**Reference counts** (`agent_role.list.changed` only) — a fifth operation, sent
when the number of work items naming a role moves. Always the whole map, which
replaces whatever the client held:
```json
{ "id": "<sub-id>", "operation": "ref_counts", "work_ref_counts": { "<role-id>": 3 } }
```
A role nothing references is absent rather than present as `0`. This arrives on
the agent role list's own channel because the count lives in the work store, not
the role store — the watcher listens to both
([why](../code/subscription-system.md#why-one-channel-carries-two-stores-changes)).

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

`agent_role.list`'s *work* events are the one exception, because they are answered with a whole recomputed map rather than an increment — a dropped one costs nothing and sets no flag ([why](../code/subscription-system.md#why-one-channel-carries-two-stores-changes)).
