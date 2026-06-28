# Project

The Project system lets users manage development stories through AI agents. Users create stories (high-level goals) that coordinate tasks (concrete units of work), each executed by an agent session with automatic lifecycle management.

## Architecture

```
React SPA                          Go Server                         AI CLI
─────────                          ─────────                         ──────
Zustand stores ◄─── WebSocket ───► RPC handlers ──┐                 MCP (stdio,
                    (JSON-RPC,                     ├─► work.Store      per-session
                    subscriptions)                 │   (JSON file,     subprocess)
                                   MCP HTTP API ───┘    flock)            │
                                        ▲                                 │
                                        └──────────── /api/mcp ───────────┘
                                   AutoResumer
                                   (process lifecycle sync,
                                    parent reactivation,
                                    step/reopen follow-ups)
```

## Documents

| Document | Contents |
|----------|----------|
| [Data Model](data-model.md) | Entities (Work, Comment, AgentRole), hierarchy rules, persistence (JSON files, atomic writes, cross-process safety), store interfaces |
| [Workflow Engine](workflow-engine.md) | Status machine and transitions, auto-close, AutoResumer (process sync + triggers), WorkStarter sequence, prompt builders |
| [API](api.md) | MCP tools (agent-facing), WebSocket RPC (client-facing), real-time subscription system with backpressure |
| [Frontend](frontend.md) | Zustand stores, RPC actions, subscription hooks, UI overlay components |
