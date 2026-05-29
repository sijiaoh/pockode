# Pockode Concept

Pockode is a mobile-first development platform where AI agents do the coding and users direct the work through natural language.

## The Problem

Traditional IDEs assume a keyboard-and-mouse workflow. On a phone, typing code is painful — small screens, no keyboard shortcuts, no multi-cursor. But reading code, reviewing diffs, and describing what you want in words? That works fine on a phone.

## The Approach

**AI edits, you direct.** Instead of fighting a tiny editor, you talk to AI agents that write and modify code on your behalf. Manual editing exists as a fallback, not the primary workflow.

This flips the traditional IDE model:

```
Traditional:  Human writes code  →  AI assists (autocomplete, suggestions)
Pockode:      Human directs work →  AI writes code  →  Human reviews
```

## Architecture

The system runs as a **local server on the user's PC**, accessed from a phone through a relay that handles NAT traversal:

```
Phone (React SPA) ──► Relay Server ──► User's PC (Go server) ──► AI CLI
```

The Go server spawns AI CLI processes (Claude Code, Codex) as subprocesses, streaming their JSON output back to the frontend over WebSocket JSON-RPC 2.0. No SDK bindings — just process management and stream parsing. This keeps AI integration loosely coupled: adding a new AI backend means implementing a process adapter, not integrating an SDK.

### Running Modes

Pockode supports two server modes:

**Single Workspace Mode** (default): Server runs in the current directory with `.pockode/` as the data directory. This is the traditional mode — one project, one server.

**Multi-Workspace Manager Mode**: A central server manages multiple workspaces from `~/.pockode/workspaces.json`. Each workspace gets its own Worker process with isolated resources.

```
Manager Mode:

                                    ┌─── Worker (project-a)
Phone ──► Relay ──► Manager ───────┼─── Worker (project-b)
                    (router)        └─── Worker (project-c)
```

The Manager routes requests by URL path (`/w/:workspace-id/...`) to the appropriate Worker. Workers start lazily on first request and can be stopped when idle.

URL structure in manager mode:
- `/w/:id/ws` → WebSocket connection
- `/w/:id/api/...` → API endpoints
- `/w/:id/health` → Health check
- `/` → Workspace selection page

Global configuration lives in `~/.pockode/`:
- `config.json` — Default port, auth token, cloud URL
- `workspaces.json` — Registered workspace list
- `relay.json` — Relay credentials

Infrastructure docs: [websocket-rpc-design.md](websocket-rpc-design.md) (RPC layer), [relay.md](relay.md) (NAT traversal), [agent-event.md](agent-event.md) (event stream), [watcher.md](watcher.md) (real-time subscriptions).

Feature docs: [agent-chat.md](agent-chat.md) (chat), [file.md](file.md) (file ops), [git.md](git.md) (git ops).

Code explanation: [multi-workspace.md](code/multi-workspace.md) (Manager/Worker architecture).

## Agent-Centric Workflow

The [Project system](projects/README.md) lets users manage work through AI agents:

1. **User creates a story** — a high-level goal like "Add dark mode support"
2. **A coordinator agent** breaks the story into tasks and assigns agent roles
3. **Worker agents** execute each task, reporting results back
4. **The coordinator** reviews results and continues until the story is complete

Each agent runs in its own CLI session. The server handles lifecycle management — starting, stopping, retrying, and reactivating agents as needed. Users can monitor progress and intervene at any point from their phone.

Agents interact with the Project system through **MCP (Model Context Protocol)** tools exposed via a stdio subprocess, allowing them to create tasks, report progress, and coordinate with each other.

## Supported AI Backends

| Backend | CLI | Status |
|---------|-----|--------|
| Claude Code | `claude` | Primary |
| Codex | `codex` | Supported |

The `agent/` package defines a common interface. Each backend implements process spawning, output parsing, and message sending. The architecture supports adding new backends without touching the core system.
