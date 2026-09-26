# Work/Project Management System

The Work system enables AI agents to coordinate complex tasks through a two-level tree structure. A coordinator agent breaks high-level stories into executable tasks, while worker agents implement each task and report back.

## Data Model

### Two-Level Tree Structure

```
Story: "Add dark mode support"
├── Task: "Create theme context"
├── Task: "Update components"
└── Task: "Add toggle UI"
```

**Design Decision**: Only two levels (Story → Task) are allowed. This constraint:
- Forces clear separation: Stories coordinate, Tasks execute
- Prevents recursion complexity while still enabling fine-grained work breakdown
- Simplifies the state machine and lifecycle management

**And the shape says so rather than a rule saying so.** One field, `StoryID`,
is the whole hierarchy, and a third level cannot be written down in it
([data-model](../projects/data-model.md#hierarchy)). What that buys the code:
there is no stored `type` beside it, so a creator cannot state a kind that
contradicts the story it picked; what is left to validate is one literal rule
(`ValidateStory`); and "what is below this work" is one query, `work.TasksOf`,
rather than a transitive closure. The type the wire, the prompts and the list
rows still speak is derived (`Work.Type()`): the vocabulary stayed, the second
copy of the fact went.

```go
// server/work/types.go
type Work struct {
    ID          string     // UUID v7
    StoryID     string     // Empty for a Story; the story's ID for a Task
    AgentRoleID string     // The AI role that executes this work
    Title       string
    Body        string     // Detailed instructions (optional)
    Status      WorkStatus
    SessionID   string     // Active AI session, empty when not running
    CurrentStep int        // 0-indexed; used only when agent role has Steps
    Worktree    string     // Worktree the session runs in; empty = main
    CreatedAt   time.Time
    UpdatedAt   time.Time
}
```

### Worktree Binding

Every work runs its AI session inside exactly one worktree, recorded in
`Worktree` (empty means the main worktree). The binding is decided once and then
frozen:

- **Top-level work** captures the frontend's *current* worktree the first time
  it starts (`handleWorkStart` → `store.SetWorktree`). It is not captured at
  create time, because a story may be created long before the user picks the
  worktree they want it to run in. An agent has no current worktree to capture,
  so its `story_start` takes the name as an argument instead and creates the
  worktree when it does not exist yet (`Registry.EnsureWorktree`, branch = name)
  — the same `SetWorktree` call, reached with the name said out loud rather than
  read off the connection. Only `story_start` has the argument at all, and it is
  still refused on a task named to it — an id is a string — rather than
  silently splitting a story from its tasks across two worktrees.
  `task_start` is a tool of its own precisely so that the schema says this,
  instead of a sentence in a description having to; and it reads the argument anyway in order to *refuse* it, because a
  field merely left off the struct would discard the request in silence and let
  the agent believe it had placed the task somewhere.
- **A task** inherits its story's worktree at create time (`store.Create`).
  Tasks are usually created by the story's already-running agent, so the story's
  worktree is fixed by then. A task pre-created under a still-open story would
  inherit the empty default instead, so `SetWorktree` also propagates the
  captured worktree down to the story's open tasks when it starts. Either way a
  story and its tasks normally share one worktree — the coordinator and all its
  tasks stay together. The one gap is a task started *before* its story
  (nothing forbids it): it is no longer open by then, so propagation skips it and
  it keeps whatever it inherited at create time.
- **Immutable once started** — `SetWorktree` only mutates a work while its status
  is still `open`; any later call is rejected. Assigning the *same* value is a
  no-op, so a main-worktree story that goes open → start → stop → start does not
  trip the immutability guard on restart. An agent naming a *different* worktree
  in `story_start` therefore has the whole call rejected: the story is neither
  moved nor restarted, rather than quietly starting where it already lives.

**Why immutable**: a session's process, cwd, and session files live in a
specific worktree. Moving a work mid-flight would strand its running session and
its history, so the worktree is pinned for the work's whole life. Restart and
reopen therefore reuse the recorded worktree rather than re-reading the
frontend's current one.

This binding is what lets `WorkStarter`, the engine's `SessionTerminator` and
session cleanup act on `worktreeManager.Get(w.Worktree)` instead of always the
main worktree, and it is
the ownership signal behind worktree-deletion protection (below).

One consumer leans on the *normally* in "a story and its tasks normally share
one worktree" while nothing here can enforce it: usage aggregation lets an
unreadable worktree cost a total its share with nothing but a log line, which is
only tolerable while a split story stays the exception noted above. Loosening
this binding means deciding that degradation again — see [Usage
Aggregation](#usage-aggregation).

### Validation Rules

On creation (`FileStore.Create` in `server/work/store.go`):
1. **Title required** — non-empty string
2. **`StoryID` names a story** — when set, it must name a work that exists and is itself a story (`ValidateStory`); this is the one hierarchy rule [above](#two-level-tree-structure) leaves
3. **Story not closed** — cannot add tasks to a closed story; reopen it first
4. **AgentRoleID required** — non-empty here; that the role actually exists is checked one layer up, in `handleWorkCreate` (`server/ws/rpc_work.go`)

There is no type to validate: it is not an input (see above).

## State Machine

The work item is the topmost of the three lifecycle layers. What belongs to the
two below it — how a turn state changes, how long a process may live — is linked
to rather than repeated here; the model all three share is
[lifecycle.md](../lifecycle.md).

### Four Statuses and a Wait

```
                         ┌──── the engine drives it ────┐
open ───── Start ───────►│            active            │──── StepDone ────► closed
                         │      wait: none | child      │                      │
                         └──────────────────────────────┘                      │
                              ▲                  │                             │
                              │                  │ Stop / abort / nudge limit  │
                     Start ───┴──── stopped ◄────┘                             │
                              ▲                                                │
                              └──────────────── Reopen ◄──────────────────────┘
```

**Every status is an intention, and nothing else.**

| Status | Means |
|--------|-------|
| `open` | Never started. No session, nothing to drive. |
| `active` | The engine drives it. |
| `stopped` | The engine does not touch it; a person has to act. |
| `closed` | Finished. |

**What the agent is *doing* is not here.** It is derived — see
[Activity](#activity) — from this status, the wait below, and the turn state of
the session the work runs in. The statuses this replaces (`in_progress`,
`needs_input`, `waiting`) were a cache of process events that went stale every
time one was missed, and four separate mechanisms existed to repair them.

`Wait` is what an active work is waiting for, as its agent declared it:

| Wait | Set by | Cleared by |
|------|--------|------------|
| none | every transition into active | — |
| `child` | `story_wait` | a child work closing, or a user message — or the engine, when no child is left that could close ([input 5](#input-5-a-child-work-left-active)) |

A wait is orthogonal to the status: a waiting work is still **active** — the
engine still owns it — it simply must not be nudged to carry on. It is cleared
by something that arrives from *outside* the session, which is why it survives a
server restart while a work with nothing outstanding does not
([startup](#input-7-startup)).

**There was a second value, `user`, and it is gone** — with `WaitReason`, the
free-text line that went with it. An agent that needs something from a person
posts a question instead (`question_post`, [Question Tools](#question-tools));
why that is strictly better, and not merely different, is
[lifecycle.md § Work: four intentions](../lifecycle.md#work-four-intentions).

What that flag actually did for the engine — "do not nudge this" — is read off
the session's unanswered list now, by the thing that knows
([input 1](#input-1-a-turn-ended)).

`NudgeCount` is the other field the engine keeps: how many times in a row it has
told the agent to carry on without the work moving. Persisted rather than held
in memory per session, so a restart does not hand a stuck agent a fresh
allowance.

**Only `open` and `closed` are gates.** Two guards in
`server/work/validation.go` say this directly, and there is deliberately no edge
table beside them to drift out of sync:

- `ValidateProgress` — may the agent move this work along (`step_done`,
  `story_wait`, stop, a liveness sync)? `active` and
  `stopped` qualify; `open` and `closed` do not, and each names its way in.
  A `stopped` work is admitted on purpose: an agent able to call `step_done` is
  running whatever the status claims, and gating on it is how a work that had
  merely gone stopped became impossible to advance or finish.
- `ValidateStartable` — may a session be started for this work? Also admits
  `open` (the fresh-start case) and rejects `active`, so a running work is never
  started twice — which is also what resolves concurrent `Claim`s to a single
  winner. A work waiting on its subtasks is `active`, so Restart is not offered
  for it; Stop is (docs/lifecycle-ui.md §3).

| Status | SessionID | CurrentStep |
|-------|-----------|-------------|
| `open` | empty | 0 |
| `active` | set | tracks current step |
| `stopped` | preserved | preserved |
| `closed` | preserved | preserved |

### Intent-Driven Transitions

The store exposes intent methods rather than raw status updates. Each
encapsulates its validation and its bookkeeping.

| Method | Transition | Purpose |
|--------|------------|---------|
| `Start(id, sessionID)` | startable → active | Launch AI session |
| `Claim(id)` | startable → active | Start plus atomic sessionID decision (a work that already owns a session is a restart and keeps it) |
| `Stop(id)` | live → stopped | Hand the work back to a person |
| `StepDone(id, totalSteps)` | live → active/closed | Advance the step, or close |
| `SetWait(id, wait, reason)` | live → active with that wait | Record what the agent is waiting for (`WaitNone` clears it) |
| `SetChildWait(id, reason)` | live with an active child → active + `child` | The same for a wait on subtasks, which is refused — *reported*, not an error — when no subtask is running |
| `Activate(id)` | live → active, wait and nudges cleared | Someone handed the work something to go on |
| `ClearChildWaitIfStranded(id)` | `active` + `child` with no active child → active, wait and nudges cleared | The same, for a wait nothing could end — and it *reports* whether this call was the one that ended it, which is what it is for ([input 5](#a-wait-nothing-could-end)) |
| `RecordNudge(id)` | counts one nudge, returns the total | The engine compares it against its own limit |
| `Reopen(id)` | closed → active | Reopen a closed item to add children or continue |
| `RollbackStart(id, wasRestart)` | active → open/stopped | Undo a failed start |

"live" is `active` or `stopped`; "startable" is what `ValidateStartable`
admits — everything but `active` and `closed`.

`SetChildWait` and `ClearChildWaitIfStranded` are the only two here **not**
written through `setLiveStatus`, and for one reason: their condition is about the
work *and its children*, while `setLiveStatus` hands a mutate func the single
record it is changing. Written that way each would have to read the children
outside the lock, and that read is the bug they exist to remove — see
[input 5](#a-wait-nothing-could-end). They share one predicate,
`work.HasActiveTask`: "is there still something that could close" is one
question, and a wait set on one answer and cleared on another would be a wait
that argues with itself.

**Every transition into or out of active clears the wait and the nudge count**
(`Work.clearDrive`). There is no path that leaves a stale wait behind for the
next one to trip over, and no status that means "waiting for a person" twice:
`stopped` already says that, and a wait kept beside it would be a second way to
say the same thing, disagreeing as soon as one went stale.

A `StepDone` from a stale `stopped` repairs it back to `active`: the agent
calling the tool is proof its session runs. The new step is a new context, so the
nudge allowance starts over with it.

Re-setting a status and wait a work already holds is a deliberate no-op rather
than a redundant write. Liveness signals repeat, and re-announcing an unchanged
record would wake every subscriber with a change event that carries no news.

`RollbackStart` is the one method that names what it is undoing: the session id
the failed start claimed. The id is the identity of that start, and the status is
what says nobody has taken the work somewhere a rollback would clobber — a work
the agent has closed, or one already started again on a different session, is
refused.

`stopped` is admitted beside `active` there for a reason that is not
hypothetical. A kickoff that fails deletes the session it created, and the engine
stops the work of a deleted session ([input 6](#input-6-the-session-was-deleted))
— so that stop and this rollback race, in either order. With the session id as
the identity both orders converge: the stop lands first and the rollback still
undoes it, or the rollback lands first and the stop finds no work owning that
session at all.

### Activity

`Activity` is what a work is *doing*, as one value, and it is derived —
never stored. Eight leaves; the rule, in full:

> The session says what is happening; the work's wait says what it is waiting
> for when nothing is happening.

```
activity(work, turn):
  status open / closed / stopped -> open / closed / stopped
  turn.phase == running          -> running
  turn.phase == blocked          -> permission > background
  otherwise (idle, or no turn):
    wait child -> waiting_children
    otherwise  -> idle
```

Phase outranks wait because a wait is a standing intention and a phase is a fact
about this second: an agent that calls `story_wait` and then keeps writing for ten
seconds *is* running. Permission outranks background because background is the one
nobody can act on — and those are the only two blockers a turn has.

`needs_answer` was a ninth leaf and is gone with the CLI's own blocking question.
Its replacement is not a leaf at all: a question an agent posts leaves the work
`running`, and what says so is the count below.

Nothing here says "this work is waiting for a person", and that is the second
dimension's job, not this one's — see below.

**It is computed on the server for work rows** (`server/work/activity.go`,
carried on `rpc.WorkListItem.activity` and on the detail). The work list is
global across worktrees while a session list is scoped to one, so a client does
not hold the `TurnState` of a session in a worktree it has not opened. The client
evaluates the same rule for *session* rows (`web/src/lib/activity.ts`), and the
two are checked against one shared table of cases,
`server/work/testdata/activity_cases.json` — the rule is written down once even
though it is evaluated in two places. An `activity` the client does not
recognise normalises to `idle` at the wire boundary.

Reading the turn of a worktree nobody has opened is what `work.TurnSource`
(implemented by `worktree.Manager`) is for: a loaded worktree answers from its
session store, an unloaded one from its index on disk — building a worktree
because somebody looked at a row is exactly what that avoids.

### Unanswered Questions

Activity is not the only thing a row reads off the session layer. A work whose
agent posted a question with `question_post` has something waiting for the user
*and* may be running at the same time, so the two are carried side by side
(`work.RowState`) rather than folded into one value — a row forced to pick would
be wrong either way.

| Surface | Field | Why |
|---|---|---|
| work row (`rpc.WorkListItem`) | `unanswered_questions: number` | a row prints `Running · 2 to answer`, and every subscriber is sent a row whenever any item changes |
| work detail | `pending_questions: PendingQuestion[]` | the one surface with room to show what is being asked |
| session row (`rpc.SessionListItem`) | `unanswered_questions: number` | `len(turn.unanswered)`, derived where the row is built so it cannot drift |
| `work_get` (MCP) | `pending_questions` | on the detail, not the summary, for the reason `body` is |

The count is only drawn for `active` and `stopped` work. Closing a work
withdraws the questions beneath it, and an open one has no session to have asked
any, so a count on either would be a leftover nobody can act on.

**`RowState.NeedsAttention` is where the two dimensions merge, and the only
place they do**: `Activity.NeedsUser() || UnansweredQuestions > 0`. On the server
it decides whether an active *task* earns a row of its own in the `Current`
segment (`watch.hasCurrentRow`) — a task whose agent posted a question and went
on working reads as `running`, and a rule looking only at the activity would roll
it up into its story and leave the question unreachable from the list. The client
mirrors the same predicate for the attention dot and the *Needs you* group
([lifecycle-ui.md §1.4](../lifecycle-ui.md#14-the-three-components)).

Everywhere with room for two things — a session row, a work row's second line —
draws them side by side instead. The merge is only for places that need a single
bit.

The mechanics of a posted question — where the list lives, what moves it, what a
fork inherits — are in
[agent-integration.md](agent-integration.md#posted-questions).

### Step Completion

Work items transition through `StepDone`; there is no intermediate `done` state.
Any work item with remaining steps advances to the next step and stays `active`.
When no steps remain, the work item closes. Waiting for child work is handled
explicitly through `story_wait`, not `StepDone`.

**The closing step_done is refused while any subtask is still `active`**, and the
refusal names them (`work.Operations.refuseIfChildrenActive`):

> This story still has 2 active subtask(s): "…", "…". Call `story_wait` to pause
> until they close. The step was not completed.

Only the closing one: advancing through a story's own steps alongside running
subtasks is ordinary. Finishing is not — the children would be left with a
parent nobody is going to report to, and closing the story retires the session
they report through. Nothing is cascaded, because stopping someone else's work
is a decision rather than a side effect of finishing your own. For the same
reason the error names only `story_wait`: stopping a subtask is a person's call
and no agent tool makes it, so offering it would send the agent after a call it
cannot make. The rule itself is stated up front in the two places an agent reads
before it acts — the tool description and the lifecycle section every message
carries. When a child closes, the engine tells the parent and clears a `child`
wait; already closed parents are not reopened, preserving the intentional
completion of coordinated work.

## File-Based Storage

### Why Files Over Database

The Work system uses atomic file I/O instead of a database:

1. **No single point of failure** — No database process to manage
2. **Simple deployment** — Just files in a directory
3. **Inspectable** — Plain JSON on disk

The main server is the **sole writer** of work data: the frontend goes through
the WebSocket layer and the AI goes through the MCP API (see *MCP Server
Architecture*), and both mutate the in-memory store directly. Mutations are
serialized by a mutex and persisted atomically.

> Because the server is the sole writer of work data, the work store does not
> run a file watcher: its change events are emitted directly from in-process
> mutations rather than reloaded after a cross-process write. (The agent-role
> store does watch its file, since users may edit it directly on disk.)

### Atomic Persistence

```
server/filestore/atomic.go
```

Writes do write-temp → fsync → rename, which is what makes a crash or a
concurrent reader never see a torn file. The lock around it — exclusive for a
write, shared for a read — is for the read-modify-write: it serializes writers
against each other and against the read half
([data-model.md](../projects/data-model.md#atomic-persistence) has the full
division of labour):

```go
lock := acquireLock(path+".lock", exclusive) // blocks until granted
defer lock.release()

tmpFile := OpenFile(path+".tmp", CREATE|WRONLY|TRUNC, perm)
tmpFile.Write(data)
tmpFile.Sync()            // fsync: bytes on disk before anything points at them
renameFile(tmpFile, path) // atomic replace
```

The lock itself is platform-split (`lock_unix.go` / `lock_windows.go`): `flock(2)`
on unix, `LockFileEx` on Windows. Windows also needs the rename retried, because
an unrelated opener (antivirus, indexer) can transiently block replacing the
destination — a failure mode that does not exist under POSIX rename.

The filestore primitive also offers fsnotify-based reload for callers that need
cross-process change detection (the settings and agent-role stores use it, as
both are user-editable on disk); the work store does not enable it, since the
server is its only writer.

## MCP Tools

AI agents interact with the Work system through MCP (Model Context Protocol) tools, exposed via a stdio JSON-RPC 2.0 subprocess.

### Work Tools

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `story_list` | List the project's stories | — |
| `task_list` | List one story's tasks | `story_id` |
| `story_create` | Create a top-level story | `title`, `agent_role_id`, `body?` |
| `task_create` | Create a task under a story | `story_id`, `title`, `agent_role_id`, `body?` |
| `work_get` | Get full details including body | `id` |
| `work_update` | Modify title/body/role | `id`, fields to update |
| `work_delete` | Delete (a story takes its tasks with it) | `id` |
| `story_start` | Begin execution of a story | `id`, `worktree?` |
| `task_start` | Begin execution of a task | `id` |
| `story_wait` | Pause for task completion | `id` |
| `work_reopen` | Reopen a closed work item | `id` |
| `step_done` | Advance work step or close work | `id` |
| `work_comment_add` | Add progress note | `work_id`, `body` |
| `work_comment_list` | List comments | `work_id` |
| `work_comment_update` | Update comment text | `id`, `body` |

**The names are the fork.** A tool is split by story and task exactly where the
behaviour forks, and keeps the `work_` prefix where it does not: `story_start`
takes a worktree and `task_start` refuses one; only a story has tasks
to list or to wait for; a creation names a story or it is one. The rest —
`work_get`, `work_update`, `work_delete`, `work_reopen`, `work_comment_*` — mean
the same thing for both kinds, and splitting them would only double what an agent
has to remember. The point is that an agent reads which kind a tool is for off
the name, instead of finding out from a runtime refusal.

The split replaced `work_create`, `work_list`, `work_start` and `work_wait`.
For the release that shipped it they stayed registered as stubs answering with
an error that named their replacement, to cover sessions that were mid-turn with
the old names; the engine resends `lifecycle_rules` with every message, so that
window closed with the next turn, and the stubs are gone. A call to one of those
names is now "unknown tool" like any other, which is why
`work.TestEverySystemMessage_SpeaksTheCurrentVocabulary` keeps them out of every
message the engine composes.

### Question Tools

These act on the session the call came from rather than on an id the model
names, which is why they need the caller identity
([MCP Caller Identity](agent-integration.md#mcp-caller-identity)) and are refused
outright for a call that arrived without one — an agent started by hand has no
chat to ask into, and no identity to be recorded as having answered.

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `question_post` | Ask the user one question and carry on; returns a `request_id` | `question`, `header`, `options?`, `multi_select?` |
| `question_answer` | Answer a question **another** session posted | `request_id`, `answers?`, `text?`, `session_id?` |
| `question_cancel` | Withdraw a question the same session posted | `request_id` |

**A question is named by a pair — the session it is waiting in and its
`request_id` — and the id alone does not name one.** A fork copies the questions
that were open at the cut with their ids unchanged, so one `request_id` can be
waiting in two sessions at once; that is the design and not a collision to
repair
([agent-integration.md](agent-integration.md#a-fork-inherits-what-was-open-at-the-cut)).
Everything that acts on a question takes both halves, and every lookup by id
alone answers with a list.

**`question_answer`'s `session_id` is the one place the pair may be given as
half of itself**, and only to save tokens: it is optional, and while exactly one
session is waiting on that id, leaving it out is the right call. The moment more
than one is, the call is **refused** rather than resolved —
Pockode picking one would leave the question the agent meant to answer still
asking, and tell the agent nothing was wrong. The refusal names each candidate
session **with the work running in it**, because the work is the half of that
pair an agent can recognise: it meets a question through the work around it — a
subtask's question arrives naming the subtask, `work_get` lists the questions of
the item asked for — and a session id appears in neither.

`question_answer` is the only one of the three that acts on somebody else's
session — the caller's identity is what is recorded as the answerer, not what is
acted on. It refuses to answer the caller's *own* question, which is a
withdrawal wearing the wrong tool's name.

`question_cancel` is the mirror of that and so takes no `session_id` at all: it
withdraws the copy in the *caller's* session, and a copy a fork carried
elsewhere is that session's agent's to withdraw. When the caller is not among
the sessions waiting, the refusal names the candidates the same way.

There is deliberately **no tool that lists questions**: the answer arrives as a
message, so a list would only invite an agent to poll for it inside the turn it
was told not to wait in. For the same reason the `question_post` description
carries the whole contract — an ordinary session gets no system prompt, so the
description is the only place it can be said.

See [Posted Questions](agent-integration.md#posted-questions).

### Agent Role Tools

| Tool | Purpose |
|------|---------|
| `agent_role_list` | List available roles (without prompts) |
| `agent_role_get` | Get role details including system prompt |
| `agent_role_reset_defaults` | Reset to default roles |

Two of these return less than their name suggests: the listings omit the body and
**A tool description is a prompt.** It is all an agent knows about a status it
never sees the code for, so the descriptions carry the same vocabulary as
`lifecycle_rules`: `story_list` and `task_list` gloss the four statuses they
return, `question_post` carries its whole contract (see below), `story_wait` says that
the news of a child closing clears the wait *and* that a wait with no subtask
running is rejected, and `step_done` says it is not a way to pause and that
completing a step withdraws the questions asked during it. The two
rejections are named rather than left to be discovered, and in both of the
places a rule can be read *before* it is hit: here, and in the lifecycle section
every engine message carries ([Prompt Format](#prompt-format)). `mcp/tools_test.go`
holds these two descriptions to it.

`agent_role_list` omits the role prompt, so that listing cannot pull someone
else's instructions into the agent's context. That is a containment rule, not a
size one, and it is stated with the rest of the tool shapes in
[api.md](../projects/api.md#security-prompt-injection-prevention).

### MCP Server Architecture

```
server/mcp/server.go    — stdio proxy (Server) + Client
server/mcp/executor.go  — server-side tool logic (Executor)
server/mcp/handler.go   — local HTTP API (APIHandler)
```

The MCP subprocess is a **thin client**. It opens no store and starts no
watcher; instead it forwards every tool call over HTTP to the running main
server, which executes it in-process against the same stores the WebSocket
layer uses:

```
AI CLI (claude / codex)
    │ spawn: `pockode mcp --data-dir <dir>`
    ▼
MCP stdio proxy (Server)
    │ reads <dir>/server.json → { local_url, token }
    │ tools/call ──HTTP POST /api/mcp/tools/call (Bearer token)──►
    ▼
Main server: APIHandler → Executor → work.Store / WorkStarter
```

The `<dir>` passed to the proxy is always the **main** data dir, because that is
the only place `server.json` is written — there is one server per process, even
when a work runs in a named worktree. A worktree has its own data dir for session
state, but pointing the proxy there would find no `server.json` and leave the
agent unable to reach the `work_*` tools (see `StartOptions.MCPServerDir` in
[agent-integration.md](agent-integration.md)).

**Why client mode** (rather than letting the subprocess write the store files
itself):

- **Single writer** — only the main server mutates work data, so there is no
  two-writer fsnotify sync to coordinate.
- **Direct side effects** — `story_start` / `task_start` / `work_reopen` run through the shared
  `work.Operations`, which owns the store transition and its follow-up alike, so a
  transition takes effect immediately instead of waiting for the main server to
  notice a file change.
- **One implementation per transport** — the WebSocket handler (user actions) and
  the MCP Executor (AI actions) call the same `work.Operations`, so a
  user-triggered command and an AI-triggered one behave identically.

**Authentication**: the server generates a random token at startup and writes
it to `server.json` alongside the port. Being a credential, it goes into a data
directory restricted to the current user (see
[Authentication → Credentials on Disk](authentication.md#credentials-on-disk));
a `0600` mode would protect it on unix only.
It is distinct from the user-facing `--password` (which is never written to
disk) and lives only for the lifetime of the process. `middleware.Auth` bypasses
the exact `/api/mcp/tools/call` route; the `APIHandler` verifies the local token
itself. The endpoint is loopback-only in practice — the relay explicitly refuses
to forward `/api/mcp/*`, so it is never reachable remotely.

All tool results are JSON (not formatted text) where structured data is
returned, to prevent prompt injection and ensure stable parsing. A tool whose
handler fails comes back as an `isError` result (the AI sees it); transport or
auth failures are surfaced to the AI rather than failing silently.

## The Work Engine

`work.Engine` is the only thing that moves a work item without being told to by a
person or by an agent. It has exactly seven inputs, and no special cases beside
them. What the old `AutoResumer` and `StatusSyncer` did with process state
changes is gone: a process state is not a work state, and every rule that read
one turned out to be a rule about a turn ending — which is what the engine reads
instead.

| Input | Reached by |
|---|---|
| A turn ended | `session.TurnSettler` → `process.Manager.SetOnTurnEnded` |
| The user handed the session something to go on | the three chat RPCs |
| A posted question was answered | `chat.message` with `answering`, or the `question_answer` MCP tool |
| An agent posted a question | the `question_post` MCP tool |
| A child work left active | the work store's own change event |
| The session was deleted | the session store's own change event |
| The server started | `RecoverStartup`, before any session exists |

### Input 1: a turn ended

A turn ending is a fact; "this session has stopped" is a guess, because a
session can start running again a moment later. The settler holds the ending for
a moment and drops it if the session comes back
([agent-integration.md](agent-integration.md#settling)) — so the engine never
sees an ending that was immediately superseded, and needs no settle delay,
activation counter or in-flight bookkeeping of its own.

| Outcome | Outstanding | What happens |
|---|---|---|
| `aborted` | anything | → `stopped` |
| `completed` / `failed` | a question of this session's own | nothing; the answer is what carries on from here |
| `completed` / `failed` | a subtask's unanswered question, and none of its own | its own nudge, asking the story to settle it; → `stopped` once the allowance is spent |
| `completed` / `failed` | a `child` wait | nothing; a subtask closing wakes it |
| `completed` / `failed` | nothing | the ordinary nudge; → `stopped` once the allowance is spent |

**The table is read top to bottom, and the order is the whole rule.** The three
things being read live in three different places — a question of this session's
own is on the *session*, a subtask's question is on *another* session, a wait is
on the work record — and two of the orderings between them are load-bearing.

- **The story's own questions are asked first**, before its subtasks'. That is
  what keeps a story which is *already* asking the user on a subtask's behalf
  from being nudged for that subtask — and so out of the stop at the end of the
  allowance. There is no separate rule saying "a story that is asking is
  exempt"; the order is that rule.
- **The wait is asked last**, after the subtasks' questions, which is the
  opposite of what it looks like it should be. A story waiting on its subtasks
  is the commonest holder of an unanswered subtask question: a wait says "there
  is nothing for me to do until a subtask closes", and a question addressed to
  the story makes that untrue. Reading the wait first would silence exactly the
  case this input was added for.

A wait and a question are otherwise orthogonal — a story can be waiting on its
subtasks and have a question outstanding at once — and either alone makes an
ending unsurprising.

**A subtask's question is the story's to settle, which is why it is nudged for
rather than left alone.** A story is its subtasks' coordinator: it answers the
question (`question_answer`) or asks the user itself (`question_post`), and
doing nothing is not one of the options. The nudge is a message of its own
(`work.BuildChildQuestionReminderMessage`) rather than the ordinary one, because
what this story has to do is not what the ordinary nudge describes; it quotes
every outstanding question whole, with both halves of each question's identity,
since the story cannot fetch them — they live on the subtasks' sessions.

**Only an `active` subtask's questions count**, and the two kinds left out are
left out for different reasons. A `closed` or never-started subtask has nothing
real to read: closing withdraws a session's questions and an `open` one never
had a session to ask from, so anything found on either is a leftover. A
**`stopped`** one does still hold its question — which is why the row a user
reads goes on counting it ([Unanswered Questions](#unanswered-questions)) — but
it is no longer the story's to settle. A person took that subtask back; the
subtask is not blocked on an answer any more; and an answer would restart it
([input 3](#input-3-a-posted-question-was-answered)). Nudging the story about it
would spend the story's allowance, and possibly stop the story too, over one
stop the user asked for. The two counts differ on purpose: one asks "is anyone
still owed an answer", the other asks "is this the story's to give".

**Both nudges share one allowance, and either can end in the stop.** The
allowance bounds how long Pockode goes on telling an agent something it is not
acting on, and a story ignoring its subtask's question is exactly that; only the
stop comment differs, naming what is still outstanding. A story that is
*asking* on its subtask's behalf never reaches that stop, because asking moves
every later ending into the first row. What acting does not do is give the
allowance back: an answer clears the *asking* session's nudges, not the story's
([input 3](#input-3-a-posted-question-was-answered)), so a story that answers and
then goes quiet carries its count into the ordinary rule — which is the ordinary
rule doing its job: what it counts is an agent ending empty turns, and answering
was one turn ago.

The questions are read **live**, through `work.TurnSource`, at the moment the
decision is taken rather than carried on the ending. An ending is held back for
the settle delay, and a question answered inside that window must not still look
outstanding — nor must one posted inside it look absent. A session the turn
source cannot read counts as *having* questions: not knowing is not a reason to
nudge, because a nudge that should not have been sent spends the allowance that
ends in a stop.

**A subtask's unreadable session defaults the other way** — to no questions —
and that is the same principle rather than an inconsistency. The story's own
list can only ever *suppress* a nudge, so guessing generously costs nothing; the
subtasks' list is what *sends* one, so guessing generously would invent work for
a story to do. The two cannot disagree in practice anyway: subtasks inherit
their story's worktree, and the story's own read is taken first.

An aborted turn was taken away rather than finished — a user interrupt, a denied
permission, the death of the process carrying it. Carrying on is the one thing
nobody asked for, so the work stops. A *failed* turn is nudged like a completed
one: an agent whose turn errored has usually lost a tool call, not the thread,
and the nudge limit is what bounds the cost of being wrong about that.

`DefaultMaxNudges` is 3. A nudge is a guess that the agent stopped mid-task;
three in a row with nothing to show is evidence the guess is wrong, and the work
is handed to a person with a comment saying who stopped it — otherwise it is
simply found stopped after a run of empty turns.

**The count lives on the work record**, not in a map keyed by session. It
survives a restart (a stuck agent gets no fresh allowance) and it is reset by
everything that counts as progress: a step advance, a user message, a reopen, a
child closing, a start, an answer.

### Input 2: a user message

A message, a permission answer, a question answer: the work goes back to
`active` with its wait and its nudge count cleared. A person is the one thing
every wait is defined to be woken by, and their attention is what the allowance
was counting down to.

The three RPCs that hand a session something to go on call
`Engine.HandleUserMessage` (`server/ws/rpc_chat.go`). Two paths deliberately do
not:

- **Interrupt.** It takes the turn away rather than handing the session
  something, and the aborted turn it produces stops the work; clearing the wait
  first would only walk the work into `stopped`.
- **The system-driven senders** (kickoff, restart, step advance, reopen, child
  closure). They put a message into a session, but they are not a person looking
  at the work, and each already clears what it means to clear.

### Input 3: a posted question was answered

The answer reaches the engine by two routes — a `chat.message` carrying
`answering` from the user, and the `question_answer` MCP tool from another agent
([agent-integration.md](agent-integration.md#an-agent-may-answer-and-the-record-says-who-did))
— and they are **one input**, `Engine.HandleAnswer`, because they are one event
as far as the work is concerned.

**Who answered is not a fact about the work's status.** Either answer hands the
agent the one thing it stopped for, and a turn starts on the back of it; a work
whose session is running has to be `active`, or the engine is not driving
something that is genuinely under way, the list shows it as stopped, and nobody
sees the turn out. So a `stopped` work is woken whichever route the answer came
by. Who gave it is kept where it belongs — in the transcript, on the record and
in the wording of the message the asking agent receives.

**There used to be a second rule here, and it is gone**: that only a person
takes a `stopped` work off the shelf, so an agent's answer cleared the nudge
count and left the status alone, and `question_answer` refused to deliver into a
stopped work at all. It traded a correct status for a permission rule, and the
status is the one the rest of the engine reads.

The input does one less thing than input 2 on purpose: the nudge allowance
starts over (`Store.ClearNudges`) and a `child` wait is left exactly where it
was. An answer is not general-purpose attention. The agent asked one specific
thing and went on working; a story that afterwards declared it was waiting for
its subtasks is still waiting for exactly that, and no subtask closed. Clearing
the wait would resume a story with nothing to do and then nudge it for having
nothing to do. Typing a message *without* answering anything is different and
still clears the wait — that is a person redirecting the work, which is the one
thing a `child` wait yields to besides a subtask closing.

The fork between this input and input 2 is taken in the handler, on what the
client sent rather than on what the send resolved to: an empty `answering` is a
person typing.

**The allowance that starts over is the asking session's**, because that is what
the input is keyed by. A story answering its subtask's question therefore clears
the *subtask's* count and not its own, which is what [input
1](#input-1-a-turn-ended) rests on.

### Input 4: a subtask's question reaches its story

A story usually knows what its subtask is asking about — it decided it, or a
sibling settled it — so a question posted by a work with a parent is passed up as
a `child_question` message carrying the question, its `request_id` and the
subtask's session id. The session id travels with the request id because the
pair is what names a question ([Question Tools](#question-tools)), and one extra
id costs less than the refused call a story would otherwise spend discovering a
fork.

The story answers with `question_answer`, or asks the user itself with
`question_post`. **Leaving it is not a third way** — the story is the subtask's
coordinator, and a question left sitting there is what [input
1](#input-1-a-turn-ended) nudges the story for.

**It clears no wait.** A `child` wait ends when a subtask *closes*, and a subtask
asking a question is not that — the subtask carries on either way. So a story
that answers and ends its turn is still waiting for exactly what it was waiting
for, and is not nudged for it. That is the mirror of input 5, which does clear
the wait, because there the thing being waited for has happened. The message says
so in words, because an agent handed something to do otherwise assumes its wait
is over.

**Nothing is retried and nothing is stopped when it cannot be delivered** — a
stopped or closed story, one whose turn is held open by a permission request.
That is the other half of the same difference: the two notifications below carry
news a waiting parent is *owed*, so an undelivered one leaves it waiting for
something that already happened. This one takes nothing away. The question stays
on the subtask, where the user can see it and answer it.

**Nor is an undelivered one forgotten.** The question is on the subtask's
session, and the story's every later turn ending is read against that live list
([input 1](#input-1-a-turn-ended)), so a story that never received this message
is still asked to settle the question. The restart and reopen prompts say the
same thing sooner, by telling a story to read its subtasks' unanswered questions
(`work_get`).

### Input 5: a child work left active

The engine hears every work change, and a child leaving `active` is one of two
things it reads off them (the other is
[the session lease](#the-session-lease)). Two quite different things are read
off it, and which one depends on whether the child *closed*.

**A closing child has a report to deliver**, so its parent is told whether or
not other subtasks are still running.

| Parent status | Wait | Transition | Message |
|---|---|---|---|
| `open` | — | — | No — no agent session started yet |
| `active` | `child` | wait cleared | Yes |
| `active` | none | — | Yes |
| `stopped` | — | — | No — see below |
| `closed` | — | — | No — a child closing is no reason to reopen it |

Only a parent waiting on its *children* has been handed what it was waiting for.
A parent waiting on the **user** has not, so its wait stands; the news reaches
its transcript either way. That is what lets a coordinator receive several child
completions while running parallel subtasks.

**A stopped parent is told nothing, and that is stricter than the old rule.** A
message is not a note left on a desk: it starts a turn, and a session whose
process has been collected gets a new one built for it. Telling a stopped parent
therefore spawns a CLI and lets it work on a story a person has taken back —
which is the one thing `stopped` exists to prevent. Nothing is lost by waiting:
the child's report is a comment on the work, its closure is in the store, and the
restart prompt tells the agent to review its tasks before doing anything.

The sender is resolved **before** the transition, so a resolve failure cannot
leave a waiting parent resumed but un-nudged.

#### A wait nothing could end

A child that left `active` **without** closing — deleted, stopped, or rolled
back to `open` — has no report to deliver, and is news only in one case: it was
the last thing its parent's wait could have been waiting for.

A `child` wait is ended by exactly one event, a subtask closing. So a parent
waiting with no subtask running is waiting for something that will never happen,
and nothing would look at it again: the engine does not nudge a waiting work
(that is what a wait means), the idle lease collects its process minutes later,
and `waiting_children` is deliberately outside the attention dot
(lifecycle-ui.md §4). It is the one shape in this model that can be stuck with
nobody told.

So the engine clears the wait and tells the agent — it does not decide what
should happen instead. Only the agent knows whether the subtask should be
restarted, replaced, or was never needed, and once the wait is gone the ordinary
nudge allowance applies again, which is the backstop if the agent does nothing
with the news. **Stopping a parent whose agent is reachable would be worse than
the bug**: it takes away the recovery that costs nobody anything — the agent
restarting the subtask itself — and makes a user who stopped one subtask restart
two things. That holds exactly as long as there *is* an agent to wake, which is
why the two cases below, and [input 7](#input-7-startup), stop instead.

Three ways a child can leave without closing, and the message names which,
because the way back differs:

| How it left | What the parent is told to consider |
|---|---|
| deleted | create a replacement with `task_create` — there is no id left to restart |
| stopped | restart it with `task_start`, by id |
| rolled back to `open` | start it with `task_start`, by id — and that the start it already had did not take |

**The whole decision is one store call.** `Store.ClearChildWaitIfStranded` asks
both halves of the question — is this wait stranded, and am I the one ending it
— under the store lock, and only the caller it answers `true` sends the message.
It is the one transition here not written through `setLiveStatus`, because its
condition spans the work *and its children* and `setLiveStatus` hands a mutate
func the single record it is changing.

Splitting it into a read and a write fails in both directions, and neither is
hypothetical: several subtasks can leave `active` at once — a user stopping two,
a delete cascade — and each follow-up would read a parent that is still waiting
and send the same news twice; and a person can start another subtask while the
check runs, so the message would go out claiming nothing is running when
something is. The engine's own status and wait checks before the call are only a
cheap way to avoid reaching for a sender it will not use.

**A parent the engine cannot reach is stopped, not left waiting.** Resolving the
sender can fail — a worktree that will not load — and the news is lost either
way; what must not be lost is the parent. So a failure to deliver falls back to
the same question: is anything left that could end this wait? If a subtask is
still running, nothing is done and that subtask's own exit brings the engine back
here. If nothing is left, the wait ends and the work stops, with a comment saying
the agent could not be reached. This is the startup rule arriving early: waking
presumes an agent to wake, and an unreachable session is not one. The same
fallback covers a *closing* child whose report cannot be delivered, since that
too leaves a parent's wait with nothing behind it.

For the same reason `Engine.OnWorkChange` does **not** skip these follow-ups when
no sender resolver is installed. It used to, and that silently turned "I cannot
reach this parent" into "this parent was never owed anything" for every event
arriving before the resolver was wired. `main.go` now also installs the change
listener only after the resolver, so the window is closed from both ends.

The refusal in [`Operations.Wait`](#commands) closes the same gap from the other
end: this input covers a wait that *became* unendable, the refusal covers one
that never could have ended. Both decisions are taken in the store, by the same
predicate, for the same reason — neither may be assembled from a read and a
write.

### Input 6: the session was deleted

A deleted session takes away the place every answer and every nudge would have
gone, so the work above it stops — including one that was *waiting*, which is the
case a dying process deliberately does not cover. The difference is the whole
point: a process can die and be resumed, a deleted session cannot.

It is reached through the session store's own deletion event
(`Engine.OnSessionChange`), so it covers every way a session can be deleted
rather than being a special case in one RPC handler. Deleting a *work* needs no
such rule: it cascades into its sessions, so no work is left behind to lie about
its status.

### Input 7: startup

`RecoverStartup` runs once, before any session exists.

| At startup | Outcome | Why |
|---|---|---|
| `active`, nothing outstanding | → `stopped` + comment | Its process is gone and nothing will end the turn it was carrying |
| `active`, a question nobody has answered | preserved | The answer comes from outside the session and still reaches it |
| `active`, waiting on children, a child still `active` | preserved | That child still wakes it when it closes |
| `active`, waiting on children, none left `active` | → `stopped` + comment | Nothing is left that could end the wait — usually because the first row just stopped its last subtask |

This is the difference the old model could not express, and why every paused work
used to come back from a restart stopped. What a work is waiting for outlives the
process by construction; a work waiting for nothing has nothing left to wake it.

**A subtask's unanswered question is deliberately not in that table**, though
[input 1](#input-1-a-turn-ended) reads it. This pass asks what could still reach
a work, and a story told about its subtask's question could do nothing with it:
no process survived, so there is nobody to answer or to ask on its behalf. The
first row is right about such a story, and stopping it is also what puts it
where a person can find it — the subtask's question is still on screen and still
answerable meanwhile.

The stop gets a comment, since nobody asked for it and the background tasks the
work may have been waiting on died with the server. A preserved work gets none —
nothing happened to it.

**The last row is a condition, re-examined after the stops, not a reaction to
them.** Recovery runs before the engine is a listener on the work store, which
is deliberate — nothing should be reacting to its own recovery, and the worktree
manager its follow-ups would need does not exist yet. The price is that the stops
it makes reach nobody, so it asks *"is anything left that could end this wait"*
itself rather than waiting for an event. Written as a reaction it would have to
be ordered against the stops, and ordering is exactly what produced the failure:
a story left waiting on a subtask that startup had already stopped sat `active`
forever, with no nudge, no process, and nothing on screen to distinguish it from
the stories that were really running.

**It also beats the second row: a work whose wait has nothing left to end it is
stopped even with a question outstanding.** A wait is not something an answer
ends — answering clears the nudge count and leaves the wait exactly where it was
([input 3](#input-3-a-posted-question-was-answered)) — so a work left
`active` here would sit on that wait for good, exactly the state this pass
exists to end. It takes nothing from the question either: questions outlive a
stop, the user is still offered them, and answering one wakes the work like any
other message.

One pass is enough, and that rests on the shape rather than on luck: a `child`
wait only ever comes from `SetChildWait`, which requires an active task, and
only a story can hold tasks (`Work.StoryID`). Nothing sits above a story stopped
in this pass, so no stop in it can strand another wait. A third level is what
would turn this into a loop to a fixed point, and the model cannot express one
— `TestCreate_StoryIDMustNameAStory` is where that is held.

**Startup stops where [input 5](#a-wait-nothing-could-end) wakes, and the two
agree rather than contradict.** Waking hands the decision to the agent, which
presumes there is an agent: at startup every process died with the last run, so
there is nobody to decide and nothing to tell. Stopping is also what keeps it
findable: `stopped` is a list group of its own with a Restart in the row, while a
work waiting on children sits in *Active* among the ones that are really running
(lifecycle-ui.md §6.1). Neither carries the attention dot — that is reserved for
work needing a person *now* (§4).

The prompts a restart destroys are the session layer's business, not the work
layer's: a killed process's blockers expire through the reducer and a
`process_ended` record lands in the transcript, so the cards read Expired
([agent-integration.md](agent-integration.md#restart-repair)). A **posted
question is not one of those cards** and survives untouched: it belongs to the
session rather than to the process, and the message carrying its answer reaches
the work whenever the user gets to it. That is why recovery keeps such a work
active, and why it reads the unanswered list straight off the session index on
disk (`worktree.StartupTurns`) — recovery runs before the worktree manager
exists, and with no process left alive the file *is* the live value.

### The session lease

**A work that has left `active` has no lease on its session's process.** The
rule is hung on the transition (`Engine.enforceSessionLease`) rather than on each
command, so it holds for the engine's own stops as much as for a user's Stop:

| Status | What happens to the process |
|---|---|
| `stopped` | Ended now (`StopSession`). The user asked for the work to stop, and a turn still running is what they asked to be rid of |
| `closed` | Retired (`RetireSession`): it may finish the turn it is in the middle of, and nothing more |

What is terminated is the *process*. The session id and its transcript stay,
which is what makes Restart and Reopen resume rather than start over.

Retirement is `process.Manager.RetireSession`
([agent-integration.md](agent-integration.md#retiring-a-closed-works-session)):
every prompt on screen is cancelled with reason `work_closed` — now and for as
long as the retirement lasts, so a question raised inside the grace does not sit
pending forever on a work the user has finished with — the turn ending ends the
process with it, and the grace is a deadline rather than a budget activity
extends.

A prompt cancels the retirement, because it falsifies its premise: somebody has
come back to the session. That is the case a Reopen inside the grace lands on —
the restart message goes to the very process the grace was armed for — and the
case of a user typing into a closed work's chat. The work stays closed; the
session's process is then governed by its own idle lease, like any session with
no work above it.

`worktree.Manager` implements both, and looks only at worktrees that are already
loaded. That is exact rather than best-effort: a worktree holding a live process
is never cleaned up, so an unloaded one provably has no process to stop —
and building one would mean starting watchers and a process manager for every
work a restart stops.

### Commands

The six things a person or an agent can ask for live in `work.Operations`, and
both transports go through it — the WebSocket handler (user actions) and the MCP
`Executor` (AI actions). A user-triggered command and an AI-triggered one are
therefore the same command and cannot drift apart; before, the waits and stop had
an implementation each, and every bug found in one had to be found again in the
other.

| Command | Store transition | Side effect |
|---|---|---|
| `StartWork` | `Claim` (atomic restart/session decision) | `WorkStartHandler` creates the session and sends the kickoff; rolls back on failure |
| `StopWork` | `Stop` | the process ends with the transition |
| `ReopenWork` | `Reopen` | reopen nudge |
| `StepDone` | `StepDone` | next-step prompt while steps remain; withdraws the step's questions; refused when it would close a work whose subtasks are still active |
| `Wait` | `SetChildWait` | refused when no subtask of the work is running |
| `DeleteWork` | `Delete` (the subtree) | the subtree's sessions and their processes go with it |

`DeleteWork`'s cascade is in `Operations` for the reason the table exists at all:
it used to live in the WebSocket handler, so an agent's `work_delete` left
behind the sessions a user's delete removed. A session whose work is gone cannot
be reached — the work detail page is the way in — so leaving one is leaving
something unreachable, and a process still running for it is working on a result
nobody can read.

**The two refusals are exactly complementary**: `Wait` is accepted precisely
when the `StepDone` that would close the work is refused. That is not symmetry
for its own sake — each error names the other as a way out, and "call `story_wait`
instead" would be a lie if the wait could be refused for the same work.

What `Wait` refuses is a wait that nothing could ever end: a `child` wait is
ended by a subtask closing, and a work with no subtask running has none coming.
The error names the subtasks that could be *started* rather than counting them,
because "nothing is running" and "you never started them" are the same sentence
to an agent that has just created three — and names what to do when there are no
subtasks to start, which is a different answer again (docs/lifecycle-ui.md §7).

**The refusal is the store's decision; only the wording is here.** `Wait` calls
`SetChildWait`, which checks and sets under one lock and answers whether it set
anything; `Operations` turns a `false` into a sentence. Checking here and setting
afterwards leaves a window in which the last active subtask stops, the engine
looks at a parent that is not waiting yet and rightly does nothing, and the wait
then lands with nothing left that could ever end it — the exact failure this
whole rule exists to prevent, rebuilt out of two correct halves.

**A completed step withdraws the questions asked during it**
(`QuestionWithdrawer`, implemented by `worktree.Manager`, reason `step_done`). A
question is about the step it was asked in; once the step is over the agent has
moved past it, and an answer would arrive for work already finished while the
user was asked for nothing. Only on an *advance* — the step that closes the work
is left to the retirement, which withdraws them with the reason that says more
(`work_closed`, [the session lease](#the-session-lease)); doing both would write
two withdrawals for one question and race over which reason the user reads.

**Stopping withdraws nothing**, and that is the deliberate opposite. A stopped
work has been handed back to a person, and the questions are exactly what that
person is being handed: they survive the stop, survive the restart after it, and
answering one wakes the work like any other message.

Process termination is deliberately **not** in `Operations`: it belongs to the
transition, not to the command that caused it (see
[the session lease](#the-session-lease)).

```
step_done ──► Operations.StepDone()
                   │
                   ▼
            hasMoreSteps?
              │        │
            yes        no
              │        │
              ▼        ▼
       CurrentStep++   Close work ──► the parent is told (input 5)
              │                       the session is retired (the lease)
              ▼
       Engine.NotifyStepDone() ──► send next-step prompt
```

The reopen message instructs the agent to review its previous work and determine
what additional changes are needed, then call `step_done` when complete.

### Background Waits and the Work Item

A Claude turn that started a background task goes quiet for as long as the task
runs. The session records that as a `background` blocker and the turn stays open
([agent-integration.md](agent-integration.md#background-waits)). The work stays
`active` with no wait, because that is simply true — the engine is driving it and
the job is not done — and the user is told what is really happening by the
derived activity, which reads the blocker: `background`, not `running` and not
`idle`. That is the whole of what the work layer needs to know about it.

The nudge is not exempted from the wait; it is never triggered in the first
place. The engine acts on a turn *ending*, and a parked turn has not ended. This
is the same path a long tool call already takes, which is why a wait of any
length needs no work state of its own.

The two ways a wait ends both land back on ordinary behaviour:

- **The background lease runs out.** The reaper ends the parked turn
  ([agent-integration.md](agent-integration.md#the-lease-table)), the turn ends,
  and the engine runs the ordinary nudge — except the agent also receives the
  explanation queued by the reaper, so the nudge does not read as an unexplained
  demand to continue.
- **The process dies during the wait.** The turn is aborted by
  `SignalProcessEnded`, which reaches the engine as an ordinary aborted ending
  and stops the work. A death nobody is left to observe — a server restart —
  reaches the same state by the other route, `RecoverStartup`.

### Follow-ups During a Background Wait

During a wait the CLI has no active turn of its own, so any message Pockode sends
opens a new one immediately.

Only the nudge is gated by the parking, because it is driven by a turn ending.
Every other send is message-driven and reaches the CLI regardless of what the
turn is doing; three of them can land on an agent's *own* waiting session: step
advance, reopen, and child-closure reactivation. (The worktree
starter's kickoff and restart are unconditional too, but they target a work being
started rather than a session already mid-wait.)

**These senders send immediately and do not wait for the background wait to
finish.** The alternative — queueing them until the wait ends — was considered
and rejected:

- **It would not work for `step_done`, the most likely of the three.** The
  command calls `NotifyStepDone` from inside the tool call, i.e. while the turn
  that invoked `step_done` is still running. The turn has not been parked yet and
  the wait is not armed, so a gate on "is a wait in progress" never sees it. The
  CLI simply queues the message and starts it the moment the turn ends.
- **The user is not gated either.** `chat.Client` has no state-based block, so a
  user can type during the wait and get a new turn the same way. A system-origin
  message travels the identical path; deferring only those would be an
  inconsistency that buys nothing.
- **The interleave is visible to the agent, not silent.** The CLI reports the
  agent's own live background tasks and delivers the completion notification into
  whatever turn is running, so the model can see it still has work pending and
  check it with `BashOutput`.
- **Nothing downstream breaks.** The injected turn's content clears the
  `background` blocker — content is what proves the CLI resumed — and its own
  ending parks the turn again while the task set is still non-empty. The wait
  therefore ends exactly when the set has drained, and the lease it is holding is
  measured from the last parking rather than the first.
- **Deferring costs more than it saves.** The queue would have to survive process
  death and server restart or lose the message, and would hold it for up to the
  background lease's budget. A reopen or child-done that produces nothing for
  that long is a silent stall — exactly what "no silent failures" forbids —
  traded against a context interleave the agent can see and handle.

If the interleave ever does prove to confuse models, the fix belongs at the
message itself (say that a background task is still pending) rather than in a
host-side deferral queue.

### Per-Worktree Sender Routing

Every follow-up the engine sends (nudge, step-advance, reopen, child-done) must
reach the worktree the target work runs in — not a single
global sender. It therefore holds a `SenderResolver` rather than one
`MessageSender`, and resolves per send from the work's `Worktree`:

```
resolver.ResolveSender(work.Worktree) → (sender, release, err)
```

Production wires the worktree `Manager` as the resolver (`main.go`), so each
message goes to that worktree's chat client. Because worktrees are
reference-counted, `ResolveSender` returns a `release` func the engine **must**
call once the send completes (always via `defer`) to drop the reference.

- **Child-done routes to the parent's worktree**, not the child's. The subtree
  shares one worktree so they usually match, but the parent owns the session
  being nudged, making it authoritative.
- **Resolve before mutating state** in parent reactivation: a waiting parent is
  only activated after its sender resolves, so a resolve failure can't leave the
  parent resumed but un-nudged (all-or-nothing).
- `SetSender` remains for tests and callers that don't need routing — it installs
  a static resolver that maps every worktree to one sender. When no resolver is
  installed the engine stays inert, the same gate as before.

### Why There Is No Settle Delay Here

The engine keeps no timer, no activation counter and no in-flight map. Both were
in the old resumer for one reason — a session that stops and comes back inside a
couple of seconds, which happens more easily than it looks: Codex aborts the
running turn the moment a second message replaces it, and answering a prompt on a
reaped session builds a new process. Acting on the older event would stop or
nudge work whose agent is running right now.

That guess is now made once, in the session layer, by `session.TurnSettler`
([agent-integration.md](agent-integration.md#settling)), and every consumer gets
the settled answer from there. The engine's inputs are facts by the time they
arrive, so there is nothing left here to wait for.

The step-done race the old settle delay also covered is gone by construction
rather than by timing: an agent calling `step_done` mid-turn resets the nudge
count in the same store write that advances the step, and the ending that follows
is judged against the record, not against a cached count.

## Worktree Deletion Protection

Deleting a worktree that still owns unclosed work would orphan sessions that are
live or resumable, so `worktree.delete` refuses it. `handleWorktreeDelete`
checks `work.UnclosedWorkByWorktree(works, name)` — every work whose `Worktree`
matches and whose status is not `closed` — *before* touching git or runtime
state, and returns a client error (`CodeInvalidRequest`) if any exist.

**Why in the work layer**: ownership is a Work concept (the `Worktree` field),
so the predicate lives in `server/work/store.go` as a pure, testable helper; the
WS handler only wires it into the delete flow and formats the rejection.

The error message names how many and *which* works block the delete (`<id>
"<title>" (<status>)`), because the developer needs to know what to close or move
before retrying — a bare refusal would not be actionable.

**main is unaffected**: the main worktree's name is `""`, and the delete handler
rejects an empty name earlier (and `registry.Delete("")` returns
`ErrMainWorktree`), so this check never governs main.

### What a Deletion Leaves Behind

The protection above is about *unclosed* work. Once the work is closed the
worktree may go — and the sessions under it stay: `Manager.ForceShutdown`
deliberately keeps the worktree's data directory. A work usually runs in a
worktree of its own and that worktree is cleaned up as soon as the work is done,
so removing the conversation with it destroyed the record of how the result was
produced, with no way back. What is left is readable from anywhere else in the
project and never writable (see
[agent-chat.md](../agent-chat.md#sessions-outlive-their-worktree) for the methods
that read it, and [websocket-rpc.md](websocket-rpc.md#a-binding-whose-worktree-was-deleted)
for what a connection still bound to the deleted worktree may do — nothing).

**It is not meant to accumulate forever, so both deletion outlets go on working
across a deleted worktree.** `DeleteWork`'s cascade (see
[Commands](#commands)) reaches its sessions through `Manager.DeleteSessions`,
which no longer gives up when the worktree is **gone**: an existing one is still
deleted *through*, because a session there may have a live process to close and
its store owns the directory, while a deleted one's index is rewritten on disk
directly. Only `ErrWorktreeNotFound` takes that second branch — any other failure
(a directory that is no longer a git repository, a worktree that exists but will
not load) is still a failure, because deleting records from under a store that may
yet open them is not a way of handling one. A session that belongs to no work is
deleted by hand through the same fork in the road, reached by `session_view.delete`
because a connection cannot be bound to a worktree that is not there.

The emptied directory goes with the last session in it, so a project does not
accumulate one empty directory per worktree that ever existed. Only a **deleted**
worktree's: a live one's directory holds more than sessions and may have a store
open on it, and the main worktree's *is* the project's `.pockode`. Deleting the
worktree checks the same thing, so a worktree whose sessions were all deleted
before it was leaves nothing behind either.

Nothing is notified along the on-disk path, and there is nobody to notify: the
worktree's watchers stopped with it, and the work engine's interest in a deleted
session is to stop the work that was waiting in it — which the protection above
means cannot exist. A client that deletes this way re-reads instead of waiting to
be told.

One consequence to know about: a closed work whose session is deleted this way
keeps the `session_id` in its record, so its detail points at a session that is
not there. That is what `session.delete` has always done, and the protection
above is what keeps the live case ("an open work whose worktree is gone") from
arising at all.

## Usage Aggregation

A work item's detail reports what it consumed: its **own** session's share, and
the **total** over itself plus every one of its tasks
(`work.AggregateUsage`, `server/work/usage.go`). The numbers are the ones the
sessions already recorded (`session.Usage`, `server/session/usage.go`) —
nothing in the work layer re-counts tokens, so a work total and a session total
are the same units added the same way. Where those units come from is [Usage
Reporting](agent-integration.md#usage-reporting); what a user sees of them is
[usage-display-ui.md](../usage-display-ui.md).

**It rides on the detail, never on `Work`.** `Work` is the record the store
holds, while a usage figure is produced by walking every session in the item's
subtree — a `Usage` field on it would hand that walk to every reader of a work
item, `Store.List` first among them, which `AggregateUsage` itself calls to find
the subtree. The field lives on `rpc.WorkDetailSubscribeResult` and on the
`work.detail.changed` notification instead, and the list is held to it by
`server/rpc/work_list_item_test.go`, which pins a row's fields as an exact set:
widening `WorkListItem` to carry an aggregation fails there.

Four facts go out:

| Field | Why it is on the wire |
|---|---|
| `own` | the work's own session lives in the work's worktree, which is not necessarily the active one — reaching its usage from the work detail would mean a second, cross-worktree session subscription |
| `total` | usage is not on the list row, by the rule just above, so the client holds no consumption figure for any work item but the one it has open — it cannot sum its own children even though it has them |
| `task_count` | same reason; it is also what decides whether a total is worth showing, a question that must **not** be answered by comparing `total` against `own` — that would make a column appear the moment a task's first turn lands. It was `descendant_count` while a work could sit at any depth; one level below a story leaves no descendant that is not a task, and a name promising depth invites reading it as one |
| `unpriced_session_count` | how many sessions under the item spent tokens while their agent reported no price. A tree mixing Claude (which prices) and Codex (which never does) would otherwise report a total that looks complete and is not |

No `total_tokens` (the four counters are summed by whoever displays them) and no
context window at any level: a window is a property of one live conversation, and
the sum of several means nothing.

**Absent is not zero.** A missing `own`/`total` means nothing was reported —
no session, a session since cleaned up, or an agent that never reported a token —
and a missing `cost_usd` means no agent in scope reported a price. Both are
displayed as "not reported", never as `0`, which would be a claim an agent never
made. A fork contributes only what it spent itself, since its own usage starts at
zero on purpose (the tokens behind its copied history were spent by the source
session, which is very often in the same tree).

**Sessions are read from disk, per worktree.** A subtree can reach into a
worktree nothing is currently using, and `worktree.Manager.SessionUsages` answers
for it by reading that worktree's session index (`session.ReadUsages`) rather
than through its session store. Going through the store would mean *building* the
worktree — watchers, process manager, git watches — and holding it alive on a
reference, because someone opened a page showing numbers. The file is current:
every usage write persists the index before notifying anyone. Each worktree is
read once per aggregation; one that cannot be read costs the total its share and
says so in the log, rather than failing the whole detail subscription.

**That silence rests on an accidental premise, not on a guarantee.** Losing a
worktree's share yields a total that is smaller than the truth with nothing on
the page to say so — the very thing `unpriced_session_count` exists to prevent.
It is acceptable today only because of a property of [Worktree
Binding](#worktree-binding) above: a work tree normally lands entirely in one
worktree, so an index that cannot be read costs the subtree *all* of its
sessions rather than a slice of them. Both then come back absent, which the page
renders as no usage at all rather than as a partially summed number that looks
complete — "nothing was reported" is a meaning those two fields already carry.
(A deleted worktree does not even reach this branch: a missing index reads as
empty and no error, so it lands on the same absent.) The same premise is why the
cross-worktree lookup here, though real, is used trivially today — one
aggregation usually reads one index.

Nothing enforces that premise. It is how work happens to be bound to worktrees
right now, it already has one hole — a task started ahead of its story keeps the
worktree it inherited, so if the story then starts from a different one, that
tree is split with today's code — and it goes away entirely the moment work may
move between worktrees or a tree may deliberately span several. **When that
changes, `usageLookup.get`'s degradation has to be decided again** — a subtree
quietly missing one worktree's share would then need the same kind of "this
total is incomplete" marker that `unpriced_session_count` carries, instead of a
log line.

**Usage changes without the work item changing**, so `WorkDetailWatcher` also
listens to every worktree's session store (`Manager.AddSessionChangeListener`)
and, on a session change, re-sends the detail of the work item owning that
session **and, when that item is a task, of its story** — the story's total
includes it. There is no level above a story, so that is the whole of it: no
walk, and nothing that could loop. Sessions belonging to no work item (plain
chats) cost nothing.

Two details of that wiring are load-bearing here, and both generalise past this
case — the rules are in
[subscription-system.md](subscription-system.md#why-a-watcher-sometimes-listens-to-a-second-store):

- **The listener is registered on worktrees that already exist, not only on the
  ones built later.** Worktrees are created lazily by whoever needs one first,
  and the engine resolves senders for work it restarts while the server is still
  wiring itself up — so the main worktree can predate the call. Missing it would
  freeze that worktree's work usage for the whole process, with nothing to show
  that it happened.
- **A session change that moved no number sends nothing.** A session is touched
  at the end of every turn, marked unread, marked as needing input; a detail
  notification carries the work item and its *entire* comment list. So the
  watcher compares the fresh aggregation against the last one it sent to that
  subscription (`work.Usage.Equal`) and stays quiet when they match. Work and
  comment changes are never filtered this way — their payload is the news.

## Frontend Integration

```typescript
// web/src/lib/workStore.ts
interface WorkStore {
    works: WorkListItem[];        // the Current segment
    hidden: WorkListHidden;       // { stopped, open }: rows each cap held back,
                                  // so each heading can still count its whole group
    archive: WorkListItem[];      // one page of closed work, fetched on demand
    isLoading: boolean;
    error: string | null;
    // ...plus the cursor stack the archive pager walks, and `archiveStale`:
    // the page admitting a closed story appeared behind it, which is what makes
    // the Closed segment ask again
    // (subscription-system.md#nobody-is-waiting-on-it-is-not-nobody-ever-looks-at-it)

    setWorks: (works: WorkListItem[], hidden?: WorkListHidden) => void;
    updateWorks: (updater: (old: WorkListItem[]) => WorkListItem[]) => void;
    setError: (error: string) => void;
    reset: () => void;
}
```

The frontend subscribes to work changes via WebSocket and updates the Zustand store.

**This store does not answer which sessions belong to work.** That relation is
resolved server-side and arrives on the session itself — a list row and a
session detail each carry their own `work_id`, and `session.list.subscribe`
narrows the list when asked to
([subscription-system.md](subscription-system.md#which-sessions-belong-to-work)).
Inverting the work list to answer it here is the arrangement that section
argues against, and the reason is the store above: this store holds the
`Current` segment and one archive page, so it cannot answer a question about a
work item the user has not paged to.

What a session row does read from this store is what its work is *waiting for*
— `sessionActivity` in `web/src/lib/activity.ts`, and only the `wait` of a work
that is `active`. That is a lookup by the id the row carries, not a scan for an
item that names the row, so a work the store does not hold costs the row its
wait and nothing else: the row is still in the right list, still says what its
own turn is doing, and still links to the right work.

### The List Is the `Current` Segment

`work.list` no longer answers with every work item. It answers with the
**`Current` segment**: every row that screen draws, plus everything those rows
make claims about, and no closed work at all. The archive is a separate, paged
fetch ([websocket-rpc.md](websocket-rpc.md#paging-a-subscribed-list)), and
`workStore` keeps it in its own field — the two halves obey opposite rules, one
pushed to and one never
([subscription-system.md](subscription-system.md#the-two-lists-update-live-in-opposite-ways)).

Three consequences worth stating on their own, because each is easy to undo:

- **A page is not a set of rows; it is a set of rows plus everything they
  assert.** A story's row says `{n} active` and `{closed}/{total} tasks` over
  *all* its children, including closed tasks that get no row anywhere, and a
  task's row names its parent story. So a story and its tasks are always on the
  same side of a cut — in `Current`, and again on whichever archive page the
  story lands on.
- **`Current` is never paged, and that is the design.** Its group counts and the
  Project tab's attention dot are read off it, and an "is there any" asked of a
  page answers *no* for a list nobody has read that far. The question it exists
  to answer — what needs a person — also has a naturally small answer.
- **The detail page no longer reads the list for its subtree** — see
  [the next section](#the-list-holds-rows-the-detail-page-holds-the-item).

Two groups of `Current` grow without limit, since nothing closes either by
itself: *Stopped* and *Not running*. Those two are capped, each on its own
budget and each reporting its own hidden count — a heading shows "rows received
plus rows held back", so one number across two headings would make at least one
of them wrong. One press of "Show earlier work" fetches the overflow of both:
`work.list.earlier` re-sends the segment uncapped, and takes no group argument.

Both caps cut along the order the client lists the rows in — `updated_at`
newest first, the archive's own order, borrowed from `session.ListOrder` rather
than restated so the two cannot disagree on a tie — and eat from the end. What
goes is the tail of what the user sees, never a work they just touched.

**The cap is deliberately soft.** `CurrentGroupCap` is 50 for each group, but
what the cap drops is whole stories — a story cannot be dropped without its
tasks, since it keeps them all for its own roll-up — and a story holding a task
that *is* a row is skipped rather than dropped. Skipping it means the group can
come back slightly over the cap when there are not enough droppable stories.
That is the intended trade: **"*Needs you* is never truncated" is the stronger
invariant**, and a number that is approximate costs a little bandwidth, while a
row that vanishes costs a user the one thing this screen exists to tell them.
Nothing should read the cap as an exact bound on the rows that arrive — least of
all on *Stopped*, where tasks are rows of their own, which makes that group's cap
the softest of the two ([the shape of
it](../list-paging-ui.md#41-current-is-loaded-whole-and-that-is-the-design)).

`hasCurrentRow` (`server/watch/work_list_segment.go`) and `rowGroup`
(`web/src/components/Project/WorkListOverlay.tsx`) are mirrors of each other,
and have to be: deciding what to *fetch* means knowing what is drawn. They are
deliberately asymmetric on a status or type neither side recognises — the server
sends the row, the client does not draw it. Sending a row nobody draws costs one
row; withholding one that would have been drawn makes a work item unreachable,
and a hand-edited or corrupted index must not be one more way for that to
happen.

### The List Holds Rows, the Detail Page Holds the Item

The store holds `WorkListItem`, not `Work`. Which fields that leaves out, and
why, is [api.md](../projects/api.md#work-list-rows-vs-work-detail); what the
frontend adds is a type that keeps the two from drifting apart —
`Work extends WorkListItem` (`web/src/types/work.ts`), so a field added to the
item is detail-only until someone puts it on the row deliberately.

The split decides where each surface reads from:

- **`WorkDetailOverlay` reads the open item from `useWorkDetailSubscription`,
  never from the store** — and not just the detail-only fields, but every field
  of it, `title` and `status` included. Taking those off the row instead would
  give one item on one page two sources that can disagree.
- **The two relations it draws — its children and its parent — arrive with the
  detail, not out of the store.** They used to be filtered out of the work list,
  which was correct while that list was every work item. It is now the `Current`
  segment and holds no closed work, so a closed story opened from the archive,
  or simply reloaded on, would show no tasks while its own row claims
  `{closed}/{total}` over them — and reloading is a daily act on a URL people
  share. A story bounds its own children and its detail page does not page them,
  so the detail is the natural place to answer for them; the alternative was a
  page stitching two arrays together and being wrong whenever one of them was a
  page. The cost is a few extra rows on every detail notification, bounded by
  one story's task count.
- **The list side never wanted the dropped fields.** `WorkListOverlay`,
  `useWorkNeedsAttention` (the Project tab's dot and its tab badge),
  `WorktreeBadge` / `isWorktreeBound` and the session row's wait lookup read
  none of them, which is why narrowing the store changed no behaviour.

`work.create` and `work.start` answer with the same `rpc.WorkDetailItem` the
detail does ([api.md](../projects/api.md#work-list-rows-vs-work-detail)).

### One Vocabulary for Work Status

Two surfaces paint a work's state — the project list and the detail page, the first of them through the shared `WorkRow` (docs/project-ui.md §3.1) — and they draw it from one set of sources so they cannot disagree: glyphs, tones and labels from `ACTIVITY_VIEW` (`web/src/lib/activity.ts`) through `ActivityIcon` and `ActivityBadge`, step arithmetic and wording from `web/src/utils/workSteps.ts` (`getStepProgress` / `formatStepProgress`), and the step markup from `StepList`, which renders a step's text as Markdown — the same rendering the agent role page gives that same string ([docs/lifecycle-ui.md §6.3](../lifecycle-ui.md#63-steplist)). The chat transcript is deliberately not on that list — it shows no status at all, and borrows only the step wording, never that markup (*Work Messages in Chat*). Three notes on the shared vocabulary:

- **The value they paint is the derived `Activity`, never the raw `status`.** The row carries it (see *Activity*) and the detail gets its own beside the item, because it is derived from the session's turn rather than stored on the record. `status` still decides one thing, and only that one: which buttons exist (docs/lifecycle-ui.md §3). A control that appeared and vanished as turns settle is one the user cannot aim at.
- **A work is a static glyph, never a spinner.** An `active` work with an idle process is an ordinary resting state, and a settle delay makes it a transient one too; a spinner would dramatize what a glyph states. The one place liveness is the question being asked is the session list (docs/lifecycle-ui.md §1.5).
- **Colour does not have to tell every status apart.** `open` and `closed` share one muted colour, and in the list the icon often stands without its label — but they are different glyphs (`Circle` against `CircleCheck`), so the glyph carries the distinction and the colour only says "nothing to attend to here".

### Displaying a Work's Worktree

The work list is **global — it spans every worktree** (its subscription sets `resubscribeOnWorktreeChange: false` and survives switches, see [subscription-system.md](subscription-system.md#why-app-level-subscriptions-survive-worktree-switches)). So a single list mixes works from different worktrees, and the user cannot tell where each one runs without a per-work label. Both the list and the detail page therefore surface the work's `Worktree` (below) via a shared `WorktreeBadge` component and a `useWorktreeDisplay` hook.

Design decisions specific to this display:

- **A work whose worktree is not decided yet shows no badge at all**, since a badge would assert a binding that can still change. What counts as decided follows from *Worktree Binding* above: a work that is no longer `open` is already frozen, and an `open` one is decided the moment its **story** starts and propagates the captured worktree down. So an open task is judged by its story, not by itself — that is what keeps the badge on an open task under a running story while hiding it for the same task under a story that has not started. An open story has nothing above it and is simply undecided.
- **The badge resolves that verdict itself rather than being told it.** `isWorktreeBound` (`workStore.ts`) owns the rule and `WorktreeBadge` reads it through a `useWorkStore` selector, so no call site can forget it. Reaching the story needs the whole work list, which is why the badge subscribes to the store instead of taking the verdict as a prop. It is one lookup and no walk — `story_id` names a story, and a story names nothing — so a story missing from that list (subscription not synced yet) leaves the task itself as the answer, which is `open`, which errs toward hiding.
- **The binding is read-only, but the badge is a navigation link.** The worktree binding is frozen once a work starts (see *Worktree Binding*), so — unlike the editable role — the badge never *reassigns* a work's worktree. It is, however — for as long as that worktree exists (see below) — a clickable `<Link>` (target from `buildNavigation({ type: "home", worktree })`) that jumps to that worktree's root URL (main → `/`, feature → `/w/<worktree>/`), letting the user pivot from the mixed global list straight into the context of any work's worktree. It carries no work/chat context — just the worktree switch — and uses real anchor semantics (middle-click / open-in-new-tab) rather than a button.
- **Stories and tasks are treated alike — the work's type is not part of the rule.** Visibility is the binding verdict above and nothing else, so every place the badge appears asks `useWorktreeBadgeVisible` the same question: the list's rows, the story detail's Tasks rows (the same `WorkRow`) and the detail header. Type did decide it on the list once, and the reason was sound for the list it was written for: a task was reachable only by expanding its story, so its badge would have restated the story badge directly above it. Neither half of that survives. A task that needs a person now gets a row of its own (docs/project-ui.md §2.2) with no story row above it — usually in a different group, and even in the same group nothing puts the two adjacent — and a task detail can be opened without its story on screen at all. A story subtree does normally share one worktree, but a task started ahead of its story (see *Worktree Binding*) is the case where it does not, and that is exactly the kind of task the list promotes.
- **Feature name comes straight from the stored `Worktree` string**, so a work still shows its original worktree name even after that worktree is deleted. The live worktree list is consulted for one thing only: whether that worktree is still there. Once it is not, the badge is a muted `Archive` marker instead of a link — there is nowhere to go, and the link used to bounce off the redirect guard back to main (the glyph and the ban on `th-error` for this state are [cross-worktree-session-ui.md](../cross-worktree-session-ui.md#gitbranch-and-archive)). An empty list reads as *not loaded yet* rather than *no worktrees*, the same reading the redirect guard takes.
- **Empty `Worktree` (main) resolves to the main branch name**, matching `WorktreeSwitcher`, and falls back to a neutral `Default` until the worktree list loads (never a guessed `main`/`master` literal). Only this main path reads the worktree list, and it reuses the existing `["worktrees"]` react-query cache read-only rather than opening a new subscription. On non-git projects the main badge renders nothing, since there is no worktree concept to show.
- **Visual hierarchy encodes the exception.** A feature worktree is accented (it is the noteworthy case, and accent doubles as the app's interactive/link color, so the chip also reads as clickable); the main worktree is muted, matching that it is the silent default.

### Cross-Worktree Chat Navigation

Because the work list is global (above), a work's **Chat** shortcut can point at a
session that lives in a *different* worktree than the one currently active.
Sessions are worktree-scoped, so `onNavigateToSession` carries the work's own
`Worktree` alongside the session id, and `AppShell` builds the URL from that
value — `/w/<worktree>/s/<sessionId>` (or `/s/<sessionId>` for the main
worktree) — never from the current URL's worktree. Opening the work therefore
switches into its worktree, which rebinds the WebSocket and resubscribes the
worktree-scoped watchers (see
[subscription-system.md](subscription-system.md#why-worktree-switch-is-a-soft-refresh-not-a-reset)).

`AppShell` deliberately does **not** redirect to home when the URL's worktree
changes: a cross-worktree session URL is legitimate and must open.

**Unless that worktree is gone.** Its sessions are not (see [What a Deletion
Leaves Behind](#what-a-deletion-leaves-behind)), so the conversation opens where
the user already stands and is read from there — a read-only screen — rather than
the URL bouncing back to main as a worktree that does not exist made it do. Both
ways into another worktree's session, a work's chat link and a sidebar row, decide
that in one place in `AppShell`, so they cannot decide it differently; the URL
convention and the screen are
[cross-worktree-session-ui.md](../cross-worktree-session-ui.md).

The subtle part is `useSession`'s recovery effects (`redirectSessionId` /
`needsNewSession`). They are *not* a safe fallback during the switch itself.
A worktree switch happens across renders: the URL's worktree updates first, but
the store worktree and the session-list subscription only catch up afterward
(the sync effect runs after the render, and the session list resubscribes only
once the switch lands). In that in-flight window the session store still holds
the *previous* worktree's list, so `redirectSessionId` / `needsNewSession` are
computed against stale data — and the target session (which lives in the new
worktree) looks absent. Left unguarded, the redirect effect would then
`navigate(replace)` the URL to some *old*-worktree session, hijacking the URL
away from the target before the new worktree's list ever loads.

Both recovery effects are therefore gated on a worktree-transition guard —
`worktreeSwitchInFlight = urlWorktree !== storeWorktree` — and skip while a
switch is in flight. Recovery only runs once `urlWorktree === storeWorktree`.
That on its own does not mean the new worktree's list has arrived — the store
worktree catches up before the resubscription does — so recovery leans on a
second condition, `isSuccess`, which stays cleared for the length of the switch.
With both satisfied the target session resolves and no redirect fires, so the
cross-worktree jump lands stably on its intended session. (The same in-flight
signal also feeds the `isSessionResolved` check that keeps `ChatPanel` from
subscribing to a session the new worktree has not listed yet, described in
[subscription-system.md](subscription-system.md#why-the-session-list-keeps-a-placeholder-during-a-switch).
Withholding the subscription does not stop the redirect effect from rewriting
the URL, though; the gate on the effect itself is what closes that gap.)

The new-session recovery effect carries a second gate for the same structural
reason. `needsNewSession` stays true for as long as the worktree has no session,
so a create that fails re-arms the effect on the very render its failure caused —
measured at over 11,000 `session.create` calls in 45 seconds, behind a permanent
"Loading..." that never said why. The effect therefore also skips while
`useSession` holds an unacknowledged `createError`: one attempt, then the failure
reaches the screen with the server's own wording — which carries the underlying
cause, see [Error Replies](websocket-rpc.md#error-replies) — and a Retry that
clears the error (which is what lets the effect run again). Retries are never
automatic: a `session.create` that merely timed out may well have succeeded
([Request Timeout](websocket-rpc.md#request-timeout)), so each silent retry
risks leaving an orphan session behind.

### Session to Work Navigation

The reverse direction of the shortcut above: from a conversation back to the
work item that drives it. It is one row, `SessionWorkSection`, at the top of the
session info panel on the chat action bar — above Usage, because what this
session *is* comes before what it has spent. A session that runs no work draws
no section at all: `WorkStarter` creates the session from the work's own
`SessionID`, and a restart reuses it, so a work never attaches itself to a
session a user made — a session without one will never grow one later, and a
disabled row would be claiming otherwise.

The row reads `work_id` off the **open session's detail**, never off the
session list and never by scanning the work list for a work that names this
session. Both of those fail exactly here: the sidebar filter hides the sessions
that have a work, so the open session usually has no row to read, and an
inverted lookup goes silently wrong the moment the work list is incomplete
([subscription-system.md](subscription-system.md#which-sessions-belong-to-work)).

*Which* detail is the chat panel's to resolve, and the row is handed it rather
than reading `sessionDetailStore` itself. That store holds the **bound**
worktree's open session, and a session read out of another worktree is
deliberately kept out of it
([cross-worktree-session-ui.md](../cross-worktree-session-ui.md)) — reading the
store here would drop this row on exactly the screen a work's chat link is the
usual way onto.
No detail yet — loading, disconnected, or held for a session the route has just
left — draws nothing rather than a skeleton: this section's whole content is one
link, and a placeholder for it would advertise a destination that may not exist.

It is pure navigation. No activity icon, no `Step n/m`, no status colour: chat
gave up answering "is my work still running" on purpose ([Work Messages in
Chat](#work-messages-in-chat), [lifecycle-ui.md](../lifecycle-ui.md) §9), and
this row lives in chat. Its existence depends on the binding alone — never on
the work's `status`, and never on its `activity`.

The label is the session's own title, which is the work's title as it stood when
the work started: `WorkStarter` names the session after the work once, at
creation, which is why the protocol carries the binding and not a second copy of
the title. The two can drift —
renaming the work does not rename its session, and the user can rename the
session — and the row says the session's name deliberately, because that is the
string the user sees in the sidebar and above the conversation; the work's
current title is on the page the row opens.

The jump does not depend on the work list at either end: `WorkDetailOverlay`
subscribes to the work by id (`useWorkDetailSubscription`), so an id no page of
the list has reached still opens its page. Opening the work changes nothing about
coming back: `WorkDetailOverlay`'s back button is the same one every other entry
point gets, and the URL still names the session, so the browser's Back lands in
this conversation.

## Multi-Step Execution

Agent roles can define a `steps` array to break task execution into sequential phases. This is useful for complex workflows like:
- Research → Plan → Implement → Test
- Design → Code → Document

### Step Lifecycle

```
Start (step 0)
     │
     ▼
┌─────────────────────┐
│ Agent works on      │
│ current step        │
└─────────┬───────────┘
          │
          ▼
    Is last step?
     │        │
    no       yes
     │        │
     ▼        ▼
 step_done   step_done
     │        │
     ▼        ▼
 CurrentStep++ Normal completion
     │        (→ closed; if parent is waiting, it resumes)
     │
     ▼
  the engine sends
 next step prompt
     │
     └──────► (loop back to working)
```

**Key distinction**:
- `step_done`: Work items advance to the next step while more steps remain, or close when no steps remain.

### Prompt Format

Every message the engine sends is the same base plus one nudge. The base is: the
MCP prefix, the agent role reference, the work context, the one section that
differs by type — a story's coordinator rules, a task's "report to your story
with `work_comment_add`" — and then `lifecycle_rules`, which every work driven by
Pockode gets verbatim.

**`lifecycle_rules` is the single place the agent-facing lifecycle is written.**
It says what the four statuses mean, that `question_post` is how the agent
reaches a person — posted and returned, nothing waiting on it, the answer
arriving later as a message — that a story's wait on its subtasks is `story_wait`,
that exactly two things end a turn cleanly (`step_done`, or something
outstanding) and what happens when neither is true: a nudge, and `stopped` once
the allowance is spent. "I still have work to do" is deliberately not
offered as a third way to end a turn; it is the nudged case, and listing it as an
ending would have promised an agent a safety it does not have. For a story it
also names **both** subtask refusals, in the one sentence that already pairs the
two tools: a `step_done` that would close a story with subtasks still running is
rejected, and so is a `story_wait` with none of them running. Naming only the
first is the trap, because that same sentence points the agent at `story_wait` —
`prompt_test.go` holds both halves.

For a story it also names the **two** ways to settle a subtask's question, says
plainly that ignoring it is not a third, and bounds the obligation to a subtask
that is still running — since that is the rule [input
1](#input-1-a-turn-ended) enforces, and the agent has no way to discover any of
it. The consequence is written here alone: the two messages that carry a
subtask's question say what the story must do, not what happens if it does not,
so the rule has one home and every message is not paying for it.

Before it existed the same rules were restated in four per-type templates, which
is exactly how the prompts came to describe a work model — `in_progress`,
"needs_input" — that the store had stopped producing.

Its one number is rendered from the constant that governs the behaviour
(`DefaultMaxNudges`) rather than typed into the YAML, so a prompt cannot promise
an allowance the engine does not give. It is stated flatly because it has no
operator flag to be overridden by.

**There used to be a second, and it went when questions stopped holding a
process open.** The answer budget was quoted here so an agent knew how long its
question would be waited on; `question_post` waits for nothing, so there is no
deadline to tell it about. `--answer-timeout` now governs permission requests
alone, which the agent is not the one waiting on.

`IsStory` gates the sections about a story's tasks: only a story has any, so a
task is never offered `story_wait` nor told about subtasks — here or in
`step_auto_continue_nudge`, which is gated the same way. `prompt_test.go` checks
both over every message a task can be sent.

**Two things the agent cannot derive from any tool description.** First, that
its CLI's own ask-the-user tool does not reach the user here: Pockode refuses it
and points the agent back at `question_post`
([agent-integration.md](agent-integration.md#refusing-the-clis-own-question)), so
a question asked that way is a turn spent for nothing. This is worth saying even
though a Claude session cannot see that tool at all — `buildArgs` takes it off the
list — because the refusal is what happens if a CLI stops honouring the flag, and
because Codex's counterpart is refused at the protocol rather than hidden.
Second, that ending a turn with a posted question outstanding is not the accident
an ordinary quiet ending is: Pockode does not nudge and does not spend the
allowance. `prompt_test.go` holds both sentences.

**The story restart nudge sends the agent to re-read its tasks**, and that is
load-bearing rather than politeness: a stopped parent is deliberately not told
when a child closes (*A Child Closing*), so re-reading `task_list` and
`work_comment_list` is the only way it learns what happened while it was stopped.

**The child-done nudge says that it cleared the wait — when it did.** Being told
about one child resumes a parent that was waiting on its children, so a story
with other tasks still running has to call `story_wait` again, otherwise its next
silent turn reads as an agent that stopped by accident. A parent that declared no
wait is told the child closed and told that nothing was cleared — there was
nothing to ask for again. Which of the two happened is passed to `BuildChildCompletionMessage` by the engine
rather than re-derived from `parent.Wait`, so the message and the transition are
decided once.

Every follow-up repeats this base rather than assuming the agent remembers an
earlier turn, which is why a nudge still works when the agent has no memory of the
work at all. That is not hypothetical: reopening an earlier conversation can fail
on either agent — a rollout that is gone, a provider session the CLI has given up
on — and the session then carries on in a fresh one, with a warning saying so
(see [agent-integration.md](agent-integration.md#thread-recovery) and
[the recovery ladder](agent-integration.md#session-recovery-ladder)). Pockode's
transcript is unaffected; the agent's memory of it is exactly what was lost. A
follow-up can therefore land in a conversation that has never seen this work, and
must be able to pick it up from the prompt alone.

Auto-continuation additionally restates the current step, so a stepped work
survives the memory loss. **Restart does not**: `BuildRestartMessage` appends only the
restart nudge, which tells the agent to review what it has done so far — and the
step number is reachable from neither the prompt nor `work_get`. An agent that
still has its history re-reads it; one that started over has to re-derive its
position from the work item and the worktree.

**Initial kickoff with steps:**
```
[Base message]

## Current Step
Step 1 of 3

<step 1 instructions>

When you finish this step:
- Call step_done with ID xxx to proceed to the next step.
```

**Step advance message:**
```
[Base message]

Step 1 of 3 completed. Proceeding to the next step.

## Current Step
Step 2 of 3

<step 2 instructions>

When you finish this step:
- Call step_done with ID xxx to proceed to the next step.
```

**Step advance message (last step):**
```
[Base message]

Step 2 of 3 completed. Proceeding to the next step.

## Current Step
Step 3 of 3

<step 3 instructions>

When you finish this step:
- Call step_done with ID xxx to close the work item.
```

**Auto-continuation with steps:**
```
[Base message]

## Current Step
Step 2 of 3

<step 2 instructions>

Your session was interrupted while working on step 2 of 3.

Check if you have completed the current step:
- If YES and this is NOT the last step: Call step_done with ID xxx to proceed to the next step.
- If YES and this IS the last step: Call step_done with ID xxx to close the work item.
- If NO: Continue working on this step.
```

### Design Notes

- **Steps apply to both Stories and Tasks**: Any work item with an agent role that has steps defined will display step progress.
- **Step state persists**: `CurrentStep` is preserved through every status change.
- **Nudge counter resets per step**: Each new step gets a fresh allowance.
- **Explicit step control**: Agents call `step_done` to advance steps, giving them control over when steps complete.
- **step_done completion flow**:
  - All work items: increments `CurrentStep` while more steps remain.
  - All work items: marks the work as `closed` on the final step or when the role has no steps.

## Work Messages in Chat

The prompts the Work engine sends land in the user's transcript alongside
everything the agent itself writes, and what happened to a work has to be
readable there. One rule governs how, and the rest of this section follows from
it:

> **A message records an event; the work store holds the state.** Messages are
> immutable history — they can say what happened, never what is true now.
> Anything the UI presents as a work's *current* state is read live from
> `workStore`, and no status is ever written into a message's `meta`.

That rule is not academic. An interrupt stops a work through a pure state change
(an aborted turn reaching the engine → `stopped`) and produces no message at all,
so a transcript that inferred status from its last message would go on claiming
the work was being nudged along after it had already stopped.

### System-Origin Message Tagging

A work-driven prompt is byte-for-byte indistinguishable from a user-typed message once it reaches the agent — same stdin, same `message` event. To let the frontend tell them apart, they are sent via `chat.Client.SendSystemMessage` (not the plain user path), which stamps the `MessageEvent` with `origin: "system"`, a `subtype`, and a `meta` summary. The origin is `"system"` rather than `"work"` because it marks a message produced by Pockode itself; the Work engine is today's only such producer, but the concept is source-agnostic. The user path leaves `origin` empty, so old history stays a normal user message — backward compatible by omission. (For why this reuses the `message` event rather than a new event type, see [agent-event.md](../agent-event.md#message-origin-user-vs-system).)

A system-driven message is refused in exactly one state, like any other: while the session is blocked on a permission request, because the CLI is not reading its input there ([lifecycle.md](../lifecycle.md#session-one-reducer)). The engine's senders — auto-continuation, step advance, reopen, child closure — log a warning and drop it; a restart fails the start it belongs to and rolls the claim back. A kickoff is the one that cannot meet this at all, since it sends into a session it has just created. Nothing holds the message for the card to clear, and [lifecycle.md § Known limits](../lifecycle.md#known-limits-kept-on-purpose) says why that is the accepted answer rather than the cheap one.

**Subtypes** (`server/work/prompt.go`) — one per send site, so the frontend can pick a word without parsing the prompt. `web/src/utils/systemMessage.ts` is the single source of that wording, and it decides both halves of a line together: which title belongs on a line depends on the same subtype the action word does.

| Subtype | Sent from | Action word | Secondary line |
|---------|-----------|-------------|----------------|
| `kickoff` | `WorkStarter` fresh start | Started | work title |
| `restart` | `WorkStarter` restart | Restarted | work title |
| `auto_continue` | the engine's nudge | Continued | *(blank)* |
| `step_advance` | `Engine.NotifyStepDone` | Step N/M | work title |
| `reopen` | `Engine.NotifyReopen` | Reopened | work title |
| `child_question` | the engine passing a subtask's question up | Subtask asked | child title |
| `child_done` | the engine telling a parent | Subtask done | child title |
| `wait_stranded` | the engine clearing a wait nothing could end | Wait cleared | child title |
| *(unknown or absent)* | — | System Message | work title |

Every action word states a finished fact — something started, continued, reached step 2 — because by the time anyone reads it the event is over. Wording it that way is the cheapest guard there is against the rule at the top of this section: a word that can only describe a moment cannot be mistaken for a live status.

- **`step_advance`'s action word *is* the step**: reaching step 2 is the whole of what happened, so a separate "Next step" label in front of it would only push the fact aside. It is formatted through `formatStepProgress(recordedStepProgress(...))` like every other step in the UI, so step wording has one source; a message that recorded no `step` falls back to "Next step".
- **`wait_stranded` takes the child title for the same reason `child_done` does**: both are delivered to the parent's session and report on a subtask, so the parent's own title would be the noise beside it. Its action word is what *Pockode* did — cleared the wait — rather than what happened to the subtask, because the three events that produce it (deleted, stopped, rolled back) have nothing in common except what they left behind, and naming any one of them would be wrong two times in three. "No subtasks running" was the obvious alternative and is the trap this section is about: the user restarts the subtask and the line is a lie, while "wait cleared" is over the moment it is written and stays true.
- **`auto_continue` says nothing else.** It is the one subtype that repeats, and repeating the same title is the least informative line there is; blank keeps it visually weightless.
- **`child_done` names the child.** The message is delivered to the parent but reports on the subtask, so the parent's own title is noise next to it.

- **`child_question` names the child for the same reason**, and its action word is what the subtask did rather than what the story must do: the story either answers it or asks the user itself, and a line promising either would be wrong half the time. The story's *reminder* to settle one is an `auto_continue` rather than a second `child_question` — it is a nudge, spending the allowance and ending in a stop, not news — and one of them may be about several subtasks at once, while `meta.child` holds one.

**Meta summary** — `NewMessageMeta(w, step, total)` builds that data so the UI never has to read the prompt body (whose first lines are always the MCP boilerplate prefix). It carries `work_id` / `work_type` / `title` from `w`, plus `step` when the send site has real step context (`total > 0` and `1 <= step <= total`); `child_done`, `child_question` and `wait_stranded` additionally carry `child: {id, title}`, so the line can name the subtask without parsing the prompt.

Every subtype fills `step`, including the three whose prompt body never restates one — `restart`, `reopen` and `child_done` append only their nudge (see *Prompt Format*). Summary and body answer different questions: the body says what the agent has to act on, the summary says where the work stood, and the UI needs the latter even when the prompt withholds it. `step` is omitted only when there is genuinely no position to report — a stepless role, a failed step lookup (`stepCount` answers 0 for both, since a missing step provider must not block a message), or a `current_step` left out of range by a role whose steps were shortened afterwards.

`w` is the **receiving** work — the one whose session the message is delivered to, which is not always the one the message is about. `child_done` is delivered to the *parent's* session, so its `work_id` is the parent's. That field is what the message's *Details* link opens, so filing the message under the child would send the reader into a work this message was never delivered to. Taking the whole `Work` rather than a loose title and id is what makes that hard to get wrong: every field is derived from one value, so no call site can label one work while keying on another.

`meta.step` is the field most easily mistaken for live state: it records where the work stood **when the message was sent**. It is what this event's own line is worded from, and the only step the transcript knows — never the work's current position.

### Rendering in the Transcript

Origin, subtype and meta ride through the reducer: `normalizeEvent` runs the raw `origin` through `normalizeOrigin`, which folds both the current `"system"` and the legacy stored `"work"` to `"system"` (so old persisted history and live events converge on the new name at this single wire boundary), passes `"user"` through, and drops anything else to `undefined`; it then copies origin/subtype/meta onto the normalized `message` event.

From there a system-origin message takes exactly the path a user-typed one takes — `applyServerEvent` → `applyUserMessage` — and lands as a `UserMessage` carrying `source` / `subtype` / `meta`. There is no branch on `meta.work_id` and no message variant of its own. History recorded before any of this existed carries no meta and simply has less to say on the same line, so there is no data migration and no second rendering path to keep in step. Plain user messages stay source-less, so optimistic local echoes and ordinary history still render as normal bubbles. Replay feeds this same function, so replay and live streaming cannot drift into two different renderings — keep it that way.

**One event, one collapsed line, where it happened** (`WorkEventItem`, in `web/src/components/Chat/MessageItem.tsx`). Collapsed it reads `Pockode · {action word}` plus the secondary line, in the same shape a Claude Task strip uses ([frontend-state.md](frontend-state.md#tool-runs)); expanded it shows the work's title in full, the prompt body, and a *Details* link into the work's detail overlay — the one thing older history cannot offer, since a message that recorded no `work_id` names no work to open. It subscribes to nothing and reads only its props.

That form falls out of the rule this section opens with, and is the reason the rule is now cheap to keep:

- **A line that states one finished fact cannot go stale.** The aggregate card this replaced had to subscribe to `workStore` and `agentRoleStore` on every render to avoid lying about status, step and blocked subtasks — the rule held only because the card kept re-reading. A work event answers no question about *now*, so there is nothing in it that could contradict the store.
- **The right-hand status area is empty, permanently.** A work event shows no status and never a spinner. A Claude Task strip does show one, and the asymmetry is deliberate: a Task call has a start and an end worth reporting on, a work event is instantaneous — it is over the moment it is recorded.
- **Pagination stops being a special case.** A work whose messages straddle a page boundary needs no folding back together, and no message needs an id that survives re-anchoring: a work event is an ordinary message, so `prependHistoryPage` treats it like every other one ([agent-chat.md](../agent-chat.md#reading-a-page-on-the-client)).
- **No step divider.** A `step_advance` line already lands where the work moved on and already reads `Step n/m`; a hairline saying the same thing in the same place was duplication left over from when the card was pinned upstream and the stream needed something else to mark the change of step.

Three consequences worth stating outright, so none of them is later "fixed" back:

- **A title freezes at the moment of the event.** The line words itself from `meta.title`, so renaming a work leaves its older messages reading the old name. That is correct — the record says what was true then — and the current title is one tap away behind *Details*.
- **A work event offers no actions and cannot be a fork anchor.** `hasMessageActions` excludes `source === "system"`, and `isForkableMessage` follows it. These are Pockode's own annotations, not conversation turns. The line still reserves the empty slot every row of a forkable session gets, so it ends where the widest bubble ends rather than overhanging it ([session-fork-ui.md](../session-fork-ui.md#which-messages-get-a-menu-and-when-fork-is-on-it)).
- **A fork's `droppedCount` counts each event separately.** A work's messages used to collapse into one card and be counted once; now each is one message, which is the honest number.

**And nowhere else in the transcript either.** Chat used to answer "is my work still running?" from a status dot and `Step n/m` in its top bar, without the user scrolling to find a card. It no longer answers it at all: that question belongs to the work list and the detail overlay (*One Vocabulary for Work Status*), and giving it up is the price of a transcript that is only a transcript. The one piece of that vocabulary chat still borrows is step wording, so a step named on an event line and the same step named in `WorkDetailOverlay` cannot come out phrased differently.

### Reply Placeholders

A message that *opens a turn* leaves an empty assistant message behind it — a system message drives the agent just as a user message does, and the placeholder is where the reply streams in. When the agent answers with nothing at all, that placeholder would render as a blank box, so it is dropped at either of the two moments its fate is settled: when the next message arrives to an idle agent (`closePreviousTurn`) and when a terminal event ends the turn. An agent that goes quiet under repeated auto-continuation produces a run of them, which is why this is worth doing at all.

A message that goes into a turn *already open* — one whose bubble is still `sending` or `streaming`, which is the test `appendUserMessage` applies rather than asking the turn's phase — makes no placeholder at all, and that is the point rather than an omission: the reply being written answers an earlier message and goes on belonging to it, so this message is simply appended below it. Its own bubble is opened later, by the read point — the record saying the agent has taken the message in ([agent-integration.md](agent-integration.md#the-read-point)) — and not by the turn ending: one turn has one ending but any number of bubbles, and a placeholder made here would be a bubble claiming the agent had reached this message when it had not. The missing placeholder is itself the signal the chat reads back to say the message is sent and still unread ([lifecycle-ui.md §2.2](../lifecycle-ui.md#22-chat-the-attention-strip)), so adding one here as a kindness would take that receipt away.

The condition (`isEmptyPlaceholder`) is `parts` empty **and** status `complete`, and the second half is not incidental: `interrupted`, `error` and `process_ended` say their whole message in the status line, so an empty body is exactly when they matter. Dropping those would hide an aborted turn from the user — and an interrupt is the case that produces them most. (The terminal sweep clears one more thing, older than this rule and unrelated to it: a bubble still `sending` when the turn ended, meaning the send never produced anything at all.)

Two entry points add a message, and the choice between the two shapes is made for both in one place — `appendUserMessage` in the reducer. One caller is `applyUserMessage`, which every broadcast comes through whether it was typed or sent by the Work engine; the other is `sendUserMessageHandler` in `useChatMessages`, which appends the local echo straight to the list without going through `applyServerEvent` and therefore has to name the two messages it adds. Letting either write the rule itself is not a hypothetical cost: a session whose process died right after a message was persisted replays as an unanswered placeholder, and the next thing the user sends would strand it as a blank box — while a copy of the rule that forgot the mid-turn shape would close a turn that is still writing and hand its remaining output to the wrong message.

## Prompt Configuration

Prompt templates are externalized in `server/work/prompts.yaml`, embedded at compile time via `go:embed`. This separation enables:
- Non-programmers to review and modify AI instructions
- Clear separation between prompt content and rendering logic
- Easy diffing and tracking of prompt changes

### Configuration File

```yaml
# server/work/prompts.yaml

# Each key is a template name, value is the template string
# Uses Go text/template syntax: {{.FieldName}}

pockode_mcp_prefix: |
  All work_*, story_*, task_* and agent_role_* tools in this session...

role_reference: |
  Your agent role ID is {{.AgentRoleID}}. Use agent_role_get...

work_context: |
  You are working on: "{{.Title}}" (Work ID: {{.ID}})...
```

### Template Keys

| Key | Used In | Placeholders |
|-----|---------|--------------|
| `pockode_mcp_prefix` | All messages | (none) |
| `role_reference` | All messages | `AgentRoleID` |
| `work_context` | All messages | `Title`, `ID` |
| `story_behavior_rules` | Story kickoff | (none) |
| `task_rules` | Task kickoff | `StoryID` |
| `lifecycle_rules` | All messages | `ID`, `IsStory`, `MaxNudges` |
| `story_restart_nudge` | Story restart | (none) |
| `task_restart_nudge` | Task restart | (none) |
| `story_auto_continue_nudge` | Story auto-continuation | (none) |
| `task_auto_continue_nudge` | Task auto-continuation | (none) |
| `step_auto_continue_nudge` | Step auto-continuation | `CurrentStep`, `TotalSteps`, `ID`, `IsStory` |
| `child_completion_nudge` | Waiting parent resume | `ChildTitle`, `ChildID`, `ID` |
| `story_reopen_nudge` | Story reopen | (none) |
| `task_reopen_nudge` | Task reopen | (none) |
| `child_question_nudge` | A subtask's question passed up | `ChildTitle`, `ChildID`, `ChildSessionID`, `Header`, `Question`, `RequestID`, `Options`, `MultiSelect` |
| `child_question_reminder_nudge` | A story nudged to settle its subtasks' questions | `Questions` (each: `ChildTitle`, `ChildID`, `SessionID`, `RequestID`, `Header`, `Question`) |
| `stranded_wait_nudge` | A wait nothing could end | `ChildTitle`, `ChildID`, `ID`, `Exit` |
| `step_advance_section` | Step advance | `PrevStep`, `TotalSteps`, `CurrentStep`, `StepPrompt`, `ID` |
| `current_step_section` | Initial step display | `CurrentStep`, `TotalSteps`, `StepPrompt`, `ID` |

### Rendering

```go
// server/work/prompt.go

//go:embed prompts.yaml
var promptsYAML []byte

// compiledTemplates caches parsed templates keyed by their source string.
// Prompt strings are compile-time constants (from embedded prompts.yaml), so each
// is parsed once and reused across the many messages built per session.
var compiledTemplates sync.Map // map[string]*template.Template

func render(tmplStr string, data any) string {
    compiled, ok := compiledTemplates.Load(tmplStr)
    if !ok {
        tmpl, err := template.New("").Parse(tmplStr)
        if err != nil {
            panic("invalid template: " + err.Error())
        }
        compiled, _ = compiledTemplates.LoadOrStore(tmplStr, tmpl)
    }
    var buf bytes.Buffer
    compiled.(*template.Template).Execute(&buf, data)
    return strings.TrimSuffix(buf.String(), "\n")
}
```

Templates are compiled lazily and cached because the same handful of prompt
templates is rendered repeatedly (once per kickoff/restart/step message across
every session); `*template.Template.Execute` is safe for concurrent use, so the
cached entry needs no additional locking.

## Code Paths

| Component | Path |
|-----------|------|
| Data types | `server/work/types.go` |
| File store | `server/work/store.go` |
| State validation | `server/work/validation.go` |
| Work engine | `server/work/engine.go` |
| Commands (both transports) | `server/work/operations.go` |
| Activity derivation | `server/work/activity.go`, `server/work/testdata/activity_cases.json` |
| Usage aggregation | `server/work/usage.go` |
| Per-worktree usage source | `server/worktree/manager.go` (`SessionUsages`), `server/session/usage.go` (`ReadUsages`) |
| Worktree start handler | `server/worktree/work_starter.go` |
| Worktree manager (sender resolver, session terminator, turn source) | `server/worktree/manager.go` |
| Retiring a closed work's session | `server/process/manager.go` (`RetireSession`) |
| Worktree delete protection | `server/ws/rpc_worktree.go` |
| Prompt builder | `server/work/prompt.go` |
| Prompt templates | `server/work/prompts.yaml` |
| MCP stdio proxy + client | `server/mcp/server.go`, `server/mcp/client.go` |
| MCP tool definitions | `server/mcp/tools.go` |
| MCP tool executor + HTTP API | `server/mcp/executor.go`, `server/mcp/handler.go` |
| File I/O | `server/filestore/filestore.go`, `server/filestore/atomic.go` |
| Frontend store | `web/src/lib/workStore.ts` |
| Frontend activity map | `web/src/lib/activity.ts` |
| Frontend step progress + list | `web/src/utils/workSteps.ts`, `web/src/components/Project/StepList.tsx` |
| Frontend work-in-chat rendering | `web/src/lib/messageReducer.ts`, `web/src/components/Chat/MessageItem.tsx`, `web/src/utils/systemMessage.ts` |
