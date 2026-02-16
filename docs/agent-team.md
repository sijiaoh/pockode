# Agent Team

Ticket-driven multi-agent collaboration.

## Concept

Agents coordinate through tickets. Each agent works autonomously; users observe via Chat UI.

```
User: "Build auth feature"
              │
              ▼
        ┌───────────┐
        │ PM Ticket │ open → in_progress → done → closed
        │ (parent)  │
        └─────┬─────┘
              │ creates sub-tickets
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
- **Any ticket can have sub-tickets** — Nesting depth unlimited
- **Roles are user-defined** — System provides presets, users customize freely
- **Comments as shared context** — Agents communicate via parent ticket's comments

## Data Model

### Ticket

```
tickets/index.json
```

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID |
| parent_id | string? | Parent ticket ID (for sub-tickets) |
| title | string | Task title |
| description | string | Detailed instructions for agent |
| role_id | string | Reference to AgentRole |
| status | enum | See status lifecycle below |
| priority | int | Sort order for open tickets (lower = higher priority) |
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
| `done` | Agent's own work complete (may still have open sub-tickets) |
| `closed` | Fully complete (self + all sub-tickets) |
| `failed` | Agent encountered unrecoverable error |
| `needs_review` | Agent requests human review before proceeding |

**Blocking statuses**: `failed` and `needs_review` block automatic execution. User must manually resolve (retry, close, or continue) via UI.

**Transition rules** (system-controlled):
- `done` → `in_progress`: When child completes, parent is reactivated for review
- `done` → `closed`: When all sub-tickets are `closed` (or no sub-tickets)
- `failed` / `needs_review` → any: Manual user action only
- Parent cycles between `done` (waiting) and `in_progress` (reviewing) until all children complete

### Comment

```
tickets/{ticket_id}/comments.json
```

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID |
| ticket_id | string | The ticket this comment belongs to |
| author_ticket_id | string? | Which ticket's agent posted this |
| author_role | string | Display name (e.g., "Designer") |
| content | string | Message content |
| created_at | time | |

**Comment placement**:
- Sub-tickets post to **parent ticket** for sibling communication
- Comments are for passing information to other agents (siblings or future sub-tickets)

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
| Project Manager | Breaks down tasks, creates sub-tickets, monitors progress |
| Engineer | Implements features, fixes bugs |
| Designer | Creates UI/UX designs |
| Reviewer | Reviews code, provides feedback |

## RPC Methods

### Ticket

| Method | Params | Result |
|--------|--------|--------|
| `ticket.create` | `{title, description, role_id, parent_id?, priority?}` | Ticket |
| `ticket.update` | `{ticket_id, title?, description?, priority?}` | Ticket |
| `ticket.delete` | `{ticket_id}` | `{}` |
| `ticket.start` | `{ticket_id}` | `{session_id}` |
| `ticket.list.subscribe` | `{}` | `{id, tickets}` |
| `ticket.list.unsubscribe` | `{id}` | `{}` |

Note: Status transitions are system-controlled. Use `ticket.start` to begin (open → in_progress). Other transitions happen automatically when agents mark done.

### Comment

| Method | Params | Result |
|--------|--------|--------|
| `ticket.comment.list` | `{ticket_id}` | `{comments}` |
| `ticket.comment.create` | `{ticket_id, content}` | Comment |

Note: `author_ticket_id` and `author_role` are auto-populated from agent context (TICKET_ID).

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
| `ticket.list.changed` | `{id, operation, ticket?}` or `{id, operation, ticketId}` |

## Code Structure

Structure details are implementation concerns. See actual files:

**Backend**: `server/ticket/`, `server/mcp/`, `server/watch/`, `server/ws/`

**Frontend**: `web/src/lib/ticketStore.ts`, `web/src/components/Team/`

## Execution Flow

### Manual Start (User-initiated)

1. User clicks "Start" on an open ticket
2. Backend creates new Session
3. Backend updates ticket: status → in_progress, session_id set
4. Backend sends initial message (description or title) with system prompt + role_prompt

### Sub-ticket Lifecycle

```
Parent (PM role)                    Sub-tickets
─────────────────                   ────────────
1. Started by user (in_progress)
2. Analyzes task
3. Creates sub-tickets ──────────→  [Designer: open, prio:0]
   (via MCP tool)                   [Engineer: open, prio:1]
4. Marks self done                  [Reviewer: open, prio:2]
         │
         ▼
   (Parent: done)
         │
5. System auto-starts ─────────────→  Designer starts (in_progress)
   first open sub-ticket                  │
                                    Designer works...
                                    Designer marks done
                                          │
                                    Designer marks done (no sub-tickets)
                                          │
6. System sets Designer: closed ←─────  Designer: closed
   System sets Parent: in_progress
   System sends chat to Parent session:
   "Designer completed. Check comments and adjust sub-tickets if needed.
    If no issues, simply finish. Lifecycle is managed automatically."
         │
7. Parent reviews (in_progress)
   - Reads comments
   - If adjustment needed: creates/modifies tickets
   - Marks self done
         │
         ▼
8. System auto-starts ─────────────→  Engineer starts
   next open sub-ticket                   │
   ...repeat...                           │
                                          │
9. Last child closed, Parent reviews     Reviewer: closed
   Parent marks done (all children closed)
         │
         ▼
10. System sets Parent: closed ────────  Complete
```

### System-controlled Transitions

The system (not agents) controls ticket lifecycle:

| Event | System Action |
|-------|---------------|
| Ticket marks `done` with no sub-tickets | Set ticket to `closed` |
| Ticket marks `done` with open sub-tickets | Start first open sub-ticket |
| Child becomes `closed` | Set parent to `in_progress`, send review chat |
| Parent marks `done` with open children | Start next open sub-ticket |
| Parent marks `done` with all children `closed` | Set parent to `closed` |

**Key insight**: Agents only call `ticket_mark_done`. All other transitions (`closed`, `in_progress` during review) are system-controlled.

### Session Lifecycle

| Condition at `done` | Session behavior |
|---------------------|------------------|
| Has open/in_progress sub-tickets | Session stays alive, awaits child completion notifications |
| No sub-tickets (or all closed) | Session terminated |

**Key distinction**:
- **Has sub-tickets**: `done` → system starts first child → child closes → system sets `in_progress` → agent reviews and marks `done` → system starts next child → repeat until all children closed → system sets `closed` → session terminated
- **No sub-tickets**: `done` → system sets `closed` → session terminated

Note: The system checks for sub-tickets at the moment of `done` transition. If an agent creates sub-tickets, it should do so before marking itself done.

### Parent Notification

When a sub-ticket becomes `closed` (done with no sub-tickets → auto-closed):
1. System sets parent to `in_progress` and sends message to parent's session
2. Parent agent reviews output (via comments)
3. If adjustment needed: parent creates/modifies tickets
4. Parent marks self as `done`
5. System starts next open child (or closes parent if all children closed)

**If parent session is terminated** (edge case):
- Sub-ticket remains in `done` status
- No automatic progression occurs
- User can manually start the parent session, or manually manage tickets via UI
- This prevents unsupervised progression and maintains human oversight

## MCP Integration

Agents access tickets via MCP tools. The `pockode mcp` subcommand runs an MCP server (stdio transport).

### Tools

**Read operations**:

| Tool | Description |
|------|-------------|
| `ticket_list` | List all tickets |
| `ticket_get` | Get single ticket by ID |
| `ticket_comment_list` | List comments on a ticket |
| `role_list` | List available agent roles |

**Write operations** (constrained actions):

| Tool | Description |
|------|-------------|
| `ticket_create` | Create sub-ticket under current ticket |
| `ticket_mark_done` | Mark own ticket as done |
| `ticket_mark_failed` | Mark own ticket as failed (with error message) |
| `ticket_request_review` | Mark own ticket as needs_review (with reason) |
| `ticket_comment_create` | Post comment to parent ticket |

**Status transitions** (all system-controlled except agent-initiated):
- `done`: Agent calls `ticket_mark_done`
- `failed`: Agent calls `ticket_mark_failed`
- `needs_review`: Agent calls `ticket_request_review`
- `in_progress`: System sets when child closes (for parent review)
- `closed`: System sets when ticket marks done with no sub-tickets, or all children closed

**Design rationale**: Agents only mark themselves `done`. System controls all other transitions based on session state and ticket relationships.

### Agent Context

When an agent session starts, it receives context via system prompt:
- `TICKET_ID`: The agent's own ticket ID
- `PARENT_TICKET_ID`: Parent ticket ID (if sub-ticket)

This allows agents to:
- Update their own ticket status
- Post comments to parent ticket (for sibling communication)

### Configuration

Claude receives MCP config via `--mcp-config`:

```json
{
  "mcpServers": {
    "pockode-ticket": {
      "command": "/path/to/pockode",
      "args": ["mcp"],
      "env": {
        "POCKODE_DATA_DIR": "/path/to/data",
        "POCKODE_TICKET_ID": "<ticket-id>",
        "POCKODE_PARENT_TICKET_ID": "<parent-ticket-id>"
      }
    }
  }
}
```

The `POCKODE_TICKET_ID` and `POCKODE_PARENT_TICKET_ID` environment variables are set dynamically when starting an agent session. MCP handlers use these to auto-populate comment author info.

### Sync

FileStore uses fsnotify to detect external changes (from MCP). When MCP modifies tickets, the WebSocket server reloads and notifies connected clients.

## Priority System

### Overview

- Lower value = higher priority (0 is highest)
- Priority is **scoped to parent** — siblings compete within the same parent
- Root tickets (no parent) share a global priority space
- Only `open` tickets are sorted by priority
- `in_progress` and `done` tickets are sorted by `updated_at` descending

### Auto-assignment

When creating a ticket without specifying priority:
- New priority = max(priority of sibling open tickets) + 1
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
| `MAX_SUBTICKET_DEPTH` | 5 | Maximum nesting depth |
| `MAX_SUBTICKETS_PER_PARENT` | 20 | Maximum children per ticket |
| `TICKET_TIMEOUT_MINUTES` | 30 | Auto-fail if in_progress exceeds this |
| `MAX_REVIEW_CYCLES` | 10 | Max done→in_progress cycles per ticket |

When limits are exceeded:
- Depth/count limits: `ticket_create` returns error
- Timeout: System sets ticket to `failed` with timeout message
- Review cycles: System sets ticket to `needs_review`

## Design Decisions

- **Store interface decoupled from transport** — Same Store used by WebSocket RPC and MCP
- **Tickets are global** (not per-worktree) — Single ticket store at Manager level
- **Roles are also global** — Shared across worktrees
- **Prompt composition** — System prompt (Pockode) + Role prompt (user-defined)
- **No special agent types** — PM vs Worker distinction is purely in role prompts
- **Comments on parent ticket** — Siblings communicate via shared board, not direct messaging
- **Sequential sub-ticket execution** — One sub-ticket at a time; parallel execution not supported in v1
- **Parent supervision required** — Sub-tickets don't auto-progress; parent reviews each before system closes
- **Constrained interfaces** — Both RPC and MCP restrict status changes; system controls transitions
- **Fail-safe defaults** — Timeouts and limits prevent infinite loops and resource exhaustion

## Prompt Structure

### System Prompt (provided by Pockode)

Pockode injects a base system prompt that teaches agents how to use the ticket system:
- Available MCP tools (ticket_create, ticket_mark_done, ticket_comment_create, etc.)
- TICKET_ID and PARENT_TICKET_ID context
- Basic workflow conventions

### Role Prompt (user-defined)

Each AgentRole has a `role_prompt` that defines role-specific behavior. Examples:

### For PM-like roles

```
You coordinate work by creating and managing sub-tickets.

Workflow:
1. Analyze the task and break it into sub-tickets
2. Create sub-tickets with appropriate roles and priorities
3. Mark yourself as done (system will auto-start first sub-ticket)
4. When notified of sub-ticket completion:
   - Review the work (check comments for outputs)
   - If adjustment needed: create new tickets or modify priorities
   - Mark yourself as done (system closes child and proceeds)
5. System closes you automatically when all sub-tickets complete

Use comments to provide guidance to sub-ticket agents.
```

### For Worker roles

```
You work on assigned tasks and report via comments.

Workflow:
1. Check parent ticket's comments for context from other agents
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

- **Parallel execution**: Sub-tickets run sequentially, not concurrently
- **Cross-project coordination**: Tickets are per-project, no global orchestration
- **Automatic quality gates**: No built-in testing/validation between steps

### Complexity Trade-off

This feature adds complexity. Consider whether simpler alternatives suffice:

| Need | Simpler Alternative |
|------|---------------------|
| Run multiple tasks | Manual ticket creation, no PM |
| Handoff context | Single long-running session with checkpoints |
| Task breakdown | User creates sub-tickets manually |

The PM/sub-ticket model is valuable when:
- Tasks are large enough to benefit from decomposition
- Different roles genuinely need different prompts
- User wants to observe without constant intervention
