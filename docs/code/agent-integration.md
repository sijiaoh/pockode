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

Three predicates on `EventType` are the entire contract between an agent and the
state layer. Every agent event answers all three, and nothing else in that layer
inspects event types.

```go
// agent/event.go
func (e EventType) AwaitsUserInput() bool      // done, error, interrupted, permission_request, ask_user_question
func (e EventType) IndicatesAgentActivity() bool
func (e EventType) ActivatesSession() bool
```

- `AwaitsUserInput` — the turn stopped: it finished, failed, was aborted, or is
  blocked on a permission or question. Moves the process to `idle`.
- `IndicatesAgentActivity` — a turn is under way. Moves the process to `running`.
- `ActivatesSession` — the agent has put something on its own side of the
  conversation. Sets `SessionMeta.Activated` (see [Activation](#activation)).

`AwaitsUserInput` and `IndicatesAgentActivity` are not complements. `warning`,
`request_cancelled` and `process_ended` are neither: they can reach the process
with no turn in flight — Codex emits a warning at startup when a restarted session
cannot recover its thread — and treating them as activity would leave a session
marked `running` forever, which `work.AutoResumer` reads as "the agent is working"
and never corrects.

That asymmetry is why `IndicatesAgentActivity` lists what counts as activity
rather than what doesn't: a wrong inclusion strands a session until the idle
reaper collects it hours later, while a wrong exclusion costs one missed
transition that the send path had already made. A new event type is therefore
inert by default, and adding it to the list is a deliberate claim that it cannot
arrive between turns.

#### Why `ActivatesSession` Is Not `IndicatesAgentActivity`

The two differ by exactly one event type — `system` — and that single difference
is the whole reason the second predicate exists. A turn can be under way from
start to finish without the agent ever contributing to it: a first message sent
through an expired login or a dead endpoint gets an `init`, a run of
`system/api_retry`, the CLI's own account of why it gave up, and a `result`
flagged as an error — the whole turn without the model being reached (measured on
claude 2.1.259 against both a refused port and a local endpoint answering 401).
Those retries mean a turn really is running, so `system` belongs to
`IndicatesAgentActivity`. But nothing was added to the conversation, so it must
stay out of `ActivatesSession` — otherwise the session that just failed to reach
the agent is marked started and locked to that agent type, which is precisely the
case where switching agents is the user's only way out.

Their biases point in opposite directions, which is why the two lists must not be
collapsed back into one. Over-including in `IndicatesAgentActivity` strands a
session as `running`; over-including in `ActivatesSession` confiscates the escape
hatch. So `command_output` and `raw` are in `ActivatesSession` despite being
borderline — neither can come from a turn that never started — while `system`,
borderline in the other direction, is not. `IndicatesAgentActivity` is written as
the union (`system || ActivatesSession()`) rather than as a second literal list,
so a future output event type added to one cannot silently go missing from the
other.

The exclusion this section claims is not something the predicate can enforce on
its own. The CLI's account of the failure arrives as an `assistant` message like
any other, and it stays out of `ActivatesSession` only because
`claude.syntheticNotice` recognises `message.model == "<synthetic>"` (the
spelling as of claude 2.1.259) and maps it to a warning rather than to text. The
property therefore rests on two things in different packages — the lists above
and that one branch in the Claude parser — and losing either brings the bug back
on its own. Anything that restores a text path for synthetic messages restores
the lock-out with it.

It is the only such dependency on the well-formed path. The CLI's other
self-authored frames — an interrupt marker, a continuation prompt — arrive as
`user` messages, and `parseUserEvent` produces nothing from prose: text blocks
are logged and dropped, and plain-string content yields events only for
`<local-command-*>` output.

It is not, however, the only way bytes the CLI wrote can become a `TextEvent` and
start the session. Three fallbacks deliberately surface whatever the parser
cannot decode: a stdout line that is not JSON (`streamOutput`), a `user` frame
whose `message` is neither a block array nor a string, and an `assistant` frame
whose `message` does not decode at all — that last one returns before the
`<synthetic>` check can run, so a malformed synthetic notice would still be read
as agent output. Each is the graceful degradation the server style guide asks
for, and each fires only on output no version of this parser understands, so none
should be closed off blindly. They are why the escape hatch is a property of
well-formed reports rather than an invariant: a CLI that started printing prose
to stdout while failing would take it away again.

The CLI writes synthetic messages for two purposes: announcing why a turn failed
("Invalid API key · Fix external API key", "API Error: 529 Overloaded"), and
answering the continuation prompt it injects into the transcript itself on
`--resume` with "No response requested." Both deliberately take the same path.
Keeping the benign class on the text path would leave a way back to this bug for
whichever future notice landed in it, and a message with no model behind it is
not the agent contributing to the conversation whatever it happens to say. That
class was never meaningful output in any case: the prompt it answers is one the
CLI marks `isMeta` and never shows anyone, so the reply used to surface as an
assistant bubble that came from nowhere.

The warning's `Code` comes from the `error` field on the assistant frame itself,
falling back to `synthetic_message` when the frame carries none. The label set is
open rather than a fixed enumeration: `authentication_failed` and `server_error`
are what the messages on one developer machine carry, and a local endpoint
answering 400 was measured later producing `unknown`. Nothing branches on the
value — it is passed straight to the banner — so a label nobody anticipated costs
at most a less helpful code. Across those 35 messages and that run, `error` is
non-empty exactly when `isApiErrorMessage` is true, so reading the second field
would add nothing.

Every one of those messages carries exactly one text block, which is all a CLI
with no model to call a tool with can produce. `syntheticNotice` logs a block of
any other type rather than skipping it quietly, so the day that assumption stops
holding is a line in the log rather than content silently missing from a
transcript.

`SystemEvent` would have kept the session switchable just as well, and is still
the wrong target: `SystemItem` in the frontend runs an unguarded `JSON.parse` on
the content (`web/src/components/Chat/MessageItem.tsx`), so prose reaching it
throws during render. `WarningItem` already draws a message-and-code banner,
which is the shape this is.

## EventRecord: Unified Event Format

`EventRecord` is the standard serialization format for events, used for both:
- **Persistence**: Appended to history file in JSON Lines format
- **Transport**: WebSocket broadcast to frontend

```go
// agent/history.go
type EventRecord struct {
    Type                  EventType          `json:"type"`
    Content               string             `json:"content,omitempty"`
    ToolName              string             `json:"tool_name,omitempty"`
    ToolInput             json.RawMessage    `json:"tool_input,omitempty"`
    ToolUseID             string             `json:"tool_use_id,omitempty"`
    ToolResult            string             `json:"tool_result,omitempty"`
    Error                 string             `json:"error,omitempty"`
    Message               string             `json:"message,omitempty"`
    Code                  string             `json:"code,omitempty"`
    RequestID             string             `json:"request_id,omitempty"`
    PermissionSuggestions []PermissionUpdate `json:"permission_suggestions,omitempty"`
    Questions             []AskUserQuestion  `json:"questions,omitempty"`
    Choice                string             `json:"choice,omitempty"`
    Answers               map[string]string  `json:"answers,omitempty"`
    Origin                MessageOrigin      `json:"origin,omitempty"`
    Subtype               string             `json:"subtype,omitempty"`
    Meta                  *MessageMeta       `json:"meta,omitempty"`
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

Codex is by now the exception to that "one observed CLI": the event mapping was
read at 0.130.0, but the approval path — policy values, elicitation payloads,
response shapes, and where begin events fall around an approval — was re-checked
live against **0.153.0**, which is where the captured approval fixtures in
`agent/codex/mcp_test.go` come from.

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

launch := resumeState.resolve()
if launch.sessionID != "" {
    if launch.resume {
        args = append(args, "--resume", launch.sessionID)
        if launch.fork {
            args = append(args, "--fork-session")
        }
    } else {
        args = append(args, "--session-id", launch.sessionID)
    }
}

if mcpConfig != "" {
    args = append(args, "--mcp-config", mcpConfig)
}
```

`resolve()` is what decides between `--session-id`, `--resume` and
`--resume --fork-session`; see [Session Recovery Ladder](#session-recovery-ladder).

`mcp-config.json` is written atomically because it is rewritten on *every*
session start, yet it lives in the shared main data dir rather than per session. A
plain write truncates the file first, so a second session starting at that moment
would hand its CLI a half-written config and that agent would come up with no
`work_*` tools at all — a failure with no error message anywhere. Replacing the
file by rename removes the window.

`StartOptions` carries two directories because they answer different questions.
`DataDir` is the session's own data dir (`claude_resume.json`, history) — for a
named worktree this is the worktree's data dir, so session state stays with the
session store that owns it and is removed when the session is deleted.
`MCPServerDir` is where the running server publishes `server.json`; the MCP stdio
proxy reads it to find the local API. There is one server per process, so this is
always the main data dir — a worktree's `DataDir` has no `server.json`, and
pointing the proxy there would leave the agent unable to reach `work_*` tools.
`MCPDir()` falls back to `DataDir` when the two are not split.

### Session Recovery Ladder

Claude keeps its provider-side session ID in `claude_resume.json` under the
Pockode session directory, and `claudeResumeStateManager` is the only thing that
reads or writes it.

**The ID is claimed earlier than it is useful.** The CLI creates
`~/.claude/projects/<encoded-cwd>/<id>.jsonl` when the first turn begins, and from
that moment `--session-id <id>` is rejected outright (`Session ID ... is already
in use`, exit 1, nothing on stdout). Recording the ID any later than that leaves a
window in which a failed turn burns an ID Pockode never wrote down — and every
subsequent message reruns the same fatal launch, so an expired login or a provider
outage on the *first* message used to kill the session permanently. So the ID is
persisted at `init`, the earliest event that carries it, which is also the exact
event that claims it.

**Only `system/init` counts**, not merely the first event carrying a `session_id`:
a `--resume` against an ID that does not exist emits a `result` event carrying
that same nonexistent ID before giving up, and writing it down would poison the
file with an ID nothing can resume. `init` also repeats at the start of every
turn, so `save()` compares against an in-memory mirror of the file and writes only
on a change.

**The reported ID is always adopted, never assumed from the one passed in.** Asking to
resume a session another live process is holding does not fail — the CLI silently
forks it and returns a brand-new ID in `init` (claude 2.1.259; resuming a finished
session returns the same ID it was given). Because the reported ID is always taken
at face value, that case needs no special handling.

**A failed launch advances a recovery rung**, persisted alongside the ID, which
`resolve()` reads back on the next start:

| State on disk | Launch |
|---|---|
| no file, not activated | `--session-id <pockodeID>` |
| no file, activated | `--resume <pockodeID> --fork-session` |
| `recovery: ""` | `--resume <sessionId>` |
| `recovery: "fork"` | `--resume <sessionId> --fork-session` |
| `recovery: "fresh"` | `--session-id <new UUID>` + a user-visible warning |

Forking is the middle rung because it is the least destructive move that can
still sidestep an ID the CLI already owns: it resumes the transcript *and* mints a
new ID, so the agent-side context survives instead of being discarded. `fresh` is
terminal — it never escalates further, so the ladder cannot loop — and it is the
only rung that mints its own UUID, which must be a real UUID because the CLI
rejects anything else.

Reaching `init` resets the rung to `""`, so a session that recovers does not stay
in recovery mode. Note that a state file plus `Resume == false` still resumes: a
recorded provider ID is proof the CLI owns that ID, which makes `--session-id`
certain to fail. This is a deliberate change from the older behaviour of falling
back to `--session-id` whenever the session was not marked activated.

The "no file, activated" rung also absorbs what used to be a separate legacy
migration path (`hasAssistantHistory()`, now deleted). Both faced the same
situation — a transcript may already exist under the Pockode ID, so using it as
`--session-id` is fatal — and activation now answers it directly: the agent has
answered here before, so an `init` must have been emitted, so the CLI owns that
ID. That is a stronger argument than scanning history for event types that
happened to look like output — and it is also why the rung is now nearly
unreachable: activation implies an `init`, which implies the file was written. What
is left is a session created before the mapping was persisted at all, or one whose
state file was lost.

**Failure is detected structurally, not by matching error text**: the process
exited without ever emitting `init`. Both fatal launches — the ID collision and
`No conversation found with session ID ...` — abort before the first turn, so
neither reaches `init`, and neither depends on an English message that upstream is
free to reword. The signal is only valid because a process is always created to
carry a message (`chat.Client.sendEvent` is the sole caller of
`GetOrCreateProcess` and sends immediately after); a CLI started with nothing to
do exits cleanly and emits no `init`, and would be misread as a failure. A process
Pockode cancelled itself (`Close`, shutdown) never escalates either — killing it
says nothing about whether the session was usable.

Reading "no init" as "the launch failed" is safe precisely because the failures
that motivated the ladder do not look like that: an expired login or a dead
endpoint still emits `init` before its `api_retry` storm, so a healthy session is
never forked merely because the network was down. The genuine false positive is a
CLI that dies before its first turn for reasons of its own — a crash on startup, a
kill from outside — and it costs one message, since the next launch forks,
succeeds, and resets the rung with the agent-side context intact. Only an
installation broken badly enough to fail every launch reaches `fresh`, where the
warning is imprecise rather than untrue: the Pockode transcript really is
unaffected, and there was no agent-side context to lose. Being terminal stops
`fresh` from looping but does not silence it — the warning goes out with every
launch made from that rung until one reaches `init` and resets it.

The `fresh` warning is emitted from the streaming goroutine rather than from
`Start()`. Claude's event channel is unbuffered, so sending before a consumer
exists would deadlock; it also has to come after `ReadStderr` starts draining, or
a CLI that fills the stderr pipe wedges while the warning waits.

Like `mcp-config.json`, `claude_resume.json` is written with
`filestore.WriteFileAtomic` — a half-written one would silently cost the user the
ability to resume that session. It is not on a hot path — it changes when the
provider ID changes or the ladder moves — so the fsync costs nothing measurable.
Sessions with no Pockode session ID (integration tests) skip the write entirely,
since `path()` would otherwise collapse to one file shared by all of them. Codex
has no counterpart because its threads cannot outlive the CLI process at all (see [Codex Implementation](#codex-implementation)).

### Message Type Mapping

| CLI Message | Subtype / Field | Converts To |
|-------------|-----------------|-------------|
| `assistant` | `message.model` is `<synthetic>` | `WarningEvent` (the CLI's own notice, not the agent — [why](#why-activatessession-is-not-indicatesagentactivity)) |
| `assistant` | anything else | `TextEvent` + `ToolCallEvent` |
| `user` | — | `ToolResultEvent` |
| `result` | any | `InterruptedEvent`, `ErrorEvent`, or `DoneEvent` (see below) |
| `control_request` | `can_use_tool` | `PermissionRequestEvent` or `AskUserQuestionEvent` |
| `control_request` | anything else | `WarningEvent` + a `control_response` error (the CLI blocks until answered) |
| `control_response` | — | `InterruptedEvent` (only for interrupts we sent) |
| `control_cancel_request` | — | `RequestCancelledEvent` |
| `system` | `background_tasks_changed` | (dropped — updates the live task set, see [Background Waits](#background-waits)) |
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
3. background tasks still running → nothing at all (see
   [Background Waits](#background-waits)).
4. otherwise → `DoneEvent`.

### Background Waits

A turn that started a background task (`run_in_background`) ends with an ordinary
`result` frame, and the CLI then resumes output **on its own** when the task
finishes — no input from the host. Both frames of such a turn are identical in
every field (measured on claude 2.1.263: `subtype: success`, `is_error: false`,
`terminal_reason: completed`), so nothing in the ending itself says whether it is
the last one.

Pockode treats that pause as one long thought rather than as a new state: the
adapter swallows the pseudo-ending, no `AwaitsUserInput` event is produced, and
everything downstream — process state, work status, the spinner and Stop button,
unread marks — keeps behaving as it does mid-turn without knowing why. That is
possible because the only thing that acts on a `DoneEvent` is the
`AwaitsUserInput` branch of `Process.streamEvents`, and it is why no
`ProcessState` or work state was added for waiting: the distinction is needed in
exactly two places inside the server, the idle reaper and the fallback timer
below. The `agent.Session` contract still holds — a turn ends
with exactly one `AwaitsUserInput` event — it just says nothing about how long a
turn may stay silent.

**Tracking what is live.** The only usable signal is `system` /
`background_tasks_changed`, whose payload is every live task after the change.
It is a *level*, not an edge — the CLI's own guidance is to replace your set with
each payload rather than pair `task_started` / `task_notification` bookends, so a
missed bookend cannot wedge a stale indicator — and it is per-process: nothing is
emitted at startup, so `backgroundTaskTracker` is created with the process and
starts empty. Tasks flagged `ambient` (housekeeping, live-update watchers) are
excluded, because the CLI tells hosts to keep them out of activity indicators and
they must not hold a turn open either. The set is live state and never enters an
event record or the history: a snapshot of it becomes a lie the moment a task
finishes. A payload the parser cannot read **empties** the set — an empty set only
costs the swallowing (the turn ends the way it did before this existed, noisily
but recoverably), while a stale non-empty one would hold the turn open with
nothing left to clear it.

**What gets swallowed.** Only a normal ending. The abort and `is_error` branches
run first and still produce `InterruptedEvent` / `ErrorEvent`, because both are
real endings. Narrowing further — to `terminal_reason == "completed"` — would be
wrong: besides `completed`, the reasons that survive both branches are
`hook_stopped`, `tool_deferred`, `background_requested` and `stop_hook_prevented`,
and the CLI itself describes turns ending via the first three as ones that "may
only be answered on continuation/resume" — to-be-continued by construction, the
same class the fourth belongs to. The reasons that really are failures
(`max_turns`, `budget_exhausted`, the API and model errors) are all built with
`is_error: true` and never reach the swallow.

**The fallback timer** (`background_wait.go`) is what keeps swallowing from being
open-ended: the ending is held, not discarded, and delivered anyway once a budget
runs out. Two cases make an unbounded wait wrong — session-scoped monitors that
never finish, and a model that started a task and is genuinely done. The budget
is 30 minutes, doubling per extension to a cap of 120, mirroring the CLI's own
background-task budget.

- It bounds a **silent** wait, not a turn. Any event indicating agent activity
  pushes the deadline out, because once the task finishes the CLI resumes and may
  work for a long time before the next result frame; firing then would mark a
  visibly streaming session idle, nudge it mid-turn, and end the same turn twice.
- Any ending that does reach the user (`AwaitsUserInput`) disarms it, so a
  held-back ending is never delivered on top of a real one. It is deliberately
  *not* disarmed when the live set drains — that is exactly when the CLI is
  supposed to resume by itself, and if it does not, this timer is the only thing
  left that can end the turn.
- Firing does **not** reset the extension count. Reaching the budget means nothing
  was resolved, so if the agent goes back to waiting after the nudge that follows,
  the next wait gets the longer budget instead of restarting the same 30-minute
  cycle.
- On expiry it emits a `WarningEvent` and then the `DoneEvent`, and everything
  falls back to the behaviour it had before background waits existed: idle, then
  the usual auto-continuation.

**Telling the agent, not just the user.** A warning in the transcript is only half
of "no silent failures": the agent is about to be nudged and would have no idea
Pockode stopped waiting for its task. `cliSession.queueNote` holds a one-shot
explanation that `SendMessage` prefixes to the **next** prompt inside a
`<system-reminder>` block. The wrapping happens at the CLI boundary only, so the
user's message is stored in history as written and the frontend needs no
knowledge of it. The lost-task report below uses the same channel.

**The idle reaper exemption.** A process waiting on background work looks exactly
like an abandoned one, since the wait produces no events to refresh `lastActive`;
reaping it would kill the very tasks being waited for, with no explanation
anywhere. `agent.BackgroundWaiter` is the optional interface the reaper
type-asserts for (Codex has no such concept and simply does not implement it).
The predicate is **"is the fallback armed"**, not "is the live set non-empty": the
live set only shrinks when the CLI sends another frame, so after a silent or dead
process it would stay non-empty forever and the exemption would never expire.
Armed means precisely "Pockode is holding an ending back", it clears itself when
the budget runs out, and the `DoneEvent` delivered then refreshes `lastActive`,
giving the process an ordinary new idle window.

Stopping during a wait needed no compensation: the CLI answers an `interrupt`
control request within about a second even with no active turn (measured), which
produces an `InterruptedEvent` through the normal path and disarms the fallback.

**Tasks lost with the process** (`background_loss.go`) are reported at the *next*
start of that session, not when they die. Background tasks live inside the CLI
process, so an idle reap, a stop, or a server restart takes them along — and at
that moment there is nowhere to say so: the event channel and the history writer
are closing behind the process, and on shutdown the whole write path is going
away. So the count is persisted to the session directory and turned into a
`WarningEvent` plus a queued note when the session next starts, which is both the
one delivery that works for every way a process can die and the moment it matters
— when the conversation that was waiting continues. Two details carry that
guarantee: the record is written synchronously in `Close` (the last point a server
shutdown waits for) with the streaming goroutine covering only deaths the process
inflicted on itself, and reading is split into `peek` / `clear` so the record is
dropped only after the explanation actually made it onto the event channel — a
record consumed before delivery would be a silent failure about a silent failure.

The CLI's own recovery path (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, which reads
`orphaned_background_tasks_pending_notification` on resume) was evaluated and not
adopted: the same switch also replays or synthesizes a continuation prompt, which
would collide with the AutoResumer's own nudge and corrupt its retry accounting,
and its benefit — telling the agent — is already covered by the queued note, while
the user side would still be unexplained.

What this means on the work side is covered there: why the work item stays
`in_progress` and why nothing nudges it
([Background Waits and the Work Item](work-system.md#background-waits-and-the-work-item)),
and why messages sent through the other, non-idle paths are *not* deferred until
the wait ends
([Follow-ups During a Background Wait](work-system.md#follow-ups-during-a-background-wait)).

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
| Session recovery | `claude_resume.json` → a `--resume` → `--fork-session` → new-session ladder ([above](#session-recovery-ladder)) | none — see below |

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

Both waits on the CLI here — the `--version` probe that chooses `mcp-server` over
`mcp`, and the handshake itself — run under a deadline, because `Start` runs
under the manager's process lock ([Lock Strategy](#lock-strategy)). Either one
expiring fails the start with a message naming the step that timed out. An expired
handshake also closes the session it was initializing: an MCP connection that
never came up leaves nothing to continue from.

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

The response identifies the conversation by **thread ID**, taken from only two places — the `session_configured` event and `structuredContent.threadId` on a *successful* `tools/call` result — so a future upstream field of the same name elsewhere cannot hijack it. Follow-up turns pass it back as `threadId`; `conversationId` is its deprecated predecessor and is sent alongside so one call works across CLI versions. Codex renamed this identifier over time (`sessionId` → `conversationId` → `threadId`), and picking the wrong name is not a visible failure: the reply is rejected inside a *successful* JSON-RPC frame, so the turn looks completed while the message was never delivered.

That is also why the result's `isError` flag decides between `DoneEvent` and `ErrorEvent`. The MCP frame stays a success for API errors, unusable thread IDs and runtime failures alike — reading only the JSON-RPC error field reports every one of them as a normal completion. The same flag decides whether the thread ID in that result is worth keeping. A failed turn is no evidence that its thread exists, because Codex answers a reply to an unknown thread with `Session not found for thread_id: X` and echoes X straight back in `structuredContent` — believing it re-pins the dead ID on every attempt, and the session can never recover on its own. A failure therefore never adopts a thread ID, and equally never drops one that `session_configured` or a completed turn has already confirmed: a turn that dies on an expired login or a budget cap still ran inside a registered thread, and replying into it works.

**Known limitation**: a confirmed thread ID is never cleared again. Nothing ever
assigns `threadID` an empty value, so if the thread does stop working later,
every `codex-reply` for the remaining life of the process fails the same way. The
session only heals when that process goes away — the idle reaper, a mode change,
a restart — and the next message opens a fresh thread. Clearing it would take a
precise signal, and the only one Codex offers is the English string `Session not
found for thread_id`, the kind of error-text matching the rest of this file
exists to avoid. The stale ID is the cheaper side of that trade: a string match
misfires the day upstream rewords it, and throws away the agent-side context of a
thread that was working fine.

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

Codex uses `elicitation/create` notifications to request user authorization.
Which actions get this far is a question of the session mode rather than of this
path: in `default`, almost nothing inside Codex's sandbox reaches it (see
[Session Modes](#session-modes)):

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

`decision` is deserialized into Codex's `ReviewDecision`, an externally tagged
enum, so the two answers do not have the same shape. The approvals are unit
variants and travel as bare strings (`"approved"`, `"approved_for_session"`), but
a refusal is a struct variant and has to carry its reason:

```json
{"action": "decline", "decision": {"denied": {"rejection": "The user denied this request."}}}
```

Sending the bare string `"denied"` fails silently in the direction that matters:
Codex still blocks the request — an approval it cannot read is not an approval —
but it drops the refusal, logs `failed to deserialize {Exec,Patch}ApprovalResponse`
to stderr, and tells the model `approval request failed` instead of why. Because
it blocks either way, no assertion that the denied work did not happen can tell
the two apart; the difference is only in what comes back. The `rejection` string
is what the model reads, and for a patch it is also `patch_apply_end`'s `stderr`,
so it reaches the transcript as user-visible text rather than a log line.

The two kinds are not equally reachable from a test, which is why only one of
them is in the integration suite. An exec approval is asked *before* the command
runs and the approved command then runs outside the sandbox, so it needs nothing
working from the sandbox. A patch approval does: `apply_patch` verifies its
target through Codex's filesystem sandbox helper — bubblewrap on Linux — so on a
host that restricts unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=1`, the Ubuntu 24.04 default) the
patch fails while merely *reading* the file, long before Codex decides an
approval is needed. No prompt can work around that. So the patch path is pinned
by unit tests against captured payloads instead, and reproducing it live means a
privileged container.

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

`exec_approval_request` and `apply_patch_approval_request` deliberately map to nothing. Each announces the same approval Codex is already raising as an `elicitation/create` with the same `call_id`, and that elicitation is what becomes the `PermissionRequestEvent` — so anything derived from these two would be a second copy of a prompt the user already has. They are no better as a source for the tool call: a patch has already emitted `patch_apply_begin` by the time it asks, so that would double it, while a command emits `exec_command_begin` only once approved (checked on codex-cli 0.153.0). Where the begin event falls relative to the approval is per-kind, not a rule to build on.

A refusal reports back differently by kind too, which is why the tool result is not where a denial can be detected. A denied patch still gets a `patch_apply_end` (`success: false`, `stderr` set to the `rejection` string). A denied command gets nothing at all — no begin, no end — and the refusal reaches the model only inside its own tool output.

The `error` event is likewise logged and not forwarded. Upstream's tool runner
always answers the `tools/call` and stops the turn after emitting it, so the
result already becomes an `ErrorEvent` — emitting one here too would report the
same failure twice.

Everything else is dropped through an explicit ignore list (`ignoredCodexEvents`) rather than forwarded. Codex emits 70+ event types — per-turn bookkeeping, token deltas, and a second copy of the whole turn in "thread item" shape — so a parser that forwards what it does not recognise fills the transcript with noise every time upstream adds a type. The list also keeps the default branch meaning "type we have never seen", which is what the debug log is for. Events that carry real information Pockode has no surface for yet (`agent_reasoning*`, `plan_update`, `web_search_*`, `turn_diff`) are listed there by choice, not by accident.

## Permission Handling Mechanism

### Session Modes

A session runs in one of two modes, `default` or `yolo`, and each CLI is told
which one at startup and only there — Claude through its arguments, Codex through
the `approval-policy` / `sandbox` pair on the `codex` tool call, which
`codex-reply` does not accept. `session.set_mode` therefore closes the running
process instead of retuning it. For Codex that costs more than a restart: the
thread cannot be resumed, so switching mode mid-session takes the earlier turns
away from the agent (see [No Session Recovery](#no-session-recovery)).

| Mode | Claude | Codex |
|---|---|---|
| `default` | `--permission-prompt-tool stdio`, no allowlist | `approval-policy: on-request`, `sandbox: workspace-write` |
| `yolo` | adds `--permission-mode bypassPermissions` | `approval-policy: never`, `sandbox: danger-full-access` |

Read as a promise to the user, those two `default` cells say different things.
Claude's puts everything its own rules gate — file edits and commands among
them — in front of the user as a `PermissionRequestEvent`, since Pockode adds no
allowlist of its own. Codex's gates nothing inside its sandbox: the working
directory, `$TMPDIR` and `/tmp` are writable (checked on Linux, codex-cli
0.153.0) and work there simply happens. Only what the sandbox refuses — writing
outside those roots, reaching the network — can produce a prompt at all.

**That gap cannot be closed.** `untrusted`, the policy Pockode relied on to make
Codex ask before running a command, is gone: `approval-policy` now enumerates
`on-request` and `never` and nothing else, from the tool schema and `config.toml`
alike (`codex.go:buildStartConfig` carries the exact errors). What is left is a
choice between sandbox modes, and `read-only` — the only remaining setting that
would still put an approval in front of workspace edits — was rejected on product
grounds rather than technical ones: on a phone, tapping approve for every write of
a multi-file edit is not a safety feature, it is an unusable session. So `default`
maps to `on-request` + `workspace-write` — the pairing Codex itself runs by
default, which `codex doctor` reports as `approval policy OnRequest` with a
restricted filesystem and network sandbox — and "Codex changed files without
asking" is the accepted cost of that trade rather than a regression to undo.

**Under `on-request` the prompt is a model decision, not a gate.** The CLI
describes the policy as "the model decides when to ask the user for approval"
(codex-cli 0.153.0). A sandbox-blocked action may equally just fail and be handed
back to the model, with the escalation arriving only afterwards — or never. What
is enforced is the sandbox; the prompt is how the model asks for it to be lifted
for one action. The integration suite holds that line: a first approval preceded
by any tool result means the CLI asked only after something failed, and the suite
fails such a run rather than counting it as a boundary that worked.

`yolo` needs no such distinction — nothing prompts, on either agent — even though
the mechanisms differ, Codex additionally dropping the sandbox it otherwise runs
under. That difference does not change what the user is promised, which is why
only `default` has to be told apart. The frontend copy is therefore keyed on
agent as well as mode (`web/src/lib/sessionMode.ts`); one shared string would
have to describe the looser of the two `default`s, which is how a UI ends up
promising more protection than the session actually has.

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
  or an IndicatesAgentActivity event (a turn that resumes on its own, such as a
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
        if event.EventType().ActivatesSession() {
            p.markActivated(ctx, log) // first transition only
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

A process is spared while it is holding a turn open for background work, which is
the one case where no events for hours does not mean abandoned; see
[Background Waits](#background-waits).

## Session Management

### Session Metadata

```go
// session/types.go
type SessionMeta struct {
    ID         string
    Title      string
    Activated  bool      // True once the agent has produced output
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

### Activation

`Activated` marks a session as *started*, and three things read it:

- Claude's [recovery ladder](#session-recovery-ladder), which receives it as
  `StartOptions.Resume`.
- Codex, through the same field, to warn that the agent has lost the earlier turns
  — its threads never survive the process that made them.
- `session.set_agent_type`, which refuses to switch a started session's backend.

It is set from the event stream — the first event answering
`ActivatesSession` — rather than when the process is created. Spawning a CLI
proves nothing about the session behind it, and the difference is the whole point
of the flag: a first message that dies before the agent says anything (expired
login, provider outage) leaves a session that never really started, and the user
should be able to point it at a different agent instead of retrying the broken one
forever. Codex's warning gets more accurate for free: a session whose first turn
died before the agent spoke no longer claims to have lost context it never had.
`process/manager.go` owns the write because the event stream passes through it
already, next to the history append.

The write happens on the transition only, guarded by an `atomic.Bool` seeded from
the session's existing flag, so an active session does not rewrite the index and
broadcast a change on every event it produces. There is deliberately no `closed`
guard like `SetRunning` has: that guard exists to avoid announcing stale process
*state*, whereas "the agent has spoken" is a fact that reaping the process does not
undo.

Switching agent type also closes any live process for the session.
`GetOrCreateProcess` keys on session ID alone and ignores agent type, so a CLI
still running from the first turn nobody heard back from — exactly the case this
switch exists for — would keep receiving the next messages, and the user's choice
would silently do nothing. The close happens after the `Activated` check, so a
rejected request does not kill a process on its way out.

**Known limitation**: the check and the switch are not atomic. `Activated` is
read from a snapshot taken before the close, so a user who picks a different
agent in the instant the first token lands kills a process that was working and
has the session marked activated by the events already in flight. The window runs
from that read to `SetAgentType`, and the state it leaves is self-consistent — the
resume file is intact, so switching back resumes — which is why it stands. Closing it
properly means a compare-and-swap in the store (`SetAgentTypeIfNotActivated` or
similar) instead of a read followed by an unconditional write.

The frontend disables the agent selector on the same flag, which `SessionListItem`
carries. Using the transcript instead (`messages.length > 0`) looks equivalent and
is not: a failed first turn leaves a user message and an error behind, so the
selector would stay disabled in exactly the situation it is meant to rescue.

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

`processesMu` is held from the lookup that finds no process through to the one it
registers, `Agent.Start` included — that is what keeps two messages arriving at
once from launching two CLIs for one session. The cost is that a worktree-wide
lock is held while a CLI comes up, so a startup step that never returns does not
hang one session: it freezes every process operation in the worktree, behind a
frontend that can only spin. Every step of `Start` that waits on something
outside the process therefore owes a bound, which turns a hang into an ordinary
start failure: the lock is released and the request is answered, instead of
neither. Codex is the only agent that has any — the version probe and the MCP
handshake ([MCP Initialization](#mcp-initialization)); Claude's `Start` spawns
and returns.

Those bounds are also a promise to the client. `chat.message` runs this path, and
so does `work.start`, whose kickoff (or restart) message goes out the same way and
is awaited before the work item's reply; both are given a client timeout sized
from the sum of these bounds
([Request Timeout](websocket-rpc.md#request-timeout)). A request that merely
queues behind the lock while a start drags on keeps the default clock, so there a
stalled start still surfaces as a plain timeout.

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
| Claude background waits | `server/agent/claude/background_tasks.go`, `background_wait.go`, `background_loss.go` |
| Codex implementation | `server/agent/codex/codex.go` |
| Chat client | `server/chat/client.go` |
| Process management | `server/process/manager.go` |
| Session storage | `server/session/store.go` |
| RPC Handler | `server/ws/rpc_chat.go` |
