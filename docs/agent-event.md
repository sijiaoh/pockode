# Agent Event

The agent event system is the structured event stream that represents all output from an AI agent (Claude, Codex, etc.) to the user. Events are the single source of truth for agent communication — they are created during CLI output parsing, persisted to session history, broadcast over WebSocket, and rendered in the UI.

## Data Flow

```
AI CLI (stdout)
  → streamOutput (line-by-line JSON parsing)
    → AgentEvent channel (unbuffered)
      → Process.streamEvents
          ├─ Persist: store.AppendToHistory (EventRecord) — skipped for a
          │           non-persisted type, which is broadcast only
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

`server/agent/event.go` — Sealed interface (unexported marker method) with 18 concrete implementations.

**There are 20 `EventType` constants and 18 event structs, and the gap is the
point.** `ask_user_question` and `question_response` are types nothing can
produce any more, kept because old transcripts hold records of them and a reader
of history still has to recognise one (see Legacy below). A type with no event
behind it is exactly what "read, never written" looks like in Go.

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
| Progress | `tool_activity` (broadcast only, never recorded) | No |
| Wait | `background_wait` (the turn parked on work outliving its tool call) | No |
| Terminal | `done`, `interrupted`, `error`, `process_ended` | Yes |
| Permission | `permission_request`, `permission_response`, `request_cancelled` | No |
| Question | `question_posted` (`request_cancelled` withdraws one; the answer is a `message`) | No |
| Legacy | `ask_user_question`, `question_response` — read from old transcripts, never written | No |
| Message | `message` (user-typed or system-driven; persisted + broadcast) | No |

Terminal events end the current message response. Non-terminal events are appended to the active assistant message.

"Terminal" above is about the message shown to the user. The state layer asks
four different questions of the same types — `Persisted`, `AwaitsUserInput`,
`IndicatesAgentActivity` and `ActivatesSession` — and they are neither complements
nor the same split as this table, so a new event type has to answer all four
explicitly. Three are allowlists and `Persisted` is a denylist, which is
deliberate: see [What an Event Says About Process
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

`tool_activity` is the one thing that answers both halves and so is the exception
that shows where the line really is. What a running tool call is doing right now
is a latest value — a snapshot of it in a transcript is wrong the moment the next
one arrives — yet it has to reach every subscriber the instant it happens, which
is the broadcast half of being an event. So it is an event that is **broadcast
and never recorded** (`EventType.Persisted`), and the process keeps the newest one
per call still in flight as the state it also is, to hand to a client that
subscribes mid-run ([tool-call-model.md](tool-call-model.md#tool_activity-is-not-persisted)).
An unpersisted event carries no `seq`, which is exactly what the broadcast rule
below already said about a record that does not exist.

#### Message Origin (user vs. system)

The `message` event covers both messages a user types and the automatic prompts Pockode itself sends to drive an agent (kickoff, restart, auto-continue, step-advance, reopen, child-completion — today all produced by the Work system). They travel the same persistence + broadcast path but must render differently, so the event carries an origin instead of introducing a separate event type:

| Field | Meaning |
|-------|---------|
| `Origin` | `""`/`"user"` = user-typed; `"system"` = Pockode system automation (currently the Work system); `"agent"` = another agent's answer to a posted question (`question_answer`) |
| `Subtype` | For system messages, which prompt produced it (`kickoff`, `restart`, …) |
| `Meta` | For system messages, a `{work_id, work_type, title, step?, child?}` summary the UI renders from instead of the prompt body |

**Why an origin field, not a new `EventType`**: user and system messages are the same kind of thing — text sent to the agent on stdin, replayed identically on resume. A distinct event type would fork the send/persist/replay path for no behavioral gain. All three fields are `omitempty`, so history written before they existed loads as a plain user message — backward compatible by omission. The producing side (subtype catalog, tagging call sites, and legacy-value normalization) and how the frontend renders the result are documented in [code/work-system.md](code/work-system.md#work-messages-in-chat).

#### Questions and Their Answers

A question an agent asks is a `question_posted` record; the answer is not a
record of its own but part of the `message` that carries it, in `answering`. One
question per record and one `request_id` per question — an answer names a
question and so does a refusal to answer one, so a record covering three
questions leaves "I will not answer the second" with no subject. The mechanism is
[code/agent-integration.md § Posted
Questions](code/agent-integration.md#posted-questions).

An `answering` entry keeps the option labels the user picked and what they wrote
themselves in **separate fields** — `answers` and `text`:

```jsonc
{ "type": "message", "content": "Answering:\n\nQ: Which database?\nA: Postgres",
  "answering": [ { "request_id": "...", "header": "Database", "question": "Which database?",
                   "answers": ["Postgres"],        // labels the question offered, and only those
                   "text": "and SQLite in tests",  // the user's own words: Other, or a free-text answer
                   "declined": false, "note": "", "answered_at": "RFC3339" } ] }
```

**Two fields rather than one list, because the agent has to be able to tell them
apart.** A label is the agent's own word handed back to it, and the server checks
every one of them against the question it answers — a label nobody was offered
would read in the transcript as an option the agent had given. Free text is under
no such rule: it is what the user said, recorded as such. Folding the two into
one list would make the check meaningless, since any string could then claim to
be a label.

What reaches the CLI is the `content` string alone; `answering` is Pockode's own
structure and is never sent. So the prose has to say in words what the record
says structurally, and it does — free text is written as *"and, in their own
words: …"* rather than beside the labels unmarked
(`web/src/utils/answerMessage.ts`).

An entry also carries `resolved_by` — `{"kind": "user"}`, or `{"kind": "agent",
"work_id": "...", "title": "..."}` when another agent answered through
`question_answer`. It is a field rather than an inference because it used to be
one: while only a person could answer, the *record type* said who — an `answering`
entry meant the user and a `request_cancelled` record meant the agent. Absent on
records written before that stopped being true, which were all the user's. A
message carrying an agent's answers is itself marked `"origin": "agent"`, for the
same reason in the other direction: a reader must not take it for something the
user said.

#### Legacy: `ask_user_question` and `question_response`

Transcripts written before Pockode stopped letting a CLI ask its own blocking
question still hold these two, and both are **read, never written**. The client
renders an `ask_user_question` record through the same card a `question_posted`
gets — one card per question, since a legacy record could carry several under one
`request_id` — and a `question_response` naming that id settles them.

`question_response` carries an `answers` object, a `map[string]string`: one entry per
question, keyed by the question text, whose value is the labels picked joined with
`", "` plus a trailing `Other: <free text>` entry. The client parses that string
back into the two halves a card draws (`web/src/utils/questionAnswer.ts`), which
is why the parser is still there. A `nil` map means the CLI cancelled the question
instead, and it arrives as an **absent key rather than `null`** — the field was
written `omitempty`, and that was right: `EventRecord` is one flat struct
shared by every event type, so dropping it would have put `"answers": null` on
every text and tool record ever written.

A legacy card that nothing settled stays `pending` and says so in words: the
process that was holding its tool call open is long gone, so there is no way to
answer it and the card offers none.

### EventRecord (Serialization)

`server/agent/history.go` — Flat struct used for both persistence and wire format. Each event type populates only its relevant fields; the rest are zero-valued and omitted from JSON.

Key fields: `Type`, `Content`, `ToolName`, `ToolInput`, `ToolResult`, `Error`, `RequestID`, `PermissionSuggestions`, `Questions`, `Reason`, `AskedAt`, `ResolvedAt`, `Answering`, and (for system-driven `message` events) `Origin`, `Subtype`, `Meta`.

Two field-level decisions worth knowing before adding one — why `AskedAt` and
`ResolvedAt` are pointers, and why a field a record on disk carries (the legacy
`answers` map) need not be here at all — are with the struct itself, in
[code/agent-integration.md § EventRecord](code/agent-integration.md#eventrecord-unified-event-format).

A `tool_result` also uses `Subtype`, for the three kinds of result that are not
simply "what the call produced", and carries `DurationMs` / `ExitCode` when the
CLI reported them as figures. A `tool_activity` record — which exists on the wire
only — carries `Activity` and `OutputDelta`. What each means is
[tool-call-model.md](tool-call-model.md); the field-by-field notes are
[code/agent-integration.md](code/agent-integration.md#eventrecord-unified-event-format).

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
on `tool_use_id` — every entry below but the last, which is the one case where an
event folds into a part its own id does not name:

- `tool_result` merges into its `tool_call` part, carrying its content blocks
  with it — so a returned image is shown against the call that produced it
  rather than floating loose in the transcript, which is what the warning it
  replaces used to do.
- `permission_request` takes the place of its `tool_call` part too, and the
  reducer gives the row back when the engine reports on the call — the two CLIs
  do not agree on which of the call and the approval is announced first, and
  neither order may draw a row spinning beside a card that is waiting for a
  person ([code/frontend-state.md](code/frontend-state.md#tool-runs)).
- `tool_activity` updates the run it names and is dropped when there is none on
  screen. It never enters history, so replay has none of it, and a row is
  readable without it.
- `question_posted` takes the place of the `question_post` tool row, matched by
  position rather than by id: the record is written *during* that MCP call, so it
  necessarily falls between the call's `tool_call` and its `tool_result`. There is
  no id to join on — an MCP call reaches the server over HTTP and the CLI's
  `tool_use_id` is not in it. Missing the take-over costs two rows saying one
  thing, which is a degradation rather than an error.
- `ask_user_question` (legacy) takes the place of its `tool_call` part by id.
  Claude asked through a regular tool call, so one question arrived as
  `tool_call` → `ask_user_question` → `question_response` → `tool_result`; the
  cards render the questions and the answers, and the trailing `tool_result`
  matches no `tool_call` and is dropped as an orphan.
- `tool_call` **carrying `origin_tool_use_id`** folds into the part that *other*
  id names instead of drawing one of its own. Claude's `TaskOutput` is a call
  whose whole content is an earlier call's output, so a row of its own would sit
  a screenful below the work it describes with an opaque `task_id` as the only
  thing tying the two together. Two things are unique to it: it is matched on
  someone else's id, and it is the only event that can fold into a part in an
  *earlier message* rather than the one being streamed. Its `tool_result`
  follows it there — the entry the fold leaves on the run is what gives a result
  naming a row that no longer exists somewhere to go. When the named part is not
  loaded the call falls through and draws an ordinary row, which is the common
  case rather than a fallback
  ([code/frontend-state.md](code/frontend-state.md#a-fetch-filed-under-the-call-it-reads)).

Blocks are read into a narrowed union at the wire boundary
(`web/src/lib/contentBlocks.ts`), where one the client cannot read is dropped
rather than half-rendered: the server forwards what it does not recognise as
text, so an unreadable block here means the two ends disagree about a version,
not that new content arrived.

A file block the result *is* — the screenshot a tool answered with — is drawn in
a strip under the tool's header line and *outside* the collapsible body, because
an answer folded behind a chevron has not been shown. A block marked
`not_fetched` is not that: nobody read it, so it is a pointer at a file rather
than an answer, and it is drawn beside the result inside the body
(`partitionFileBlocks`, [tool-call-ui.md](tool-call-ui.md#the-body-problems-2-and-3)).
The body keeps the prose — and opens whether or not there is any: a tool row's
chevron is unconditional, because there is always at least the invocation to
show ([tool-call-ui.md](tool-call-ui.md#the-row)).
Content is fetched only once the strip scrolls into view, so paging back through
a long session does not pull every image in it, and it is rendered through the
same `FileContent` states the Files tab uses — which is why a decode failure, a
file too large to send and a binary read the same in both places.

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
