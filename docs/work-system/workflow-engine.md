# Workflow Engine

The workflow engine manages work item lifecycles through status transitions, automatic session management, and inter-process coordination.

## Statuses

| Status        | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `open`        | Created, not yet started                                 |
| `in_progress` | Agent session is actively working                        |
| `needs_input` | Agent paused, waiting for user confirmation              |
| `done`        | Direct work complete; children may still be pending      |
| `closed`      | Fully complete — auto-derived, never set directly by API |

## Status Transitions

```
                    ┌──────────────┐
          ┌────────►│  in_progress │◄───────────┐
          │         └──┬───┬───┬───┘            │
          │            │   │   │                 │
          │            │   │   │                 │
          │            ▼   │   ▼                 │
       ┌──┴──┐   ┌────────┐   ┌────────────┐   │
       │open │   │  done  │   │needs_input │   │
       └─────┘   └───┬────┘   └────────────┘   │
                     │                          │
                     ▼ (auto)                   │
                 ┌────────┐                     │
                 │closed  │─────────────────────┘
                 └────────┘
```

### Transition Table

| From           | To             | Trigger                                    |
| -------------- | -------------- | ------------------------------------------ |
| `open`         | `in_progress`  | `work_start` (external or internal)        |
| `in_progress`  | `open`         | Rollback on failed session start           |
| `in_progress`  | `needs_input`  | Agent calls `work_needs_input`             |
| `in_progress`  | `done`         | Agent calls `work_done`                    |
| `needs_input`  | `in_progress`  | User confirms, agent resumes               |
| `done`         | `in_progress`  | Parent reactivation (Trigger B)            |
| `closed`       | `in_progress`  | Parent reactivation after auto-close       |
| `done`         | `closed`       | Auto-close (not an API transition)         |

> Source: `server/work/validation.go` — `validTransitions` map.

### SessionID Constraints

`SessionID` can only change alongside a status transition:

- **Set** (non-empty) — only when transitioning **to** `in_progress`
- **Cleared** (empty) — only when transitioning **to** `open` (rollback)

This prevents orphaned sessions from accumulating and ensures every active work item has exactly one associated session.

> Source: `server/work/validation.go` — `validateSessionIDChange`.

## Auto-Close

When a work item transitions to `done`, the engine checks whether it can be promoted to `closed`. The rule:

1. A `done` item with **all children `done` or `closed`** (or no children) is promoted to `closed`.
2. After promotion, the engine recursively checks the **parent** — if the parent is also `done` and all its children are now `done`/`closed`, the parent is promoted too.
3. Recursion depth is capped at 10 (current model only has story → task, depth 2).

This means a single `work_done` call on the last child task can cascade: child → `done` → `closed`, parent story → `done` → `closed`.

> Source: `server/work/store.go` — `autoCloseRecursive`.

## AutoResumer

The `AutoResumer` listens to work change events and process state changes, triggering three automatic behaviors:

### Trigger A: Auto-Continuation

**When:** An agent process goes idle (stops) while its work item is still `in_progress`.

**Flow:**
1. Process emits idle state (not `needsInput`, not the initial idle on creation).
2. Wait **2 seconds** (settle delay) — allows `work_done` writes from MCP to propagate via fsnotify before checking status.
3. Look up the work item by `sessionID`. If still `in_progress`, send a continuation message.
4. Retry counter per session, max **3 retries**. Counter resets when work transitions to `done`/`closed` or is deleted.

**Purpose:** Recover from transient agent failures or premature stops without losing work context.

> Source: `server/work/auto_resumer.go` — `HandleProcessStateChange`, `handleAutoContinuation`.

### Trigger B: Parent Reactivation

**When:** A child work item transitions to `closed` and the parent has a `sessionID`.

**Flow:**
1. Child transitions to `closed` (via auto-close after `done`).
2. Look up parent. If parent is `done` or `closed` with a non-empty `sessionID`:
   - Transition parent back to `in_progress`.
   - Reset parent's retry counter.
   - Send a reactivation message to the parent's existing session.
3. The reactivation message instructs the parent to read the child's report, check remaining tasks, and decide next steps.

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

**Sequence:**
1. **Validate agent role** — verify the work item's `agent_role_id` exists in the agent role store.
2. **Acquire main worktree** — get the main worktree from the worktree manager.
3. **Create session** — create a new chat session with the pre-assigned `sessionID`.
4. **Set session title** — set the session title to the work item's title (best-effort, failure logged but not fatal).
5. **Send kickoff message** — send `BuildKickoffMessage` to start the agent. On failure, the session is cleaned up (deleted).

> Source: `server/worktree/work_starter.go`.

## Prompt Builders

Three prompt builders generate messages for different lifecycle events. All share a common base structure:

**Base (`buildBase`):**
- Agent role reference (instructs agent to fetch its role via `agent_role_get`)
- Work context (title, ID, instruction to read full details via `work_get`)
- Behavior rules (vary by work type):
  - **Story:** Coordinator rules — break work into tasks, call `work_done` immediately, do not implement anything, do not call `work_done` on children.
  - **Task with parent:** Must report results via `work_comment_add` on parent, then call `work_done`.
  - **Task without parent:** Must call `work_done` when finished.

### BuildKickoffMessage

Returns the base message. Used when a work item is first started.

### BuildAutoContinuationMessage

Base + a nudge appropriate to the work type:
- **Story:** "Review your tasks, then call `work_done`."
- **Task:** "Review what you've done so far, then complete remaining work or call `work_done`."

### BuildParentReactivationMessage

Base + a nudge instructing the parent story to:
1. Read task reports via `work_comment_list` on the parent (tasks report results by commenting on their parent).
2. Check remaining tasks via `work_list` with the parent's ID.
3. Call `work_done` if all tasks are finished, or adjust the plan and call `work_done` to wait for the next completion.

> Source: `server/work/prompt.go`.
