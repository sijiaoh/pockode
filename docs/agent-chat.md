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
| Chat client | `server/chat/client.go` | Session coordination, message persistence, event broadcast; `SendMessageExcluding` (user) and `SendSystemMessage` (system automation) share one persist+broadcast path |
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

Besides user-typed messages, the Work system pushes automatic prompts to the same session via `Client.SendSystemMessage`; these are tagged `origin: "system"` with a `meta` summary naming the work, so the frontend can fold them into that work's progress card instead of rendering user bubbles. See [agent-event.md](agent-event.md#message-origin-user-vs-system) and [code/work-system.md](code/work-system.md#work-messages-in-chat).

## Agent Events

See [agent-event.md](agent-event.md) for the full event type catalog, data flow, and frontend processing pipeline.

An `AskUserQuestion` blocks the agent until it is answered, yet its card is easily pushed out of view by whatever the agent streams next. How chat keeps an unanswered question reachable is in [pending-question-entry.md](pending-question-entry.md).

## Session Persistence

Session metadata and chat history are stored under the session data directory. History is JSON Lines of `EventRecord`s appended on each event. Claude records its provider-side session ID in `claude_resume.json` as soon as the CLI reports it, and falls back through a recovery ladder (plain resume → fork → new session) when a launch turns out to be unresumable, so a session cannot be permanently stuck by a first turn that failed ([code/agent-integration.md](code/agent-integration.md#session-recovery-ladder)). Codex never resumes — its CLI keeps a thread only in the memory of the process that created it, so a restarted session gets a new thread and a warning that the agent no longer has the earlier turns ([code/agent-integration.md](code/agent-integration.md#no-session-recovery)). Pockode's own transcript survives either way; what a resume decides is whether the *agent* still has the context.

A session can also be **forked**: `session.fork` starts a new session from a copy of the source's transcript, cut to the moment before the message the user picked — which keeps that message when the agent said it, and drops it when the user did, because the fork returns to before they sent it ([session-fork-ui.md](session-fork-ui.md#the-rule)). The source is left untouched. Whether the agent comes along is that agent's own declared answer, and it is a stronger question than resuming: Claude can follow a fork to a chosen message inside a conversation, while a Codex session cannot be forked at all and the request is refused rather than handing back a session whose agent has never seen the conversation filling its screen ([code/agent-integration.md](code/agent-integration.md#session-forking), UI in [session-fork-ui.md](session-fork-ui.md)).
