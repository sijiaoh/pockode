# Workflow Engine

The workflow engine manages work item lifecycles through status transitions, automatic session management, and inter-process coordination.

## Statuses

| Status        | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `open`        | Created, not yet started                                 |
| `in_progress` | Agent session is actively working                        |
| `needs_input` | Agent paused, waiting for user confirmation              |
| `stopped`     | Agent session ended (retry limit, interrupt, or orphan)  |
| `done`        | Direct work complete; children may still be pending      |
| `closed`      | Fully complete — auto-derived, never set directly by API |

## Status Transitions

```
                    ┌──────────────┐
          ┌────────►│  in_progress │◄───────────┐
          │         └┬───┬───┬──┬─┘             │
          │          │   │   │  │                │
          │          ▼   │   ▼  ▼                │
       ┌──┴──┐  ┌──────┐ │ ┌────────────┐ ┌─────┴──┐
       │open │  │ done │ │ │needs_input │ │stopped │
       └─────┘  └──┬───┘ │ └────────────┘ └────────┘
                   │     │
                   ▼     │
               ┌────────┐│
               │closed  │┘
               └────────┘
```

### Transition Table

| From           | To             | Trigger                                    |
| -------------- | -------------- | ------------------------------------------ |
| `open`         | `in_progress`  | `Store.Start` (fresh start)                |
| `in_progress`  | `open`         | `Store.RollbackStart` (fresh start failed) |
| `in_progress`  | `needs_input`  | `Store.MarkNeedsInput`                     |
| `in_progress`  | `stopped`      | `Store.Stop` (process ended/interrupted)   |
| `in_progress`  | `done`         | `Store.MarkDone`                           |
| `needs_input`  | `in_progress`  | `Store.Resume` (user confirms)             |
| `needs_input`  | `stopped`      | `Store.Stop` (process ended while paused)  |
| `stopped`      | `in_progress`  | `Store.Start` (restart) or `Store.Reactivate` |
| `done`         | `in_progress`  | `Store.Reactivate` (parent reactivation)   |
| `closed`       | `in_progress`  | `Store.Reactivate` (parent reactivation)   |
| `done`         | `closed`       | Auto-close (internal, not an API call)     |

> Source: `server/work/validation.go` — `validTransitions` map.

### SessionID Management

SessionID changes are encapsulated in intent-based Store methods:

- **`Start`** — sets a new sessionID (fresh start or restart)
- **`RollbackStart`** — clears sessionID on fresh-start failure; preserves on restart failure (→ `stopped`)
- **`Reactivate`** — preserves existing sessionID (used for parent reactivation, process-running detection)
- All other transitions leave sessionID unchanged

> Source: `server/work/store.go` — intent-based transition methods.

## Auto-Close

When a work item transitions to `done`, the engine checks whether it can be promoted to `closed`:

A `done` item with **all children `closed`** (or no children) is promoted to `closed`.

Note: the parent cascade is **not** recursive within `autoClose`. Instead, the child's `closed` event fires Trigger B (parent reactivation), which sends a message to the parent agent. The parent then calls `work_done` itself, triggering its own auto-close check.

> Source: `server/work/store.go` — `autoClose`.

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
1. Wait **2 seconds** (settle delay) — allows `work_done` writes from MCP to propagate via fsnotify.
2. Look up the work item by `sessionID`. If still `in_progress`, send a continuation message.
3. Retry counter per session (configurable `maxRetries`). On limit, work transitions to `stopped`. Counter resets on `done`/`closed`/`stopped` transitions or deletion.

> Source: `server/work/auto_resumer.go` — `HandleProcessStateChange`, `handleAutoContinuation`.

### Trigger B: Parent Reactivation

**When:** A child work item transitions to `closed` and the parent is `done` with a `sessionID`.

**Flow:**
1. Child transitions to `closed` (via auto-close after `done`).
2. Look up parent. If parent is `done` with a non-empty `sessionID`:
   - Reactivate parent to `in_progress` (preserving sessionID).
   - Reset parent's retry counter.
   - Send a reactivation message to the parent's existing session.

**Purpose:** Stories (coordinators) are automatically woken up when a child task completes, so they can review results and continue orchestration.

> Source: `server/work/auto_resumer.go` — `handleParentReactivation`.

### Trigger C: External Work Start

**When:** A work item transitions to `in_progress` with a `sessionID` via an **external** write (fsnotify, e.g. MCP `work_start`).

**Flow:**
1. External process writes `status=in_progress` + `sessionID` to the index file.
2. fsnotify detects the change, store reloads, fires a `ChangeEvent` with `External=true`.
3. AutoResumer delegates to `WorkStartHandler.HandleWorkStart`.
4. On failure, the work item is rolled back to `open` with an empty `sessionID`.

**Purpose:** Allow MCP tools (or other external processes) to start work items. The session creation and kickoff happen in-process even though the trigger was external.

> Source: `server/work/auto_resumer.go` — `handleExternalWorkStart`.

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

## Prompt Builders

Four prompt builders generate messages for different lifecycle events. All share a common base structure:

**Base (`buildBase`):**
- Agent role reference (instructs agent to fetch its role via `agent_role_get`)
- Work context (title, ID, instruction to read full details via `work_get`)
- Behavior rules (vary by work type):
  - **Story:** Coordinator rules — break work into tasks, call `work_done` immediately, do not implement anything, do not call `work_done` on children.
  - **Task with parent:** Must report results via `work_comment_add` on parent, then call `work_done`.
  - **Task without parent:** Must call `work_done` when finished.

### BuildKickoffMessage

Returns the base message. Used when a work item is first started.

### BuildRestartMessage

Base + a restart nudge appropriate to the work type:
- **Story:** "Your story was stopped and is now being restarted. Review your tasks…"
- **Task:** "Your task was stopped and is now being restarted. Review what you've done…"

### BuildAutoContinuationMessage

Base + a nudge appropriate to the work type:
- **Story:** "Your story is still in_progress but your session was interrupted. Review your tasks…"
- **Task:** "Your task is still in_progress but your session was interrupted. Review what you've done…"

### BuildParentReactivationMessage

Base + a nudge instructing the parent story to:
1. Read task reports via `work_comment_list` on the parent (tasks report results by commenting on their parent).
2. Check remaining tasks via `work_list` with the parent's ID.
3. Call `work_done` if all tasks are finished, or adjust the plan and call `work_done` to wait for the next completion.

> Source: `server/work/prompt.go`.
