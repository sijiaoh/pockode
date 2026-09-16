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
│  ├─ chat.message → ChatClient.SendMessageExcluding()                │
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
│  └─ Codex: app-server JSON-RPC                                       │
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
- **Channel event stream**: Uses unbuffered channels for low-latency event delivery. A consumer drains `Events()` until the agent closes it — that close is the end of the session, and it is what `process.Manager.Close` waits for before letting a caller delete what the session writes to
- **`process_ended` waits for its consumer**: every other send on the channel steps aside when the session's context is cancelled, which is right for output overtaken by a shutdown. The last event cannot: it is needed *most* when that context has just been cancelled on purpose — a reaped or deleted session — and a `select` over the two has both cases ready, so Go picks at random and half the closes never reach the client, which goes on showing the session as running until it refetches history. `agent.EmitProcessEnded` therefore waits for the consumer instead, with only a 10s backstop against a read loop that has stopped draining without closing the session (a panic recovered above it). The guarantee ends at that consumer: the next hop, `watch.ChatMessagesWatcher.OnChatMessage`, is a bounded queue that drops on overflow like every other chat event, and a client that loses one recovers by refetching history. What was fixed is the hop that dropped the event *by design*, on exactly the closes a user asked for
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
rather than what doesn't, and nothing downstream softens a wrong inclusion: the
idle reaper will not collect the stranded session either, because a session
marked `running` is a turn in progress and turns in progress are never reaped
([Idle Timeout Cleanup](#idle-timeout-cleanup)). A new event type is therefore
inert by default, and adding it to the list is a deliberate claim that it cannot
arrive between turns; the rest of that trade-off is at
`agent.EventType.IndicatesAgentActivity`.

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

### Session Forking

Forking is two jobs with one interface between them. Pockode does the first
itself: `chat.Client.Fork` copies the source's history into a new session, cut at
the anchor. The second — bringing the *agent's* own memory of that conversation
across — belongs to the agent, and whether it can is the agent's own answer.

**The agent declares what it can do by implementing `agent.SessionForker`, and
everything else reads that declaration through `agent.ForkSupportOf`.** The
capability and the work behind it are one interface: an agent that cannot be
forked implements nothing at all, and one that can cannot promise a capability it
has no code for. There is no way to configure the two halves into disagreeing, so
nothing has to check a declaration against an implementation.

`SessionForker.ForkSupport` then says *where* a fork may be taken from; it never
answers `ForkUnsupported`, which is what `ForkSupportOf` returns when the
interface is absent. Between them they make two `agent.ForkSupport` values:

| `agent.ForkSupport` | What the CLI can reopen | What Pockode does with it |
|---------------------|-------------------------|---------------------------|
| `ForkUnsupported` (`"none"`) | nothing — it cannot reopen an earlier conversation at all | the fork is refused: `chat.Client.Fork` answers `ErrForkUnsupported` before creating anything, and the frontend offers no fork action in such a session at all ([session-fork-ui.md](../session-fork-ui.md#blocked-and-failed)) |
| `ForkFromAnyMessage` (`"any_message"`) | a conversation at a chosen point inside it | forking is offered from any message and can carry the agent's memory from any of them |

**Both agents Pockode ships answer `ForkFromAnyMessage`**, so nothing returns
`ForkUnsupported` today: it is what `ForkSupportOf` answers for an agent that
implements no `SessionForker`, and the refusal path below is what would meet one
if it appeared. Codex reached that value by changing channels, not by the CLI
learning something — its answer used to be `ForkUnsupported`, and the reason was
always the channel Pockode spoke rather than the CLI
([Forking a Thread](#forking-a-thread)).

The type stays a named string rather than a bool even so. The values are
capabilities, not yes and no: an agent able to reopen a whole conversation and
nothing finer would fork from the end of one and from nowhere else, which the
frontend has to tell apart from both of today's values, since it decides which
messages offer the row and what a disabled row says. `codex exec fork` is shaped
that way — it takes a session id and no message selector — so an agent reached
through a channel like that one would need such a value. Collapsing it to a bool
would cost a synchronised frontend-and-backend change to grow it back, since it
goes over the wire.

Nothing on the subject of forking asks *which* agent it is holding: no branch
anywhere in the backend or the frontend compares an agent type to `"codex"` to
decide what a fork may do. The frontend is sent the same declaration (`agent.list`
→ `rpc.AgentInfo.fork_support`) rather than keeping a table of its own, which would
be a second place for the fact to be told from and would disagree the day an agent
learns something new.

(Forking is the only subject settled this way so far. One agent-name branch remains
elsewhere — `ChatPanel` passes `isCodex` down to decide whether a permission
request offers *Always Allow* — which is a different fact about an agent and would
need a capability of its own to express.)

`process.Manager.ForkAgentSession` reaches the interface through a type assertion
and **reports** an agent that does not implement it as an error rather than
shrugging it off. Callers ask `ForkSupport` first, so that branch answers a caller
that skipped the question: a fork whose agent was never consulted is
indistinguishable, from the outside, from one that was consulted and could not
help.

Under `ForkFromAnyMessage`, `carried == false` is still an ordinary answer: the
source may turn out to have nothing worth reopening. It owes the user a
sentence, which `chat.Client` writes into the forked transcript as a
`fork_agent_context_unavailable` warning rather than leave to be discovered. Only
a returned *error* is a failure, and it costs the whole fork: the caller deletes
the half-made session instead of leaving an empty one wearing the source's title.

**Why `ForkUnsupported` is a refusal and not a warning.** The Pockode side of such
a fork would work perfectly — the transcript copies like any other. What the user
would get is a session whose agent has never seen the conversation filling its
screen, and no way to continue it; `session.fork` must not claim to do something
it does not do just because half of it succeeded. The frontend blocks it first for
the user's sake, and the backend refuses it because that is the contract.

**What the cut means.** The anchor names the message the user picked, and which
side of it the cut falls on is decided in `chat.Client.Fork` and nowhere else: an
agent message is kept, because the agent had finished saying it; a message the
user sent is dropped, because the fork returns to before they sent it — and
because the agent's own context stopped one message short of it regardless, there
being no uuid for a prompt Pockode sent ([Claude's case](#forking)). A client
sends back the seq it was handed and does no arithmetic on it. An anchor the user
sent with nothing before it leaves no conversation to keep and is refused,
`ErrForkAnchorNoHistory`, rather than producing an empty session that would
answer "forked" to a request that carried nothing across. The reasoning the user
is shown is in [session-fork-ui.md](../session-fork-ui.md#the-rule).

The cut is not snapped to a turn boundary. Cutting mid-turn leaves a last turn
with no terminal event, and none is invented to tidy it up: the next agent reads
this transcript too, and one claiming a turn ended where it was cut would lie to
it as well as to the user.
The price lands in the fork's UI: with nothing to
settle it, that last message sits in the frontend's `streaming` status until the
user's next message closes the turn, and while it does it cannot itself be a fork
anchor. It does not look busy in the meantime — the spinner is gated on a live
process, and a fresh fork has none.

Events the cut left half of go the other way — `agent.TruncateHistory` drops a
tool call whose result fell after the anchor, and a permission or question prompt
whose answer did. Extending the cut forward to the answer instead would copy back
part of the very turn the user forked away from. Only an event with an ID to pair
on can dangle; one without could not have been paired before the fork either, so
dropping it would remove history the source still shows.

**The source's current state is not part of the hand-off.** `ForkOptions` carries
the cut history and the directories, and nothing about whether the source has
records after the anchor or a process still writing them. It does not have to:
the agent finds its fork point *inside* `ForkOptions.History`, pinned to a
message, so everything the source adds — during the call or hours later — falls
past that point by construction. An agent that cannot find a point there carries
nothing rather than falling back on the source's momentary state (see [Claude's
case](#forking)).

**A forked session is [activated](#activation) at birth** when the copied records
contain agent output (`agent.HistoryActivatesSession`) — it has a transcript, so
the agent half of its engine selector locks, which is right: that transcript was
produced by that agent. Model and effort stay open, as they are on any other
activated session — those can change mid-conversation, the agent cannot. The cost
is that activation stops implying "a CLI has run for this session" — an inference
[Claude had to be taught to stop making](#forking). Codex never had to learn it:
nothing on its side reads activation, and its recorded state names where the
conversation lives rather than whether one has run, so a fork that has not
launched yet is already indistinguishable from a session that never started
([Thread Recovery](#thread-recovery)).

**A fork inherits the whole engine choice — agent, mode, model and effort** —
rather than starting from the defaults (`FileStore.CreateFork`). The argument for
the agent carries unchanged to the rest: a conversation continued on a different
model is not a continuation of the one that was forked, and a user who tuned a
session before branching off it means the branch to keep that tuning. Inheriting
needs no validation pass, either — the source's values were already checked
against the source's agent ([Session Models](#session-models)), and the fork runs
the same agent.

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
    Contents              []ContentBlock     `json:"contents,omitempty"`
    IsError               bool               `json:"is_error,omitempty"`
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
    ProviderMessageID     string             `json:"provider_message_id,omitempty"`
}
```

**Design Decision**: A single format avoids type conversion errors during serialization/deserialization.

`ProviderMessageID` is the agent's own id for the piece of its conversation this
event was parsed out of. It is a fact the event arrived with rather than Pockode
state, which is why it lives on the record. It exists so a fork can name its cut
point in the agent's own terms ([Session Forking](#session-forking)): `HistorySeq`
means nothing to a CLI, and one piece of an agent's conversation can produce
several records here, so position cannot be recovered from the records either.
Empty for events with nothing of the agent's behind them (a warning Pockode
raised itself), for agents that expose no ids, and for every record written
before the field existed — which is why every reader treats it as optional rather
than assuming it.

**What the id names is each agent's own business**, since only that agent ever
reads it back: whatever anchor it accepts for reopening a conversation is what
belongs here. Claude stores a transcript message's `uuid`, the anchor
`--resume-session-at` takes; Codex stores a turn id, the anchor `thread/fork`'s
`lastTurnId` takes. So the field says *message* while the granularity does not
have to be one, and the consequences of the coarser grain are Codex's to state
([Forking a Thread](#forking-a-thread)). The search for the last record carrying
one is shared — `agent.LastProviderMessageID` — because skipping the trailing
records Pockode wrote itself is the same job for both.

`IsError` is best-effort and is only ever set from what the CLI itself reports —
Claude's `is_error` on a `tool_result` block, and the `status` Codex puts on a
finished thread item. It is never inferred from the result text: a wrong "failed"
badge is worse than no badge, so a CLI that stays silent leaves the call looking
successful.

`Contents` holds a tool result that is not prose, cut into ordered blocks; it
and `ToolResult` are the same field in two shapes and never both set. See
[Content Blocks and Attachments](#content-blocks-and-attachments).

## Content Blocks and Attachments

A tool result is not always prose. Reading an image answers with the image,
reading a PDF with a line of text and the document, an MCP tool with its report
and its screenshot in one array, a tool search with the names it found. So
`ToolResultEvent` carries either prose or an ordered list of
`agent.ContentBlock` (`agent/content.go`), and a result that is nothing but
prose still carries no blocks at all — the shape that has always been on the
wire stays the shape, and every history record written before blocks existed
loads unchanged.

Blocks are built one element at a time (`agent/claude/tool_result.go`). Deciding
the whole array's fate from a single element in it is what the parser used to
do — an array holding an `image` block became an `image_not_supported` warning
and nothing else — and it cost everything beside that element: the MCP tool's
prose, its resource links and its audio notice all disappeared with the
screenshot, and the warning left behind carried no `tool_use_id`, so it could
not even be shown against the call that produced it. An element of a kind nobody
has seen yet is now passed through as its own raw JSON instead, which keeps it
visible in the transcript without letting it take its neighbours down. History
written before this keeps the warnings it recorded, and they replay as the
warnings they are — nothing rewrites a transcript to say what would be said
today.

### One Route to the Bytes

The two agents hand over different things. Claude delivers the content itself,
base64 inside the frame. Codex delivers a path, regularly one outside the work
directory ([Codex Event Mapping](#codex-event-mapping)). That difference is
settled in the parsers and nowhere above them: Codex's file is read when its
`imageView` item completes and stored where Claude's inline content is stored,
so a block has one field naming its content (`AttachmentID`) and a client has
one way to fetch it. `Path` is description — which file was looked at, and
whether the UI can offer to open it in the Files tab — and it is not the route
to the bytes while there are stored bytes to reach. A block may well carry
both; the path being present says nothing about where the content comes from.
(The one time the path is read for content is when there is no stored content to
read and the reason is `unavailable`; see
[the table below](#what-is-kept-and-what-is-only-described).)

The alternative was to let the client understand both shapes, which buys two
loaders, two sets of failure wording and two click behaviours for what the user
sees as one image.

### Why the Bytes Are Not in the Event

An `EventRecord` is written whole into `history.jsonl` and replayed with every
page of scrollback. One image Claude hands over is around half a megabyte, so a
session with a dozen screenshots in it would carry megabytes of base64 in every
page, forever, for images the reader has already seen. The content is therefore
written once into `sessions/<sessionID>/attachments/`, addressed by its own
sha256, and the record keeps the id alone — a record carrying an image measures
under half a kilobyte.

The id keeps the original file's extension where it had one that names the
content (`contents.ImageExtension`). That is not decoration: the read side types
an attachment by sniffing it again, and SVG, AVIF, HEIC and TIFF cannot be named
from their bytes, so under a bare hash they would come back as plain text or as
an unnamed binary — stored perfectly well and impossible to draw. Every other
format sniffs, and its id is the hash alone.

Transport was never the constraint. The Claude parser used to carry a comment
deferring images until a "10 MB HTTP relay limit" lifted; that ceiling belonged
to a relay transport which packed a whole request into one WebSocket message and
has since been replaced, and today's relay lowers no limit at all
([file.md](../file.md#transfer)). The ceilings that do apply are
`ws.maxClientMessage` (16 MiB, client to server only, so not this direction at
all), `contents.MaxFileSize` (2 MiB, what one JSON-RPC message carries) and
`filetransfer.MaxUploadSize` (32 MiB, on the HTTP upload route). Claude's inline
images sit far under the one that applies: it re-encodes anything large as JPEG
before handing it over, and measured against claude 2.1.263 an 18 MB PNG arrived
as 591 KB of base64, with ~650 KB the largest seen from any input. The cost was
always the writing down, not the sending.

### What Is Kept, and What Is Only Described

A block with no content behind it still describes what the agent produced, and
says why it is empty in `contents.OmitReason` — the same vocabulary the file
namespace omits with, so one client code path renders both:

| Case | `omitted` | Why |
|------|-----------|-----|
| An image within `contents.MaxFileSize` | — | stored; this is the whole point |
| A PDF or other non-image | `binary` | the UI lists it rather than rendering it, and the read that produced it names the file on disk in the text block beside it, so half a megabyte of base64 would buy nothing. The file namespace omits non-image binaries for the same reason. On the Codex side this is also the boundary of the copy: the event says the file is an image and the path is the agent's, so what does not sniff as one is described where it lies rather than copied in on the strength of that claim |
| An image over `contents.MaxFileSize` | `too_large` (+ `limit`) | it could not be sent back through one JSON-RPC message, so storing it would only defer the failure |
| Content that could not be read, decoded or stored; a path the server cannot use | `unavailable` | there is nothing to keep |

`unavailable` is the one of the three a client may get past. The other two are
statements about the content — the same ceiling and the same refusal would come
back from any route — while this one says only that the server could not keep
it, so a block naming a file still in the work directory is read through
`file.get` instead and the image appears after all. Claude's blocks carry no
path of their own, but the call that produced one does, and its `file_path` is
that file: the client fills it in for a lone file block, which is also what
gives a Claude read the file name and the way over to the Files tab that a Codex
read of the same file has. Two conditions on that, both about not stating
something untrue: only a `Read`, whose contract is that the result *is* what is
in `file_path` — plenty of other tools take a path and answer with something
else, and a chart drawn from a CSV is not the CSV — and only when the result
holds exactly one file block, since one path cannot say which of several files
it belongs to (`web/src/lib/contentBlocks.ts`).

Width and height are read from the delivered bytes' own header rather than from
the `tool_use_result` field Claude sends alongside: that field is one per frame
and a frame may carry several file blocks, so it cannot be attributed, and it is
not part of any published shape. They travel with the block so a client can hold
an image's space before the image arrives — without them, paging back through a
transcript re-lays-out under the reader as each one loads.

### Lifetime, and What a Fork Does

A store is the pair `(DataDir, SessionID)` resolved into a directory
(`attachments.NewStore`, and `attachments.Dir` for the read side, which resolves
the same directory without holding a store). Nothing else is state, and the rest
of the lifetime falls out of that. The directory is created on the first write,
so a session that is never handed content costs nothing. A session started
without a data directory to keep anything in gets the zero value, which fails
the write instead of returning an id that resolves to nothing, and the block
then says `unavailable` like any other content that could not be kept.

It also means the store is derived rather than carried, which is what makes a
restart a non-event. The subprocess is restarted for a model change, an effort
change and a resume ([Session Models](#session-models)), and every new process
builds the store from the same session id, so it writes into the same directory:
images from before the restart still resolve, and an image delivered a second
time content-addresses onto the file already there.

Deletion needs no step at all, for the same reason: the attachments are inside
the session's directory, so `session.FileStore.Delete` takes them with it and
there is no separate collector to get wrong. Forking needs one deliberate step
to keep that true (`attachments.Clone`, called from `FileStore.CreateFork`). A fork copies the source's history records
verbatim, and those records name content by id alone — so without cloning, every
image in the fork would resolve into the *source's* directory and vanish the day
that session was deleted. The clone hard-links rather than copies — the content
is immutable and addressed by its own hash, so the bytes outlive whichever
session is deleted first and are freed when the last one naming them goes — and
a clone that fails warns rather than aborting the fork, because a fork missing
its images is still the conversation the user asked for.

### Reading It Back

`attachment.get` (`ws/rpc_attachment.go`) takes a session id and an attachment
id and answers with the same `contents.FileContent` that `file.get` answers
with — MIME sniffed from the bytes, base64 for an image, text for content that
is text, omitted with a reason for the rest — so a client renders an attachment
through the file viewer's existing code path instead of a second one built to
say the same things.

It is a WebSocket method and not an HTTP endpoint because an `<img src>` cannot
carry the bearer header ([file.md](../file.md#downloading)); the viewer already
fetches and builds a data URL, and this fits that without inventing a way to
authenticate an image tag.

Two things confine it. The session id is checked against this worktree's own
sessions before it is allowed to pick a directory — it selects the path, so an
unknown one must not become one — and the attachment id goes through
`contents.ValidatePath` inside a directory that holds nothing but
content-addressed files. An attachment that no longer exists is an error reply,
the same as a missing file is on `file.get`.

### Why This Is Not the File Namespace

The two routes look alike from the client — both answer with a
`contents.FileContent`, and the same viewer draws either — and they are kept
apart because of what each one lets a request name.

The file namespace addresses a file by a path relative to the work directory,
and `contents.ValidatePath` refuses absolute paths and `../`
([file.md](../file.md#security)). Everything reachable through `file.get`, the
download endpoint, the tree and search is therefore something the user could
have browsed to. What an agent looks at is routinely not: Codex's `view_image`
reads a screenshot out of `/tmp` as readily as out of the project, and Claude
hands over content that was never a file on this machine at all. So the
namespace cannot serve these, and the way to make it able to — letting a path
be absolute — would turn every authenticated client into a reader of the whole
filesystem for the sake of one image, in a validation shared by the writes and
the deletes as well. Merging costs the containment of the file namespace and
buys nothing, because the bytes have already been read by then.

The bytes are secured on this side of the boundary instead. Codex's file is read
once, at the moment the item reports it, by the server acting with the reach the
agent already had; Claude's content was never on disk and arrives in hand. Both
end up in the session's directory, and what a client is given afterwards is an
id into that one directory. The path travels beside it as description — which
file was looked at, and whether the Files tab can offer to open it — and is
never a route to content ([One Route to the Bytes](#one-route-to-the-bytes)).

The split holds on the other side too. A path names something that can change
under the client, so a cache entry held under one is dropped when the Files tab
writes, creates or deletes; an id names bytes that cannot change, so an
attachment's entry is never invalidated by anything
(`web/src/hooks/useAttachmentContent.ts` — which is also why a block that has
only a path shares the Files tab's entry instead of getting one of its own).
Saving an attachment does not reach the HTTP download route either, since there
is no path to ask it with: the viewer saves the content it already fetched
(`web/src/components/Chat/AttachmentPreview.tsx`).

The one crossing is the `unavailable` fallback above, where a block naming a
file that *is* in the work directory is read through `file.get`. That direction
is fine precisely because it is the ordinary one — a work-directory-relative
path, validated as every other file read is.

## Protocol Baselines

Nothing below is a spec. The event payloads are unversioned — Claude negotiates
named capabilities in `init` precisely because there is no version to branch on,
and Codex's app-server declares no protocol version at all. So every mapping here
describes one observed CLI: **Claude Code 2.1.222** and **codex-cli 0.153.0**.

Each was established by running that CLI with Pockode's own arguments and reading
the shipped source of truth rather than the published docs: the zod schemas
embedded in the Claude binary, whose `.describe()` annotations the online
documentation omits or contradicts, and — for Codex — the JSON schema the CLI
generates for its own app-server protocol (`codex app-server
generate-json-schema --experimental`), which is the same artefact upstream offers
third parties for generating bindings.

Codex has a single baseline again because the whole channel was replaced at
0.153.0 ([Codex Implementation](#codex-implementation)); the fixtures in
`agent/codex/appserver_test.go` and `usage_test.go` are frames captured from that
version. The one exception is noted where it applies: the compaction usage frames
are the MCP channel's, transcribed field-for-field, because compaction cannot be
reproduced cheaply and the behaviour under test is identical on both channels.

Claude has a smaller exception. The mapping was read at 2.1.222, but the
`tool_result` content shapes and the subagent tool's name were checked live
against **2.1.263**: that is where the text-block array below was observed, and
where the subagent tool answers to `Agent`, and where the truncating-resume
behaviour behind [forking](#forking) was measured — note that `--resume-session-at`
and its companions are absent from `claude --help`, so their semantics come from
running them, not from reading it. Which version renamed it from
`Task` was not established and does not matter — history recorded by older CLIs
still says `Task`, so both names have to keep working
([frontend-state.md](frontend-state.md#task-parts)).

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

if opts.Model != "" {
    args = append(args, "--model", opts.Model)
}
if opts.Effort != "" {
    args = append(args, "--effort", opts.Effort)
}

launch := resumeState.resolve()
if launch.sessionID != "" {
    if launch.resume {
        args = append(args, "--resume", launch.sessionID)
        if launch.fork {
            args = append(args, "--fork-session")
        }
        if launch.resumeAt != "" {
            args = append(args, "--resume-session-at", launch.resumeAt)
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
An empty model or effort is how a session says "let the CLI pick", so neither
flag is passed at all in that case; see [Session Models](#session-models) and
[Session Effort](#session-effort).

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
| `unstarted: true` | `--session-id <pockodeID>` |
| `recovery: ""` | `--resume <sessionId>` |
| `recovery: "fork"` | `--resume <sessionId> --fork-session` |
| `recovery: "fork"` + `resumeAt` | the same, plus `--resume-session-at <uuid>` |
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
keeps a `codex_resume.json` of its own, written the same way for the same reason
and with a much smaller job — see [Thread Recovery](#thread-recovery) for why it
needs no ladder.

### Forking

`claude.Agent.ForkSession` starts no process. It writes the forked session's
`claude_resume.json` ahead of time, so the first launch the user's first message
triggers is already the right one, and the states it can write are the whole
implementation:

| Fork | Seeded state | First launch |
|---|---|---|
| carries the conversation, cut at the anchor | `{sessionId: <source's provider ID>, recovery: "fork", resumeAt: <anchor message uuid>}` | `--resume <source's ID> --fork-session --resume-session-at <uuid>` |
| carries nothing | `{unstarted: true}` | `--session-id <pockodeID>` |

**The `fork` rung is what protects the source**, not a convenience. It is the only
launch that replays a conversation without claiming its ID, and the ladder only
ever escalates away from resuming (`fork` → `fresh`), so no retry of the new
session can decay into a plain `--resume` that would write its turns into the
source's transcript. Once the new session reaches `init` it owns a provider ID of
its own and the rung resets, exactly as a recovery would.

**`--resume-session-at <uuid>` is what makes a fork from the middle carry
anything.** `--resume` alone replays a conversation in full; adding it keeps the
transcript entry with that uuid, drops everything after it, and does so before the
session is forked. Both facts were measured against claude 2.1.263 and are pinned
by `TestIntegration_ForkSessionCarriesContextFromTheMiddle`: a fork taken at the
first of two turns knows the first and has never heard of the second.

Pinning by *message* rather than by *time* is also why the source's own state
stopped mattering. Whatever its process appends to its transcript — while the
fork is being taken, or hours later — lands past the anchor and is cut away by
the same slice. The same test forks from a source that is still running and makes
it talk again afterwards; none of it reaches the new session, and the source's
transcript keeps every turn.

**It is also why there is no uncut fallback.** An earlier design let a fork with
no anchor replay the source whole, guarded by "the source is not truncated and
has no live process". That guard cannot hold: `ForkSession` only *seeds* the
resume state, and the CLI reads the source's transcript when the forked session
first launches, which may be days later and after the user has talked to the
source again. An uncut replay would then deliver exactly the turns the user
forked away from — silently, since the fork reported `carried == true`. No anchor
now means no context, which the user is told about.

The optional companion flag `--resume-drops-turn` is deliberately **not** passed.
It asserts that everything being discarded belongs to one named turn and refuses
the resume otherwise, which is a guard for undoing a single turn; a Pockode fork
routinely discards many, so passing it would turn the normal case into a refusal.

**Naming the anchor needs the CLI's own uuid for that message**, which Pockode
keeps in `EventRecord.ProviderMessageID` — `HistorySeq` means nothing to the CLI,
and one CLI message can become several records, so position cannot stand in for
it. `forkAnchorMessage` takes the last record in the copied history that carries
one. The message it names is kept whole, so a cut *inside* an assistant message
(text, then a tool call) brings that message across entire: the CLI reports the
tool call whose result was cut away as failed, which is a better mismatch than
dropping the very message the user forked at.

The mismatch runs the other way wherever the **last kept record names no
message** — a prompt Pockode sent, which the CLI never streams back and so has no
uuid here, or a warning Pockode wrote itself. The replay then stops at the last
message the agent did speak, while the transcript shows more, which is the safe
direction — carrying less than the transcript shows rather than more — and the
only one available.

A fork anchored on a user message used to be the ordinary way into that
mismatch, and is not any more: `chat.Client.Fork` cuts that message away (*What
the cut means*), so the kept history normally ends on the agent's turn and the
replay stops exactly where the transcript does. **Normally, not always** — the
mismatch survives wherever the record *before* the anchor also names no message:
two prompts sent back to back while the agent worked, or a message Pockode wrote
itself — a work event, say — sitting in front of the anchor. Do not read the
change as having removed it.

Two situations carry nothing, both reported the same honest way —
`carried == false`, which makes `chat.Client` record it in the new session's
history:

- **no record in the copied history carries a message uuid** — history written
  before Pockode stored the uuids, or a session the agent never spoke in. There
  is no point to cut at, and replaying uncut is not an option (above). The second
  case has no memory to carry in any event.
- **the source has no provider session recorded, or gave up on the one it had**
  (`recovery: "fresh"`) — replaying it would fail, which is worse *after* telling
  the user it would not.

**A fork of a fork falls out of this** with nothing extra. The provider session
read from the source is the source's *own* source when the source has not
launched yet, and copied uuids survive `--fork-session` (the CLI keeps them), so
the grandchild's own anchor names a message that session really contains — and it
is at or before the source's own cut, because the grandchild kept a prefix of
what the source kept.

One promise can still be broken after the fact: a uuid the source's current
provider session does not contain — because it started over at some point and the
earlier messages live in a conversation it has abandoned, or for any other reason
an entry is no longer in that transcript — makes the first launch exit with
`No message found with message.uuid of: ...` before `init`. That is a launch
failure like any other, so the ladder escalates `fork` → `fresh` and the user gets
the `session_not_resumable` warning — late, but honest. A fork taken at the end
of the conversation is the one case it cannot reach: that anchor is the newest
message recorded, and nothing removes the newest entry from a transcript.

**`unstarted` exists because a forked session is [activated](#activation) at
birth.** Activation is otherwise proof the CLI owns the Pockode ID (the "no file,
activated" rung above), and that inference is false for a session whose transcript
was copied in: resuming it would fail, walk the ladder, and arrive at the
`--session-id` launch it should have started with — after telling the user Claude
"could not reopen this session's earlier conversation", about a conversation it
never had. Claude's answer records the fact in the state file that already decides
how the session opens; Codex needs no such flag, because its state file records
only where a conversation lives, so a fork that has not launched yet looks exactly
like a session that never started ([Thread Recovery](#thread-recovery)).
`unstarted` only means anything while no provider ID is recorded, because
recording one is precisely what stops a session being unstarted.

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

A `user` message carries tool results, whose `content` arrives in three shapes.
A JSON string is the result text as-is. An array is walked element by element,
and if any element is one the UI cannot render as prose — an image, a document,
a tool reference — the array becomes ordered [content
blocks](#content-blocks-and-attachments), which is how an image, a PDF and a
tool search's answer reach the transcript as themselves instead of as the raw
JSON they were flattened into before. An array with nothing like that in it is
joined back into one string as it always was: the subagent tool reports this way
and its report is Markdown, so forwarding the array verbatim would show the user
a wall of escaped JSON instead. An object, or content that does not decode at
all, is forwarded as raw JSON — there is nothing there to cut.

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

### Why the app-server Channel

Pockode used to speak `codex mcp-server`, whose two tools were `codex` (start a
thread) and `codex-reply` (continue one by id). That channel had a single defect
that everything else about Codex followed from: **a thread lived in the memory of
the process that created it.** `codex-reply` resolved thread ids against an
in-memory map and answered `Session not found for thread_id` for anything else,
so a restarted session could not continue its conversation, could not be forked,
and lost the agent's memory to every mode or model change. Pockode's own
transcript survived all of that, which is what made the loss easy to miss.

`codex app-server` — the same binary, a different subcommand — removes the defect
rather than working around it. `thread/resume {threadId}` loads a thread back from
its rollout file on disk, `thread/fork` does the same and cuts the copy at a
chosen turn, and both reopen threads the **MCP channel** created, so no session
recorded before the move was lost (measured on codex-cli 0.153.0, against a
rollout Pockode's own integration tests had left behind).

Two things about the old conclusion are worth keeping straight, because the
version of it that said *Codex cannot reopen a conversation* was always too
strong:

- **The limit was the channel, not the CLI.** The MCP server offered no way to
  open a thread from the rollout files on disk. That was the limit that applied,
  because that was the channel Pockode spoke.
- **The remaining `exec` channel is still not the answer.** `codex exec` runs one
  turn per process, and `codex exec fork <SESSION_ID>` takes a session id and no
  message selector of any kind — whole-conversation forks and never the one this
  feature is for. More decisively, its `--help` offers no way to put an approval
  in front of a user at all: the choices are `--approve-for-me` and a full bypass,
  so there is nowhere for a `PermissionRequestEvent` to come from. That is read
  off the interface surface, not from a live run.

The trade is that `codex app-server` is marked `[experimental]` in `codex --help`
where `mcp-server` is not, and that the handshake declares an `experimentalApi`
capability on top of that ([Startup](#startup)). What makes it acceptable is that the
protocol is machine-checkable: the CLI generates the JSON schema for it (`codex
app-server generate-json-schema --experimental`), so a shape that moves can be
found by asking rather than by a user running into it.
`TestIntegration_ProtocolSchemaStillFitsWhatWeSend` is where that is asked. It
generates the schema and asserts the shapes this package depends on — the fields
each of `thread/start`, `thread/resume` and `thread/fork` is sent, the `turnId`
that `item/started` and `item/completed` must keep marking required, the four
approval decisions, and the three `PatchChangeKind` variants
`web/src/lib/codexChanges.ts` renders. A schema that *grows* is not drift and the
test ignores it; what it catches is a field disappearing, a required field
becoming optional, or a union gaining a case that would be silently dropped.

It sits behind the `integration` tag because it needs `codex` installed, but
unlike its neighbours there it **spends no tokens and never reaches a model** —
generation is local, and the whole check runs in under a second. CI does not run
it, for the same reason CI runs no integration test: no CLI on the runner.

"app-server is the channel the official VS Code extension speaks" is an
**inference**, not a measurement, and the paragraph above deliberately does not
rest on it. The evidence for it is indirect: upstream ships `generate-ts` /
`generate-json-schema` for third parties to build bindings from, and `thread/start`
writes `source: "vscode"` into the rollout of every thread it creates whatever the
client passes.

### Channel Differences

| Aspect | Claude | Codex |
|--------|--------|-------|
| Protocol | stream-json, one JSON object per line | JSON-RPC 2.0 over stdio (`codex app-server`) |
| Turn boundary | one `result` frame | `turn/started` … `turn/completed` |
| A message sent mid-turn | queued behind the running turn | **steers** it: both messages share one turn and therefore one ending |
| Permission requests | `control_request` / `can_use_tool` | server→client JSON-RPC *requests*, answered with a `decision` |
| Interrupt | `control_request` / `interrupt` | `turn/interrupt {threadId, turnId}` |
| Session recovery | `claude_resume.json` + a recovery ladder ([above](#session-recovery-ladder)) | `codex_resume.json` + `thread/resume` ([below](#thread-recovery)) |
| Session forking | `--resume-session-at <message uuid>` ([above](#forking)) | `thread/fork` + `lastTurnId` ([below](#forking-a-thread)) |

The steering row is the one that changed a contract rather than a mechanism. The
MCP channel aborted a running turn and replaced it with the new message; the
app-server answers both inside the turn already running, and the second
`turn/start` returns that turn's own id (measured on codex-cli 0.153.0). It is the
better of the two — nothing the agent had already done is thrown away — but it is
why `agent.Session.SendMessage` promises nothing about endings *per message*, and
why Codex's adapter counts nothing per message either.

### Startup

`Start` does three bounded things before it hands back a session: probe that the
CLI has the subcommand, answer the JSON-RPC handshake, and open this session's
thread. All three are bounded because `Start` runs under the process manager's
worktree-wide lock ([Lock Strategy](#lock-strategy)), where a step that never
returns freezes every session in the worktree rather than just this one.

**The capability probe reads `codex --help`, not `codex --version`.** The version
that introduced `app-server` is not documented anywhere Pockode can check, so a
version comparison would be a guess in both directions: too high locks out installs
that work, too low defers the failure into an unreadable JSON-RPC error much later.
Asking which subcommands exist answers the actual question. The match is on the
line's first field rather than anywhere in the text, because other entries'
descriptions mention the string too — `agents` and `remote-control` both do on
0.153.0.

**The handshake declares `capabilities.experimentalApi: true`.** Without it a
fork anchor can be refused outright — `thread/fork.beforeTurnId requires
experimentalApi capability`. Only `beforeTurnId` was observed being refused that
way; `lastTurnId`, the one Pockode actually sends, is present in the schema
generated *without* `--experimental` as well, so it may not need the flag at all.
Declaring it settles the question without having to keep answering it: capabilities
are negotiated once, at the handshake, and nothing arrives because of it that the
notification dispatch does not already drop by default.

**Pockode's MCP server rides in as a config override.** The thread parameters
carry a `config` map that overrides `config.toml` for this thread only, and
`mcp_servers.pockode` there is what gives the agent its `work_*` tools — the
counterpart of Claude's `--mcp-config`, with no file to write and therefore none
of the atomic-rewrite problem that one has. `model_reasoning_effort` rides in the
same way, for a different reason ([Session Effort](#session-effort)).

**`threadSource` says whose thread this is, and does not say it where you would
expect.** It lands in the rollout's `thread_source`, next to `originator` (which
takes `clientInfo.name`, also `pockode`). It does *not* change the rollout's
`source` field: on 0.153.0 that one is hard-coded per channel and reads `vscode`
for everything app-server creates, whatever is passed (measured — which is also
the second piece of indirect evidence behind the VS Code inference above).

The two budgets — 10s for the probe, 45s for the handshake plus opening the thread
— carry no model latency: nothing in either step sends a prompt anywhere, and a
resume or a fork is told to skip hydrating the thread's turns (`excludeTurns`,
since Pockode renders from its own history).

**That is not the same as "local work", and it is worth being exact about,
because the margin is thinner than it looks.** Measured on 0.153.0 with no prompt
involved, over five cold runs: `initialize` 2.3–4.9s, `thread/start` 8.6–14.2s,
11–19s together. The CLI logs its own network timeouts while doing it (`failed to
refresh available models`), so it is reaching the network during the handshake,
not just reading disk. Against the 30s this budget started at that is a margin of
well under 2x, and two integration runs on a contended machine exceeded it
outright, failing with `codex did not answer the app-server handshake within 30s`
and `codex did not open a thread within 30s`. Hence 45s, about 3x the worst
measured start.

The asymmetry is what picks the number. The budget is only ever spent in full
when a start is genuinely stuck, and then all it decides is how long the user
waits to be told so. Set it too low and it kills starts that would have
succeeded — and the user pays the whole wait again on the retry. Waiting longer
to report a real failure is the cheaper of the two mistakes.

`web/src/lib/wsStore.ts` mirrors their sum as `CODEX_START_BUDGET_MS` and keeps
the timeout of the requests that run `Start` above it: if the client gave up
first, the error naming the stalled step would go into a reply nobody is waiting
for. The two constants have to grow together.

### Thread Recovery

A session's thread id lives in `codex_resume.json` under the session directory,
written atomically for the same reason Claude's is — a half-written one silently
costs the user the ability to reopen that conversation. Sessions with no Pockode
session id (integration tests) skip the write, since the path would otherwise
collapse to one file shared by all of them.

**There is no recovery ladder, and the difference from Claude is the point.**
Claude's ladder exists because its CLI *claims* a session id the moment it starts,
so reusing one is fatal and a failed launch has to be told apart from a stale
mapping. A Codex thread id is only ever a key into a rollout file: `thread/resume`
either finds it or says so, at the one moment it matters, in one step. So the
state file holds where the conversation is and nothing about whether a session has
ever run — which is also why `ForkSession` writing nothing is a complete answer
([below](#forking-a-thread)) where Claude needed an `unstarted` flag.

**Reopening that fails does not fail the session.** A rollout that is gone —
deleted, or written by a Codex install that is no longer there — would otherwise
make the session permanently unusable. Codex starts a fresh thread instead,
records the new id over the dead one so the next restart does not repeat the same
failure, and emits a `session_not_resumable` warning carrying Codex's own reason.
The user needs to know the agent no longer remembers the transcript in front of
them.

**One failure deliberately does not degrade**: the startup budget running out. A
timeout says nothing about whether the thread is good, and starting a new one
would burn a recorded id for nothing. It is returned as a start failure instead.

**Two live processes on one thread do not silently share it.** A second
`thread/resume` of a thread another process is holding is refused outright
(`-32600 thread <id> already has an active writer`, measured on 0.153.0). Pockode
runs one process per session, so reaching this means a process leaked; it takes
the same degradation path as a missing rollout, and the warning carries Codex's
wording so the cause is visible rather than guessed at.

### Forking a Thread

`Agent.ForkSession` starts no process. It writes the forked session's
`codex_resume.json` with the *source's* thread id and a `forkAtTurnId`, and the
first process that session ever starts opens its thread with `thread/fork` instead
of `thread/resume`. Deferring the work is what keeps a fork from costing a process
for a session the user may never type into, and it stays correct however long the
wait is, because the anchor is a turn id rather than anything sampled from the
source's current state.

**One field carries the intent, and recording a thread is what retires it.** The
state is written whole, so the moment the fork has been taken and the new thread
recorded, `forkAtTurnId` is gone and the next launch resumes the fork's own thread
rather than forking the source again.

**The anchor is `lastTurnId`, which is inclusive, and not `beforeTurnId`.** A turn
is the finest anchor this channel offers, so the fork keeps the whole turn the
anchor sits in — including anything the agent went on to do later inside it, which
the copied transcript may stop short of. Steering makes that visible: a message
sent while a turn was running belongs to that turn, so a fork taken at it carries
the answer to it as well. The alternative cuts the turn away entirely, which would
leave the agent not remembering the very exchange the user forked at — prompt
included — while the transcript in front of them shows it. Carrying slightly more
than is shown is the smaller of the two mismatches, and it is the direction
Claude's fork errs in too, at the finer grain of a message.

**The turn id comes from the notification the item arrived in**, not from the
session's idea of which turn is running. `item/started` and `item/completed` both
carry `turnId` as a required field (checked against the generated schema), and
which turn a record belongs to is a fact that arrived with it — reading it back off
the session would stamp an empty id on any item processed after `turn/completed`
had moved on, silently making that record unusable as an anchor. It is stored in
`EventRecord.ProviderMessageID`, the same field Claude puts a message uuid in
([EventRecord](#eventrecord-unified-event-format)).

**An anchor turn that is still running is refused**, says the schema the CLI
generates (*The referenced turn cannot be in progress*) — which is what a fork
taken from a session mid-turn, and typed into before that turn ends, would name.
Whatever Codex answers to it lands in the degradation below. Recorded as the
schema's claim rather than as a measurement.

**A fork that fails degrades to a new thread and never to resuming the source.**
That is the one constraint here that cannot be relaxed: two sessions resuming one
thread would write their turns into a single conversation, which is precisely what
forking exists to prevent. The user is told, exactly as for a source with nothing
to reopen.

**`carried == true` can still be an over-promise, and knowingly is.** A source
that once degraded to a new thread has history naming turns of *both*, and an
anchor landing on the abandoned one is a fork Codex will refuse. Nothing on
Pockode's side can tell those ids apart — only the thread knows which turns are
its own — so the question is left to the one place that can answer it: the fork is
attempted at first launch, and a refusal lands in the degradation above. The
ending is honest even where the promise was not.

**`ForkSupport` is a static declaration and probes nothing.** It is read on every
`agent.list` call, and probing would mean spawning a process to answer a question
about the installation rather than about any session. If `lastTurnId` is renamed
or withdrawn by a Codex release, the cost is bounded and visible: forks are still
offered, the first launch fails to fork, and it degrades to a new thread with the
user told — the same answer as an unreopenable source, one step later.

### Approvals

Codex asks for approval by making a JSON-RPC **request** of Pockode —
`item/commandExecution/requestApproval` or `item/fileChange/requestApproval` —
which is answered with one `decision` string: `accept`, `acceptForSession` (the
*Always Allow* answer, which lasts as long as the thread) or `decline`. There is
no externally tagged enum and no rejection payload; the MCP channel's
`{"denied": {"rejection": …}}` shape is gone with it. Which actions get this far
at all is a question of the session mode rather than of this path (see
[Session Modes](#session-modes)).

Each request is handled on its own goroutine, because everything else the CLI has
to say keeps arriving while the user decides.

**A request is answered, always.** Every server→client request Pockode does not
serve gets a definite reply rather than silence: an MCP elicitation is declined
(the one server Pockode installs never elicits, so it can only come from one the
user configured in Codex themselves), a `granular` permission grant hands back an
empty permission set, `item/tool/requestUserInput` hands back no answers, and
anything unrecognised gets `-32601`. Refusing costs one call; not answering hangs
the turn for the life of the process. Unrecognised methods are logged at **warn**,
not debug — the protocol still defines the v1 `execCommandApproval` /
`applyPatchApproval` pair, which 0.153.0 does not send here, and the day something
starts sending it should read as a log line rather than as a turn that mysteriously
gave up.

**A file-change approval does not carry its own patch.** The patch arrives in the
`item/started` that precedes the approval and nowhere else, so the session keeps
the rendered input of in-flight items and the prompt reuses it — which also makes
the prompt and the transcript row agree, since it is literally the same rendering.
Two shapes have nothing to reuse: a file change whose `item/started` was never
seen, and a command approval of `kind: "writeStdin"` (input sent to a terminal
already running), which has no command of its own. Both fall back to the request's
own `reason` — the CLI's explanation of why it is asking, which every
`on-request` approval observed on 0.153.0 carried ("May I read old.txt outside the
sandbox to make your requested edit?") — because a prompt that says why beats an
empty box the user is still expected to decide on.

`reason` is nullable, so the fallback needs one of its own: empty fields are
dropped, and a request that described nothing at all gets a sentence saying so
and suggesting denial. This is not cosmetic. The frontend summarises a request by
the first non-empty string in its input and hides the body when every field is
empty, so `{"reason": "", "kind": ""}` renders as a prompt with no question in
it — while still blocking the turn until the user answers.

**Two approvals must never share one request id.** The CLI sends an `approvalId`
wherever one item can raise several callbacks, and that is what keeps them apart;
the id of the item is used only when there is no `approvalId`. If two live
approvals ever did collide, one would replace the other and the user's single
answer would settle whichever was still there, leaving the other's request
unanswered forever — a turn wedged for the life of the process. So a collision is
logged as an error and the second approval is declined outright: refusing one
request costs that request, while wedging costs the session.

**Interrupting answers the prompts before it interrupts.** A turn blocked on an
approval is not reading its interrupt request, so answering is what actually
unblocks it — with `cancel`, the decision that refuses *and* ends the turn.
`RequestCancelledEvent` is emitted before the decision is handed over, not after:
the decision is what lets `turn/completed` arrive, and an ending that overtakes
the withdrawal leaves a prompt on screen that nothing will ever take away.

The two kinds are not equally reachable from a test, which is why only the command
one is in the integration suite. A command approval is asked *before* the command
runs, so it needs nothing working from the sandbox. A file change does:
`apply_patch` verifies its target through Codex's sandbox helper — bubblewrap on
Linux — so on a host that restricts unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=1`, the Ubuntu 24.04 default) the
patch fails while merely *reading* the file, long before an approval is needed. No
prompt works around that, so the file-change path is pinned by unit tests against
captured payloads and reproducing it live means a privileged container.

### Codex Event Mapping

The channel reports work as **thread items** with a lifecycle — `item/started`
when one begins, `item/completed` when it ends — wrapped in a turn.

| Notification | Agent Event |
|---|---|
| `turn/started` | (none — supplies the turn id `turn/interrupt` has to name, and is where a stop that arrived before it is carried out) |
| `turn/completed`, `status: "interrupted"` | `InterruptedEvent` |
| `turn/completed`, `status: "failed"` | `ErrorEvent` |
| `turn/completed`, otherwise | `DoneEvent` |
| `item/started`, `commandExecution` | `ToolCallEvent {ToolName: "Bash"}` |
| `item/started`, `fileChange` | `ToolCallEvent {ToolName: "Edit"}` |
| `item/started`, `mcpToolCall` | `ToolCallEvent {ToolName: "server:tool"}` |
| `item/started`, `imageView` | `ToolCallEvent {ToolName: "Read"}` |
| `item/completed`, `agentMessage` | `TextEvent` |
| `item/completed`, the four item types above | `ToolResultEvent` (`imageView`'s carries a file block, the rest text) |
| `mcpServer/startupStatus/updated`, `status: "failed"` | `WarningEvent` per failed server |
| `error` with `willRetry` | `WarningEvent` |
| `warning`, `guardianWarning`, `configWarning` | `WarningEvent` |
| `thread/tokenUsage/updated` | (none — feeds the usage observer, see [Usage Reporting](#usage-reporting)) |

The tool names are Pockode's rather than Codex's: the frontend renders a command
as `Bash` and a patch as `Edit` for either agent, so the mapping happens here
instead of in a frontend branch on agent type.

**`imageView` is the one item rendered as a tool it is not.** It is what Codex's
`view_image` tool puts in front of the model, and it has no result of its own to
report: `item/started` and `item/completed` carry the identical `{type, id,
path}` and nothing else (measured end to end on codex-cli 0.153.0). Read as a
`Read` call whose result is the file, it lands in the same chat UI as claude
reading an image — one renderer, one set of failure wording — instead of earning
a branch of its own for an operation that is a read. The result's file block is
built by the parser, which is where the bytes are fetched and stored
([One Route to the Bytes](#one-route-to-the-bytes)); the item is still reported
when the path turns out to be unusable, with `omitted: unavailable`, because a
transcript that says the turn looked at an image it could not fetch is worth more
than one that says the turn never touched an image at all.

**That path is not promised to be absolute.** The schema types it as a bare
string, while `imageGeneration`'s `savedPath` in the very same union is typed
`AbsolutePathBuf` — so the omission reads as deliberate, even though 0.153.0 was
only observed sending absolute paths. A path that is not already anchored by the
OS is therefore resolved against the thread's `cwd`, which is what a path the
agent wrote means. Resolving it against the Pockode process's own working
directory — what opening it unchanged would do — has nothing to do with the
session, and would show the user a different file under the agent's name. The
test is `pathutil.IsAnchored` rather than `filepath.IsAbs`, which reports the
Windows `\shot.png` and `C:shot.png` forms as relative and would have them
joined into nonsense.

**Item types not in the table produce nothing**, which is a second and separate
place work is dropped from the ignore list below: the echo of the prompt just
sent, reasoning, plans and web searches all arrive as ordinary `item/*`
notifications and fall through the type switch. They are dropped for the same
reason — no surface to render them on — and would be picked up by adding a case
rather than by removing a list entry.

**A patch's `changes` payload is forwarded as Codex sent it**, and its shape
changed with the channel: the MCP channel sent a map of path to change
(`content` or `unified_diff`, with `move_path` on the change), the app-server
sends an array of `{path, kind, diff}` (measured on 0.153.0: `diff` is the whole
file for an add or a delete, and hunks without a file header for an update).
`web/src/lib/codexChanges.ts` reads **both**, and has to keep doing so: history is
replayed from the records as they were written, so dropping the old shape would
blank out every patch in every Codex session that predates the move. A malformed
entry sends the whole payload to the raw-result fallback rather than rendering
half a patch.

**Exactly one event ends a turn**, which is the contract
`agent.Session.Events` describes, and `turn/completed` is the only thing that
produces one. A frame that cannot be parsed still ends the turn — deliberately,
since a turn left pending waits for an event that is never coming. The `error`
notification is the one thing that looks like an ending and is not forwarded as
one: a failure the turn does not survive is already reported by `turn/completed`,
and emitting here too would show the user the same failure twice. Only
`willRetry` is forwarded, because that turn goes on and the retries are what
explain a turn that has apparently stalled. It keeps the MCP channel's
`stream_error` code so that a transcript recorded before the move and one recorded
after carry the same code for the same event; nothing branches on the value.

**Failure is read off the item's `status`, not off an exit code.** Codex has
already folded the exit code into it (a command exiting 2 reports `failed`,
measured on 0.153.0), and `status` also covers failures that produce no exit code
at all — a declined approval reports `declined`, which is how a refusal reaches the
transcript as words rather than as an empty successful-looking row.

**`configWarning` reaches the transcript on purpose.** It is how the user finds
out that, say, bubblewrap is missing and the sandbox could not start — which is
also the explanation for why every single command is suddenly asking for approval.
The cost is that a standing misconfiguration repeats its line on every process
start; silence would cost the user any way of understanding the prompts.

**Everything else is dropped through an explicit list** (`ignoredNotifications`)
rather than forwarded. The app-server defines 81 notifications, most of them
per-turn bookkeeping or increments of content that also arrives whole, and
upstream keeps adding more — a parser that forwards what it does not recognise
fills the transcript with noise on every CLI update. The list also keeps the
default branch meaning "a method we have never seen", which is what its debug log
is for. Only methods actually observed on 0.153.0, plus those whose names say
plainly what they are, are listed; guessing at the rest would put entries there on
no evidence. Reasoning, plans and the turn's accumulated diff are listed by choice
rather than by accident — they carry real information Pockode has no surface for
yet, and their whole form is dropped alongside their increments, so they are not
increments of anything rendered.

Two entries there are not increments of anything and are listed for reasons of
their own. `item/fileChange/outputDelta` is dead: the schema says outright that
the server no longer emits it. `item/fileChange/patchUpdated` is a *revision* of
a patch already shown — it carries the whole `changes` array again — so dropping
it would leave a superseded patch in an approval prompt if it ever arrived. It is
listed on a measurement rather than on its name: an `apply_patch` driven end to
end on 0.153.0 never sent it, and `item/started` carried the final patch, byte for
byte what `item/completed` then repeated. Nothing Pockode offers can revise a
patch either — that is the editable approval surface of a desktop client. If
either of those stops being true it has to be wired to `rememberToolInput`, since
the prompt reads from there.

### Deliberately Not Wired Up

These are choices, recorded so they do not become blanks nobody knows about.

- **`item/tool/requestUserInput`** is Codex's counterpart to Claude's
  AskUserQuestion, and Pockode already has the surface for it
  (`AskUserQuestionEvent`). It is not wired up: it is a feature of its own rather
  than part of changing channels, and the schema marks it EXPERIMENTAL, so what it
  would be wired *to* is not settled. It is declined rather than ignored, so the
  model is told nobody answered and carries on.
- **`thread/settings/update`** can change model and reasoning effort without
  restarting the process — something Claude cannot do. Pockode still restarts, so
  the two agents keep one code path; the win is now cheap in any case, since the
  restarted process resumes the thread ([Session Models](#session-models)).
- **The `granular` approval policy** (`AskForApproval` is `untrusted`,
  `on-request`, `never` or a `granular` object) would let individual approval
  classes be turned on one at a time. Not adopted: the product question it answers
  is the one [Session Modes](#session-modes) settles, and a third mode needs a
  reason in the UI before it needs a policy value.
- **The app-server's session-management surface** — listing, naming and searching
  threads — is not used at all. Pockode *is* the session manager; a second index
  of the same conversations could only disagree with the one the user sees.
- **The `imageGeneration` item** is the model *making* an image rather than
  looking at one, and it reports a `savedPath` the same machinery behind
  `imageView` could read. Not wired up: it is a feature of its own, not part of
  showing the user what the agent looked at, and unlike `imageView` it has not
  been observed end to end — it carries a `status`, a `failure` and a `result`
  whose meanings would be guesses. (The MCP channel's `image_generation_begin` /
  `image_generation_end` were its predecessors, and were ignored for the same
  reason; app-server has no notification by either name, so there is nothing to
  add to `ignoredNotifications` — the item simply falls through the type switch
  like reasoning and plans.)
- **`agent.BackgroundWaiter`** has no Codex counterpart to implement. Codex has no
  concept of a task that outlives its turn, so the interface stays unimplemented
  and the idle reaper's exemption simply never applies
  ([Background Waits](#background-waits)).

## Usage Reporting

Both CLIs say, every turn, how many tokens the conversation has consumed and
(Claude only) what it cost. Those figures travel a path of their own, running
beside the event stream rather than through it:

```
CLI frame (Claude's `result`, Codex's `thread/tokenUsage/updated`)
  ├─ parser        → AgentEvent → history + broadcast    what was said
  └─ usageObserver → UsageAccumulator → OnUsage → store  what it cost
```

A per-backend observer (`claude/usage.go`, `codex/usage.go`) reads the figures out
of the stream the parser is reading, `agent.UsageAccumulator` turns them into
increments, and `StartOptions.OnUsage` hands those to the session store, which
folds them into `SessionMeta.Usage` (`session/usage.go`). A frame need not take
both branches: Claude's `result` ends a turn and also reports its cost, while
Codex's `thread/tokenUsage/updated` has nothing to say to the transcript at all —
it arrives several times within a turn as well as at the end of one, which taking
deltas makes harmless.

**Usage is not an event.** Every `AgentEvent` is persisted into history and
broadcast to chat subscribers, and a history record is fixed at the moment it was
written — it says what was true then and cannot be corrected. A running total is
the opposite: one mutable fact the session store owns, which every reader must
see the current value of. Shipping it as an event would put a number into the
transcript that goes stale as soon as the next turn lands, and any reader
recomputing the total would be re-deriving state the store already holds. This is
the *events are events, state is state* rule in `AGENTS.md`. The parser side of it
is visible in Codex's `thread/tokenUsage/updated`, handled by an explicit case that
feeds the usage observer and emits nothing, rather than left in
`ignoredNotifications`: it is not a notification Pockode has no surface for, it is
not an event at all.

**Increments, not the totals as reported.** Both CLIs count from the start of
their own *process*, not of the session — a resumed session's counters start
again at zero (measured on claude 2.1.263 and codex-cli 0.153.0; two turns inside
one Codex process ran 16,721 → 33,458, and the resume that followed began afresh).
That Codex can now resume at all does not change this — the counters still belong
to the process, which is what `agent.UsageAccumulator` is built for. A session
outlives many processes, so storing what was reported would drop everything spent
before the last restart, and adding it every turn would count each turn again for
every later turn. One accumulator per process, contributing only what is new,
does neither. Two consequences are worth knowing: usage before Pockode started
counting is unrecoverable, and a counter that moves backwards mid-process is
clamped to no increment and warned about once — the honest response to a case
neither CLI has been seen to produce, where guessing would mean choosing
double-counting or under-counting on no evidence.

**One convention across backends.** Counts are stored Anthropic-style, with
cache reads and cache writes beside the input count rather than inside it. Codex
reports the other convention, so its parser subtracts them back out and then
checks its normalised sum against Codex's own `totalTokens`, warning once if
they disagree — the assumption cannot be proven against the one provider
available for testing, so it is wired to announce itself if it ever goes stale.
Without a single convention, adding two sessions' totals would add up two
different things, which is exactly what the work-level aggregation does
([work-system.md](work-system.md#usage-aggregation)).

**Cost is what an agent charged, or nothing at all.** Claude prices its own
turns; Codex reports rate limits, plan and credits and never a price. So an
absent cost means *this agent does not price*, not zero, and it stays absent all
the way to the screen — Pockode estimates none from a price list, because a
number we invented is indistinguishable, once displayed, from the one the
provider will bill. Two visible consequences: a session whose agent type was
switched — possible only while it is unactivated, and a session can burn tokens
before it activates — carries tokens from both agents and a price from at most
one of them, and a work subtree mixing the two backends reports a floor rather
than a total ([work-system.md](work-system.md#usage-aggregation)).

**Context size is a level, not a total.** `ContextTokens` / `ContextWindow`
describe how full one live conversation currently is; compaction makes them fall
while the totals keep climbing. They belong to a session and are never summed —
the work aggregate carries no window at any depth.

**The level is one request's prompt, and each CLI also reports a total that looks
exactly like it.** Both were measured on the same CLI versions as the counter
behaviour above, and reading the wrong one is the whole history of this section:

| | The level | The total it is not |
|---|---|---|
| Claude | the last main-conversation `assistant` frame's `message.usage`, summed as `input + cache_read + cache_creation` | `result.usage` — every request the turn made, added up. A seven-request turn reported `cache_read_input_tokens: 163135`, to the token the sum of its seven per-request reads |
| Codex | `tokenUsage.last.inputTokens`, which is one request's whole prompt with its cached part already inside it | `tokenUsage.total` — the running total since this process opened the thread. The same shape of turn had it at 87,193 while the level was 12,726 |

Read either total as a level and the reading is inflated by every request it has
already summed over — for Claude every request in the turn, for Codex every
request in the thread. A `904%` sitting in a stored index came from exactly that.
Claude needs one filter besides: an `assistant` frame carrying
`parent_tool_use_id` belongs to a subagent's own conversation (11,800 against the
main conversation's 24,034), and a turn that ends in a Task call would otherwise
report the subagent's context as the session's. Codex needs no equivalent — one
app-server process carries one thread.

**Two fields that look like the level after compaction, and are not.** Claude's
`compact_boundary.compact_metadata.post_tokens` counts only the conversation that
was kept, without the system prompt and tool definitions the next request still
sends: `pre_tokens` 66,631 against a measured prompt of 66,200, but `post_tokens`
3,026 against a measured 24,876. Codex's compaction usage frame zeroes every
field of `last` apart from a `totalTokens` of 6,140 — its own estimate of the
compacted history, where the next real request measured 12,616 (measured on the
MCP channel, whose counters these are the renamed form of: compaction is not cheap
to reproduce and the behaviour under test is the same on both). Either would make
the reading collapse and then jump back. Taking the level from the fields above
instead means a compaction frame reports no level at all, and `session/usage.go`
reads that zero as *this frame measured nothing* — never *the conversation is
empty* — and keeps the previous reading, so the level falls once rather than
flickering.

**The percentage is not clamped, and does not match Codex's own.** On one thread
Codex's status line read `1% used` where Pockode showed 5.6%: Codex subtracts a
fixed baseline of roughly 12,000 tokens — the magnitude of a thread's first
prompt, which is to say the system prompt and tool definitions that every later
prompt carries too — from both sides of the ratio. Pockode does not. The constant
appears in no event, so copying it would be a magic number that rots silently;
subtracting it for Codex alone would make two agents' percentages incomparable on
one screen; and those tokens genuinely occupy the window. For the same reason a
level above the window is displayed above 100% rather than capped — how full an
agent lets its own context get is its decision to show, not Pockode's to hide.

**A stored reading is a cache, not history.** Nobody is owed the number an agent
reported last month, so a reading known to have been taken wrong is dropped
rather than kept or guessed at. `indexData` therefore carries a `version`, and an
index older than version 1 loses its Claude `ContextTokens` on load — the window
is kept, since it was always read correctly and says which window the next
measurement will be against, and Codex's readings are untouched because that side
was measuring the last prompt all along. Nothing can recompute the right figure:
the per-request counts it would come from were never stored.

`SessionMeta.Usage` reaches clients through `session.detail` alone; the list row
has no use for it and goes to every subscriber on every change
([why](subscription-system.md#why-a-session-is-two-subscriptions)). Recording
usage deliberately does not touch `UpdatedAt` — every counted turn would
otherwise reorder the sidebar — and a fork starts at zero, since the tokens
behind its copied history were spent by the session it came from.

## Permission Handling Mechanism

### Session Modes

A session runs in one of two modes, `default` or `yolo`, and each CLI is told
which one at startup and only there — Claude through its arguments, Codex through
the `approvalPolicy` / `sandbox` pair on `thread/start`, `thread/resume` and
`thread/fork`. `session.set_mode` therefore closes the running process instead of
retuning it. For Codex that now costs exactly a restart: the new process resumes
the same thread with the new pair, so the agent keeps the conversation
([Thread Recovery](#thread-recovery)). It used to cost the conversation with it,
which is the single largest thing the channel move bought
([Why the app-server Channel](#why-the-app-server-channel)). Codex could avoid even
the restart ([Deliberately Not Wired Up](#deliberately-not-wired-up)); doing so
would buy one agent a path the other cannot have.

| Mode | Claude | Codex |
|---|---|---|
| `default` | `--permission-prompt-tool stdio`, no allowlist | `approvalPolicy: on-request`, `sandbox: workspace-write` |
| `yolo` | adds `--permission-mode bypassPermissions` | `approvalPolicy: never`, `sandbox: danger-full-access` |

Read as a promise to the user, those two `default` cells say different things.
Claude's puts everything its own rules gate — file edits and commands among
them — in front of the user as a `PermissionRequestEvent`, since Pockode adds no
allowlist of its own. Codex's gates nothing inside its sandbox: the working
directory, `$TMPDIR` and `/tmp` are writable (checked on Linux, codex-cli
0.153.0) and work there simply happens. Only what the sandbox refuses — writing
outside those roots, reaching the network — can produce a prompt at all.

**That gap is now a choice, not a limit.** It used to be both: the MCP channel
rejected `untrusted` — the policy that asks before every command — outright, so
the wording here said the gap could not be closed. The app-server channel accepts
it, and it is a real gate rather than an after-the-fact escalation: asked to run
`touch SHOULD_NOT_EXIST` and declined, the file was **not created** (measured on
codex-cli 0.153.0). The schema the CLI generates lists `untrusted`, `on-request`,
`never` and a `granular` object.

The mapping stays where it was anyway, because the argument that decided it was
never a technical one: on a phone, tapping approve for every write of a multi-file
edit is not a safety feature, it is an unusable session. That applies to
`untrusted` exactly as it applied to a `read-only` sandbox. So `default` maps to
`on-request` + `workspace-write` — the pairing Codex itself runs by default, which
`codex doctor` reports as `approval policy OnRequest` with a restricted filesystem
and network sandbox — and "Codex changed files without asking" remains the
accepted cost of that trade. **What changed is why**: this is a difference Pockode
chooses knowing it could be removed, not one it cannot reach.

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
`acceptForSession`, which lasts as long as the thread and is not written anywhere
([Approvals](#approvals)).

## Process Management

### Starting the CLI

Every AI CLI launch goes through `agent.Command` (`server/agent/command.go`)
rather than `exec.Command`, because on Windows two things have to happen before
`Start` that `exec.Cmd` will not do.

**Resolving the binary cannot rely on `PATH` alone.** A process keeps the
environment it was started with, so the `PATH` entry an installer appends is
invisible to an already-running `pockode.exe` — the CLI exists, but the inherited
`PATH` predates it. `agent.Command` tries `PATH` first (whatever the user's
own shell would run is the right answer when it exists), then the directories the
CLI installers actually write to. When it still fails, the error names the CLI,
every directory that was searched, the need to restart Pockode, and — on Windows
— that a CLI installed inside WSL is not reachable from a Windows process. Naming
the search set is the point: without it "not found" is a conclusion the user
cannot check. The same lookup feeds the startup banner, so what the banner
reports and what a session gets are the same answer, not two implementations of
it.

**The command line has to be built by hand for `.cmd` wrappers.** `npm install
-g` installs the CLIs as batch files, and Windows runs a batch file by handing
the command line to `cmd.exe`. Go quotes arguments for `CommandLineToArgvW`,
which quotes only on spaces and tabs — so a path containing `&`, `^`, `(` or `)`
arrives at `cmd.exe` unquoted and is split at that character. Go documents this
as the caller's problem and does not intend to fix it, which is why it is fixed
here: `agent.Command` invokes `cmd.exe` explicitly, so that the behaviours a user
can change in the registry — AutoRun, command extensions, delayed expansion — are
pinned here rather than inherited, and quotes each argument for both parsers it
will cross. Arguments that quoting cannot make safe — a quote, a newline, a `%NAME%`
naming a variable that is actually defined — are rejected with an error that
names the offender, because handing the CLI a quietly different path is the worse
outcome. The string-building half lives in `agent/cmdline.go`, deliberately
platform-independent so it can be tested everywhere rather than only on a Windows
runner.

Both halves are the same code path for every caller. A short probe that has to
be abandonable — `codex --help` behind a timeout — uses `agent.CommandContext`,
which is `agent.Command` plus a context; a session process uses
`agent.StartProcess`, which owns its own lifecycle (below).

`server/AGENTS.md` carries this as a rule: start an AI CLI through that path,
never `exec.Command`. `lookupBinary` is unexported for the same reason —
resolving a path separately and then calling `exec.Command` on it would bypass
exactly the quoting that the resolved path determines.

### Subprocess Lifecycle

`agent.Process` (`server/agent/process.go`) wraps the CLI subprocess. Both agent
implementations go through it instead of using `exec.Cmd` directly, because an
AI CLI is never a single process:

- It spawns processes of its own — shell commands it runs, MCP servers it starts.
- On Windows npm installs `claude` as `claude.cmd`, so the direct child is the
  `cmd.exe` invoked above and the real node process is a grandchild.

Two consequences follow, and `exec.Cmd` handles neither on its own.

**Killing the child is not killing the tree.** Terminating only the direct child
leaves the rest running: sessions never end, goroutines leak, and the worktree
cannot be removed because orphans still hold files in it. `Process` therefore
tracks the whole tree from the start:

| Platform | Mechanism |
|----------|-----------|
| Unix | The child leads its own process group (`Setpgid`); termination signals the group |
| Windows | The child is assigned to a Job Object; termination calls `TerminateJobObject` |

The agent side asks for `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` as well
(`proctree.KillOnClose`), so if the server itself dies the OS tears the tree down
instead of leaving orphans behind. A session outlives the call that started it,
and a crash leaves nothing to terminate it.

Both mechanisms live in `server/internal/proctree`, not in `agent`: an AI CLI is
not the only subprocess with descendants that have to go with it. A network
`git` spawns `git-remote-https`, `ssh` and credential helpers, and on Windows
that is how a timed-out `git` is stopped — see `server/git/terminate_windows.go`.
That caller does *not* ask for kill-on-close: it closes the tree after every
command, including the ones that succeeded, and a credential daemon git started
on purpose is not an orphan.

**Reaping must not depend on the pipes.** Descendants inherit the stdout and
stderr write ends, so those pipes do not reach EOF while any of them is alive.
`Cmd.StdoutPipe` must not be read after `Wait`, which forces callers into
"drain, then Wait" — and that deadlocks outright the moment one orphan survives:
the drain never finishes, so `Wait` is never reached. `Process` supplies its own
`os.Pipe` files instead, which keeps `Wait` dependent only on the direct child,
and reaps it concurrently with the drain:

```
Start ──┬─ reap goroutine:  Wait ─→ terminate tree ─→ close pipes
        └─ caller:          drain stdout ─→ OutputDone ─→ Wait
```

Once the direct child is reaped, anything still holding the pipes outlived it, so
the tree is terminated there too — that is what lets the caller's drain finish.
A backstop closes the pipes a few seconds later regardless, covering a descendant
that escaped the tree entirely (e.g. by starting a new session).

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
- Agents can announce the same end twice — Claude acknowledges an interrupt with
  a `control_response` and then ends the same turn again with an aborted `result`
  — and a second idle reads downstream as a second stop.

#### A Prompt Belongs to the Process That Raised It

A message starts a process when the session has none; an answer does not.
`chat.Client` sends permission and question responses only to a process that is
already there (`chat.Client.liveProcess`), and reports `ErrSessionNotRunning`
otherwise. That is not caution on Pockode's part, it is the shape of the
transport. A prompt is a request still in flight on the process's own stdio
connection, addressed by an id that only that connection ever issued:

| CLI | How the prompt arrives | How an answer is addressed |
|---|---|---|
| Claude | `control_request` | `control_response` carrying the same `request_id`, matched against the session's own pending-request map |
| Codex | MCP `elicitation/create` | a JSON-RPC response to that request's id on the same connection |

Neither id outlives the connection that issued it, and nothing replays an
in-flight request into a later process — so an answer has exactly one possible
recipient, and it is a live one. Starting a process to take an answer therefore
delivers it nowhere and leaves that process running with no turn to end it. An
interrupt in the same situation succeeds silently: nothing to stop is what the
caller wanted.

A prompt can therefore outlive the only thing that could answer it — replayed
from history after a restart, with the card still on screen. Two rules elsewhere
exist to keep that window as narrow as the premise allows, and they point in
opposite directions for the same reason:

- **While the server runs, Pockode does not take the process away itself.** The
  idle reaper spares a process paused on a prompt and gives that hold no time
  budget ([Idle Timeout Cleanup](#idle-timeout-cleanup)), because only that
  process can still take the answer. A CLI that dies on its own still ends the
  session, and the card with it — but that is the CLI's doing, not a card
  expired by a timer nobody asked for.
- **Across a restart, the work is not kept waiting.** Startup stops
  `needs_input` work instead of preserving it
  ([work-system.md](work-system.md#triggers), Trigger C): the process is gone,
  so the question is gone, and the status would be promising a resumption that
  cannot arrive.

**Both rules stand on this premise and have to be revisited if it changes.** The
change to watch for is a CLI re-offering its outstanding prompts to a resumed
session, or accepting an answer addressed by something more durable than a live
request id. Either one turns the reaper's unbounded hold into a plain resource
leak — the process would no longer be the only way back to the question — and
turns a `needs_input` work preserved across a restart from a lie into the correct
answer. Neither rule has a second reason to fall back on, which is why the
premise is written down once here instead of being re-derived at each of them.

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
            if now.Sub(proc.lastActive) > idleTimeout && proc.reapHold() == "" {
                proc.agentSession.Close()
                delete(processes, sessionID)
            }
        }
    }
}
```

**Design Decision**: Check frequency is 1/4 of timeout duration, balancing response speed with CPU overhead.

The timeout is only half the rule. `lastActive` measures silence, and silence is
the normal condition of a wait, so on its own it says "abandoned" exactly when
collecting the process would destroy what it is waiting for. What the reaper
actually asks is `Process.reapHold`: the name of the thing this process is still
in the middle of, or `""` when it is in the middle of nothing.

Three things hold a process, checked most specific first because the name is
what gets logged:

- **Paused on an unanswered prompt** (`permission_request`, `ask_user_question`).
  Reaping one answers the agent's question by killing it, and no later process
  can make up for that: the prompt belongs to the process that raised it
  ([A Prompt Belongs to the Process That Raised It](#a-prompt-belongs-to-the-process-that-raised-it)).

  The predicate is `Process.awaitingUserAnswer`, which tracks the outstanding
  answer separately from the turn rather than reading it off `turnEnded`. The
  two come apart in both directions — an agent can withdraw a prompt without
  ending the turn, which the frontend shows as a card moving from `pending` to
  `expired`, and a prompt raised after a turn has reported its end outlives that
  turn. Which flag answers which question is worked out at
  `Process.promptPending`.
- **Waiting on background work** — a turn held open for background tasks, which
  would be killed with the process; see [Background Waits](#background-waits).
- **A turn in progress** — the state is not a reported idle (`state != idle` or
  `!turnEnded`). This is the hold that does the most work, and the one that had
  to be written: a turn can run for minutes without producing a single event —
  one `Bash` call around a build or a test suite is enough — and to `lastActive`
  that is indistinguishable from a session nobody came back to. Requiring the
  turn's own report of having ended is what keeps "quiet" from passing for
  "done".

  It is also the widest, and it comes close enough to covering the other two
  that the gaps are worth stating: a prompt raised after its turn already
  reported an end has no turn behind it and is held by the prompt check alone.
  So the earlier checks are not prettier labels for cases this one would catch
  anyway — dropping one can cost a session rather than a log line. Which check
  covers which case is worked out at `Process.reapHold`.

None of the three holds has a time budget, and none can: a build outruns any
timeout worth setting and a person outruns it by more. Each ends when the session
itself moves on — the turn reports its end, the agent gives up on its background
tasks, the prompt is answered or withdrawn.

So a process outlives the timeout whenever the session never moves on: a session
left on an unanswered question keeps its process for as long as the server runs,
and so does a CLI that stays alive without ever ending its turn. Both are
deliberate. The alternative to the first is a prompt on screen that answers
`ErrSessionNotRunning`
([the premise above](#a-prompt-belongs-to-the-process-that-raised-it));
the alternative to the second is killing builds, and nothing distinguishes a slow
turn from a stuck one from outside. A CLI that actually dies closes its event
stream, which ends the process through the ordinary path rather than the reaper.

Because the holds carry the whole rule, the timeout itself only has to answer
"how long may a session that is in the middle of nothing keep a CLI alive?", and
the answer is short: `--idle-timeout` defaults to **5m**. A reaped process costs
the next message a resume, and nothing else — history lives in the store, and
`process_ended` reaches the client either way. What it costs the *work* bound to
that session is the other half of this story, and the short version is "nothing
it was not already exposed to": a reaped process is an ordinary process death, so
it stops `in_progress` work and leaves paused work alone
([work-system.md](work-system.md#triggers), Trigger A). That rule and this one are
written against each other — narrowing what a death stops is only safe because
the holds keep the reaper off the sessions somebody is waiting on, and the holds
are only affordable because a reaped session is cheap to resume.

`--idle-timeout=0` turns reaping off rather than reaping everything — worth
saying because the literal reading is the opposite one: every process is older
than a zero timeout the instant it is created. An operator who writes zero means
"never", and `Manager.reapingDisabled` is the single place that reading is
written down, asked by both the ticker and the reaping rule.

## Session Management

### Session Metadata

```go
// session/types.go
type SessionMeta struct {
    ID         string
    Title      string
    Activated  bool        // True once the agent has produced output
    AgentType  AgentType   // claude, codex
    Mode       Mode        // default, yolo
    Model      string      // agent-specific model id; empty = CLI decides
    Effort     string      // agent-specific reasoning effort; empty = CLI decides
    NeedsInput bool        // Awaiting user permission/question response
    Unread     bool        // Has unread changes
    ForkedFrom *ForkOrigin // Set on a fork, naming the session it came from
    Usage      Usage       // Tokens and cost, as the agent reported them
}
```

`Unread` is set by every idle the session reports while nobody is viewing it,
including the initial idle a process emits the moment it is created — so simply
building a process marks the session unread, whether or not the agent said
anything. `StateChangeEvent.IsInitial` distinguishes that first idle, but only
`work.AutoResumer` reads it. Noted rather than fixed: what "unread" should mean
for a session that was merely started is a product question.

`Usage` is the one field here no user action sets and no RPC writes — it is
accumulated from what the CLI reports, and [Usage
Reporting](#usage-reporting) covers how.

### Session Models

Each session carries its own model, and the choices are per agent — Claude takes
aliases (`opus`, `sonnet`, …), Codex takes slugs (`gpt-5.6-sol`, …). Neither CLI
can list its models, so `session/model.go` holds the list by hand and is the
only place it exists: `session.models` answers the UI from it and
`session.set_model` validates against it, so the UI can never offer a choice the
server would then reject. It needs a manual update whenever an agent retires a
model.

The one other source that exists is Codex's own catalog cache
(`~/.codex/models_cache.json`, whose `visibility: "list"` entries are exactly
what a picker should show). It was rejected: an undocumented internal file that
a fresh or logged-out install may not have, and Claude has no counterpart — so
the hand-written list has to exist either way, and reading the cache would only
add a second source that can disagree with it. If Codex's models start turning
over fast enough to make the manual list a burden, that cache is the first thing
to reach for.

An empty model means *pass no model flag* — the CLI picks for itself. It is
where a new session starts unless whoever creates it names a model: the global
default in Settings names one for every session created from scratch, and a
session started for a work item can take the agent role's instead ([Role Engine
to Session Engine](../projects/workflow-engine.md#role-engine-to-session-engine)).
Since the field simply did not exist before, it is also the value every older
session already reads as, so no migration was needed.

The same lists judge the engines chosen *outside* a session — an agent role's,
and the global defaults — through `session.ValidateEngine`, which takes agent,
model and effort as one trio, so a combination refused in one of those places is
refused in the other. A session checks the two lists one at a time instead: its
agent type is settled by the time it is created, and `session.set_model` /
`session.set_effort` each change a single value and answer with
`ErrModelNotAvailable` / `ErrEffortNotAvailable`. Judging the global defaults as
a trio is what makes them refused as a whole rather than half-applied, and that
is why a client changing the default agent sends an emptied model and effort with
it: `settings.update` carries the whole settings object, so a model picked for
the previous agent would otherwise come back with the write and be rejected.

Like the mode, the model is only read when a CLI is launched: Claude gets
`--model` in its arguments, Codex gets `model` on whichever of `thread/start`,
`thread/resume` or `thread/fork` opens its thread. `session.set_model` therefore
closes the running process, at the same cost for Codex as a mode change (see
[Session Modes](#session-modes)).

A session that has already started can still change its model, unlike its
[agent type](#activation), because nothing outside the next launch is keyed to
it: each agent's resume file is written per session, not per model, so the session
resumes across the change with its context intact. That now holds for Codex too —
its thread is keyed by nothing the model touches.

Switching agents drops a model the new agent does not have, rather than trying
to map it — no model is shared between agents. Both halves of that invariant
live in the store: `SetAgentType` clears a model the new agent cannot run, and
`SetModel` refuses one, judged against the agent type while the store lock holds
it still. An RPC handler that checked first would be racing the other call, and
it would have to kill the session's process before finding out the request was
invalid. So `session.set_model` writes to the store first and closes the process
only once that write is accepted — the reverse of `session.set_mode`, which has
nothing to reject and closes first.

### Session Effort

How much reasoning an agent spends before answering is carried exactly like the
model: per session, agent-specific, read only at launch, and kept in a
hand-written list (`session/effort.go`) that is the single source both
`session.efforts` and `session.set_effort` read — so the UI can only offer what
the server would accept. Empty means *pass nothing, let the CLI keep its own
default* and, like the empty model, needed no migration. Everything
[Session Models](#session-models) argues for that shape holds here unchanged,
down to writing the store before closing the process so a refused level costs
nobody their running CLI. Four things are its own.

**Neither CLI refuses a level it does not understand, so the server must.**
Claude answers an unknown `--effort` with a single warning line and then runs the
turn at its default; Codex does not inspect the value at all and hands it to the
API's `reasoning.effort`. So `IsValidEffort` is not the belt-and-braces it looks
like next to `IsValidModel`: a level it let through would not fail anywhere
downstream — it would run the turn at something the user did not choose and say
nothing.

**Codex receives it as a config override rather than an argument.** The thread
parameters have no effort field at all — checked against the protocol schema the
CLI generates — so the level rides in as a `config` override under
`model_reasoning_effort`, the key `config.toml` uses for the same setting. Claude
simply takes `--effort`.

**The levels belong to the agent, not to the model.** Claude's `--effort` is a
session flag whose accepted set does not vary with the model, and every model in
`session/model.go`'s Codex list answered an invalid level with the same accepted
set, so there is no per-model variation to encode. Should a model narrow its set
later, the refusal comes from the API at the point of use and reaches the user as
a real error — whereas the alternative is maintaining by hand a model-by-level
matrix neither CLI publishes. Hence switching agent resets a level the new agent
does not offer, the way it drops an unusable model, while switching model leaves
the level alone.

**An agent with no effort concept has no list at all, rather than an empty one.**
That absence is the answer the UI needs: it distinguishes *this agent has nothing
to offer* from *the list has not arrived*, and the empty effort stays valid for
such an agent so nothing has to special-case it.

Neither accepted set comes from a stable published source: Claude's is the
parenthetical in its own `--help`, Codex's is the enum the API names when it
refuses an invalid level. Both will drift with upstream, so `effort.go` records
which CLI version each was read from and how — that is what makes the list
checkable again later instead of merely re-guessable. One level the API accepts
is deliberately left out of the Codex list (`none`): a coding agent asked not to
reason at all is not a choice worth offering.

### Activation

`Activated` marks a session as *started*, and three things read it:

- Claude's [recovery ladder](#session-recovery-ladder), which receives it as
  `StartOptions.Resume` — overridden for a forked session, whose transcript is
  [not a conversation of its own](#forking).
- `session.set_agent_type`, which refuses to switch a started session's backend.

Codex used to be a third reader, through the same field, to warn that a restarted
session had lost the agent's earlier turns. It no longer reads it at all: a thread
now survives its process, so whether the agent still remembers is answered by
whether the recorded thread reopens — a question `thread/resume` settles at the
one moment it matters ([Thread Recovery](#thread-recovery)) rather than something
to infer from activation.

It is set from the event stream — the first event answering
`ActivatesSession` — rather than when the process is created. Spawning a CLI
proves nothing about the session behind it, and the difference is the whole point
of the flag: a first message that dies before the agent says anything (expired
login, provider outage) leaves a session that never really started, and the user
should be able to point it at a different agent instead of retrying the broken one
forever. `process/manager.go` owns the write because the event stream passes
through it already, next to the history append.

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

The frontend disables the agent half of the engine selector on the same flag,
which reaches it through `session.detail` — the session list does not carry it,
having no row to draw with it. Using the transcript instead
(`messages.length > 0`) looks equivalent and is not: a failed first turn leaves a
user message and an error behind, so the selector would stay disabled in exactly
the situation it is meant to rescue.

### History Storage

History is stored in JSON Lines format, one `EventRecord` per line:

```
<dataDir>/sessions/<sessionID>/history.jsonl
```

This format facilitates append-only writes and streaming reads.

Binary content an agent delivered inside its output is written beside it, in
`sessions/<sessionID>/attachments/`, and named from the record by id — that is
what keeps a line holding an image small enough to replay on every page. What
goes there, what only gets described, and what a fork does with it are in
[Content Blocks and Attachments](#content-blocks-and-attachments).

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

**Naming a record.** A client that needs to point at one record — forking is so
far the only caller — quotes back a `session.HistorySeq`: the record's 1-based
position in what `GetHistory` returns. The server hands the number out, on
replayed history (`StampHistorySeq`) and on every `chat.*` notification of a
persisted event alike, and the client only ever reads it back.

**Counting records client-side is the trap the number exists to close.**
`chat.Client.SendPermissionResponse` and `SendQuestionResponse` append to history
without broadcasting, so a client's own counter drifts by one for every
permission or question answered in the session — silently, and a fork would then
cut somewhere the user never chose. For the same reason the seqs a client knows
are sparse, which is harmless: it can only anchor on a record it has seen.
Broadcasting those responses to fill the gaps would trade a harmless hole for a
real one.

Sequence numbers are stamped on the way out and never written to the file. A seq
is a record's address in one session's history, not part of what happened, and a
stored one would be copied into a fork and go on naming a position it no longer
holds. Nothing is lost by not storing them: the counter is seeded by counting the
records already in the file, so numbering picks up where it left off across
restarts. The one record carrying a seq of its own is the synthetic warning
`GetHistory` appends when the file was damaged: `NoHistorySeq` (0), "not
addressable", because it is in no file and the next real append takes the
position it would otherwise appear to hold.

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
neither. Codex is the only agent that has any — the subcommand probe, and the
handshake plus opening the thread ([Startup](#startup)); Claude's `Start` spawns
and returns.

Those bounds are also a promise to the client. `chat.message` runs this path, and
so does `work.start`, whose kickoff (or restart) message goes out the same way and
is awaited before the work item's reply; both are given a client timeout sized
from the sum of these bounds
([Request Timeout](websocket-rpc.md#request-timeout)). A request that merely
queues behind the lock while a start drags on keeps the default clock, so there a
stalled start still surfaces as a plain timeout.

### Ending a Turn Exactly Once

Both agents promise exactly one `AwaitsUserInput` event per turn, and each gets
there differently.

Codex gets there for free: `turn/completed` is a notification the CLI sends once
per turn, and it is the only thing that produces an ending. Nothing has to be
correlated, because the ending is announced rather than inferred — which is what
the MCP channel could not do, where an aborted `tools/call` was simply never
answered and Pockode had to resolve the pending request itself. The one rule left
is that a `turn/completed` Pockode cannot parse still ends the turn: a turn left
pending waits for an event that is never coming.

An interrupt does not end a turn by itself. `turn/interrupt` asks, and the turn's
own `turn/completed` — `status: "interrupted"` — is still what ends it. A turn
blocked on an approval is a separate case, since it is not reading its interrupt
at all; see [Approvals](#approvals).

**A stop can arrive before there is a turn to stop.** `turn/interrupt` has to name
a turn id, and that id arrives with `turn/started`, which trails the prompt by
however long the CLI takes to get going — measured at over two seconds on a loaded
machine, which is well inside the time a user takes to change their mind. A stop
in that window has nothing to name, so it is remembered and carried out by
`handleTurnStarted` on the turn it was meant for. It does not outlive that turn:
`turn/completed` clears it, because a turn that ended on its own leaves nothing to
stop and a stop carried forward would kill whatever the user sends next.

The turn id in the `turn/start` *reply* is deliberately not used for this, though
it is there. That reply is handled on a goroutine of its own, while every
`turn/started` and `turn/completed` arrives on the single reader — so adopting the
reply's id could put a finished turn back after `turn/completed` had cleared it,
and leave the session holding a turn that no longer exists.

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
- Process crash (`Process.Wait()` returns non-context error)
- A handshake that never completes, on either channel
- Critical I/O errors

## Code Paths

| Module | Path |
|--------|------|
| Agent interface | `server/agent/agent.go` |
| Event types | `server/agent/event.go` |
| Event serialization | `server/agent/history.go` |
| Subprocess lifecycle | `server/agent/process.go`, `server/internal/proctree/` |
| Claude implementation | `server/agent/claude/claude.go` |
| Claude background waits | `server/agent/claude/background_tasks.go`, `background_wait.go`, `background_loss.go` |
| Codex implementation | `server/agent/codex/codex.go` (process, JSON-RPC, thread lifecycle), `events.go` (notification mapping), `approval.go` (server requests), `resume.go` (`codex_resume.json`), `view_image.go` (the image an `imageView` item names) |
| Content blocks and attachments | `server/agent/content.go` (block shapes), `server/agent/claude/tool_result.go` (Claude's blocks), `server/attachments/attachments.go` (per-session store), `server/ws/rpc_attachment.go` (`attachment.get`), `web/src/lib/contentBlocks.ts`, `web/src/components/Chat/AttachmentStrip.tsx` |
| Session forking | `server/agent/fork.go`, `claude/fork.go`, `codex/fork.go` |
| Codex protocol drift check | `server/agent/codex/schema_integration_test.go` |
| Fork capability over the wire | `server/ws/rpc_agent.go`, `web/src/lib/rpc/agent.ts`, `web/src/hooks/useForkSupport.ts` |
| Chat client | `server/chat/client.go` |
| Process management | `server/process/manager.go` |
| Session storage | `server/session/store.go` |
| Usage collection | `server/agent/usage.go`, `server/agent/claude/usage.go`, `server/agent/codex/usage.go` |
| Session usage record | `server/session/usage.go` |
| RPC Handler | `server/ws/rpc_chat.go` |
