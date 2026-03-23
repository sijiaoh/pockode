# Agent Event

The agent event system is the structured event stream that represents all output from an AI agent (Claude, Codex, etc.) to the user. Events are the single source of truth for agent communication — they are created during CLI output parsing, persisted to session history, broadcast over WebSocket, and rendered in the UI.

## Data Flow

```
AI CLI (stdout)
  → streamOutput (line-by-line JSON parsing)
    → AgentEvent channel (unbuffered)
      → Process.streamEvents
          ├─ Persist: store.AppendToHistory (EventRecord)
          └─ ProcessManager.EmitMessage
               → ChatMessagesWatcher (implements ChatMessageListener)
                 → Broadcast: JSON-RPC notification ("chat.<type>")
                   → WebSocket → Frontend
                     → wsStore (route by subscription ID)
                       → normalizeEvent (snake_case → camelCase)
                         → applyServerEvent (message state reducer)
                           → UI render (ContentPart[])
```

## Backend

### AgentEvent Interface

`server/agent/event.go` — Sealed interface (unexported marker method) with 17 concrete implementations.

```go
type AgentEvent interface {
    EventType() EventType
    ToRecord() EventRecord
    isAgentEvent()
}
```

### Event Types

| Category | Types | Terminal? |
|----------|-------|-----------|
| Content | `text`, `tool_call`, `tool_result`, `system`, `warning`, `raw`, `command_output` | No |
| Terminal | `done`, `interrupted`, `error`, `process_ended` | Yes |
| Permission | `permission_request`, `permission_response`, `request_cancelled` | No |
| Question | `ask_user_question`, `question_response` | No |
| Message | `message` (user broadcast for history) | No |

Terminal events end the current message response. Non-terminal events are appended to the active assistant message.

### EventRecord (Serialization)

`server/agent/history.go` — Flat struct used for both persistence and wire format. Each event type populates only its relevant fields; the rest are zero-valued and omitted from JSON.

Key fields: `Type`, `Content`, `ToolName`, `ToolInput`, `ToolResult`, `Error`, `RequestID`, `PermissionSuggestions`, `Questions`.

### Event Parsing (Claude)

`server/agent/claude/claude.go` — `streamOutput()` reads stdout line-by-line, `parseLine()` maps CLI JSON to events:

| CLI Message Type | Events Produced |
|-----------------|-----------------|
| `assistant` | `TextEvent` + `ToolCallEvent` (per content block) |
| `result` | `ToolResultEvent` |
| `control_request` | `PermissionRequestEvent` or `AskUserQuestionEvent` |
| `control_response` | `InterruptedEvent` (interrupt acknowledgment) |
| `control_cancel_request` | `RequestCancelledEvent` |

### Broadcasting

`server/watch/chat_messages.go` — `ChatMessagesWatcher` implements `process.ChatMessageListener`. Receives already-persisted events (persistence happens in `ProcessManager.streamEvents()` via `store.AppendToHistory`), converts them to `EventRecord` via `ToRecord()`, then broadcasts JSON-RPC notifications with method `"chat.<event-type>"` and the subscription ID for client-side routing.

## Frontend

### Type Layers

Three representations of the same data, each serving a different purpose:

| Type | File | Format | Purpose |
|------|------|--------|---------|
| `ServerNotification` | `web/src/types/message.ts` | snake_case (wire format) | WebSocket reception |
| `NormalizedEvent` | `web/src/lib/messageReducer.ts` | camelCase | Internal processing |
| `ContentPart` | `web/src/types/message.ts` | Structured union | UI rendering |

### Message Reducer

`web/src/lib/messageReducer.ts` — Stateless reducer that builds message state from events:

- **`normalizeEvent`** — snake_case → camelCase conversion
- **`applyServerEvent`** — Updates message list; creates new assistant message on first content event, appends content events, applies terminal events to mark complete/error/interrupted
- **`applyEventToParts`** — Converts each event to a `ContentPart` for rendering

### Message Status Transitions

```
(first content event) → "streaming"
    → done           → "complete"
    → error          → "error"
    → interrupted    → "interrupted"
    → process_ended  → "interrupted"
```

### Subscription

`web/src/hooks/useChatMessages.ts` — Subscribes via `chat.messages.subscribe` RPC, receives initial history, replays it through the reducer, then processes live notifications through the same pipeline.

## Key Files

| Layer | File | Role |
|-------|------|------|
| Backend | `server/agent/event.go` | Event interface and concrete types |
| Backend | `server/agent/history.go` | EventRecord serialization format |
| Backend | `server/agent/claude/claude.go` | CLI output parsing and event emission |
| Backend | `server/process/manager.go` | Event distribution |
| Backend | `server/watch/chat_messages.go` | WebSocket broadcast to subscribers |
| Frontend | `web/src/types/message.ts` | Wire types and ContentPart definitions |
| Frontend | `web/src/lib/messageReducer.ts` | Event normalization and state reduction |
| Frontend | `web/src/hooks/useChatMessages.ts` | Subscription and history replay |
| Frontend | `web/src/lib/wsStore.ts` | WebSocket routing by subscription ID |
