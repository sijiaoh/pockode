# Agent Team

Ticket-driven multi-agent collaboration.

## Concept

Agents coordinate through tickets. Each agent works autonomously in yolo mode; users observe via Chat UI.

```
┌─────────────────────────────────────────────────────┐
│                    Agent Loop                       │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐         │
│  │  Open   │ →  │ In Prog │ →  │  Done   │         │
│  │ Tickets │    │ (Agent) │    │         │         │
│  └─────────┘    └─────────┘    └─────────┘         │
│       ↑              │                              │
│       │              ↓                              │
│       │         Sub-tickets (future)                │
└───────┼─────────────────────────────────────────────┘
        │
   User creates (optional)
```

## Data Model

### Ticket

```
tickets/index.json
```

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID |
| parent_id | string? | For sub-tickets (future) |
| title | string | Task title |
| description | string | Detailed instructions for agent |
| role_id | string | Reference to AgentRole |
| status | "open" \| "in_progress" \| "done" | Kanban column |
| session_id | string? | Linked session (set when started) |
| created_at | time | |
| updated_at | time | |

### AgentRole

```
agent_roles.json
```

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID (or "default") |
| name | string | Display name |
| system_prompt | string | Custom system prompt for agent |

## RPC Methods

### Ticket

| Method | Params | Result |
|--------|--------|--------|
| `ticket.create` | `{title, description, role_id, parent_id?}` | Ticket |
| `ticket.update` | `{ticket_id, title?, description?, status?}` | Ticket |
| `ticket.delete` | `{ticket_id}` | `{}` |
| `ticket.start` | `{ticket_id}` | `{session_id}` |
| `ticket.list.subscribe` | `{}` | `{id, tickets}` |
| `ticket.list.unsubscribe` | `{id}` | `{}` |

### Agent Role

| Method | Params | Result |
|--------|--------|--------|
| `agent.role.list` | `{}` | `{roles}` |
| `agent.role.create` | `{name, system_prompt}` | AgentRole |
| `agent.role.update` | `{role_id, name, system_prompt}` | AgentRole |
| `agent.role.delete` | `{role_id}` | `{}` |

### Notifications

| Method | Params |
|--------|--------|
| `ticket.list.changed` | `{id, operation, ticket?}` or `{id, operation, ticketId}` |

## Backend Structure

```
server/
  ticket/
    types.go        # Ticket, AgentRole, TicketStatus, Operation
    store.go        # FileStore (implements Store interface)
    role_store.go   # FileRoleStore (implements RoleStore interface)
  watch/
    ticket.go       # TicketWatcher (real-time notifications)
  ws/
    rpc_ticket.go   # Ticket RPC handlers
    rpc_agent.go    # AgentRole RPC handlers
```

## Frontend Structure

```
web/src/
  lib/
    ticketStore.ts   # Zustand store for tickets
    roleStore.ts     # Zustand store for roles
    rpc/
      ticket.ts      # Ticket RPC actions
      agent.ts       # Role RPC actions
  hooks/
    useTickets.ts           # Ticket data + subscription
    useTicketSubscription.ts # WebSocket subscription
    useRoles.ts             # Role data + CRUD
  components/Team/
    TeamTab.tsx             # Main tab (sidebar)
    KanbanBoard.tsx         # 3-column layout
    KanbanColumn.tsx        # Single column
    TicketCard.tsx          # Ticket display + actions
    TicketCreateDialog.tsx  # Create form
    AgentSettingsOverlay.tsx # Role management
```

## Start Flow

1. User clicks "Start" on an open ticket
2. Backend creates new Session (yolo mode)
3. Backend updates ticket: status → in_progress, session_id set
4. Backend sends initial message (description or title) with role's system_prompt
5. Frontend navigates to the session

## Design Decisions

- **Store interface decoupled from RPC** — Enables future MCP tool integration
- **Tickets are global** (not per-worktree) — Single ticket store at Manager level
- **Roles are also global** — Shared across worktrees
- **System prompt via CLI flag** — `claude --system-prompt "..."`
