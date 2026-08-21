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
    isAgentEvent()                  // sealed interface marker
}
```

**Sealed Interface Pattern**: `isAgentEvent()` is an unexported method that external packages cannot implement. This ensures that when adding new event types, the compiler will enforce implementation of all required methods.

### What an Event Says About Process State

Two predicates on `EventType` are the entire contract between an agent and the
process state machine. Every agent event answers both, and nothing else in the
state layer inspects event types.

```go
// agent/event.go
func (e EventType) AwaitsUserInput() bool      // done, error, interrupted, permission_request, ask_user_question
func (e EventType) IndicatesAgentActivity() bool
```

- `AwaitsUserInput` — the turn stopped: it finished, failed, was aborted, or is
  blocked on a permission or question. Moves the process to `idle`.
- `IndicatesAgentActivity` — the event is output the agent produced, so a turn is
  under way. Moves the process to `running`.

They are not complements. `warning`, `request_cancelled` and `process_ended` are
neither: they can reach the process with no turn in flight — Codex emits a
warning at startup when a restarted session cannot recover its thread — and
treating them as output would leave a session marked `running` forever, which
`work.AutoResumer` reads as "the agent is working" and never corrects.

That asymmetry is why `IndicatesAgentActivity` lists what counts as output rather
than what doesn't: a wrong inclusion strands a session until the idle reaper
collects it hours later, while a wrong exclusion costs one missed transition that
the send path had already made. A new event type is therefore inert by default,
and adding it to the list is a deliberate claim that it cannot arrive between
turns.

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

## Protocol Baselines

Nothing below is a spec. The event payloads are unversioned — Codex's MCP envelope
does carry a `protocolVersion`, but it says nothing about the `codex/event` shapes
inside it, and Claude negotiates named capabilities in `init` precisely because
there is no version to branch on. So every mapping here describes one observed
CLI: **Claude Code 2.1.222** and **Codex 0.130.0**.

Each was established by running that CLI with Pockode's own arguments and reading
the shipped source of truth rather than the published docs: the zod schemas
embedded in the Claude binary, whose `.describe()` annotations the online
documentation omits or contradicts, and the `protocol/` and `mcp-server/` crates
at the matching `openai/codex` tag.

The versions are written down because these findings expire. When a mapping stops
working, the useful question is which version changed what, and the way to answer
it is to re-run the CLI and diff against the baseline rather than reason about it.
Unit-test fixtures come from captured output for the same reason: hand-written
fixtures agree with the parser instead of with the CLI, which is how the
`exec_command_end` output fields and the patch-approval routing stayed wrong since
Codex v0.44 with green tests the whole time.

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
| `result` | any | `InterruptedEvent`, `ErrorEvent`, or `DoneEvent` (see below) |
| `control_request` | `can_use_tool` | `PermissionRequestEvent` or `AskUserQuestionEvent` |
| `control_request` | anything else | `WarningEvent` + a `control_response` error (the CLI blocks until answered) |
| `control_response` | — | `InterruptedEvent` (only for interrupts we sent) |
| `control_cancel_request` | — | `RequestCancelledEvent` |
| `system` | `local_command_output` | `CommandOutputEvent` |
| `system` | allowlisted subtypes | `SystemEvent` |
| `system` | other | (dropped — internal bookkeeping) |
| `progress`, `tool_progress`, `tool_use_summary`, `rate_limit_event`, `auth_status`, `prompt_suggestion`, `command_lifecycle` | — | (dropped — telemetry / host control) |

`system` subtypes are **allowlisted**, not denylisted: the CLI emits dozens of
internal subtypes (`task_started`, `task_notification`, `session_state_changed`,
`turn_duration`, `hook_*`, …) and keeps adding more, so a denylist guarantees
future transcript noise — a plain `echo hi` alone emits `task_started` and
`task_notification`. The allowlist (`userVisibleSystemSubtypes`) covers
`compact_boundary`, `informational`, `api_retry`, `permission_denied`, and the
`model_*_fallback` family. Unknown subtypes are dropped with a debug log.

This mirrors the CLI's own SDK message adapter, which renders the same set and
ignores unknown subtypes. `api_retry` and `permission_denied` are deliberate
additions: the adapter drops them because the interactive REPL has its own retry
banner and denial dialog, which Pockode does not.

A `control_request` from the CLI is a *request*, not a notification: the CLI blocks
until it gets a `control_response`. Pockode serves exactly one subtype
(`can_use_tool`) and answers **everything else** with an error: a subtype no
version of this code has seen, a request with no body, a body of the wrong shape,
and an `AskUserQuestion` whose `input` it cannot read. Dropping a request with a
debug log is the worst available failure — it costs nothing visible and hangs the
conversation forever, with neither the user nor the log saying a request went
unanswered, and there is no path back from it. Answering an error is recoverable
by comparison: the CLI fails that one call and the turn goes on. That is also why
a parse failure here declines instead of degrading gracefully into a raw
forward the way one in a *notification* does — a notification has nobody
waiting on it.

The one request that cannot be answered is one whose `request_id` itself is
unreadable; that logs a warning saying the turn may hang, because it is the only
case where silence is forced. `unsupportedControlSubtypes` names the six known
subtypes only to word the message ("Pockode does not support MCP elicitation"
rather than the raw subtype); it is not what decides whether to answer.

This is the opposite arrangement from `system` subtypes, and deliberately so.
There, an unknown subtype forwarded by default is noise, so the safe default is
to drop; here, an unknown subtype dropped by default is a hang, so the safe
default is to answer. Both are "unknown input takes the recoverable branch".

The `result` message is classified in this order:

1. `terminal_reason` starting with `aborted` → `InterruptedEvent` (2.1.222 sends
   `aborted_streaming` and `aborted_tools`). This is how the CLI itself
   classifies an abort; a denied tool ends the turn this way. Matched by prefix
   for the same reason control requests are declined by default: an abort read as
   a failure would let the work engine carry on with a turn the user stopped,
   and no other terminal reason the CLI defines uses that prefix. CLIs that
   predate the field fall back to matching `Request was aborted` in `errors`.
2. `is_error` → `ErrorEvent` carrying `errors` (or `result`, which is where a
   `success` subtype flagged `is_error` puts its message).
3. otherwise → `DoneEvent`.

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
| Session recovery | `claude_resume.json` → `--resume <providerSessionID>` | none — see below |

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
- Goroutine waits for the response and turns it into the event that ends the turn

The response identifies the conversation by **thread ID**, taken from only two places — the `session_configured` event and `structuredContent.threadId` on the `tools/call` result — so a future upstream field of the same name elsewhere cannot hijack it. Follow-up turns pass it back as `threadId`; `conversationId` is its deprecated predecessor and is sent alongside so one call works across CLI versions. Codex renamed this identifier over time (`sessionId` → `conversationId` → `threadId`), and picking the wrong name is not a visible failure: the reply is rejected inside a *successful* JSON-RPC frame, so the turn looks completed while the message was never delivered.

That is also why the result's `isError` flag decides between `DoneEvent` and `ErrorEvent`. The MCP frame stays a success for API errors, unusable thread IDs and runtime failures alike — reading only the JSON-RPC error field reports every one of them as a normal completion.

An aborted turn gets **no response at all**: Codex answers neither the cancelled `tools/call` nor an interrupted one. Pockode resolves the pending request itself when it sees `turn_aborted` (or when it sends the interrupt), matching the event's `_meta.requestId` against the pending call so a late abort of a finished turn cannot end the turn running now. `budget_limited` becomes an `ErrorEvent`, every other reason an `InterruptedEvent` — the latter stops the work item rather than letting `work.AutoResumer` continue it.

**Known limitation**: that correlation is also the fallback's floor. An abort
carrying no `_meta.requestId` matches no pending call and resolves nothing, so the
turn stays running until the process exits. Only CLIs old enough to deliver events
over the `notifications/message` channel do this, and Pockode does not compensate:
writing a fallback for a version nobody could run and observe is the guesswork
these baselines exist to replace.

### No Session Recovery

Codex is the one agent Pockode cannot resume. A thread lives in the memory of the `mcp-server` process that created it — `codex-reply` resolves thread IDs against an in-memory map and answers `Session not found for thread_id` for anything else, confirmed by replaying a thread ID into a fresh process. So a stored thread ID does not merely fail to help, it makes **every** message of the restarted session fail; Pockode therefore starts a new thread and emits a warning saying the agent no longer has the earlier turns. Pockode's own transcript keeps them, which is what makes the loss easy to miss.

### Elicitation (Permission Requests)

Codex uses `elicitation/create` notifications to request user authorization:

```json
{
    "jsonrpc": "2.0",
    "method": "elicitation/create",
    "params": {
        "message": "Allow Codex to run `ls -la` in `/tmp`?",
        "codex_elicitation": "exec-approval",
        "codex_call_id": "...",
        "codex_command": ["ls", "-la"],
        "codex_cwd": "/tmp"
    }
}
```

`codex_elicitation` has exactly two values, `exec-approval` and `patch-approval`, and they describe their subject differently: an exec approval carries `codex_command`/`codex_cwd`, a patch approval carries `codex_changes`. Routing on the wrong value degrades quietly — a file edit is then shown as a shell command with nothing in it.

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
| `exec_command_end` | `ToolResultEvent` (`formatted_output`, falling back to the raw streams) |
| `patch_apply_begin` | `ToolCallEvent {ToolName: "Edit"}` |
| `patch_apply_end` | `ToolResultEvent` |
| `mcp_tool_call_begin` | `ToolCallEvent {ToolName: "server:tool"}` |
| `mcp_tool_call_end` | `ToolResultEvent` |
| `mcp_startup_complete` (with failures) | `WarningEvent` per failed server |
| `stream_error`, `warning`, `guardian_warning` | `WarningEvent` |
| `turn_aborted` | `InterruptedEvent` / `ErrorEvent` (see above) |

These are legacy event names, and matching on them is still correct even though
upstream now constructs `ItemStarted` / `ItemCompleted` "thread item" events in
their place: `as_legacy_events` fans those items back out into their legacy
counterparts, which is where `patch_apply_begin` and `mcp_tool_call_begin` still
arrive from. So the place an event is constructed answers the wrong question —
whether a legacy event still reaches us is decided by that compatibility layer,
and reading only the constructor makes a live event look removed.

`exec_approval_request` and `apply_patch_approval_request` deliberately map to nothing. Codex emits the begin event of a command or patch *before* it asks for approval, and the approval request repeats the same `call_id`, so emitting a tool call for both shows the same work twice and leaves one copy without a result. A denied command still reports back: Codex answers it with an `exec_command_end` carrying the rejection message and `exit_code: -1`.

The `error` event is likewise logged and not forwarded. Upstream's tool runner
always answers the `tools/call` and stops the turn after emitting it, so the
result already becomes an `ErrorEvent` — emitting one here too would report the
same failure twice.

Everything else is dropped through an explicit ignore list (`ignoredCodexEvents`) rather than forwarded. Codex emits 70+ event types — per-turn bookkeeping, token deltas, and a second copy of the whole turn in "thread item" shape — so a parser that forwards what it does not recognise fills the transcript with noise every time upstream adds a type. The list also keeps the default branch meaning "type we have never seen", which is what the debug log is for. Events that carry real information Pockode has no surface for yet (`agent_reasoning*`, `plan_update`, `web_search_*`, `turn_diff`) are listed there by choice, not by accident.

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

Those destinations are Claude's, and Pockode picks none of them:
`PermissionAlwaysAllow` echoes back the `PermissionSuggestions` the CLI attached
to its own request, so the CLI decides where its rule is stored. Codex has no
equivalent — its answer is one `decision` field, and always-allow becomes
`approved_for_session`, which dies with the thread.

## Process Management

### State Machine

```
ProcessStateIdle ←→ ProcessStateRunning
       ↓
ProcessStateEnded

Transition conditions:
- Idle → Running: SendMessage / SendPermissionResponse / SendQuestionResponse,
  or an IndicatesAgentActivity event (output that resumes on its own, such as a
  message that stayed queued behind an interrupt)
- Running → Idle: AwaitsUserInput events (done, error, interrupted, permission_request, ask_user_question)
- Any → Ended: Process termination / Idle timeout
```

An idle that ends a turn is reported once, but an idle that only pauses the turn
(`permission_request`, `ask_user_question`) can still be followed by one. That
asymmetry matters at both ends:

- A pending permission prompt disappears with its turn. The interrupt or error
  that ends it has to be reported even though the process is already idle, or the
  session waits forever for an answer to a prompt nobody can see.
- Agents can announce the same end twice — Codex answers an aborted call while
  Pockode synthesizes a response for the same call — and a second idle reads
  downstream as a second stop.

A message starts a process when the session has none; an answer does not.
`chat.Client` sends permission and question responses only to a process that is
already there, and reports `ErrSessionNotRunning` otherwise. An answer belongs to
the process that asked, so a prompt outliving its process — reaped after an idle
timeout, or replayed from history after a restart, with the card still on screen —
can no longer be answered. Starting a process to receive it delivers the answer
nowhere and leaves that process running with no turn to end it. An interrupt in
the same situation succeeds silently: nothing to stop is what the caller wanted.

### Event Stream Handling

```go
// process/manager.go
func (p *Process) streamEvents(ctx context.Context) {
    for event := range p.agentSession.Events() {
        p.touch()      // Update active time

        if event.EventType().IndicatesAgentActivity() {
            p.SetRunning()
        }

        // 1. Persistence
        store.AppendToHistory(ctx, sessionID, event.ToRecord())

        // 2. State transition
        if event.EventType().AwaitsUserInput() {
            p.SetIdle(needsInput) // SetIdleInterrupted for interrupted
            store.Touch(ctx, sessionID)
        }

        // 3. Broadcast
        manager.EmitMessage(sessionID, event)
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

`Unread` is set by every idle the session reports while nobody is viewing it,
including the initial idle a process emits the moment it is created — so simply
building a process marks the session unread, whether or not the agent said
anything. `StateChangeEvent.IsInitial` distinguishes that first idle, but only
`work.AutoResumer` reads it. Noted rather than fixed: what "unread" should mean
for a session that was merely started is a product question.

### History Storage

History is stored in JSON Lines format, one `EventRecord` per line:

```
<dataDir>/sessions/<sessionID>/history.jsonl
```

This format facilitates append-only writes and streaming reads.

## Concurrency Safety

### Lock Strategy

| Mutex | Protected Resource |
|-------|---------------------|
| `stdinMu` | Subprocess stdin writes |
| `requestsMu` | Pending requests map |
| `processesMu` | Process map |
| `sessionsMu` | Session list |

### Ending a Turn Exactly Once

Codex has no session-wide interrupt flag. A turn ends when its pending `tools/call` channel receives a value — from the CLI's response, from `SendInterrupt`, or from `turn_aborted` — and the channel is buffered with a non-blocking send, so whichever arrives first wins and the rest are dropped. Keying on the request ID instead of a flag is what makes a late event of a previous turn harmless: it simply finds no pending call of its own.

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
