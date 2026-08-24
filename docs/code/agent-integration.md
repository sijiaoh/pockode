# AI Agent Integration

Pockode integrates AI Agents (Claude and Codex) through subprocess management. This document explains the design decisions and implementation mechanisms of this integration system.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                              Frontend                                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ WebSocket JSON-RPC
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ws/rpc_chat.go                                                      │
│  ├─ chat.message → ChatClient.SendMessage()                         │
│  ├─ chat.interrupt → ChatClient.Interrupt()                         │
│  ├─ chat.permission_response → ChatClient.SendPermissionResponse()  │
│  └─ chat.question_response → ChatClient.SendQuestionResponse()      │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ChatClient (chat/)                                                  │
│  ├─ Session/Process coordination                                     │
│  ├─ History persistence                                              │
│  └─ Event broadcasting                                               │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ProcessManager (process/)                                           │
│  ├─ Create Agent Session                                             │
│  ├─ Event stream handling: persistence + broadcast                   │
│  ├─ State machine: idle ↔ running → ended                            │
│  └─ Idle timeout cleanup                                             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Agent (agent/claude or agent/codex)                                 │
│  ├─ Subprocess management                                            │
│  ├─ Event channel                                                    │
│  ├─ Bidirectional I/O                                                │
│  └─ Protocol parsing                                                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ stdin/stdout
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  External CLI                                                        │
│  ├─ Claude: stream-json                                              │
│  └─ Codex: MCP JSON-RPC                                              │
└─────────────────────────────────────────────────────────────────────┘
```

## Why Subprocess Instead of SDK

1. **Decoupled AI versions**: Users can upgrade CLI independently without waiting for Pockode updates
2. **Standardized protocols**: Both Claude and Codex provide stable CLI output protocols
3. **Resource isolation**: AI process crashes don't affect the main service
4. **Tool reuse**: CLI's built-in permission system, session recovery, and other features can be used directly

## Agent Interface Design

### Core Interface

```go
// agent/agent.go
type Agent interface {
    Start(ctx context.Context, opts StartOptions) (Session, error)
}

type Session interface {
    Events() <-chan AgentEvent       // Event stream
    SendMessage(prompt string) error // Send user message
    SendPermissionResponse(...)      // Respond to permission request
    SendQuestionResponse(...)        // Respond to question
    SendInterrupt() error            // Interrupt AI
    Close()                          // Close session
}
```

**Design Decisions**:

- **Long-lived Session**: A Session is a persistent subprocess, not request-response. It survives across multiple messages, supporting continuous context conversations
- **Channel event stream**: Uses unbuffered channels for low-latency event delivery. Consumers can cancel via `ctx.Done()`
- **Close() returns nothing**: Session closure is a best-effort operation; errors don't affect the outcome

### Event Types

Events are divided into four categories:

| Category | Event Types | Description |
|----------|-------------|-------------|
| **Content** | `text`, `tool_call`, `tool_result`, `system`, `warning`, `raw`, `command_output` | AI-generated content |
| **Terminal** | `done`, `error`, `interrupted`, `process_ended` | Marks end of AI turn |
| **Permission** | `permission_request`, `permission_response`, `request_cancelled` | Tool execution authorization |
| **Q&A** | `ask_user_question`, `question_response` | AI-initiated questions |

```go
// agent/event.go
type AgentEvent interface {
    EventType() EventType
    ToRecord() EventRecord          // Unified serialization format
    AwaitsUserInput() bool          // Whether user response is needed
    isAgentEvent()                  // sealed interface marker
}
```

**Sealed Interface Pattern**: `isAgentEvent()` is an unexported method that external packages cannot implement. This ensures that when adding new event types, the compiler will enforce implementation of all required methods.

### Events Awaiting User Input

```go
func (e SomeEvent) AwaitsUserInput() bool {
    return e.EventType() == EventTypeDone ||
           e.EventType() == EventTypeError ||
           e.EventType() == EventTypeInterrupted ||
           e.EventType() == EventTypePermissionRequest ||
           e.EventType() == EventTypeAskUserQuestion
}
```

These events trigger a process state transition from `running` to `idle`, waiting for the user's next action.

## EventRecord: Unified Event Format

`EventRecord` is the standard serialization format for events, used for both:
- **Persistence**: Appended to history file in JSON Lines format
- **Transport**: WebSocket broadcast to frontend

```go
// agent/history.go
type EventRecord struct {
    Type                  EventType          `json:"type"`
    Content               string             `json:"content,omitempty"`
    ToolName              string             `json:"toolName,omitempty"`
    ToolInput             json.RawMessage    `json:"toolInput,omitempty"`
    ToolUseID             string             `json:"toolUseId,omitempty"`
    ToolResult            string             `json:"toolResult,omitempty"`
    Error                 string             `json:"error,omitempty"`
    RequestID             string             `json:"requestId,omitempty"`
    PermissionSuggestions []PermissionUpdate `json:"permissionSuggestions,omitempty"`
    Questions             []AskUserQuestion  `json:"questions,omitempty"`
    Choice                string             `json:"choice,omitempty"`
    Answers               map[string]string  `json:"answers,omitempty"`
}
```

**Design Decision**: A single format avoids type conversion errors during serialization/deserialization.

## Claude Implementation

### stream-json Protocol

Claude CLI uses `--output-format stream-json` for structured event stream output, one JSON object per line.

**Startup Arguments**:

```go
// agent/claude/claude.go
args := []string{
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--permission-prompt-tool", "stdio",
}

if opts.Mode == ModeYolo {
    args = append(args, "--permission-mode", "bypassPermissions")
}

providerSessionID, shouldResume := resumeState.resolve()
if shouldResume {
    args = append(args, "--resume", providerSessionID)
} else {
    args = append(args, "--session-id", providerSessionID)
}

if mcpConfig != "" {
    args = append(args, "--mcp-config", mcpConfig)
}
```

Claude keeps its provider-side session ID in `claude_resume.json` under the
Pockode session directory. A process resumes only when that file contains a
Claude session ID; otherwise it starts with `--session-id` and writes the resume
file after the first assistant event. Legacy sessions with assistant history but
no resume file are migrated by using the Pockode session ID once.

Both resume-state files (`claude_resume.json`, `codex_resume.json`) are written
with `filestore.WriteFileAtomic`: a half-written one would silently cost the user
the ability to resume that session. Neither sits on a hot path — Claude writes it
once the provider session ID becomes known, Codex on close — so the fsync costs
nothing measurable.

`mcp-config.json` is written atomically for a different reason: it is rewritten
on *every* session start, but it lives in the shared main data dir rather than
per session. A plain write truncates the file first, so a second session
starting at that moment would hand its CLI a half-written config and that agent
would come up with no `work_*` tools at all — a failure with no error message
anywhere. Replacing the file by rename removes the window.

`StartOptions` carries two directories because they answer different questions.
`DataDir` is the session's own data dir (`claude_resume.json`, history) — for a
named worktree this is the worktree's data dir, so session state stays with the
session store that owns it and is removed when the session is deleted.
`MCPServerDir` is where the running server publishes `server.json`; the MCP stdio
proxy reads it to find the local API. There is one server per process, so this is
always the main data dir — a worktree's `DataDir` has no `server.json`, and
pointing the proxy there would leave the agent unable to reach `work_*` tools.
`MCPDir()` falls back to `DataDir` when the two are not split.

### Message Type Mapping

| CLI Message | Subtype | Converts To |
|-------------|---------|-------------|
| `assistant` | — | `TextEvent` + `ToolCallEvent` |
| `user` | — | `ToolResultEvent` |
| `result` | `success` | `DoneEvent` |
| `result` | `error_during_execution` | `InterruptedEvent` or `DoneEvent` |
| `control_request` | `can_use_tool` | `PermissionRequestEvent` or `AskUserQuestionEvent` |
| `control_response` | — | `InterruptedEvent` (only for interrupts we sent) |
| `control_cancel_request` | — | `RequestCancelledEvent` |
| `system` | `init`, `thinking_tokens` | (filtered, not sent — session metadata / token-estimate noise) |
| `system` | other | `SystemEvent` |

Filtering is deliberately scoped to these two subtypes. The CLI also emits
other high-frequency telemetry (`task_progress`, `status`, `api_retry`,
`task_notification`, …) which is currently forwarded verbatim as `SystemEvent`;
these are potential future noise sources but are left untouched for now to keep
the filter minimal.

### Stream Parsing Implementation

```go
// agent/claude/claude.go
func streamOutput(ctx context.Context, stdout io.Reader, events chan<- agent.AgentEvent, resumeState *claudeResumeStateManager) {
    scanner := bufio.NewScanner(stdout)
    scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB buffer

    for scanner.Scan() {
        line := scanner.Bytes()
        // Decode the stream-json envelope once and share it with both the resume
        // observer and the parser, rather than unmarshaling the same line twice.
        var event cliEvent
        if err := json.Unmarshal(line, &event); err != nil {
            events <- agent.TextEvent{Content: string(line)} // graceful degradation
            continue
        }
        if resumeState != nil {
            resumeState.observe(event)
        }
        for _, ev := range parseLine(log, line, event, pendingRequests) {
            select {
            case events <- ev:
            case <-ctx.Done():
                return
            }
        }
    }
}
```

**Key Design Points**:
- **1MB buffer**: Handles large tool outputs
- **Single decode**: The envelope is unmarshaled once per line and reused by both the resume observer and `parseLine` (which retains the raw `line` only for events needing a superset struct), avoiding a redundant parse on every high-frequency line
- **Non-blocking send**: Checks `ctx.Done()` to avoid deadlocks
- **Graceful degradation**: Returns raw text when JSON parsing fails, no data is discarded

### Bidirectional Communication

**Sending user messages**:

```go
type userMessage struct {
    Type    string      `json:"type"`
    Message userContent `json:"message"`
}

// Format: {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

**Sending permission responses**:

```go
type controlResponse struct {
    Type     string `json:"type"` // "control_response"
    Response struct {
        Subtype  string `json:"subtype"` // "success"
        Response struct {
            Behavior string `json:"behavior"` // "allow" or "deny"
            // ...
        }
    }
}
```

**Interrupt mechanism**:

```go
type interruptRequest struct {
    Type      string `json:"type"`      // "control_request"
    RequestID string `json:"request_id"`
    Request   struct {
        Subtype string `json:"subtype"` // "interrupt"
    }
}
```

Pending control requests we need to correlate later are tracked via `pendingRequests *sync.Map`. The map holds interrupt markers (matched against incoming `control_response` to emit `InterruptedEvent`) and AskUserQuestion markers (remembering the original tool input so `SendQuestionResponse` can echo it back as the SDK requires). The two marker kinds live in disjoint ID namespaces — interrupt IDs are crypto-random hex strings we generate, while AskUserQuestion IDs are assigned by the CLI — so handlers can type-assert without coordinating.

## Codex Implementation

### MCP Protocol Differences

| Aspect | Claude | Codex |
|--------|--------|-------|
| Protocol | stream-json | MCP JSON-RPC 2.0 |
| Tool calls | Stateless (request → response) | Stateful (call → wait for result) |
| Permission requests | `PermissionUpdate` objects | Elicitation mechanism |
| Session recovery | `claude_resume.json` → `--resume <providerSessionID>` | Custom JSON state file |

### MCP Initialization

```go
// agent/codex/codex.go
params := map[string]any{
    "protocolVersion": "2025-03-26",
    "capabilities": map[string]any{
        "elicitation": map[string]any{},
    },
    "clientInfo": map[string]any{
        "name":    "pockode",
        "version": "1.0.0",
    },
}
```

After initialization, sends `notifications/initialized` notification.

### Asynchronous Tool Calls

```go
func (c *Codex) SendMessage(prompt string) error {
    return c.callToolAsync("codex", map[string]any{
        "prompt": prompt,
        "cwd":    c.cwd,
        "config": config,
    })
}
```

- Generates unique request ID, stores in `pendingRPCResults` map
- Sends `tools/call` request (non-blocking)
- Goroutine waits for response, extracts `sessionId`/`conversationId`
- Sends `DoneEvent` (or `InterruptedEvent`)

### Elicitation (Permission Requests)

Codex uses `elicitation/create` notifications to request user authorization:

```json
{
    "jsonrpc": "2.0",
    "method": "elicitation/create",
    "params": {
        "message": "Execute command: ls -la",
        "codex_elicitation": "command",
        "codex_call_id": "...",
        "codex_command": "ls -la"
    }
}
```

Pockode handling flow:
1. Parse elicitation, route to appropriate tool (Bash/Edit)
2. Send `PermissionRequestEvent`
3. Store response channel in `pendingElicit` map
4. Wait for user response via `chat.permission_response`
5. Send MCP response: `{"action": "accept", "decision": "approved"}`

### Codex Event Mapping

| Codex Event | Agent Event |
|-------------|-------------|
| `agent_message` | `TextEvent` |
| `exec_command_begin` | `ToolCallEvent {ToolName: "Bash"}` |
| `exec_command_end` | `ToolResultEvent` |
| `patch_apply_begin` | `ToolCallEvent {ToolName: "Edit"}` |
| `patch_apply_end` | `ToolResultEvent` |
| `mcp_tool_call_begin` | `ToolCallEvent {ToolName: "server:tool"}` |
| `mcp_tool_call_end` | `ToolResultEvent` |

## Permission Handling Mechanism

### Permission Options

```go
// agent/event.go
type PermissionChoice int

const (
    PermissionDeny        // Deny this request
    PermissionAllow       // Allow this request
    PermissionAlwaysAllow // Allow and persist the rule
)
```

### Permission Updates

```go
type PermissionUpdate struct {
    Type        PermissionUpdateType        // addRules, replaceRules, removeRules, setMode
    Behavior    PermissionBehavior          // allow, deny, ask
    Destination PermissionUpdateDestination // userSettings, projectSettings, localSettings, session
    Mode        PermissionMode              // default, acceptEdits, bypassPermissions, plan
}
```

Permission rules can be saved to different locations:
- **session**: Valid only for current session
- **localSettings**: Local settings
- **projectSettings**: Project-level settings
- **userSettings**: User global settings

## Process Management

### State Machine

```
ProcessStateIdle ←→ ProcessStateRunning
       ↓
ProcessStateEnded

Transition conditions:
- Idle → Running: SendMessage / SendPermissionResponse / SendQuestionResponse
- Running → Idle: AwaitsUserInput events (done, error, interrupted, permission_request, ask_user_question)
- Any → Ended: Process termination / Idle timeout
```

### Event Stream Handling

```go
// process/manager.go
func (p *Process) streamEvents(ctx context.Context) {
    for event := range p.agentSession.Events() {
        p.touch()      // Update active time
        p.SetRunning() // Ensure state is running

        // 1. Persistence
        store.AppendToHistory(ctx, sessionID, event.ToRecord())

        // 2. Broadcast
        manager.EmitMessage(sessionID, event)

        // 3. State transition
        if event.AwaitsUserInput() {
            p.SetIdle(needsInput)
        }
    }
}
```

### Idle Timeout Cleanup

```go
func (m *Manager) runIdleReaper() {
    ticker := time.NewTicker(idleTimeout / 4) // Check frequency = timeout/4
    for range ticker.C {
        for sessionID, proc := range processes {
            if now.Sub(proc.lastActive) > idleTimeout {
                proc.agentSession.Close()
                delete(processes, sessionID)
            }
        }
    }
}
```

**Design Decision**: Check frequency is 1/4 of timeout duration, balancing response speed with CPU overhead.

## Session Management

### Session Metadata

```go
// session/types.go
type SessionMeta struct {
    ID         string
    Title      string
    Activated  bool      // True after first message sent
    AgentType  AgentType // claude, codex
    Mode       Mode      // default, yolo
    NeedsInput bool      // Awaiting user permission/question response
    Unread     bool      // Has unread changes
}
```

### History Storage

History is stored in JSON Lines format, one `EventRecord` per line:

```
<dataDir>/sessions/<sessionID>/history.jsonl
```

This format facilitates append-only writes and streaming reads.

**Crash safety** (`server/filestore/jsonl.go`):

- Each record is written with a single `write` syscall, so a killed process can
  never split one.
- Appends are not fsynced: this is the streaming path, and a disk round-trip per
  event would stall messages on their way to the UI. A power loss can therefore
  drop the not-yet-flushed tail.
- The next append terminates an unterminated trailing line before writing, so a
  partial line left by a crash cannot swallow the following record.
- Reads skip lines that are not valid JSON (or exceed the 1 MiB line limit),
  keeping the rest of the conversation loadable, and report the count so the
  session store can log it and surface a `warning` record in the chat.

The session index (`sessions/index.json`) is a whole-file rewrite instead, and
uses `filestore.WriteFileAtomic`. If it is nonetheless found corrupt at startup,
it is moved to `index.json.corrupt` and the store starts empty rather than
failing to boot.

## Concurrency Safety

### Lock Strategy

| Mutex | Protected Resource |
|-------|---------------------|
| `stdinMu` | Subprocess stdin writes |
| `requestsMu` | Pending requests map |
| `processesMu` | Process map |
| `sessionsMu` | Session list |

### Atomic Operations

Codex uses `atomic.Bool` to track interrupt state:

```go
interrupted atomic.Bool

// Send interrupt
c.interrupted.Store(true)

// Check if interrupted
if c.interrupted.Load() {
    return InterruptedEvent
}
```

### Resource Cleanup Order

```go
func (s *session) Close() {
    s.closeOnce.Do(func() {
        s.cancel()        // Cancel context
        s.stdinMu.Lock()
        s.stdin.Close()   // Close stdin (triggers subprocess exit)
        s.stdinMu.Unlock()
    })
}
```

## Error Handling

### Graceful Degradation

**JSON parsing failure**:

```go
if err := json.Unmarshal(line, &event); err != nil {
    log.Warn("failed to parse JSON", "error", err)
    return []agent.AgentEvent{agent.TextEvent{Content: string(line)}}
    // Return raw text, not nil
}
```

**Buffer overflow**:

```go
if errors.Is(err, bufio.ErrTooLong) {
    events <- agent.WarningEvent{
        Message: "Some output was too large to display",
        Code:    "scanner_buffer_overflow",
    }
}
```

### Fatal Errors

The following conditions send an `ErrorEvent` and end the session:
- Process crash (`cmd.Wait()` returns non-context error)
- MCP initialization failure
- Critical I/O errors

## Code Paths

| Module | Path |
|--------|------|
| Agent interface | `server/agent/agent.go` |
| Event types | `server/agent/event.go` |
| Event serialization | `server/agent/history.go` |
| Claude implementation | `server/agent/claude/claude.go` |
| Codex implementation | `server/agent/codex/codex.go` |
| Chat client | `server/chat/client.go` |
| Process management | `server/process/manager.go` |
| Session storage | `server/session/store.go` |
| RPC Handler | `server/ws/rpc_chat.go` |
