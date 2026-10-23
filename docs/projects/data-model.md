# Data Model and Persistence

## Entities

### Work

A unit of work — a **story** (no `story_id`), a **task** (the `story_id` names the story it belongs to), or a **job** (the `schedule_id` names the schedule it is a run of; [Jobs](#jobs)).

| Field         | Type         | Description                                            |
| ------------- | ------------ | ------------------------------------------------------ |
| id            | string       | UUIDv7 (time-ordered)                                  |
| story_id      | string?      | The story this work is a task of; absent means it *is* a story ([Hierarchy](#hierarchy)) |
| schedule_id   | string?      | The schedule this work is a run of, which makes it a job; never set beside `story_id`, and never changed once set ([Jobs](#jobs)) |
| agent_role_id | string       | Agent role assigned to this work                       |
| title         | string       | Short description (required)                           |
| body          | string?      | Detailed description or instructions                   |
| status        | WorkStatus   | `open` / `active` / `stopped` / `closed` — what the engine may do with it (see below) |
| wait          | WorkWait?    | What an active work is waiting for: `child`, the only value; absent means nothing. Waiting on a *person* is not recorded here — the agent posts a question instead ([work-system.md](../code/work-system.md#four-statuses-and-a-wait)) |
| nudge_count   | int?         | Consecutive nudges with no progress; reset by anything that counts as progress |
| session_id    | string?      | Agent session ID (set on start, preserved through stop/closed) |
| current_step  | int?         | 0-indexed step index (only when agent role has steps)  |
| worktree      | string?      | Worktree the session runs in (empty = main); captured on a story's first start, inherited by its tasks, given to a job by its schedule when the run is created, immutable once started |
| watcher       | Watcher?     | Stories only: `{session_id, worktree?}` of the session that started it with `story_start`'s `watch` and is sent its news; kept across stops and restarts, cleared by the write that closes the story, or earlier by `story_unwatch` or the watching session's deletion ([work-system.md](../code/work-system.md#a-storys-watcher)) |
| created_at    | time         | Creation timestamp                                     |
| updated_at    | time         | Last modification timestamp                            |

`type` (`"story"` / `"task"` / `"job"`) is not stored. It is derived from
`schedule_id` first and `story_id` second (`work.Work.Type()`) and still sent
everywhere a work item is reported — the list row (`rpc.NewWorkListItem`), the
detail and the replies to `work.create` / `work.start`
(`rpc.NewWorkDetailItem`), and the MCP summary (`newWorkSummary`) — as a display
field the client reads and never writes, the same standing as `activity`. It
must not reach `index.json`, where it would be a second copy of the fact
`schedule_id` and `story_id` hold; `TestPersistedIndexCarriesNoType` reads the
file's bytes to hold that. Why the wire keeps it off the domain record is
[api.md](api.md#work-list-rows-vs-work-detail).

### Comment

A note attached to a work item, used for progress reports and results.

| Field      | Type   | Description           |
| ---------- | ------ | --------------------- |
| id         | string | UUIDv7                |
| work_id    | string | Owning work item ID   |
| body       | string | Comment text          |
| created_at | time   | Creation timestamp    |

### AgentRole

Defines an agent persona with a system prompt, optional execution steps, and the
engine its sessions run on.

| Field       | Type       | Description                                  |
| ----------- | ---------- | -------------------------------------------- |
| id          | string     | UUIDv7                                       |
| name        | string     | Display name (required)                      |
| role_prompt | string     | System prompt for the agent                  |
| steps       | []string   | Optional ordered list of step instructions   |
| agent_type  | AgentType  | Agent to run on; empty = the global default  |
| model       | string     | Agent-specific model id; empty = CLI decides |
| effort      | string     | Agent-specific effort; empty = CLI decides   |
| work_type   | WorkType   | `story` / `task` / `job` it may be assigned to; empty = any |
| created_at  | time       | Creation timestamp                           |
| updated_at  | time       | Last modification timestamp                  |

#### Steps Field

When `steps` is non-empty, tasks using this role execute in sequential steps:
1. On task start, the agent receives step 1 instructions
2. When the agent calls `step_done`, the task advances to the next step if more steps remain
3. When the final step completes, `step_done` closes the work item

#### Engine Fields

The three fields are one choice, not three: [models and effort levels belong to
an agent](../code/agent-integration.md#session-models) and no id is shared
between agents, so a model is only meaningful next to the agent it was picked
for. They are therefore stored together, validated together against the agent
type the role ends up with, and `model`/`effort` are dropped whenever
`agent_type` changes. A client switching agents sends `agent_type` alone and
lets that reset happen server-side.

**Every empty defers to Settings, and only then to the CLI.** An empty
`agent_type` means *follow the global default agent*; an empty `model` or
`effort` takes the global default chosen for that agent, and reaches the CLI's
own default only when Settings has none to give. The full rule — including when
a role is given nothing from Settings — is [Role Engine to Session
Engine](workflow-engine.md#role-engine-to-session-engine).

**A role's empty `agent_type` is not the built-in default agent**, though the
global setting's empty is: an unset global default still has to start sessions on
some agent, so it is read as the built-in one. Here empty is a deferral to a
value the user set and can go change. Resolving it in place would pin the role to
whatever agent is built in today and stop it following Settings, which is the one
thing it was left empty to do.

**An unavailable combination is an error, not a reset** (`ErrInvalidRole`, whole
update rolled back), the opposite of `session.SetAgentType`, which quietly drops
a model the new agent cannot run. The two differ because a role's engine is what
the user is editing at that moment, while a session's is collateral damage from
a switch. The consequence to design around: a role may hold a model the server
has since retired, and that value is kept rather than rewritten to Auto, so
validation must not make the role read-only — an update touching none of the
three fields is not judged by them. The retired value surfaces where it actually
bites, at [work start](workflow-engine.md#workstarter), in an error naming the
role to fix.

#### Work Type Field

`work_type` says which kind of work item the role may be put on: `story`,
`task`, `job`, or empty for any. A story wants a role whose steps break it into
tasks, drive them and commit; a task wants one that executes and does not
commit; a job wants one that does a scheduled prompt's work itself, with no
story to coordinate or report to. Written only in the role prompt, that
constraint was invisible to the agent doing the assigning — it reads its own
prompt, not the candidates' — so a story handed to an engineer was never split and never committed. The system therefore
declares the type, filters `agent_role_list` by it, and refuses an assignment
that breaks it.

**Empty is a real value, not a missing one.** It means "no restriction", which
is what every role written before the field existed reads as, so nothing is
migrated and an old `index.json` behaves exactly as before. The question
"does this role take this type?" is answered in one place, `AgentRole.AcceptsWorkType`;
`agent_role_list`'s filter and the assignment check both ask it, so the meaning
of empty cannot drift between them. Any other value is refused
with `ErrInvalidRole`, the whole update rolled back as for the engine fields.

**It is checked when a role is assigned, and never again.** The check —
`agentrole.CheckAssignment`, and `CheckReassignment` for an update, in
`server/agentrole/assign.go` — runs on every write that sets a role: MCP
`story_create` / `task_create` / `work_update` and WebSocket `work.create` /
`work.update` — at the transport, not in the store. So `Store.CreateJob`, which
no transport reaches, does not run it either: whatever creates a run has to
call `CheckAssignment` with `job` itself. Starting, stepping, reopening, and an
update that leaves the role alone or names the role the work already has are not judged by it. The reason is
the same as for a retired model above: restricting a role must not make the work
that already uses it read-only or unstartable. A work keeps the role it was
legitimately given; the restriction governs what is assigned from then on. A
refusal wraps `work.ErrInvalidWork`, so both transports report it as the
caller's mistake, and its message lists the roles that would have been
accepted, so an agent can retry without another listing.

**Defaults.** The built-in roles carry a type: `PM` takes stories; the engineer,
UI designer, documentation writer and reviewer take tasks; `执行者` takes jobs.
The types apply only to roles the defaults create — the first seed of a data
dir and `ResetDefaults` — and never rewrite a role that already exists. `执行者`
has no steps on purpose: a job's prompt is the whole of its work, so the one
`step_done` that finishes it is the one that closes the run.

**The default role (`settings.default_agent_role_id`) is the default *story*
role.** The server never assigns work from it: it only names the role the create
form preselects ([agent-roles-ui.md §7](../agent-roles-ui.md#7-the-default-story-role-in-words)),
and that form makes stories only — a task's role is named by the agent that
creates it with `task_create`, and MCP `story_create` names its role explicitly
too. So it must name a role that can run stories, and one rule keeps it so:

- **`settings.update` refuses a role that cannot run stories** (InvalidParams,
  naming the role), as it refuses one that does not exist. It judges the value
  only when it changes: `settings.update` replaces the whole object, so a stored
  value that went stale outside the server — a hand-edited `settings.json` —
  must not make every unrelated setting unsavable.
- **A role that stops being able to run stories takes the default with it.**
  Narrowing the default role to tasks or jobs (`agent_role.update` with
  `work_type: "task"` or `"job"`) and deleting it are all *accepted*, and the
  default is cleared to none. Refusing the role change instead would make editing a role
  wait on a trip to a different setting; the default only ever names a
  preselection, so losing it costs one pick in the create form.

The field keeps its name, `default_agent_role_id`: it is stored in every
existing `settings.json` and sent by every client, and a renamed key would be
silently dropped by both decoders, quietly resetting the default. What changed is
which roles it may name, and that lives here.

Readers still treat a stored default that cannot run stories as no default — the
web client's `resolveInitialRole` filters by `roleAcceptsWorkType`
([agent-roles-ui.md §8](../agent-roles-ui.md#8-which-kind-of-work-a-role-runs))
— because a hand-edited file can still produce one. A client that does not has
the create refused by the server, visibly, rather than accepted.

## Hierarchy

`story_id` *is* the hierarchy. A work without one is a story — unless it is a
[job](#jobs), which stands outside the hierarchy; a work with one is that
story's task. Two levels, and the shape is what holds them there: a task's
own `story_id` would have to be empty for it to be a story, so a third level
cannot be written down at all.

- The only rule left to check is that `story_id` names a work that exists and is
  itself a story — a task naming a task is how a third level would be built, and
  that is where it is refused.
- `agent_role_id` is required on all work items, and the role must take the
  work's type when it is assigned ([Work Type Field](#work-type-field)).
- Deleting a story cascade-deletes its tasks.
- "What is below this work" is one query, `work.TasksOf`, not a walk.

### Jobs

A job is one run of a schedule: an agent doing a fixed prompt's work itself.
`schedule_id` is what makes a work one, and `Type()` reads it before `story_id`,
so the type stays derived for all three kinds. A job stands **beside** the
hierarchy rather than in it — no story above it, no tasks below it — so that
everything else about a work (session creation, kickoff, nudging, stop,
restart, reopen, startup recovery, the session link) applies to a run
unchanged, and none of the story/task coordination does.

- **Only `Store.CreateJob` makes one**, as a fresh `open` work with a new id,
  every time: a run is never reused, so each has its own session and its own
  history. It requires `schedule_id`, `title` and `agent_role_id`, and refuses a
  `story_id`. It is a Go method only — no RPC or MCP tool reaches it, because
  runs are made by their schedule, never by hand — and `Store.Create` refuses any
  work carrying a `schedule_id`, so there is no second way in.
- **`schedule_id` never changes.** Nothing but `CreateJob` writes it, so a
  work's kind is fixed for its whole life, and a check on it cannot be raced.
- **It cannot hold tasks**: `ValidateStory` refuses a job as a task's story.
  Nor can it be watched — `Claim` with a watcher and `Unwatch` refuse it.
- **Its runs are listed under their schedule** (`Store.ListBySchedule`, oldest
  first), never among the stories: the Stories list leaves jobs out
  ([work-system.md](../code/work-system.md#jobs)).

## Status Lifecycle

See [workflow-engine.md](workflow-engine.md) for the full status machine, transitions, and session ID constraints.

Summary: `open → active → closed`, with `stopped` for a work handed back to a
person. What the agent is *doing* is not a status: it is derived from the status,
the wait and the session's turn state
([work-system.md](../code/work-system.md#activity)).

Old index values (`in_progress`, `needs_input`, `waiting`) are normalised on
load — those three were exactly this model flattened, so each maps to the status
and wait it always meant, except `needs_input`, whose `user` wait no longer
exists and which lands on plain `active`. The two-level shape arrives the same
way: `parent_id` is read as `story_id` — every value it holds on disk is already
a story id, because nothing deeper was ever creatable — and `type` is read and
dropped. There is no migration script.

## Persistence

### Storage format

Both Work and AgentRole stores use JSON files:

```
<dataDir>/
├── works/
│   ├── index.json        # all Work items + Comments
│   └── index.json.lock   # lock coordination file
└── agent-roles/
    ├── index.json        # all AgentRole items
    └── index.json.lock   # lock coordination file
```

The index files contain all items in a flat array:

```json
// works/index.json
{ "works": [...], "comments": [...] }

// agent-roles/index.json
{ "roles": [...] }
```

### What the project's git sees

The data directory sits inside the user's project, so the server keeps a
`<dataDir>/.gitignore` there (`server/datadir`) that ignores everything in it —
sessions, logs, `server.json` and `relay.json` with their tokens, the file
itself — except `agent-roles/index.json`, which a team may commit to share its
roles. The user never has to touch their own `.gitignore`. The rules are
anchored to the directory's top level, so a worktree's data under `worktrees/`
is ignored whole.

The file belongs to Pockode for as long as its first line is Pockode's marker
comment: every start rewrites it if its bytes differ from what the running
build defines, so a rule change reaches existing projects on their next start
and a local edit is lost. Deleting the marker hands the file to the user —
Pockode never writes it again, and later rule changes no longer reach it;
deleting the whole file hands it back, since a missing file is written fresh on
the next start. Only the first line counts, and a byte-order mark, trailing
whitespace or CRLF on it do not read as a takeover: an editor that adds them was
not told to take anything over.

The header tells the user the rest of what is in their hands — an outer
`.gitignore` can drop `.pockode/` as a whole but cannot override a single rule
in it (the nearer file wins), and `git add -f` commits a file it ignores. The
file ignores itself, so a taken-over copy stays on the one machine unless it is
committed that way.

Only the default `<work>/.pockode` gets one. A `--data` path can be any
directory, the project root included, and a `/*` written there would hide the
user's whole tree from git — so a custom data directory inside the project is
the user's to ignore.

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
`server.json`, `relay.json`, `sessions.json`, `mcp-config.json`, the data
directory's `.gitignore` and the per-session Claude resume file. Files whose
mode matters pass it explicitly — `server.json`, `relay.json` and
`sessions.json` stay `0600` because they hold credentials.

Attachments (`server/attachments`) keep the same guarantee without the
primitive, because a user's upload is too large to hold in memory:
`attachments.Store.PutStream` streams it into a temp file under the session's
`attachments/incoming/`, fsyncs it, and renames it into place with
`filestore.Rename`, the retrying rename `WriteFileAtomic` uses. No lock is needed — the name is the content's hash, so
two writers of one name write the same bytes, and a name already present is kept
([file.md](../file.md#transfer)).

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

**File lock:** A dedicated lock file (`index.json.lock`) serializes writers
against each other and against the read half of a read-modify-write. Reads
acquire a shared lock; writes acquire an exclusive lock. What the lock does
*not* do is make a reader see a whole file — the atomic rename already
guarantees that, which is why code that only wants to inspect a file (such as
`serverinfo.Read`) reads it without locking. A separate lock file is used
because atomic rename replaces the data file, which would detach a lock held on
the data file itself. The lock is `flock(2)` on unix and `LockFileEx` on
Windows, behind one interface in `filestore`.

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
| ListBySchedule | `(scheduleID) → ([]Work, error)`    | Returns a schedule's runs, oldest first; `""` names no schedule and returns none |
| Create       | `(ctx, Work) → (Work, error)`         | Validates title/story/agent_role, assigns ID and timestamps; refuses a `schedule_id` |
| CreateJob    | `(ctx, Work) → (Work, error)`         | Adds one run of `schedule_id` as a fresh open work; takes only `schedule_id`, `agent_role_id`, `title`, `body`, `worktree` ([Jobs](#jobs)) |
| Update       | `(ctx, id, UpdateFields) → error`     | Partial update of data fields (title, body, agent_role_id)  |
| Delete       | `(ctx, id) → error`                   | Cascade-deletes a story's tasks                             |

**Intent-based transitions** (preferred way to change status):

| Method        | Signature                              | Behavior                                                         |
| ------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Start         | `(ctx, id, sessionID) → (Work, error)` | Transitions to `active`, sets sessionID; rejected when already `active` or `closed` |
| Stop          | `(ctx, id) → error`                    | Transitions any live status → `stopped`                         |
| StepDone      | `(ctx, id, totalSteps) → (bool, error)` | Work items advance to the next step or close when no steps remain; an advance also restores `active` |
| SetChildWait  | `(ctx, id) → (set bool, error)`        | Records the wait on child work; refuses when no child is active, reporting *whether it set one* rather than erroring — only the caller can say why in the agent's terms |
| ClearChildWaitIfStranded | `(ctx, id) → (cleared bool, error)` | Ends a wait no child can end any more, leaving the work active with its allowance reset |
| Activate      | `(ctx, id) → error`                    | → `active` with the wait and the nudge count cleared (preserves sessionID) |
| ClearNudges   | `(ctx, id) → error`                    | The narrower half of `Activate` — the allowance back, the wait untouched — for an answer to a posted question, which is attention without being a transition ([workflow-engine.md](workflow-engine.md#the-work-engine)) |
| RecordNudge   | `(ctx, id) → (int, error)`             | Counts one nudge and returns the total; the limit is the engine's |
| Reopen        | `(ctx, id) → error`                    | Transitions `closed` → `active` (reopens closed item)           |
| RollbackStart | `(ctx, id, sessionID, wasRestart) → error` | Reverts the start that claimed `sessionID` (fresh → `open`; restart → `stopped`) |

"live" is `active` or `stopped` — see [workflow-engine.md](workflow-engine.md#status-transitions). Every transition into or out of `active` clears the wait and the nudge count.

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
| Create             | `(ctx, AgentRole) → (AgentRole, error)`                | Validates name, engine fields and work_type; assigns ID and timestamps |
| Update             | `(ctx, id, UpdateFields) → error`                      | Partial update; name cannot be empty; engine fields validated together; empty `work_type` clears the restriction |
| Delete             | `(ctx, id) → error`                                    | Removes the role                                                      |
| ResetDefaults      | `(ctx) → error`                                        | Deletes all roles and recreates built-in defaults (with their `work_type`) |
| AddOnChangeListener| `(OnChangeListener)`                                   | Registers a listener for create/update/delete events                  |
