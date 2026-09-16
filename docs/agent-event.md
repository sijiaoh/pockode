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

A tool result holding something that is not prose — the image a tool returned,
the document a read delivered — travels as blocks ([below](#eventrecord-serialization)),
and a file block names its content instead of carrying it. The content is
therefore a second request, made when the UI has somewhere to draw it:

```
UI (attachment strip scrolled into view)
  → attachment.get {session_id, id}
    → contents.GetContents(<dataDir>/sessions/<id>/attachments)
      → FileContent (base64) → the same file viewer the Files tab renders with
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
| Message | `message` (user-typed or system-driven; persisted + broadcast) | No |

Terminal events end the current message response. Non-terminal events are appended to the active assistant message.

"Terminal" above is about the message shown to the user. The state layer asks
three different questions of the same types — `AwaitsUserInput`,
`IndicatesAgentActivity` and `ActivatesSession` — and they are neither complements
nor the same split as this table, so a new event type has to answer all three
explicitly. See [What an Event Says About Process
State](code/agent-integration.md#what-an-event-says-about-process-state).

#### What Is Not an Event

Not everything a CLI frame carries belongs in the stream. Token counts, cost and
context size arrive on frames the parser reads — Claude's `result`, Codex's
`thread/tokenUsage/updated` — and are deliberately routed around it: an event is a
fixed record of one moment, persisted and broadcast, while a running total is state
the session store owns and every reader has to see the current value of. Putting
the total in the stream would write a figure into the transcript that the next turn
makes wrong. Codex's usage notification is therefore handled by an explicit case
that feeds the usage observer and emits nothing — not by the ignore list, which is
for notifications Pockode has no surface for yet. See
[Usage Reporting](code/agent-integration.md#usage-reporting).

The same test applies to anything new: if a later reader needs *the latest* value,
it is state and needs an owner; if it needs *what happened*, it is an event.

#### Message Origin (user vs. system)

The `message` event covers both messages a user types and the automatic prompts Pockode itself sends to drive an agent (kickoff, restart, auto-continue, step-advance, reopen, child-completion — today all produced by the Work system). They travel the same persistence + broadcast path but must render differently, so the event carries an origin instead of introducing a separate event type:

| Field | Meaning |
|-------|---------|
| `Origin` | `""`/`"user"` = user-typed; `"system"` = Pockode system automation (currently the Work system) |
| `Subtype` | For system messages, which prompt produced it (`kickoff`, `restart`, …) |
| `Meta` | For system messages, a `{work_id, work_type, title, step?, child?}` summary the UI renders from instead of the prompt body |

**Why an origin field, not a new `EventType`**: user and system messages are the same kind of thing — text sent to the agent on stdin, replayed identically on resume. A distinct event type would fork the send/persist/replay path for no behavioral gain. All three fields are `omitempty`, so history written before they existed loads as a plain user message — backward compatible by omission. The producing side (subtype catalog, tagging call sites, and legacy-value normalization) and how the frontend renders the result are documented in [code/work-system.md](code/work-system.md#work-messages-in-chat).

#### Question Answers (`question_response`)

`Answers` is a `map[string]string` — one entry per question, keyed by the question text, whose value is the chosen option labels joined with `", "`, plus a trailing `Other: <free text>` entry when the user typed one. A `nil` map means the user cancelled instead of answering.

**A cancelled question reaches consumers as an absent `answers` key, not as `null`.** The `chat.question_response` RPC that submits an answer does spell cancellation as an explicit `null`, but the record written from it does not: `Answers` is `omitempty`, so a nil map drops the key entirely. And the record is all any consumer ever sees — unlike the events streamed from the agent, `question_response` is only persisted, never broadcast, so it surfaces on the replay path alone. Code that tests only for `null` therefore misses cancellation entirely and shows the question as answered. The `omitempty` stays despite that sharp edge: `EventRecord` is one flat struct shared by every event type, so dropping it would put `"answers": null` on every text and tool record, while history already on disk would keep the omitted form regardless. Absence is unambiguous because the map carries one entry per question — a card with questions to answer cannot produce the empty map that would serialize identically.

The value string is not only a display form: it is handed to the CLI as-is (merged back into the original tool input, see [code/agent-integration.md](code/agent-integration.md#bidirectional-communication)) and it is the only trace history keeps. An answered card re-renders the same form, disabled, with the user's picks highlighted — and on the replay path that string is all it has to reconstruct them from.

So the frontend parses the string back into selections (`web/src/utils/questionAnswer.ts`) rather than persisting a structured copy beside it: the copy would be missing on exactly the replay path that needs it, and one answer with two representations can disagree with itself. The price is that the join is load-bearing rather than cosmetic, and it cannot be undone by splitting on `", "` — option labels may contain commas and free text usually does. That is why formatting and parsing live in one module, held together by a round-trip test.

### EventRecord (Serialization)

`server/agent/history.go` — Flat struct used for both persistence and wire format. Each event type populates only its relevant fields; the rest are zero-valued and omitted from JSON.

Key fields: `Type`, `Content`, `ToolName`, `ToolInput`, `ToolResult`, `Error`, `RequestID`, `PermissionSuggestions`, `Questions`, `Answers`, and (for system-driven `message` events) `Origin`, `Subtype`, `Meta`.

`Contents` and `ToolResult` are one field in two shapes, and a `tool_result`
record fills exactly one of them. A tool result that is nothing but prose fills
`ToolResult`; one holding anything else — the image a read returned, the
document a PDF read delivered, the tools a search named — fills `Contents` with
ordered blocks instead, one per piece, in the agent's own order. The blocks then
hold the whole result, its prose included: lifting the text back out into
`ToolResult` would lose where it sat relative to the files, and a PDF read is
exactly a line of text followed by the document.

A file block describes its content — name, MIME type, size, an image's
dimensions — and names it by id; it never carries it. That follows the same rule
the rest of the record does: a record is replayed with every page of scrollback,
so an image written into one would be re-sent for as long as the session
exists. Where the bytes live instead, why the two agents' very different
deliveries (Claude hands over content, Codex hands over a path) are made one
before they reach here, and what a fork has to do about it are in
[code/agent-integration.md](code/agent-integration.md#content-blocks-and-attachments).

### Event Parsing

Each backend maps its CLI's output to this event set: `server/agent/claude/claude.go`
scans stream-json line-by-line (`streamOutput()` → `parseLine()`), and
`server/agent/codex/events.go` maps the app-server channel's JSON-RPC
notifications — thread items and turn boundaries — onto the same set.

Both parsers forward only what they recognise. The CLIs emit far more than Pockode
can render and both keep adding types, so each parser also names the types it
drops on purpose, leaving its default branch to mean "never seen before" and log
accordingly. The per-CLI mapping tables, the CLI versions they were derived from,
and the reasoning behind each drop live in
[code/agent-integration.md](code/agent-integration.md#protocol-baselines) — they
change whenever the CLIs do, so they are documented once, next to the code that
owns them.

### Broadcasting

`server/watch/chat_messages.go` — `ChatMessagesWatcher` implements `process.ChatMessageListener`. Receives already-persisted events (persistence happens in `ProcessManager.streamEvents()` via `store.AppendToHistory`), converts them to `EventRecord` via `ToRecord()`, then broadcasts JSON-RPC notifications with method `"chat.<event-type>"` and the subscription ID for client-side routing. Each notification also carries the record's `seq`, the same address a history page carries on its records ([paging](agent-chat.md#history-paging)), so a client cannot tell a replayed record from a live one when it names a point in the conversation ([code/agent-integration.md](code/agent-integration.md#history-storage)). Events that were not persisted carry none.

A user message is broadcast to every subscriber except the tab that sent it, which has already echoed the message into its own transcript. That tab therefore learns its own record's address from a third source — the reply to the `chat.message` call it made (`rpc.MessageResult`), the only channel that reaches it. Replayed history, live notification and that reply all carry the same `seq`, so what a client can name does not depend on which of the three delivered the record. A message no record names stays unaddressable, and a client must not number it itself.

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

Events do not map one-to-one onto parts. Several events can describe the same
tool use, and the reducer folds them into the one part that renders it, matching
on `tool_use_id`:

- `tool_result` merges into its `tool_call` part, carrying its content blocks
  with it — so a returned image is shown against the call that produced it
  rather than floating loose in the transcript, which is what the warning it
  replaces used to do.
- `ask_user_question` takes the place of its `tool_call` part. Claude asks
  through a regular `AskUserQuestion` tool call, so one question arrives as
  `tool_call` → `ask_user_question` → `question_response` → `tool_result`. The
  question card renders the questions and the answers, and the trailing
  `tool_result` matches no `tool_call` and is dropped as an orphan.

Blocks are read into a narrowed union at the wire boundary
(`web/src/lib/contentBlocks.ts`), where one the client cannot read is dropped
rather than half-rendered: the server forwards what it does not recognise as
text, so an unreadable block here means the two ends disagree about a version,
not that new content arrived.

File blocks are drawn in a strip under the tool's header line and *outside* its
collapsible body — when a tool answers with a screenshot, the screenshot is the
answer, and an answer folded behind a chevron has not been shown. The body keeps
the prose, which is what the chevron is gated on: a call whose whole result is
an image has nothing left to expand. Content is fetched only once the strip
scrolls into view, so paging back through a long session does not pull every
image in it, and it is rendered through the same `FileContent` states the Files
tab uses — which is why a decode failure, a file too large to send and a binary
read the same in both places.

### Message Status Transitions

```
(first content event) → "streaming"
    → done           → "complete"
    → error          → "error"
    → interrupted    → "interrupted"
    → process_ended  → "interrupted"
```

### Subscription

`web/src/hooks/useChatMessages.ts` — Subscribes via `chat.messages.subscribe` RPC, receives the newest page of history, replays it through the reducer, then processes live notifications through the same pipeline. Earlier pages are fetched on demand as the user scrolls back and spliced in front of what is already there ([agent-chat.md](agent-chat.md#reading-a-page-on-the-client)).

## Key Files

| Layer | File | Role |
|-------|------|------|
| Backend | `server/agent/event.go` | Event interface and concrete types |
| Backend | `server/agent/history.go` | EventRecord serialization format |
| Backend | `server/agent/content.go` | Content block and file block shapes shared by both agents |
| Backend | `server/attachments/attachments.go` | Per-session store for content an event references by id |
| Backend | `server/ws/rpc_attachment.go` | `attachment.get` — serving that content to a client |
| Backend | `server/agent/claude/claude.go` | CLI output parsing and event emission |
| Backend | `server/process/manager.go` | Event distribution |
| Backend | `server/watch/chat_messages.go` | WebSocket broadcast to subscribers |
| Frontend | `web/src/types/message.ts` | Wire types and ContentPart definitions |
| Frontend | `web/src/lib/messageReducer.ts` | Event normalization and state reduction |
| Frontend | `web/src/lib/contentBlocks.ts` | Content block parsing at the wire boundary |
| Frontend | `web/src/hooks/useChatMessages.ts` | Subscription and history replay |
| Frontend | `web/src/lib/wsStore.ts` | WebSocket routing by subscription ID |
