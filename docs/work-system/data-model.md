# Data Model and Persistence

## Entities

### Work

A unit of work — either a **task** (top-level, wire type `"story"`) or a **subtask** (child, wire type `"task"`).

| Field         | Type         | Description                                            |
| ------------- | ------------ | ------------------------------------------------------ |
| id            | string       | UUIDv7 (time-ordered)                                  |
| type          | WorkType     | `"story"` or `"task"`                                  |
| parent_id     | string?      | ID of parent story (tasks only)                        |
| agent_role_id | string       | Agent role assigned to this work                       |
| title         | string       | Short description (required)                           |
| body          | string?      | Detailed description or instructions                   |
| status        | WorkStatus   | Current lifecycle state (see below)                    |
| session_id    | string?      | Agent session ID (set on start, preserved through stop/done/closed) |
| created_at    | time         | Creation timestamp                                     |
| updated_at    | time         | Last modification timestamp                            |

### Comment

A note attached to a work item, used for progress reports and results.

| Field      | Type   | Description           |
| ---------- | ------ | --------------------- |
| id         | string | UUIDv7                |
| work_id    | string | Parent work item ID   |
| body       | string | Comment text          |
| created_at | time   | Creation timestamp    |

### AgentRole

Defines an agent persona with a system prompt.

| Field       | Type   | Description                    |
| ----------- | ------ | ------------------------------ |
| id          | string | UUIDv7                         |
| name        | string | Display name (required)        |
| role_prompt | string | System prompt for the agent    |
| created_at  | time   | Creation timestamp             |
| updated_at  | time   | Last modification timestamp    |

## Hierarchy

Two-level only: **Task → Subtask** (wire types: `story` → `task`).

- Tasks are always top-level (no parent).
- Subtasks must have exactly one task parent.
- `agent_role_id` is required on all work items.
- Deleting a story cascade-deletes all its children.

## Status Lifecycle

See [workflow-engine.md](workflow-engine.md) for the full status machine, transitions, auto-close, and session ID constraints.

Summary: `open → in_progress → done → closed`, with `needs_input` as a pause state and `stopped` for ended sessions. `closed` is auto-derived, never set directly.

## Persistence

### Storage format

Both Work and AgentRole stores use JSON files:

```
<dataDir>/
├── works/
│   ├── index.json        # all Work items + Comments
│   └── index.json.lock   # flock coordination file
└── agent-roles/
    ├── index.json        # all AgentRole items
    └── index.json.lock   # flock coordination file
```

The index files contain all items in a flat array:

```json
// works/index.json
{ "works": [...], "comments": [...] }

// agent-roles/index.json
{ "roles": [...] }
```

### Atomic writes

Writes use the **write → fsync → rename** pattern to prevent corruption:

1. Marshal JSON to `index.json.tmp` (same directory = same filesystem)
2. `fsync` the temp file to ensure data hits disk
3. Atomically `rename` temp file to `index.json`

A crash at any point leaves either the old file intact or the new file fully written — never a partial file.

### Cross-process safety

**flock:** A dedicated lock file (`index.json.lock`) coordinates access across processes. Reads acquire a shared lock (`LOCK_SH`); writes acquire an exclusive lock (`LOCK_EX`). A separate lock file is used because atomic rename changes the data file's inode, which would break flock on the data file itself.

**fsnotify:** The store watches the index file's directory for changes. When an external process (e.g. MCP server) modifies the file, the store detects it and reloads. Events are debounced (100ms) to coalesce rapid writes.

**writeGen (stale reload prevention):** An atomic counter incremented on every in-process write. Before reloading from disk, the store snapshots this value. After the disk read, the store acquires the write lock and rechecks — if the value changed, the reload is skipped because the in-process write already updated in-memory state.

**Change diffing:** On reload, the store diffs old and new data to produce change events. Self-inflicted reloads produce no diff and fire no events. External changes fire events with `External: true`.

### Rollback on persist failure

If `persistIndex` fails, the in-memory state is reverted to match the on-disk state. Mutations that modify existing items snapshot the full state before mutation; Create/AddComment use append-then-truncate.

## Store Interface

### work.Store

**CRUD:**

| Method       | Signature                             | Behavior                                                    |
| ------------ | ------------------------------------- | ----------------------------------------------------------- |
| List         | `() → ([]Work, error)`                | Returns all work items                                      |
| Get          | `(id) → (Work, bool, error)`          | Returns a single item; bool indicates found                 |
| FindBySessionID | `(sessionID) → (Work, bool, error)` | Finds a work item by its active session ID                  |
| Create       | `(ctx, Work) → (Work, error)`         | Validates type/parent/agent_role, assigns ID and timestamps |
| Update       | `(ctx, id, UpdateFields) → error`     | Partial update of data fields (title, body, agent_role_id)  |
| Delete       | `(ctx, id) → error`                   | Cascade-deletes children                                    |

**Intent-based transitions** (preferred way to change status):

| Method        | Signature                              | Behavior                                                         |
| ------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Start         | `(ctx, id, sessionID) → (Work, error)` | Transitions to `in_progress`, sets sessionID                    |
| Stop          | `(ctx, id) → error`                    | Transitions `in_progress`/`needs_input` → `stopped`             |
| MarkDone      | `(ctx, id) → error`                    | Transitions to `done`; auto-advances from `open` if needed      |
| MarkNeedsInput| `(ctx, id) → error`                    | Transitions `in_progress` → `needs_input`                       |
| Resume        | `(ctx, id) → error`                    | Transitions `needs_input` → `in_progress`                       |
| Reactivate    | `(ctx, id) → error`                    | Transitions `stopped`/`done`/`closed` → `in_progress` (preserves sessionID) |
| RollbackStart | `(ctx, id, wasRestart) → error`        | Reverts a failed Start (fresh → `open`; restart → `stopped`)   |

**Comments and events:**

| Method                    | Signature                      | Behavior                                                |
| ------------------------- | ------------------------------ | ------------------------------------------------------- |
| AddComment                | `(ctx, workID, body) → (Comment, error)` | Creates a comment; fails if work not found    |
| ListComments              | `(workID) → ([]Comment, error)`          | Returns comments for a work item              |
| AddOnChangeListener       | `(OnChangeListener)`                     | Registers a listener for work change events   |
| AddOnCommentChangeListener| `(OnCommentChangeListener)`              | Registers a listener for comment events       |
| StartWatching             | `() → error`                             | Starts fsnotify monitoring for external changes |
| StopWatching              | `()`                                     | Stops the watcher                             |

### agentrole.Store

| Method             | Signature                                              | Behavior                                                              |
| ------------------ | ------------------------------------------------------ | --------------------------------------------------------------------- |
| List               | `() → ([]AgentRole, error)`                            | Returns all roles                                                     |
| Get                | `(id) → (AgentRole, bool, error)`                      | Returns a single role; bool indicates found                           |
| Create             | `(ctx, AgentRole) → (AgentRole, error)`                | Validates name, assigns ID and timestamps                             |
| Update             | `(ctx, id, UpdateFields) → error`                      | Partial update; name cannot be empty                                  |
| Delete             | `(ctx, id) → error`                                    | Removes the role                                                      |
| ResetDefaults      | `(ctx) → error`                                        | Deletes all roles and recreates built-in defaults                     |
| AddOnChangeListener| `(OnChangeListener)`                                   | Registers a listener for create/update/delete events                  |
| StartWatching      | `() → error`                                           | Starts fsnotify monitoring for external changes                       |
| StopWatching       | `()`                                                   | Stops the watcher                                                     |
