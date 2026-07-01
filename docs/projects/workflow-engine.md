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

```
                    ┌──────────────┐
          ┌────────►│  in_progress │◄───────────┐
          │         └┬───┬───┬──┬─┘             │
          │          │   │   │  │                │
          │          ▼   │   ▼  ▼                │
       ┌──┴──┐ ┌───────┐ │ ┌────────────┐ ┌─────┴──┐
       │open │ │waiting│ │ │needs_input │ │stopped │
       └─────┘ └───────┘ │ └────────────┘ └────────┘
                         │
                         ▼
                    ┌────────┐
                    │closed  │
                    └────────┘
```

### Transition Table

| From           | To             | Trigger                                    |
| -------------- | -------------- | ------------------------------------------ |
| `open`         | `in_progress`  | `Store.Claim` (fresh start)                |
| `in_progress`  | `open`         | `Store.RollbackStart` (fresh start failed) |
| `in_progress`  | `needs_input`  | `Store.MarkNeedsInput`                     |
| `in_progress`  | `waiting`      | `Store.MarkWaiting`                         |
| `in_progress`  | `stopped`      | `Store.Stop` (process ended/interrupted)   |
| `in_progress`  | `closed`       | `Store.StepDone`                           |
| `needs_input`  | `in_progress`  | `Store.Resume` (user confirms)             |
| `needs_input`  | `stopped`      | `Store.Stop` (process ended while paused)  |
| `waiting`      | `in_progress`  | `Store.ResumeFromWaiting` (child completes or user message) |
| `waiting`      | `stopped`      | `Store.Stop` (process ended while waiting) |
| `stopped`      | `in_progress`  | `Store.Claim` (restart) or `Store.Reactivate` |
| `closed`       | `in_progress`  | `Store.Reopen` (reopen closed item) |

> Source: `server/work/validation.go` — `validTransitions` map.

### SessionID Management

SessionID changes are encapsulated in intent-based Store methods:

- **`Start`** — sets a new sessionID (fresh start or restart)
- **`RollbackStart`** — clears sessionID on fresh-start failure; preserves on restart failure (→ `stopped`)
- **`Reactivate`** — preserves existing sessionID (used for process-running detection)
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

| Process State | Work Action |
|---|---|
| `running` | Reactivate `stopped` work → `in_progress` (handles user sending a message directly to a stopped session) |
| `idle` (not initial, not interrupted) | After settle delay, send auto-continuation if still `in_progress` |
| `idle` (interrupted) | After settle delay, stop work → `stopped` |
| `ended` | After settle delay, stop `in_progress`/`needs_input` work → `stopped` |

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
   - `ResumeFromWaiting` transitions parent to `in_progress` and sends a child completion message.

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
2. Acquire the main worktree.
3. Check if a session with the `sessionID` already exists. If not (fresh start):
4. Create a new chat session, set its title (best-effort).
5. Send `BuildKickoffMessage`. On failure, the session is cleaned up (deleted).

**Restart sequence** (session already exists, e.g. stopped work restarted):
1–3 same as above, but the existing session is detected, so:
4. Send `BuildRestartMessage` to the existing session instead of creating a new one.

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
