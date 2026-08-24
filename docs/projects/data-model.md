# Data Model and Persistence

## Entities

### Work

A unit of work — either a **story** (top-level, wire type `"story"`) or a **task** (child, wire type `"task"`).

| Field         | Type         | Description                                            |
| ------------- | ------------ | ------------------------------------------------------ |
| id            | string       | UUIDv7 (time-ordered)                                  |
| type          | WorkType     | `"story"` or `"task"`                                  |
| parent_id     | string?      | ID of parent story (tasks only)                        |
| agent_role_id | string       | Agent role assigned to this work                       |
| title         | string       | Short description (required)                           |
| body          | string?      | Detailed description or instructions                   |
| status        | WorkStatus   | Current lifecycle state (see below)                    |
| session_id    | string?      | Agent session ID (set on start, preserved through stop/closed) |
| current_step  | int?         | 0-indexed step index (only when agent role has steps)  |
| worktree      | string?      | Worktree the session runs in (empty = main); captured on a top-level work's first start, inherited by children, immutable once started |
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

Defines an agent persona with a system prompt and optional execution steps.

| Field       | Type       | Description                                  |
| ----------- | ---------- | -------------------------------------------- |
| id          | string     | UUIDv7                                       |
| name        | string     | Display name (required)                      |
| role_prompt | string     | System prompt for the agent                  |
| steps       | []string   | Optional ordered list of step instructions   |
| created_at  | time       | Creation timestamp                           |
| updated_at  | time       | Last modification timestamp                  |

#### Steps Field

When `steps` is non-empty, tasks using this role execute in sequential steps:
1. On task start, the agent receives step 1 instructions
2. When the agent calls `step_done`, the task advances to the next step if more steps remain
3. When the final step completes, `step_done` closes the work item

## Hierarchy

Two-level only: **Story → Task** (wire types: `story` → `task`).

- Stories are always top-level (no parent).
- Tasks must have exactly one story parent.
- `agent_role_id` is required on all work items.
- Deleting a story cascade-deletes all its children.

## Status Lifecycle

See [workflow-engine.md](workflow-engine.md) for the full status machine, transitions, and session ID constraints.

Summary: `open → in_progress → closed`, with `needs_input` and `waiting` as pause states, and `stopped` for ended sessions.

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
2. `fsync` the temp file so the bytes are on disk before anything points at them
3. Atomically `rename` temp file to `index.json`

A crash at any point leaves either the old file intact or the new file fully written — never a partial file.

The parent directory is deliberately *not* fsynced: a rename lost to a power
failure rolls back to the previous valid file rather than a corrupt one, and the
extra fsync adds a second full disk round-trip to every index write (measured on
a slow disk: ~150ms → ~220ms).

The same primitive (`filestore.WriteFileAtomic`) backs every file the server
rewrites whole: the stores built on `filestore.File` (work, agent-role,
settings, the cluster node registry), the session and command indexes, plus
`server.json`, `relay.json`, `mcp-config.json` and the per-session agent resume
files. Files whose mode matters pass it explicitly — `server.json` and
`relay.json` stay `0600` because they hold tokens.

Session history is the one piece of state not rewritten whole: it is appended a
record at a time through `filestore.AppendJSONL`, which gives up the whole-file
guarantee for a per-record one. See
[agent-integration.md](../code/agent-integration.md) for that trade-off.

Four writes are deliberately left non-atomic. The reasons are unobvious enough
that each is also recorded at its call site, because "fixing" one of these to
use `WriteFileAtomic` would make things worse, not better:

| Write | Why not atomic |
| ----- | -------------- |
| `contents.WriteFile` — files in the user's own project | A rename would break hard links, reset an executable script to `0644`, swap the inode out from under editors and watchers, and leave `.tmp`/`.lock` files sitting in the working tree |
| `.git-credentials` | git's own `credential-store` helper locks that path with the same `<file>.lock` name `WriteFileAtomic` uses; a leftover lock file makes git fail with `unable to get credential storage lock` |
| The worktree setup hook template | Everything after `set -eu` is comments, so any prefix a crash could leave is still a valid no-op script |
| `server.log` | Append-only and tolerant of a truncated last line, and too hot a path to fsync |

When a JSON state file fails to parse, `filestore.ReadJSONOrQuarantine` moves it
to `<path>.corrupt` and the store starts from empty instead of failing — damaged
state must never make the server unbootable or a session unreachable, and the
quarantined copy keeps the original bytes for hand recovery.

### Atomic persistence

The main server is the **sole writer** of the work index (the MCP path goes
through the in-process API, not the filesystem), so there is no cross-process
write coordination to manage. The agent-role index has one additional writer:
the user editing it directly on disk (same as `settings.json`), which the
server picks up via the fsnotify reload described below.

**flock:** A dedicated lock file (`index.json.lock`) serializes writers against
each other and against the read half of a read-modify-write. Reads acquire a
shared lock (`LOCK_SH`); writes acquire an exclusive lock (`LOCK_EX`). What the
lock does *not* do is make a reader see a whole file — the atomic rename already
guarantees that, which is why code that only wants to inspect a file (such as
`serverinfo.Read`) reads it without locking. A separate lock file is used
because atomic rename changes the data file's inode, which would break flock on
the data file itself.

> To surface those external edits, the settings and agent-role stores watch
> their files via the `filestore` fsnotify primitive: a disk change is reloaded
> and diffed against in-memory state, then fired as change events to subscribers.
> The work store has no external writer, so it does not watch — its events come
> directly from in-process mutations.

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
| StepDone      | `(ctx, id, totalSteps) → (bool, error)` | Work items advance to the next step or close when no steps remain |
| MarkNeedsInput| `(ctx, id) → error`                    | Transitions `in_progress` → `needs_input`                       |
| MarkWaiting   | `(ctx, id) → error`                    | Transitions `in_progress` → `waiting`                           |
| Resume        | `(ctx, id) → error`                    | Transitions `needs_input` → `in_progress`                       |
| ResumeFromWaiting | `(ctx, id) → error`                | Transitions `waiting` → `in_progress`                           |
| Reactivate    | `(ctx, id) → error`                    | Transitions `stopped` → `in_progress` (preserves sessionID)     |
| Reopen        | `(ctx, id) → error`                    | Transitions `closed` → `in_progress` (reopens closed item)      |
| RollbackStart | `(ctx, id, wasRestart) → error`        | Reverts a failed Start (fresh → `open`; restart → `stopped`)   |

**Comments and events:**

| Method                    | Signature                      | Behavior                                                |
| ------------------------- | ------------------------------ | ------------------------------------------------------- |
| AddComment                | `(ctx, workID, body) → (Comment, error)` | Creates a comment; fails if work not found    |
| ListComments              | `(workID) → ([]Comment, error)`          | Returns comments for a work item              |
| AddOnChangeListener       | `(OnChangeListener)`                     | Registers a listener for work change events   |
| AddOnCommentChangeListener| `(OnCommentChangeListener)`              | Registers a listener for comment events       |

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
