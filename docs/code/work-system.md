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

```go
// server/work/types.go
type Work struct {
    ID          string     // UUID v7
    Type        WorkType   // "story" | "task"
    ParentID    string     // Empty for Story, required for Task
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
  worktree they want it to run in.
- **Child work** inherits its parent's worktree at create time (`store.Create`).
  Children are usually created by the parent's already-running agent, so the
  parent's worktree is fixed by then. A child pre-created under a still-open
  story would inherit the empty default instead, so `SetWorktree` also propagates
  the captured worktree down to any open descendant when the story starts. Either
  way an entire story subtree normally shares one worktree — the coordinator and
  all its tasks stay together. The one gap is a task started *before* its story
  (nothing forbids it): it is no longer open by then, so propagation skips it and
  it keeps whatever it inherited at create time.
- **Immutable once started** — `SetWorktree` only mutates a work while its status
  is still `open`; any later call is rejected. Assigning the *same* value is a
  no-op, so a main-worktree story that goes open → start → stop → start does not
  trip the immutability guard on restart.

**Why immutable**: a session's process, cwd, and session files live in a
specific worktree. Moving a work mid-flight would strand its running session and
its history, so the worktree is pinned for the work's whole life. Restart and
reopen therefore reuse the recorded worktree rather than re-reading the
frontend's current one.

This binding is what lets `WorkStarter`/`WorkStopper` and session cleanup act on
`worktreeManager.Get(w.Worktree)` instead of always the main worktree, and it is
the ownership signal behind worktree-deletion protection (below).

### Validation Rules

On creation (`server/work/store.go:175-210`):
1. **Type must be valid** — either "story" or "task"
2. **Title required** — non-empty string
3. **AgentRoleID required** — must exist in the role store
4. **Parent type match** — Tasks must have a Story parent, Stories cannot have parents
5. **Parent not closed** — Cannot create children under closed parents

## State Machine

### Six States

```
                    ┌──────── live cluster ────────┐
                    │  in_progress   needs_input   │
open ──────────────►│         (all four mutually   │──────► closed
                    │          reachable)          │          │
                    │  waiting       stopped       │          ▼
                    └──────────────────────────────┘     in_progress
                                                          (via Reopen)
```

**Only `open` and `closed` are gates.** The four live states reach each other
freely, in both directions. They answer "might an agent session be running, and
what is it doing" — and that answer comes from process events that go stale: a
crashed CLI, an orphaned session, a dropped event. None of them says how far the
work got; that is `CurrentStep`. Gating progress on them was how a work item
that had merely gone `stopped` became impossible to advance or finish, locked
for good.

Two guards in `server/work/validation.go` say this directly, and there is
deliberately no edge table beside them to drift out of sync:

- `ValidateProgress` — may the agent move this work along (`step_done`,
  `work_wait`, `work_needs_input`, stop, liveness sync)? Every live status
  qualifies; `open` and `closed` do not, and each names its way in.
- `ValidateStartable` — may a session be started for this work? Also admits
  `open` (the fresh-start case) and rejects `in_progress`, so a running work is
  never started twice — which is also what resolves concurrent `Claim`s to a
  single winner.

| State | Meaning | SessionID | CurrentStep |
|-------|---------|-----------|-------------|
| `open` | Not started | empty | 0 |
| `in_progress` | AI session active | set | tracks current step |
| `needs_input` | Waiting for user input | preserved | preserved |
| `waiting` | Waiting for child work to complete | preserved | preserved |
| `stopped` | Session ended unexpectedly | preserved | preserved |
| `closed` | Work completed | preserved | preserved |

### Intent-Driven Transitions

The API exposes intent methods rather than raw status updates. Each method encapsulates business logic and validates transitions.

| Method | Transition | Purpose |
|--------|------------|---------|
| `Start(id, sessionID)` | startable → in_progress | Launch AI session |
| `Claim(id)` | startable → in_progress | Start plus atomic sessionID decision (a work that already owns a session is a restart and keeps it) |
| `Stop(id)` | live → stopped | Terminate session |
| `StepDone(id, totalSteps)` | live → in_progress/closed | Advance work step or close work |
| `MarkNeedsInput(id)` | live → needs_input | Pause for user input |
| `MarkWaiting(id)` | live → waiting | Pause for child work completion |
| `MarkRunning(id)` | live → in_progress | Session is live again (user input, child closed, process detected running) |
| `Reopen(id)` | closed → in_progress | Reopen a closed item to add children or continue |
| `RollbackStart(id, wasRestart)` | in_progress → open/stopped | Undo failed start |

"live" is any of `in_progress` / `needs_input` / `waiting` / `stopped`;
"startable" is what `ValidateStartable` admits — `open` plus every live status
but `in_progress`.

A `StepDone` from a stale live status also repairs it back to `in_progress`: the
agent calling the tool is proof its session runs, and the next-step prompt only
reaches `in_progress` work.

Re-setting a live status a work already holds is a deliberate no-op rather than
a redundant write. Liveness signals repeat — the same session is reported running
more than once — and re-announcing an unchanged status would wake every
subscriber with a change event that carries no news.

`RollbackStart` is the one method inside the cluster that still names a single
source status. It undoes the `in_progress` a failed start left behind, so if the
agent has already moved the work on, the kickoff did not fail cleanly and rolling
back would clobber live state — most visibly on a restart, where the rollback to
`stopped` would erase a `needs_input` the agent had just set.

### Waiting vs NeedsInput

Both `waiting` and `needs_input` pause the agent's work, but serve different purposes:

| State | Purpose | Resumed By |
|-------|---------|------------|
| `needs_input` | Agent needs user confirmation or clarification | User sending a message |
| `waiting` | Agent waiting for child work to complete | Child work closure, or user message |

**Key difference**: `waiting` is used when a coordinator agent has created child tasks and wants to pause until they complete, while `needs_input` is used when the agent genuinely needs user input to proceed. Both are recorded through `MarkNeedsInput` / `MarkWaiting` and left through `MarkRunning`, which is one method rather than three because "the session is live again" is one fact regardless of what it was waiting on.

Both states can be resumed by user messages, allowing users to interrupt the wait if needed.

### Step Completion

Work items transition through `StepDone`; there is no intermediate `done` state. Any work item with remaining steps advances to the next step and stays `in_progress`. When no steps remain, the work item closes. Waiting for child work is handled explicitly through `work_wait` / `MarkWaiting`, not `StepDone`. When a child task closes, the system automatically resumes its parent story only if the parent is `waiting`. Already closed parents are not reopened, preserving the intentional completion of coordinated work.

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
| `work_list` | List all works, optionally by parent | `parent_id?` |
| `work_create` | Create Story or Task | `type`, `title`, `agent_role_id`, `parent_id?` |
| `work_get` | Get full details including body | `id` |
| `work_update` | Modify title/body/role | `id`, fields to update |
| `work_delete` | Delete (cascades to children) | `id` |
| `work_start` | Begin execution | `id` |
| `work_needs_input` | Pause for user input | `id`, `reason` |
| `work_wait` | Pause for child work completion | `id` |
| `work_reopen` | Reopen a closed work item | `id` |
| `step_done` | Advance work step or close work | `id` |
| `work_comment_add` | Add progress note | `work_id`, `body` |
| `work_comment_list` | List comments | `work_id` |
| `work_comment_update` | Update comment text | `id`, `body` |

### Agent Role Tools

| Tool | Purpose |
|------|---------|
| `agent_role_list` | List available roles (without prompts) |
| `agent_role_get` | Get role details including system prompt |
| `agent_role_reset_defaults` | Reset to default roles |

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
- **Direct side effects** — `work_start`/`work_reopen` run through the shared
  `work.Operations` (claim + kickoff, or reopen + nudge) and `step_done` sends its
  follow-up via the AutoResumer (`NotifyStepDone`), so a transition takes effect
  immediately instead of waiting for the main server to notice a file change.
- **One implementation per transport** — the WebSocket handler (user actions) and
  the MCP Executor (AI actions) call the same `work.Operations`, so a user start/
  reopen and an AI start/reopen behave identically.

**Authentication**: the server generates a random token at startup and writes
it to `server.json` alongside the port. Being a credential, it goes into a data
directory restricted to the current user (see
[Authentication → Credentials on Disk](authentication.md#credentials-on-disk));
a `0600` mode would protect it on unix only.
It is distinct from the user-facing `--auth-token` (which is never written to
disk) and lives only for the lifetime of the process. `middleware.Auth` bypasses
the exact `/api/mcp/tools/call` route; the `APIHandler` verifies the local token
itself. The endpoint is loopback-only in practice — the relay explicitly refuses
to forward `/api/mcp/*`, so it is never reachable remotely.

All tool results are JSON (not formatted text) where structured data is
returned, to prevent prompt injection and ensure stable parsing. A tool whose
handler fails comes back as an `isError` result (the AI sees it); transport or
auth failures are surfaced to the AI rather than failing silently.

## AutoResumer

The AutoResumer watches for state changes and automatically manages work lifecycle.

### Triggers

**Trigger A: Process State Changes**

When an AI session's state changes, sync the work status:

| Process State | Work Transition | Purpose |
|---------------|-----------------|---------|
| running | stopped → in_progress | User message to stopped session |
| idle (first) | (ignored) | Initial process startup |
| idle (normal) | in_progress → in_progress | Send auto-continuation |
| interrupted | in_progress/needs_input/waiting → stopped | Turn aborted (user interrupt, denied permission, replaced turn) |
| ended | in_progress/needs_input/waiting → stopped | Process exited |

An aborted turn stops the work instead of continuing it, which is what makes a
denied permission during an automated run end the run rather than nudge the agent
to try again.

**Trigger B: Child Closure**

When a child work closes, the system notifies its parent based on the parent's status. The logic separates two concerns: *state transition* and *message sending*.

| Parent Status | State Transition | Message Sent | Rationale |
|---------------|------------------|--------------|-----------|
| `open` | — | No | No agent session started yet |
| `in_progress` | — | Yes | Agent is running; notify it of child completion |
| `needs_input` | — | Yes | Agent is paused but active; deliver notification |
| `waiting` | → `in_progress` | Yes | Resume the waiting coordinator |
| `stopped` | — | Yes | Session can be restarted; preserve notification |
| `closed` | — | No | Parent was explicitly closed; stay closed |

```
Task: closed ──► Parent (waiting) → in_progress
                       │
                       ▼
            Send "Child completed" message

Task: closed ──► Parent (in_progress/needs_input/stopped)
                       │
                       ▼
            Send "Child completed" message (no state change)

Task: closed ──► Parent (open/closed) → (no message)
```

**Key distinction**: Only `waiting` parents undergo a state transition. Other active parents (`in_progress`, `needs_input`, `stopped`) receive the notification without changing status. This enables coordinators to receive multiple child completion messages when running with parallel subtasks.

### Step-Advance and Reopen Follow-ups

`work_start`, `step_done`, and `work_reopen` are driven in-process rather than by
the AutoResumer reacting to a file change. `work_start` and `work_reopen` live in
the shared `work.Operations`, called by both the WebSocket handler and the MCP
`Executor`:

- **work_start** — `Operations.StartWork` claims the work (`store.Claim`, which
  decides restart/session reuse atomically under the store lock) and calls
  `WorkStartHandler` to create the session and send the kickoff, rolling back the
  claim on failure. Runs detached from the caller's context.
- **work_reopen** — `Operations.ReopenWork` calls `store.Reopen`, then
  `AutoResumer.NotifyReopen` to send the reopen nudge.
- **step_done** (MCP-only) — after `store.StepDone` advances the step, the
  `Executor` calls `AutoResumer.NotifyStepDone`, which sends the next-step prompt
  (only while the work is still `in_progress`).

```
step_done ──► store.StepDone()
                   │
                   ▼
            hasMoreSteps?
              │        │
            yes        no
              │        │
              ▼        ▼
       CurrentStep++   Close work ──► Trigger B (parent reactivation, if any)
              │
              ▼
       Executor.NotifyStepDone() ──► send next-step prompt
```

The reopen message instructs the agent to review its previous work and determine what additional changes are needed, then call `step_done` when complete.

### Background Waits and the Work Item

A Claude turn that started a background task goes quiet for as long as the task
runs, and the adapter swallows the ending the CLI emits meanwhile
([agent-integration.md](agent-integration.md#background-waits)). Nothing about
that reaches the work layer, and nothing should: the work item stays
`in_progress` because that is simply true — the turn is still under way and the
job is not done.

Auto-continuation is not exempted from the wait; it is never triggered in the
first place. Trigger A fires on process state changes, and with no
`AwaitsUserInput` event the session never leaves `running`, so
`handleAutoContinuation` does not run, no nudge is sent, and `retries` does not
move. This is the same code path a long tool call already takes, which is why a
wait of any length needs no work state of its own.

The two ways a wait ends both land back on existing behaviour:

- **The fallback budget runs out.** The adapter delivers the ending it held, the
  session goes idle, and the AutoResumer runs the ordinary auto-continuation it
  would have run when the wait began — except the agent also receives the
  explanation queued by the adapter, so the nudge does not read as an unexplained
  demand to continue.
- **The process dies during the wait.** `ProcessEndedEvent` moves the work to
  `stopped` through Trigger A, as for any other death. A death nobody is left to
  observe — a server restart — reaches the same state by the other route,
  `StopOrphanedWork` at startup, which leaves a comment on each work it stops:
  otherwise the user comes back to a work stopped for no stated reason, with the
  background tasks it was waiting for gone too.

### Follow-ups During a Background Wait

During a wait the CLI has no active turn of its own, so any message Pockode sends
opens a new one immediately.

Only `handleAutoContinuation` is gated by the swallowing, because it is driven by
the session going idle. Every other send is message-driven and reaches the CLI
regardless of process state; three of them can land on an agent's *own* waiting
session: step advance, reopen, and child-closure reactivation. (The worktree
starter's kickoff and restart are unconditional too, but they target a work being
started rather than a session already mid-wait.)

**These senders send immediately and do not wait for the background wait to
finish.** The alternative — queueing them until the wait ends — was considered
and rejected:

- **It would not work for `step_done`, the most likely of the three.** The MCP
  handler calls `NotifyStepDone` from inside the tool call, i.e. while the turn
  that invoked `step_done` is still running. The ending has not been swallowed
  yet and the wait is not armed, so a gate on "is a wait in progress" never sees
  it. The CLI simply queues the message and starts it the moment the turn ends.
- **The user is not gated either.** `chat.Client` has no state-based block, so a
  user can type during the wait and get a new turn the same way. A system-origin
  message travels the identical path; deferring only those would be an
  inconsistency that buys nothing.
- **The interleave is visible to the agent, not silent.** The CLI reports the
  agent's own live background tasks and delivers the completion notification into
  whatever turn is running, so the model can see it still has work pending and
  check it with `BashOutput`.
- **Nothing downstream breaks.** The injected turn's events push the fallback
  deadline out, its ending is swallowed again while the task set is still
  non-empty, and it ends the wait exactly when the set has drained. The session
  stays `running`; no spurious idle, nudge, or retry accounting.
- **Deferring costs more than it saves.** The queue would have to survive process
  death and server restart or lose the message, and would hold it for up to the
  fallback budget (30–120 minutes). A reopen or child-done that produces nothing
  for two hours is a silent stall — exactly what "no silent failures" forbids —
  traded against a context interleave the agent can see and handle.

If the interleave ever does prove to confuse models, the fix belongs at the
message itself (say that a background task is still pending) rather than in a
host-side deferral queue.

### Per-Worktree Sender Routing

Every follow-up the AutoResumer sends (auto-continuation, step-advance, reopen,
child-done) must reach the worktree the target work runs in — not a single
global sender. It therefore holds a `SenderResolver` rather than one
`MessageSender`, and resolves per send from the work's `Worktree`:

```
resolver.ResolveSender(work.Worktree) → (sender, release, err)
```

Production wires the worktree `Manager` as the resolver (`main.go`), so each
message goes to that worktree's chat client. Because worktrees are
reference-counted, `ResolveSender` returns a `release` func the AutoResumer
**must** call once the send completes (always via `defer`) to drop the reference.

- **Child-done routes to the parent's worktree**, not the child's. The subtree
  shares one worktree so they usually match, but the parent owns the session
  being nudged, making it authoritative.
- **Resolve before mutating state** in parent reactivation: a waiting parent is
  only transitioned to `in_progress` after its sender resolves, so a resolve
  failure can't leave the parent resumed but un-nudged (all-or-nothing).
- `SetSender` remains for tests and callers that don't need routing — it installs
  a static resolver that maps every worktree to one sender. When no resolver is
  installed the AutoResumer stays inert, the same gate as before.

### Retry and Settle Delay

```go
maxRetries = 3        // Stop work after 3 auto-continuation failures
settleDelay = 2s      // Let an in-flight step_done's retry reset land first
```

An agent typically calls `step_done` right before its turn ends. The settle
delay gives that in-process transition's retry reset time to land before
`handleAutoContinuation` reads the retry count, so the stop-after-N accounting
stays correct (it does not by itself suppress a redundant continuation message —
that remains a rare worst case).

Both delayed follow-ups (stop after interrupt/end, and auto-continuation) drop
their decision if the session started running again during the delay. A session
comes back inside those two seconds more easily than it looks: Codex aborts the
running turn the moment a second message replaces it, which arrives as an
interrupt immediately followed by the replacement turn, and answering a prompt on
a reaped session builds a new process. Acting on the older event would stop work
whose agent is running right now, and nothing would restart it — `running` only
reactivates work that is already `stopped`, so it fires before the stop lands and
leaves the work stopped for good.

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

## Frontend Integration

```typescript
// web/src/lib/workStore.ts
interface WorkStore {
    works: Work[];
    isLoading: boolean;
    error: string | null;

    setWorks: (works: Work[]) => void;
    updateWorks: (updater: (old: Work[]) => Work[]) => void;
    setError: (error: string) => void;
    reset: () => void;
}

// Collect active session IDs for routing
export function collectWorkSessionIds(works: Work[]): Set<string> {
    const ids = new Set<string>();
    for (const w of works) {
        if (w.session_id) ids.add(w.session_id);
    }
    return ids;
}
```

The frontend subscribes to work changes via WebSocket and updates the Zustand store. Session IDs are collected to route chat messages to the correct work context.

### One Vocabulary for Work Status

Two surfaces paint a work's status — `WorkListOverlay` and `WorkDetailOverlay` — and they draw it from one set of sources so they cannot disagree: labels from `statusLabels` and the badge palette from `StatusBadge`, glyphs from `StatusIcon`, step arithmetic and wording from `web/src/utils/workSteps.ts` (`getStepProgress` / `formatStepProgress`), and the step markup from `StepList`. The chat transcript is deliberately not on that list — it shows no status at all, and borrows only the step wording (*Work Messages in Chat*). Two notes on the shared vocabulary:

- **`in_progress` is a static glyph, never a spinner.** A work that is `in_progress` with its process idle is an ordinary resting state, and it is also a transient one the user should not be alarmed by: `handleProcessEnded`'s settle delay leaves an interrupted work on `in_progress` for a couple of seconds, which a spinner would dramatize and a glyph does not.
- **Colour does not have to tell every status apart.** `open` and `closed` share one muted colour, and in the list the icon often stands without its label — but they are different glyphs (`Circle` against `CircleCheck`), so the glyph carries the distinction and the colour only says "nothing to attend to here".

### Displaying a Work's Worktree

The work list is **global — it spans every worktree** (its subscription sets `resubscribeOnWorktreeChange: false` and survives switches, see [subscription-system.md](subscription-system.md#why-app-level-subscriptions-survive-worktree-switches)). So a single list mixes works from different worktrees, and the user cannot tell where each one runs without a per-work label. Both the list and the detail page therefore surface the work's `Worktree` (below) via a shared `WorktreeBadge` component and a `useWorktreeDisplay` hook.

Design decisions specific to this display:

- **A work whose worktree is not decided yet shows no badge at all**, since a badge would assert a binding that can still change. What counts as decided follows from *Worktree Binding* above: a work that is no longer `open` is already frozen, and an `open` one is decided the moment its **root** starts and propagates the captured worktree down. So an open work is judged by its root, not by itself — that is what keeps the badge on an open task under a running story while hiding it for the same task under a story that has not started.
- **The badge resolves that verdict itself rather than being told it.** `isWorktreeBound` (`workStore.ts`) owns the rule and `WorktreeBadge` reads it through a `useWorkStore` selector, so no call site can forget it. Reaching the root needs the whole work list, which is why the badge subscribes to the store instead of taking the verdict as a prop. When an ancestor is missing from that list (subscription not synced yet), the walk stops at the deepest known one and *its* status decides — with the two-level hierarchy `validParents` enforces, that means falling back to the work's own status, which errs toward hiding.
- **The binding is read-only, but the badge is a navigation link.** The worktree binding is frozen once a work starts (see *Worktree Binding*), so — unlike the editable role — the badge never *reassigns* a work's worktree. It is, however, a clickable `<Link>` (target from `buildNavigation({ type: "home", worktree })`) that jumps to that worktree's root URL (main → `/`, feature → `/w/<worktree>/`), letting the user pivot from the mixed global list straight into the context of any work's worktree. It carries no work/chat context — just the worktree switch — and uses real anchor semantics (middle-click / open-in-new-tab) rather than a button.
- **List page shows the badge on story rows only.** A story subtree normally shares one worktree (the same invariant that lets `SetWorktree` propagate to descendants), so a badge on every task row would almost always restate the story badge already sitting above it — noise in an already dense row.
- **Detail page shows it on both stories and tasks**, because a task detail can be opened directly, without its story on screen — and because a task started ahead of its story (see *Worktree Binding*) is the one case where it differs from the story's.
- **Feature name comes straight from the stored `Worktree` string**, so a work still shows its original worktree name even after that worktree is deleted — no lookup against the live worktree list is needed.
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
 AutoResumer sends
 next step prompt
     │
     └──────► (loop back to working)
```

**Key distinction**:
- `step_done`: Work items advance to the next step while more steps remain, or close when no steps remain.

### Prompt Format

Base prompts tell the agent to fetch its agent role and use that role's instructions. They also state the lifecycle rule in one place: call `step_done` when a step is complete, or when the work is done if the work item has no steps. Tasks with a parent story report results to that parent with `work_comment_add`. Story prompts tell coordinators to call `work_wait` after starting child tasks so the story waits for task completion reports.

Every follow-up repeats this base rather than assuming the agent remembers an
earlier turn, which is why a nudge still works when the agent has no memory of the
work at all. That is not hypothetical: a Codex session cannot carry its
conversation across a process restart (see
[agent-integration.md](agent-integration.md#no-session-recovery)), so a follow-up
can land in a thread that has never seen this work and must be able to pick it up
from the prompt alone.

Auto-continuation additionally restates the current step, so a stepped work
survives the memory loss. **Restart does not**: `BuildRestartMessage` appends only the
restart nudge, which tells the agent to review what it has done so far — and the
step number is reachable from neither the prompt nor `work_get`. An agent that
still has its history re-reads it; a fresh Codex thread has to re-derive its
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
- **Step state persists**: `CurrentStep` is preserved through `stopped`/`needs_input` transitions.
- **Retry counter resets per step**: Each new step gets a fresh retry budget.
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
(`AutoResumer`'s interrupted branch → `stopped`) and produces no message at all,
so a transcript that inferred status from its last message would go on claiming
the work was being nudged along after it had already stopped.

### System-Origin Message Tagging

A work-driven prompt is byte-for-byte indistinguishable from a user-typed message once it reaches the agent — same stdin, same `message` event. To let the frontend tell them apart, they are sent via `chat.Client.SendSystemMessage` (not the plain user path), which stamps the `MessageEvent` with `origin: "system"`, a `subtype`, and a `meta` summary. The origin is `"system"` rather than `"work"` because it marks a message produced by Pockode itself; the Work engine is today's only such producer, but the concept is source-agnostic. The user path leaves `origin` empty, so old history stays a normal user message — backward compatible by omission. (For why this reuses the `message` event rather than a new event type, see [agent-event.md](../agent-event.md#message-origin-user-vs-system).)

**Subtypes** (`server/work/prompt.go`) — one per send site, so the frontend can pick a word without parsing the prompt. `web/src/utils/systemMessage.ts` is the single source of that wording, and it decides both halves of a line together: which title belongs on a line depends on the same subtype the action word does.

| Subtype | Sent from | Action word | Secondary line |
|---------|-----------|-------------|----------------|
| `kickoff` | `WorkStarter` fresh start | Started | work title |
| `restart` | `WorkStarter` restart | Restarted | work title |
| `auto_continue` | `AutoResumer` auto-continuation | Continued | *(blank)* |
| `step_advance` | `AutoResumer.NotifyStepDone` | Step N/M | work title |
| `reopen` | `AutoResumer.NotifyReopen` | Reopened | work title |
| `child_done` | `AutoResumer` parent reactivation | Subtask done | child title |
| *(unknown or absent)* | — | System Message | work title |

Every action word states a finished fact — something started, continued, reached step 2 — because by the time anyone reads it the event is over. Wording it that way is the cheapest guard there is against the rule at the top of this section: a word that can only describe a moment cannot be mistaken for a live status.

- **`step_advance`'s action word *is* the step**: reaching step 2 is the whole of what happened, so a separate "Next step" label in front of it would only push the fact aside. It is formatted through `formatStepProgress(recordedStepProgress(...))` like every other step in the UI, so step wording has one source; a message that recorded no `step` falls back to "Next step".
- **`auto_continue` says nothing else.** It is the one subtype that repeats, and repeating the same title is the least informative line there is; blank keeps it visually weightless.
- **`child_done` names the child.** The message is delivered to the parent but reports on the subtask, so the parent's own title is noise next to it.

**Meta summary** — `NewMessageMeta(w, step, total)` builds that data so the UI never has to read the prompt body (whose first lines are always the MCP boilerplate prefix). It carries `work_id` / `work_type` / `title` from `w`, plus `step` when the send site has real step context (`total > 0` and `1 <= step <= total`); `child_done` additionally carries `child: {id, title}`, so the line can name the finished subtask without parsing the prompt.

Every subtype fills `step`, including the three whose prompt body never restates one — `restart`, `reopen` and `child_done` append only their nudge (see *Prompt Format*). Summary and body answer different questions: the body says what the agent has to act on, the summary says where the work stood, and the UI needs the latter even when the prompt withholds it. `step` is omitted only when there is genuinely no position to report — a stepless role, a failed step lookup (`stepCount` answers 0 for both, since a missing step provider must not block a message), or a `current_step` left out of range by a role whose steps were shortened afterwards.

`w` is the **receiving** work — the one whose session the message is delivered to, which is not always the one the message is about. `child_done` is delivered to the *parent's* session, so its `work_id` is the parent's. That field is what the message's *Details* link opens, so filing the message under the child would send the reader into a work this message was never delivered to. Taking the whole `Work` rather than a loose title and id is what makes that hard to get wrong: every field is derived from one value, so no call site can label one work while keying on another.

`meta.step` is the field most easily mistaken for live state: it records where the work stood **when the message was sent**. It is what this event's own line is worded from, and the only step the transcript knows — never the work's current position.

### Rendering in the Transcript

Origin, subtype and meta ride through the reducer: `normalizeEvent` runs the raw `origin` through `normalizeOrigin`, which folds both the current `"system"` and the legacy stored `"work"` to `"system"` (so old persisted history and live events converge on the new name at this single wire boundary), passes `"user"` through, and drops anything else to `undefined`; it then copies origin/subtype/meta onto the normalized `message` event.

From there a system-origin message takes exactly the path a user-typed one takes — `applyServerEvent` → `applyUserMessage` — and lands as a `UserMessage` carrying `source` / `subtype` / `meta`. There is no branch on `meta.work_id` and no message variant of its own. History recorded before any of this existed carries no meta and simply has less to say on the same line, so there is no data migration and no second rendering path to keep in step. Plain user messages stay source-less, so optimistic local echoes and ordinary history still render as normal bubbles. Replay feeds this same function, so replay and live streaming cannot drift into two different renderings — keep it that way.

**One event, one collapsed line, where it happened** (`WorkEventItem`, in `web/src/components/Chat/MessageItem.tsx`). Collapsed it reads `Pockode · {action word}` plus the secondary line, in the same shape a Claude Task strip uses ([frontend-state.md](frontend-state.md#task-parts)); expanded it shows the work's title in full, the prompt body, and a *Details* link into the work's detail overlay — the one thing older history cannot offer, since a message that recorded no `work_id` names no work to open. It subscribes to nothing and reads only its props.

That form falls out of the rule this section opens with, and is the reason the rule is now cheap to keep:

- **A line that states one finished fact cannot go stale.** The aggregate card this replaced had to subscribe to `workStore` and `agentRoleStore` on every render to avoid lying about status, step and blocked subtasks — the rule held only because the card kept re-reading. A work event answers no question about *now*, so there is nothing in it that could contradict the store.
- **The right-hand status area is empty, permanently.** A work event shows no status and never a spinner. A Claude Task strip does show one, and the asymmetry is deliberate: a Task call has a start and an end worth reporting on, a work event is instantaneous — it is over the moment it is recorded.
- **Pagination stops being a special case.** A work whose messages straddle a page boundary needs no folding back together, and no message needs an id that survives re-anchoring: a work event is an ordinary message, so `prependHistoryPage` treats it like every other one ([agent-chat.md](../agent-chat.md#reading-a-page-on-the-client)).
- **No step divider.** A `step_advance` line already lands where the work moved on and already reads `Step n/m`; a hairline saying the same thing in the same place was duplication left over from when the card was pinned upstream and the stream needed something else to mark the change of step.

Three consequences worth stating outright, so none of them is later "fixed" back:

- **A title freezes at the moment of the event.** The line words itself from `meta.title`, so renaming a work leaves its older messages reading the old name. That is correct — the record says what was true then — and the current title is one tap away behind *Details*.
- **A work event carries no action row and cannot be a fork anchor.** `hasMessageActions` excludes `source === "system"`, and `isForkableMessage` follows it. These are Pockode's own annotations, not conversation turns ([session-fork-ui.md](../session-fork-ui.md#which-messages-get-the-row-and-when-fork-is-on-it)).
- **A fork's `droppedCount` counts each event separately.** A work's messages used to collapse into one card and be counted once; now each is one message, which is the honest number.

**And nowhere else in the transcript either.** Chat used to answer "is my work still running?" from a status dot and `Step n/m` in its top bar, without the user scrolling to find a card. It no longer answers it at all: that question belongs to the work list and the detail overlay (*One Vocabulary for Work Status*), and giving it up is the price of a transcript that is only a transcript. The one piece of that vocabulary chat still borrows is step wording, so a step named on an event line and the same step named in `WorkDetailOverlay` cannot come out phrased differently.

### Reply Placeholders

Every message added to the transcript leaves an empty assistant message behind it — a system message drives the agent just as a user message does, and the placeholder is where the reply streams in. When the agent answers with nothing at all, that placeholder would render as a blank box, so it is dropped at either of the two moments its fate is settled: when the next message arrives (`closePreviousTurn`) and when a terminal event ends the turn. An agent that goes quiet under repeated auto-continuation produces a run of them, which is why this is worth doing at all.

The condition (`isEmptyPlaceholder`) is `parts` empty **and** status `complete`, and the second half is not incidental: `interrupted`, `error` and `process_ended` say their whole message in the status line, so an empty body is exactly when they matter. Dropping those would hide an aborted turn from the user — and an interrupt is the case that produces them most. (The terminal sweep clears one more thing, older than this rule and unrelated to it: a bubble still `sending` when the turn ended, meaning the send never produced anything at all.)

Two entry points add a message, and both have to call `closePreviousTurn`. One is `applyUserMessage` in the reducer, which every broadcast now takes whether it was typed or sent by the Work engine; the other is `sendUserMessageHandler` in `useChatMessages`, which appends the local echo straight to the list without going through `applyServerEvent`. Missing it there is not hypothetical: a session whose process died right after a message was persisted replays as an unanswered placeholder, and the next thing the user sends would strand it as a blank box.

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
  All work_* and agent_role_* tools in this session...

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
| `story_rules_suffix` | Story kickoff | `ID` |
| `task_rules_with_parent` | Task with parent | `ParentID`, `ID` |
| `task_rules_without_parent` | Standalone task | `ID` |
| `story_restart_nudge` | Story restart | `ID` |
| `task_restart_nudge` | Task restart | `ID` |
| `story_auto_continue_nudge` | Story auto-continuation | `ID` |
| `task_auto_continue_nudge` | Task auto-continuation | `ID` |
| `step_auto_continue_nudge` | Step auto-continuation | `CurrentStep`, `TotalSteps`, `ID` |
| `child_completion_nudge` | Waiting parent resume | `ChildTitle`, `ChildID`, `ID` |
| `story_reopen_nudge` | Story reopen | `ID` |
| `task_reopen_nudge` | Task reopen | `ID` |
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
| Auto resumer | `server/work/auto_resumer.go` |
| Worktree start/stop handlers | `server/worktree/work_starter.go`, `server/worktree/work_stopper.go` |
| Worktree manager (sender resolver) | `server/worktree/manager.go` |
| Worktree delete protection | `server/ws/rpc_worktree.go` |
| Prompt builder | `server/work/prompt.go` |
| Prompt templates | `server/work/prompts.yaml` |
| MCP stdio proxy + client | `server/mcp/server.go`, `server/mcp/client.go` |
| MCP tool definitions | `server/mcp/tools.go` |
| MCP tool executor + HTTP API | `server/mcp/executor.go`, `server/mcp/handler.go` |
| File I/O | `server/filestore/filestore.go`, `server/filestore/atomic.go` |
| Frontend store | `web/src/lib/workStore.ts` |
| Frontend step progress + list | `web/src/utils/workSteps.ts`, `web/src/components/Project/StepList.tsx` |
| Frontend work-in-chat rendering | `web/src/lib/messageReducer.ts`, `web/src/components/Chat/MessageItem.tsx`, `web/src/utils/systemMessage.ts` |
