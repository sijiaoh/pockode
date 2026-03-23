# Agent Chat

Users interact with AI agents through natural language conversations. The system manages bidirectional communication with persistent agent processes (Claude CLI, Codex CLI) via WebSocket JSON-RPC.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──spawn──▶ AI CLI (subprocess)
                              │                     │
                         ChatClient            stream-json
                              │                     │
                         ProcessManager ◀───── AgentSession
```

- **ChatClient** (`server/chat/`) — Coordinates session/process management, persists messages to history, broadcasts events to all WebSocket subscribers.
- **ProcessManager** (`server/process/`) — Manages agent process lifecycle. Tracks state (`idle` / `running` / `ended`), runs idle timeout reaper.
- **Agent Session** (`server/agent/`) — Common `Session` interface implemented by each backend (`agent/claude/`, `agent/codex/`). Handles subprocess spawning, stream-json parsing, stdin messaging.

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_chat.go` | `chat.message`, `chat.interrupt`, `chat.messages.subscribe`, permission/question responses |
| Chat client | `server/chat/client.go` | Session coordination, message persistence, event broadcast |
| Agent interface | `server/agent/agent.go` | `Session` and `AgentEvent` interfaces |
| Claude impl | `server/agent/claude/claude.go` | Claude CLI subprocess, stream-json parsing, MCP server config |
| Process manager | `server/process/manager.go` | Process lifecycle, state machine, idle reaper |
| Frontend panel | `web/src/components/Chat/ChatPanel.tsx` | Message list, input bar, mode/agent selector |
| Chat hook | `web/src/hooks/useChatMessages.ts` | Message state, streaming, permission/question handling |
| RPC actions | `web/src/lib/rpc/chat.ts` | `sendMessage`, `interrupt`, `permissionResponse`, `questionResponse` |

## Data Flow

1. User sends message → `chat.message` RPC
2. ChatClient persists message to session history, forwards to `Process.SendMessage()`
3. Agent subprocess receives via stdin, processes, emits stream-json events
4. Events are parsed into typed `AgentEvent`s (Text, ToolCall, ToolResult, Error, PermissionRequest, AskUserQuestion, Done, etc.)
5. Events are broadcast to all WebSocket subscribers and persisted to session history
6. On `Done` event, process transitions to `idle`

## Agent Events

See [agent-event.md](agent-event.md) for the full event type catalog, data flow, and frontend processing pipeline.

## Session Persistence

Session metadata and chat history are stored via `server/session/store.go`. History is a JSON array of `EventRecord`s appended on each event. Sessions can be resumed with `--resume` flag (Claude).
