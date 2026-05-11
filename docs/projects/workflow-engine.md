# Workflow Engine

The workflow engine manages work item lifecycles through status transitions, automatic session management, and inter-process coordination.

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
| `open`         | `in_progress`  | `Store.Start` (fresh start)                |
| `in_progress`  | `open`         | `Store.RollbackStart` (fresh start failed) |
| `in_progress`  | `needs_input`  | `Store.MarkNeedsInput`                     |
| `in_progress`  | `waiting`      | `Store.MarkWaiting`                         |
| `in_progress`  | `stopped`      | `Store.Stop` (process ended/interrupted)   |
| `in_progress`  | `closed`       | `Store.StepDone`                           |
| `needs_input`  | `in_progress`  | `Store.Resume` (user confirms)             |
| `needs_input`  | `stopped`      | `Store.Stop` (process ended while paused)  |
| `waiting`      | `in_progress`  | `Store.ResumeFromWaiting` (child completes or user message) |
| `waiting`      | `stopped`      | `Store.Stop` (process ended while waiting) |
| `stopped`      | `in_progress`  | `Store.Start` (restart) or `Store.Reactivate` |
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

The `AutoResumer` listens to work change events and process state changes. It handles process lifecycle sync and two event-driven triggers.

### Process Lifecycle Sync

`HandleProcessStateChange` syncs work status with process lifecycle:

| Process State | Work Action |
|---|---|
| `running` | Reactivate `stopped` work → `in_progress` (handles user sending a message directly to a stopped session) |
| `idle` (not initial, not interrupted) | After settle delay, send auto-continuation if still `in_progress` |
| `idle` (interrupted) | After settle delay, stop work → `stopped` |
| `ended` | After settle delay, stop `in_progress`/`needs_input` work → `stopped` |

**Auto-continuation details:**
1. Wait **2 seconds** (settle delay) — allows `step_done` writes from MCP to propagate via fsnotify.
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

> Source: `server/work/auto_resumer.go` — `handleParentResume`.

### Trigger C: External Work Start

**When:** A work item transitions to `in_progress` with a `sessionID` via an **external** write (fsnotify, e.g. MCP `work_start`).

**Flow:**
1. External process writes `status=in_progress` + `sessionID` to the index file.
2. fsnotify detects the change, store reloads, fires a `ChangeEvent` with `External=true`.
3. AutoResumer delegates to `WorkStartHandler.HandleWorkStart`.
4. On failure, the work item is rolled back to `open` with an empty `sessionID`.

**Purpose:** Allow MCP tools (or other external processes) to start work items. The session creation and kickoff happen in-process even though the trigger was external.

> Source: `server/work/auto_resumer.go` — `handleExternalWorkStart`.

### Trigger E: Explicit Step Done

**When:** A work item's `CurrentStep` is advanced externally via MCP `step_done` tool.

**Flow:**
1. Agent calls `step_done` MCP tool when it completes the current step.
2. `Store.StepDone` advances `CurrentStep` if more steps remain; otherwise it closes the work item.
3. AutoResumer detects the step change via `knownSteps` tracking (External event).
4. If there are more steps:
   - Send `BuildStepAdvanceMessage` with the next step's instructions.
5. If this is the last step, `step_done` closes the work item and no next-step prompt is sent.

**Constraints:**
- Work must be `in_progress` to call `step_done`.
- On the last step, agent should call `step_done` to close the work item.

**Purpose:** Enable explicit step-by-step execution where the agent controls when to advance. This gives the agent full control over step completion timing, avoiding race conditions from automatic detection.

> Source: `server/work/auto_resumer.go` — `handleExternalStepDone`, `server/mcp/tools.go` — `handleStepDone`.

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

Used when Trigger E advances to the next step. Format:
```
[Base message]

Step N-1 of M completed. Proceeding to the next step.

## Current Step
Step N of M

<step instructions>
```

> Source: `server/work/prompt.go`.
