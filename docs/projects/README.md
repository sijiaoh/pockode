# Project

The Project system lets users manage development stories through AI agents. Users create stories (high-level goals) that coordinate tasks (concrete units of work), each executed by an agent session with automatic lifecycle management.

## Architecture

```
React SPA                          Go Server                         AI CLI
─────────                          ─────────                         ──────
Zustand stores ◄─── WebSocket ───► RPC handlers ──┐                 MCP (stdio,
                    (JSON-RPC,                     ├─► work.Store      per-session
                    subscriptions)                 │   (JSON file,     subprocess)
                                   MCP HTTP API ───┘    file lock)        │
                                        ▲                                 │
                                        └──────────── /api/mcp ───────────┘
                                   Work engine
                                   (settled turn endings, nudges,
                                    parent reactivation,
                                    startup recovery)
```

## Documents

| Document | Contents |
|----------|----------|
| [Data Model](data-model.md) | Entities (Work, Comment, AgentRole), hierarchy rules, persistence (JSON files, atomic writes, cross-process safety), store interfaces |
| [Workflow Engine](workflow-engine.md) | Status machine and transitions, the work engine's seven inputs, the command surface, WorkStarter sequence, prompt builders |
| [API](api.md) | MCP tools (agent-facing), WebSocket RPC (client-facing), real-time subscription system with backpressure |
| [Frontend](frontend.md) | Zustand stores, RPC actions, subscription hooks, UI overlay components |
| [Project UI](../project-ui.md) | The project page's information architecture: the two segments, the four groups, which work gets a row, the row itself, and where creating work lands |
| [Agent Roles UI](../agent-roles-ui.md) | The agent-role screens: what a row says about a role, where deleting lives, and the footer that owns the default role |
