# Autopilot

Task-driven autonomous development.

## Concept

Agents coordinate through tasks. Each agent works autonomously; users observe via Chat UI.

```
User: "Build auth feature"
              │
              ▼
        ┌───────────┐
        │  PM Task  │ open → in_progress → done → closed
        │ (parent)  │
        └─────┬─────┘
              │ creates subtasks
    ┌─────────┼─────────┐
    ▼         ▼         ▼
┌────────┐ ┌────────┐ ┌────────┐
│Designer│ │Engineer│ │Reviewer│  (priority order)
│ prio:0 │ │ prio:1 │ │ prio:2 │
└────────┘ └────────┘ └────────┘
    │
    └→ Comments: shared board for agent communication
```

### Key Principles

- **No special agent types** — PM behavior comes from role prompts, not system logic
- **Any task can have subtasks** — Nested hierarchy supported
- **Roles are user-defined** — System provides presets, users customize freely
- **Comments as shared context** — Agents communicate via parent task's comments

## Data Model

### Task

```
tasks/index.json
```

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID |
| parent_id | string? | Parent task ID (for subtasks) |
| title | string | Short title |
| description | string | Detailed instructions for agent |
| role_id | string | Reference to AgentRole |
| status | enum | See status lifecycle below |
| priority | int | Sort order for open tasks (lower = higher priority) |
| session_id | string? | Linked session (set when started) |
| created_at | time | |
| updated_at | time | |

### Status Lifecycle

```
open → in_progress → done → closed
                  ↘ failed
                  ↘ needs_review
```

| Status | Description |
|--------|-------------|
| `open` | Not started |
| `in_progress` | Agent working |
| `done` | Agent's own work complete (may still have open subtasks) |
| `closed` | Fully complete (self + all subtasks) |
| `failed` | Agent encountered unrecoverable error |
| `needs_review` | Agent requests human review before proceeding |

**Blocking statuses**: `failed` and `needs_review` block automatic execution. User must manually resolve (retry, close, or continue) via UI.

**Transition rules** (system-controlled):
- `done` → `in_progress`: When child completes, parent is reactivated for review
- `done` → `closed`: When all subtasks are `closed` (or no subtasks)
- `failed` / `needs_review` → any: Manual user action only
- Parent cycles between `done` (waiting) and `in_progress` (reviewing) until all children complete

### Comment

```
tasks/{task_id}/comments.json
```

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID |
| task_id | string | The task this comment belongs to |
| author_task_id | string? | Which task's agent posted this |
| author_role | string | Display name (e.g., "Designer") |
| content | string | Message content |
| created_at | time | |

**Comment placement**:
- Subtasks post to **parent task** for sibling communication
- Comments are for passing information to other agents (siblings or future subtasks)

Example flow:
1. Designer posts to parent: "UI specs at /designs/auth.fig"
2. Engineer reads parent's comments before starting work

### AgentRole

```
agent_roles.json
```

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID |
| name | string | Display name |
| role_prompt | string | Role-specific instructions (appended to system prompt) |

**Preset roles** (user-editable):

| Role | Purpose |
|------|---------|
| Project Manager | Breaks down tasks, creates subtasks, monitors progress |
| Engineer | Implements features, fixes bugs |
| Designer | Creates UI/UX designs |
| Reviewer | Reviews code, provides feedback |

## RPC Methods

### Task

| Method | Params | Result |
|--------|--------|--------|
| `task.create` | `{title, description, role_id, parent_id?, priority?}` | Task |
| `task.update` | `{task_id, title?, description?, priority?}` | Task |
| `task.delete` | `{task_id}` | `{}` |
| `task.start` | `{task_id}` | `{session_id}` |
| `task.list.subscribe` | `{}` | `{id, tasks}` |
| `task.list.unsubscribe` | `{id}` | `{}` |

Note: Status transitions are system-controlled. Use `task.start` to begin (open → in_progress). Other transitions happen automatically when agents mark done.

### Comment

| Method | Params | Result |
|--------|--------|--------|
| `task.comment.list` | `{task_id}` | `{comments}` |
| `task.comment.create` | `{task_id, content}` | Comment |

Note: `author_task_id` and `author_role` are auto-populated from agent context (TASK_ID).

### Agent Role

| Method | Params | Result |
|--------|--------|--------|
| `agent.role.list` | `{}` | `{roles}` |
| `agent.role.create` | `{name, role_prompt}` | AgentRole |
| `agent.role.update` | `{role_id, name?, role_prompt?}` | AgentRole |
| `agent.role.delete` | `{role_id}` | `{}` |

### Notifications

| Method | Params |
|--------|--------|
| `task.list.changed` | `{id, operation, task?}` or `{id, operation, taskId}` |

## Code Structure

Structure details are implementation concerns. See actual files:

**Backend**: `server/task/`, `server/mcp/`, `server/watch/`, `server/ws/`

**Frontend**: `web/src/lib/taskStore.ts`, `web/src/components/Autopilot/`

## Execution Flow

### Manual Start (User-initiated)

1. User clicks "Start" on an open task
2. Backend creates new Session
3. Backend updates task: status → in_progress, session_id set
4. Backend sends initial message (description or title) with system prompt + role_prompt

### Subtask Lifecycle

```
Parent (PM role)                    Subtasks
─────────────────                   ────────
1. Started by user (in_progress)
2. Analyzes task
3. Creates subtasks ─────────────→  [Designer: open, prio:0]
   (via MCP tool)                   [Engineer: open, prio:1]
4. Marks self done                  [Reviewer: open, prio:2]
         │
         ▼
   (Parent: done)
         │
5. System auto-starts ─────────────→  Designer starts (in_progress)
   first open subtask                     │
                                    Designer works...
                                    Designer marks done (no subtasks)
                                          │
6. System sets Designer: closed ←─────  Designer: closed
   System sets Parent: in_progress
   System sends chat to Parent session:
   "Designer completed. Check comments and adjust subtasks if needed.
    If no issues, simply finish. Lifecycle is managed automatically."
         │
7. Parent reviews (in_progress)
   - Reads comments
   - If adjustment needed: creates/modifies tasks
   - Marks self done
         │
         ▼
8. System auto-starts ─────────────→  Engineer starts
   next open subtask                      │
   ...repeat...                           │
                                          │
9. Last child closed, Parent reviews     Reviewer: closed
   Parent marks done (all children closed)
         │
         ▼
10. System sets Parent: closed ────────  Complete
```

### System-controlled Transitions

The system (not agents) controls task lifecycle:

| Event | System Action |
|-------|---------------|
| Task marks `done` with no subtasks | Set task to `closed` |
| Task marks `done` with open subtasks | Start first open subtask |
| Child becomes `closed` | Set parent to `in_progress`, send review chat |
| Parent marks `done` with open children | Start next open subtask |
| Parent marks `done` with all children `closed` | Set parent to `closed` |

**Key insight**: Agents only call `task_mark_done`. All other transitions (`closed`, `in_progress` during review) are system-controlled.

### Session Lifecycle

| Condition at `done` | Session behavior |
|---------------------|------------------|
| Has open/in_progress subtasks | Session stays alive, awaits child completion notifications |
| No subtasks (or all closed) | Session terminated |

**Key distinction**:
- **Has subtasks**: `done` → system starts first child → child closes → system sets `in_progress` → agent reviews and marks `done` → system starts next child → repeat until all children closed → system sets `closed` → session terminated
- **No subtasks**: `done` → system sets `closed` → session terminated

Note: The system checks for subtasks at the moment of `done` transition. If an agent creates subtasks, it should do so before marking itself done.

### Parent Notification

When a subtask becomes `closed` (done with no subtasks → auto-closed):
1. System sets parent to `in_progress` and sends message to parent's session
2. Parent agent reviews output (via comments)
3. If adjustment needed: parent creates/modifies tasks
4. Parent marks self as `done`
5. System starts next open child (or closes parent if all children closed)

**If parent session is terminated** (edge case):
- Subtask becomes `closed` as normal
- Parent cannot be notified (session gone)
- No automatic progression to next subtask
- User must manually restart parent session or manage tasks via UI
- This prevents unsupervised progression and maintains human oversight

## MCP Integration

Agents access tasks via MCP tools. The `pockode mcp` subcommand runs an MCP server (stdio transport).

### Tools

**Read operations**:

| Tool | Description |
|------|-------------|
| `task_list` | List all tasks |
| `task_get` | Get single task by ID |
| `task_comment_list` | List comments on a task |
| `role_list` | List available agent roles |

**Write operations** (constrained actions):

| Tool | Description |
|------|-------------|
| `task_create` | Create subtask under current task (root tasks are created via UI/RPC only) |
| `task_mark_done` | Mark own task as done |
| `task_mark_failed` | Mark own task as failed (with error message) |
| `task_request_review` | Mark own task as needs_review (with reason) |
| `task_comment_create` | Post comment to parent task |

**Status transitions** (all system-controlled except agent-initiated):
- `done`: Agent calls `task_mark_done`
- `failed`: Agent calls `task_mark_failed`
- `needs_review`: Agent calls `task_request_review`
- `in_progress`: System sets when child closes (for parent review)
- `closed`: System sets when task marks done with no subtasks, or all children closed

**Design rationale**: Agents only mark themselves `done`. System controls all other transitions based on session state and task relationships.

### Agent Context

When an agent session starts, it receives context via system prompt:
- `TASK_ID`: The agent's own task ID
- `PARENT_TASK_ID`: Parent task ID (if subtask)

This allows agents to:
- Update their own task status
- Post comments to parent task (for sibling communication)

### Configuration

Claude receives MCP config via `--mcp-config`:

```json
{
  "mcpServers": {
    "pockode-task": {
      "command": "/path/to/pockode",
      "args": ["mcp"],
      "env": {
        "POCKODE_DATA_DIR": "/path/to/data",
        "POCKODE_TASK_ID": "<task-id>",
        "POCKODE_PARENT_TASK_ID": "<parent-task-id>"
      }
    }
  }
}
```

The `POCKODE_TASK_ID` and `POCKODE_PARENT_TASK_ID` environment variables are set dynamically when starting an agent session. MCP handlers use these to auto-populate comment author info.

### Sync

FileStore uses fsnotify to detect external changes (from MCP). When MCP modifies tasks, the WebSocket server reloads and notifies connected clients.

## Priority System

### Overview

- Lower value = higher priority (0 is highest)
- Priority is **scoped to parent** — siblings compete within the same parent
- Root tasks (no parent) share a global priority space
- Only `open` tasks are sorted by priority
- `in_progress` and `done` tasks are sorted by `updated_at` descending

### Auto-assignment

When creating a task without specifying priority:
- New priority = max(priority of sibling open tasks) + 1
- If no open siblings exist, priority = 0

### MCP Usage

```json
// Create with explicit priority
{"title": "...", "role_id": "...", "priority": 0}  // Highest priority

// Create with auto-assignment
{"title": "...", "role_id": "..."}  // Priority auto-assigned
```

## Limits

To prevent runaway execution:

| Limit | Default | Description |
|-------|---------|-------------|
| `MAX_SUBTASK_DEPTH` | 5 | Maximum nesting depth |
| `MAX_SUBTASKS_PER_PARENT` | 20 | Maximum children per task |
| `TASK_TIMEOUT_MINUTES` | 30 | Auto-fail if in_progress exceeds this |
| `MAX_REVIEW_CYCLES` | 10 | Max done→in_progress cycles per task |

When limits are exceeded:
- Depth/count limits: `task_create` returns error
- Timeout: System sets task to `failed` with timeout message
- Review cycles: System sets task to `needs_review`

## Design Decisions

- **Store interface decoupled from transport** — Same Store used by WebSocket RPC and MCP
- **Tasks are global** (not per-worktree) — Single task store at Manager level
- **Roles are also global** — Shared across worktrees
- **Prompt composition** — System prompt (Pockode) + Role prompt (user-defined)
- **No special agent types** — PM vs Worker distinction is purely in role prompts
- **Comments on parent task** — Siblings communicate via shared board, not direct messaging
- **Sequential subtask execution** — One subtask at a time; parallel execution not supported in v1
- **Parent supervision required** — Subtasks don't auto-progress; parent reviews each before system closes
- **Constrained interfaces** — Both RPC and MCP restrict status changes; system controls transitions
- **Fail-safe defaults** — Timeouts and limits prevent infinite loops and resource exhaustion

## Prompt Structure

### System Prompt (provided by Pockode)

Pockode injects a base system prompt that teaches agents how to use the task system:
- Available MCP tools (task_create, task_mark_done, task_comment_create, etc.)
- TASK_ID and PARENT_TASK_ID context
- Basic workflow conventions

### Role Prompt (user-defined)

Each AgentRole has a `role_prompt` that defines role-specific behavior. Examples:

### For PM-like roles

```
You coordinate work by creating and managing subtasks.

Workflow:
1. Analyze the task and break it into subtasks
2. Create subtasks with appropriate roles and priorities
3. Mark yourself as done (system will auto-start first subtask)
4. When notified of subtask completion:
   - Review the work (check comments for outputs)
   - If adjustment needed: create new tasks or modify priorities
   - Mark yourself as done (system starts next subtask)
5. System closes you automatically when all subtasks complete

Use comments to provide guidance to subtask agents.
```

### For Worker roles

```
You work on assigned tasks and report via comments.

Workflow:
1. Check parent task's comments for context from other agents
2. Do your work
3. Post results to comments (file paths, PR numbers, etc.)
4. Mark yourself as done (this ends your session)

If you encounter issues:
- Unrecoverable error: mark as failed with error details
- Need human decision: mark as needs_review with question

Example comment: "UI design complete. See /designs/auth-flow.fig"
```

## Scope & Limitations

### What This Enables

- **Autonomous task breakdown**: User describes goal, PM agent decomposes into steps
- **Handoff between specialists**: Designer → Engineer → Reviewer with context preserved
- **Human oversight**: Parent supervision prevents runaway execution
- **Flexible workflows**: Users define their own roles and processes

### What This Does NOT Do (v1)

- **Parallel execution**: Subtasks run sequentially, not concurrently
- **Cross-project coordination**: Tasks are per-project, no global orchestration
- **Automatic quality gates**: No built-in testing/validation between steps

### Complexity Trade-off

This feature adds complexity. Consider whether simpler alternatives suffice:

| Need | Simpler Alternative |
|------|---------------------|
| Run multiple tasks | Manual task creation, no PM |
| Handoff context | Single long-running session with checkpoints |
| Task breakdown | User creates subtasks manually |

The PM/subtask model is valuable when:
- Tasks are large enough to benefit from decomposition
- Different roles genuinely need different prompts
- User wants to observe without constant intervention
