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
  mcp/
    server.go       # MCP server (stdio transport)
    tools.go        # Tool definitions
    handlers.go     # Tool handlers
    errors.go       # Structured error types
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

## MCP Integration

Agents access tickets via MCP tools. The `pockode mcp` subcommand runs an MCP server (stdio transport).

### Tools

| Tool | Description |
|------|-------------|
| `ticket_list` | List all tickets |
| `ticket_get` | Get single ticket by ID |
| `ticket_create` | Create new ticket |
| `ticket_update` | Update ticket (title, description, status) |
| `ticket_delete` | Delete ticket |
| `role_list` | List available agent roles |

### Configuration

Claude receives MCP config via `--mcp-config`:

```json
{
  "mcpServers": {
    "pockode-ticket": {
      "command": "/path/to/pockode",
      "args": ["mcp"],
      "env": {"POCKODE_DATA_DIR": "/path/to/data"}
    }
  }
}
```

### Sync

FileStore uses fsnotify to detect external changes (from MCP). When MCP modifies tickets, the WebSocket server reloads and notifies connected clients.

## Design Decisions

- **Store interface decoupled from transport** — Same Store used by WebSocket RPC and MCP
- **Tickets are global** (not per-worktree) — Single ticket store at Manager level
- **Roles are also global** — Shared across worktrees
- **System prompt via CLI flag** — `claude --system-prompt "..."`
