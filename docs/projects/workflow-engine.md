# Workflow Engine

The workflow engine manages work item lifecycles through status transitions and automatic session management.

## Statuses

| Status        | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `open`        | Created, not yet started                                 |
| `in_progress` | Agent session is actively working                        |
| `needs_input` | Agent paused, waiting for user confirmation              |
| `waiting`     | Agent paused, waiting for child work to complete         |
| `stopped`     | Agent session ended (retry limit, interrupt, or orphan)  |
| `closed`      | Work completed                                           |

## Status Transitions

`in_progress`, `needs_input`, `waiting` and `stopped` — the **live** statuses —
form one mutually reachable cluster: they describe process liveness, not
progress (progress is `CurrentStep`). Only `open` and `closed` gate anything, so
a stale liveness status can never lock a work item out of being advanced or
finished. See [work-system.md](../code/work-system.md#state-machine) for the
state diagram and for why the cluster is shaped that way.

### Transition Table

| From           | To             | Trigger                                    |
| -------------- | -------------- | ------------------------------------------ |
| `open`         | `in_progress`  | `Store.Claim` (fresh start — no session yet) |
| `in_progress`  | `open`         | `Store.RollbackStart` (fresh start failed) |
| `in_progress`  | `stopped`      | `Store.RollbackStart` (restart failed)     |
| live           | `needs_input`  | `Store.MarkNeedsInput`                     |
| live           | `waiting`      | `Store.MarkWaiting`                        |
| live           | `stopped`      | `Store.Stop` (process ended/interrupted)   |
| live           | `in_progress`  | `Store.MarkRunning` (user confirms, child completes, or process detected running) |
| paused         | `in_progress`  | `Store.Claim` (restart — the work already owns a session, which is reused) |
| live           | `in_progress`  | `Store.StepDone` (steps remain — the advance also repairs a stale status) |
| live           | `closed`       | `Store.StepDone` (no steps remain)         |
| `closed`       | `in_progress`  | `Store.Reopen` (reopen closed item)        |

"paused" is live minus `in_progress`: a work that is already running must not be
started a second time, which is what makes concurrent `Claim`s resolve to one
winner.

> Source: `server/work/validation.go` — `ValidateProgress` (may the agent move this work along?) and `ValidateStartable` (may a session be started for it?). The code holds no transition table of its own: with the live statuses mutually reachable, those two predicates say everything an edge list would, and a second copy would only be one more thing to keep in sync. The table above enumerates the *triggers*, which the predicates do not name.

### SessionID Management

SessionID changes are encapsulated in intent-based Store methods:

- **`Start`** — sets a new sessionID (fresh start or restart)
- **`RollbackStart`** — clears sessionID on fresh-start failure; preserves on restart failure (→ `stopped`)
- **`Claim`** — reuses the work's existing sessionID when it has one (a restart preserves chat history); generates a fresh one otherwise
- **`MarkRunning`** — preserves existing sessionID (used for process-running detection and resume-from-pause)
- All other transitions leave sessionID unchanged

> Source: `server/work/store.go` — intent-based transition methods.

## Step Completion

Work items transition through `StepDone`; there is no intermediate `done` state. Any work item with remaining steps advances to the next step and stays `in_progress`. When no steps remain, the work item closes. Waiting for child work is handled explicitly through `work_wait` / `Store.MarkWaiting`, not `StepDone`.

When a child work closes, its parent story is automatically resumed (if the parent is `waiting`), allowing the coordinator agent to review results and continue orchestration.

> Source: `server/work/store.go` — `StepDone`.

## AutoResumer

The `AutoResumer` listens to work change events and process state changes. It handles process lifecycle sync, parent-resume on child completion, and the step-advance / reopen follow-up messages the in-process MCP and WebSocket paths request.

### Process Lifecycle Sync

`HandleProcessStateChange` syncs work status with process lifecycle:

The per-state mapping is tabulated in
[work-system.md](../code/work-system.md#triggers). It used to be repeated here
too, which is how the two copies came to disagree with each other and with the
code; what follows is only the auto-continuation policy, which this document
owns.

**Auto-continuation details:**
1. Wait **2 seconds** (settle delay) — lets an in-flight `step_done`'s in-process retry reset land first.
2. Look up the work item by `sessionID`. If still `in_progress`, send a continuation message.
3. Retry counter per session (configurable `maxRetries`). On limit, work transitions to `stopped`. Counter resets on `closed`/`stopped` transitions or deletion.

> Source: `server/work/auto_resumer.go` — `HandleProcessStateChange`, `handleAutoContinuation`.

### Trigger B: Parent Resume on Child Completion

**When:** A child work item transitions to `closed` and the parent is `waiting` with a `sessionID`.

**Flow:**
1. Child transitions to `closed`.
2. Look up parent. If parent is `waiting` with a non-empty `sessionID`:
   - `MarkRunning` transitions parent to `in_progress` and sends a child completion message.

**Purpose:** Stories (coordinators) are automatically woken up when a child task completes, so they can review results and continue orchestration.

> Source: `server/work/auto_resumer.go` — `handleParentReactivation`.

### Work Start, Step Advance, and Reopen (in-process)

`work_start`, `step_done`, and `work_reopen` are driven in-process rather than by
reacting to file changes. `work_start` and `work_reopen` go through a single
shared implementation, `work.Operations`, called by **both** the WebSocket
handler (user actions) and the MCP `Executor` (AI actions) — so a user-triggered
action and an AI-triggered action have identical effects:

- **work_start** (`Operations.StartWork`) — atomically claims the work
  (`Store.Claim`: `in_progress` + `sessionID`, deciding restart/session reuse
  under the store lock) and invokes `WorkStartHandler.HandleWorkStart` to
  create the session and send the kickoff. On failure the claim is rolled back to
  `open` with an empty `sessionID`. Runs on a detached context so a caller
  timeout/disconnect cannot orphan a half-created session.
- **work_reopen** (`Operations.ReopenWork`) — after `Store.Reopen`
  (`closed → in_progress`), calls `AutoResumer.NotifyReopen` to send the reopen
  nudge.
- **step_done** (MCP-only) — `Store.StepDone` advances `CurrentStep` if more steps
  remain, otherwise it closes the work item. While the work stays `in_progress`,
  the `Executor` calls `AutoResumer.NotifyStepDone`, which sends the next step's
  instructions via `BuildStepAdvanceMessage`. On the last step no prompt is sent.
  Work must be `in_progress` to call `step_done`.

**Purpose:** Give the agent explicit control over step timing while keeping the
main server the single writer; the follow-up messages are requested directly by
the in-process caller instead of being detected from a file change. Routing
start/reopen through one `Operations` type keeps the two transports behaviorally
identical.

> Source: `server/work/operations.go` — `StartWork`, `ReopenWork`;
> `server/work/auto_resumer.go` — `NotifyStepDone`, `NotifyReopen`.

## WorkStarter

`WorkStarter` implements `WorkStartHandler` and performs the session initialization sequence for work items that have already been claimed (`status=in_progress`, `sessionID` set).

**Fresh start sequence:**
1. Validate `agent_role_id` exists.
2. Acquire the work's worktree (`w.Worktree`; empty = main), so the session, its
   process, and cwd live in the worktree the work is bound to.
3. Check if a session with the `sessionID` already exists. If not (fresh start):
4. Create a new chat session on the role's engine, set its title (best-effort).
5. Send `BuildKickoffMessage`. On failure, the session is cleaned up (deleted).

**Restart sequence** (session already exists, e.g. stopped work restarted):
1–3 same as above, but the existing session is detected, so:
4. Send `BuildRestartMessage` to the existing session instead of creating a new one.

### Role Engine to Session Engine

A session started for a work item takes its engine from the work's agent role
([engine fields](data-model.md#engine-fields)):

| Session field | Comes from |
|---|---|
| `agent_type` | `role.agent_type`, or the global default agent if the role set none |
| `model` / `effort` | `role.model` / `role.effort`, or the global defaults — see below |
| `mode` | `settings.DefaultMode` — always global, never the role |

Mode is the one launch-time setting a role does not carry — it stayed global
when the other three moved onto the role, so there is no `role.mode` to look
for.

The model and effort fall back to `settings.DefaultModel` / `DefaultEffort` field
by field: a role that names a model but no effort keeps its model and takes the
global effort. Two branches are easy to miss:

- **Only while the session stays on the global agent.** A role naming a
  *different* agent than the global default gets neither the global model nor the
  global effort — both were picked from the global agent's lists and mean nothing
  in another's, so its empties go to the CLI. This is all-or-nothing: it is the
  agent that decides, not whether the individual value happens to exist on both.
- **An unset `DefaultAgentType` counts as the built-in default agent**
  (`session.DefaultAgentType`) for that comparison, since that is the agent these
  sessions will actually run on. So a role that explicitly picks that agent
  inherits the global model from a user who never touched the agent setting — the
  two agree, whatever the stored strings look like. (The role's own empty agent
  type is never resolved this way; see [Engine
  Fields](data-model.md#engine-fields).)

`settings.Settings.ResolveEngine` is the single implementation of all of this.
`handleSessionCreate` hands it an empty role engine, so a session created by hand
is the case where Settings supplies every field, and the two kinds of session are
born the same way.

All four go to `SessionStore.Create` as a `CreateSpec`, which checks the model
and the effort against the agent type before the session exists. A rejection
therefore means no session was made at all, and the error has a path all the way
out: `WorkStarter` wraps it with the role's name and id — adding *"with the
global defaults applied"* when the engine did not come from the role alone —
`Operations.StartWork` rolls the claim back, and the ws and MCP callers surface
the text. That chain is what makes a retired model a reportable failure rather
than a silent one, and the wrapping names every place the value could have to be
fixed: pointing only at the role would send the user looking for a model that
lives in Settings.

**Only a fresh start reads the role.** The restart path leaves the existing
session's engine alone, so editing a role changes what the *next* session gets,
never a conversation already running; the chat's engine selector is what changes
an existing one.

> Source: `server/worktree/work_starter.go`.

## WorkStopper

`WorkStopper` is the counterpart to `WorkStarter`. It transitions a work item to `stopped` and terminates the associated agent process.

> Source: `server/worktree/work_stopper.go`.

## NeedsInputSyncer

`NeedsInputSyncer` bridges session-level `needs_input` state to work status. When a session enters `needs_input`, the associated `in_progress` work transitions to `needs_input`; when the session resumes, the work transitions back to `in_progress`.

> Source: `server/work/needs_input_syncer.go`.

## Prompt Builders

Six prompt builders generate messages for different lifecycle events. All share a common base structure:

**Base (`buildBase`):**
- Agent role reference (instructs agent to fetch its role via `agent_role_get`)
- Work context (title, ID, instruction to read full details via `work_get`)
- Behavior rules (vary by work type):
  - **Story:** Coordinator rules — break work into tasks, call `work_wait` after starting child tasks to wait for completion reports, do not implement anything, do not call `step_done` on children, and call `step_done` when a step is complete or when story work with no steps is complete.
  - **Task with parent:** Check parent comments and report results via `work_comment_add`; call `step_done` when a step is complete or when task work with no steps is complete.
  - **Task without parent:** Call `step_done` when a step is complete or when task work with no steps is complete.

### BuildKickoffMessage

Returns the base message. Used when a work item is first started (without steps).

### BuildKickoffMessageWithSteps

Base + step section if the agent role has steps. Format:
```
[Base message]

## Current Step
Step 1 of N

<step instructions>
```

Used when a work item's agent role has `steps` defined. Falls back to `BuildKickoffMessage` if no steps.

### BuildRestartMessage

Base + a restart nudge appropriate to the work type:
- **Story:** "Your story was stopped and is now being restarted. Review your tasks…"
- **Task:** "Your task was stopped and is now being restarted. Review what you've done…"

### BuildAutoContinuationMessage

Base + a nudge appropriate to the work type:
- **Story:** "Your story is still in_progress but your session was interrupted. Review your tasks…"
- **Task:** "Your task is still in_progress but your session was interrupted. Review what you've done…"

### BuildAutoContinuationMessageWithSteps

For work items with steps, base + current step section + step completion check:
```
[Base message]

## Current Step
Step N of M

<step instructions>

Your session was interrupted while working on step N of M.
Check if you have completed the current step:
- If YES: Call step_done with ID xxx to proceed to the next step or close the work.
- If NO: Continue working on this step.
```

Falls back to `BuildAutoContinuationMessage` for stories or when no steps are defined.

### BuildStepAdvanceMessage

Used when a step advance is sent (`NotifyStepDone`). Format:
```
[Base message]

Step N-1 of M completed. Proceeding to the next step.

## Current Step
Step N of M

<step instructions>
```

> Source: `server/work/prompt.go`.

### System-Origin Tagging

Every builder's output reaches the agent through `chat.Client.SendSystemMessage` (not the user path), tagging the `message` event with `origin: "system"`, a per-builder `subtype`, and a `{work_id, work_type, title, step?, child?}` meta summary. Keyed on `work_id`, the frontend folds every prompt one work produced into a single progress card instead of a run of user bubbles. See [code/work-system.md](../code/work-system.md#work-messages-in-chat) for the subtype catalog and rendering flow.
