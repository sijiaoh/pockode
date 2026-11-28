# Agent Event

The agent event system is the structured event stream that represents all output from an AI agent (Claude, Codex, etc.) to the user. Events are the single source of truth for agent communication — they are created during CLI output parsing, persisted to session history, broadcast over WebSocket, and rendered in the UI.

## Data Flow

```
AI CLI (stdout)
  → streamOutput (line-by-line JSON parsing)
    → AgentEvent channel (unbuffered)
      → Process.streamEvents
          └─ chatstream.Sequencer (one per worktree, locked per session;
             │  the chat client writes through it too)
             ├─ Append: store.AppendToHistory (agent.Record), then enqueue;
             │          Publish for an agent.LiveEvent, which is never stored
             │  (the append folds the record into projection.Live)
             → ChatMessagesWatcher.Enqueue (implements chatstream.Sink)
                 → Broadcast: what the record changed ("chat.update"),
                   or a live event's stream extended ("chat.delta")
                   → WebSocket → Frontend
                     → wsStore (route by subscription ID)
                       → useChatMessages → ChatItems (the items as sent)
                         → buildTranscript (items → Message[])
                           → UI render (ContentPart[])
```

A tool result holding something that is not prose — the image a tool returned,
the document a read delivered — travels as blocks ([below](#records-serialization)),
and a file block names its content instead of carrying it. The content is
therefore a second request, made when the UI has somewhere to draw it:

```
UI (attachment strip scrolled into view)
  → attachment.get {session_id, id}
    → contents.GetContents(<dataDir>/sessions/<id>/attachments)
      → FileContent → the same file viewer the Files tab renders with
        → a raster image (encoding "http"):
          GET /api/chat/attachments?session_id=&id= → the bytes
```

The description is small and comes over the WebSocket; an image's bytes come
over HTTP on a request of their own
([code/agent-integration.md](code/agent-integration.md#reading-it-back)).

## Backend

### AgentEvent Interface

`server/agent/event.go` — Sealed interface (unexported marker method) with 23 concrete implementations.

**There are 25 `EventType` constants and 23 event structs, and the gap is the
point.** `ask_user_question` and `question_response` are types nothing can
produce any more, kept because old transcripts hold records of them and a reader
of history still has to recognise one (see Legacy below). A type with no event
behind it is exactly what "read, never written" looks like in Go.

```go
type AgentEvent interface {
    EventType() EventType
    Encode() Wire // an agent.Record, or an agent.LiveEvent for a broadcast-only type
    isAgentEvent()
}
```

### Event Types

| Category | Types | Terminal? |
|----------|-------|-----------|
| Content | `text`, `tool_call`, `tool_result`, `thinking`, `plan`, `system`, `warning`, `raw`, `command_output` | No |
| Live | `tool_activity`, `thinking_delta` (an `agent.LiveEvent`: broadcast only, never recorded) | No |
| Wait | `background_wait` (the turn parked on work outliving its tool call) | No |
| Terminal | `done`, `interrupted`, `error`, `process_ended` | Yes |
| Permission | `permission_request`, `permission_response`, `request_cancelled` | No |
| Question | `question_posted` (`request_cancelled` withdraws one; the answer is a `message`) | No |
| Legacy | `ask_user_question`, `question_response` — read from old transcripts, never written | No |
| Message | `message` (user-typed or system-driven; persisted + broadcast) | No |
| Read point | `message_ingested` (the agent has taken in a message sent mid-turn) | No |
| Message ending | `message_discarded` (a Stop threw away a message the agent had not read) | No |
| Turn | `turn_started` (a turn opened; written by Pockode, never by an agent) | No |

Terminal events end the current message response. Non-terminal events are appended to the active assistant message.

"Terminal" above is about the message shown to the user. The state layer asks
four different questions of the same types — persisted (does it encode as a
record or a live event), `AwaitsUserInput`, `IndicatesAgentActivity` and
`ActivatesSession` — and they are neither complements nor the same split as this
table, so a new event type has to answer all four explicitly. Three are
allowlists, and the first is answered by the type itself: see [What an Event Says About Process
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
and never recorded** (an `agent.LiveEvent`), and the chat watcher keeps the
stream of each call still in flight as the state it also is, to hand to a client
that subscribes mid-run ([agent-chat.md](agent-chat.md#live-updates)).
An unpersisted event carries no `seq`, which is exactly what the broadcast rule
below already said about a record that does not exist.

#### Thinking

What the agent thought on the way is two events, because it is two things
([turn-progress-ui.md](turn-progress-ui.md)). That a stretch of thinking
happened, what it said and how long it took stays true, so it is a **recorded**
`thinking` event, written once the thinking is over. That the agent is thinking
*right now* lasts seconds and only changes the tail line's words, so it is
`thinking_delta`: **broadcast and never recorded**, the same exception
`tool_activity` is, and kept the same way: the chat watcher holds the thinking
so far until the record that settles it, so a client that subscribes
mid-thinking starts from the text already streamed
([agent-chat.md](agent-chat.md#live-updates)).

```jsonc
{ "type": "thinking",
  "content": "**Counting multiples**\n\n…",  // what was thought, for a reader; Markdown
  "full_reasoning": "…",                       // Codex's raw reasoning, when it shares any
  "redacted": true,                            // the provider withheld the text
  "duration_ms": 12000,                        // measured by the server; absent = not measured
  "parent_tool_use_id": "…" }                  // a subagent's, filed under its spawn

{ "type": "thinking_delta",                    // the main agent only, never a subagent
  "content_delta": "…",                        // the next piece of the coming `content`
  "full_reasoning_delta": "…" }                // …and of `full_reasoning`
```

Every field is optional. An empty thinking — a block with no text, a reasoning
item with nothing in either list — is still recorded, because *that the agent
thought, and for how long* is the part the reader came for. A `thinking_delta`
with neither delta is the signal alone: Claude streams no thinking text, only a
token estimate, and Codex's reasoning has started before its first words. The deltas accumulate,
and a new part already carries its paragraph separator, so concatenating them
gives exactly the text the record will hold. The live text is still
best-effort: a delta is the first thing dropped when a subscriber falls behind,
and a client that subscribed mid-thinking holds only a tail of it. The record is
what is kept. A live thinking ends with the next
main-agent `thinking` record or with the turn; a client also ends it on the
main agent's next text or tool call
([turn-progress-ui.md §2.3](turn-progress-ui.md#23-what-it-says)). The record carries no id joining
it to its deltas, because there is only ever one live thinking. A thinking the
engine never finished — Codex's, cut off by Stop — leaves no record at all.

**The duration is the server's measurement, never the client's.** A client only
has the moment a record reached it, which means nothing on a reload — the reason
a tool row's observed times are server stamps too
([tool-call-model.md](tool-call-model.md#observed-times-and-reported-durations)).
The server takes the reading while the thinking happens and stores
it: Codex's from the engine's own item timestamps, Claude's as the time from the
thread's last transcript output to the block. `0` is never written for a
measured thinking, so an absent `duration_ms` always means unmeasured. Neither
CLI sends thinking text unless asked, and how Pockode asks — gated on the
Claude CLI's version — is in
[code/agent-integration.md](code/agent-integration.md#thinking).

`thinking` is in `ActivatesSession`: only the model writes one, so the turn
reached it. `thinking_delta` is not. Claude's is a CLI estimate, and it sits
with `system` and `tool_activity` in the gap between the two predicates, the
gap that must not end a background wait.

#### Plan

The agent's plan is a **recorded** `plan` event: the checklist as the agent
stated it at one moment. It is never updated afterwards, and the newest one is
the current plan, which is why the turn tail's plan chip can read it without a
store ([turn-progress-ui.md §4.6](turn-progress-ui.md#46-the-plan-record)
defines the fields and the three producers: Codex's `turn/plan/updated`,
Claude's `TodoWrite`, and the server's fold of Claude's `TaskCreate` /
`TaskUpdate` / `TaskList`). The one part of it that is state, the Claude
adapter's fold of incremental task calls, lives in the adapter. Each record is
a snapshot of the fold, never the fold itself, and a process that resumes the
CLI's session seeds its fold from the newest snapshot record (§4.6 there says
when, and why that read-back is acceptable).

The four predicates, answered explicitly:

- **Persisted: yes** (`PlanRecord`). It is history, and a reload draws the plan from it.
- **`AwaitsUserInput`: no.** Nobody answers a plan.
- **`IndicatesAgentActivity`: yes.** It only arrives while the agent is working,
  so `plan` is in that allowlist's switch in `server/agent/event.go`.
- **`ActivatesSession`: no.** A Claude `plan` follows a tool result that
  already proves the turn reached the model, and a Codex one arrives inside a
  turn that has started. It must not end a background wait either, the same gap
  `tool_activity` sits in. So `agent.TurnInputOf` maps it to `SignalNoise`.

#### Message Origin (user vs. system)

The `message` event covers both messages a user types and the automatic prompts Pockode itself sends to drive an agent (kickoff, restart, auto-continue, step-advance, reopen, child-completion — today all produced by the Work system). They travel the same persistence + broadcast path but must render differently, so the event carries an origin instead of introducing a separate event type:

| Field | Meaning |
|-------|---------|
| `Origin` | `""`/`"user"` = user-typed; `"system"` = Pockode system automation (currently the Work system); `"agent"` = another agent's answer to a posted question (`question_answer`) |
| `Subtype` | For system messages, which prompt produced it (`kickoff`, `restart`, …, and a permission reviewer's `permission_review` / `permission_review_nudge`) — an `agent.MessageSubtype`, whose values the sending packages declare |
| `Meta` | For system messages, a `{work_id, work_type, title, step?, child?}` summary the UI renders from instead of the prompt body |

**Why an origin field, not a new `EventType`**: user and system messages are the same kind of thing — text sent to the agent on stdin, replayed identically on resume. A distinct event type would fork the send/persist/replay path for no behavioral gain. All three fields are `omitempty`, so history written before they existed loads as a plain user message — backward compatible by omission. The producing side (subtype catalog, tagging call sites, and legacy-value normalization) and how the frontend renders the result are documented in [code/work-system.md](code/work-system.md#work-messages-in-chat).

A [Pockode command](pockode-commands.md) is **not** a system message, though Pockode wrote the text the agent reads. The user sent it, so its origin is theirs: it forks, and it drives a work as a user message does. What marks it is a `command` field — `{name, args?}`, what the user typed — beside a `content` that holds the prompt the command expanded to. Like `answering`, it is a structured copy the client draws from, never sent to the CLI.

What a page in the chat sends on the reader's press (`chat.html_action`) is a user message the same way: origin user, it joins or opens a turn and drives a work, and it is refused while a permission request is open. What marks it is an `html_action` field — `{page, action, data}`, the card's page id, the action the page named and the JSON it put with it — beside a `content` the server wrote for the agent from it (`Page action "approve" from p3:` and the data on the next line). The client draws its bubble from `html_action` alone, and never turns it back into a draft ([tool-call-ui.md](tool-call-ui.md#the-action-message)).

A message can carry the files the user sent with it, in `attachments`: a list of the same file block a tool result uses (`name`, `mime`, `size`, `width`/`height`, `attachment_id`), described from the stored bytes and fetched through `attachment.get`. The record names each file by id only; how it reached the agent — inline, or by a path in the prompt — is the adapter's business and is not recorded ([code/agent-integration.md](code/agent-integration.md#files-the-user-sends)).

#### The Read Point (`message_ingested`)

A message sent while a turn is running is steered into that turn rather than
starting a second one, so one turn has one ending but any number of messages
inside it. The ending therefore cannot say which message the output belongs to,
and without a second signal a client has to guess — the guess it used to make
was that everything until the ending answered the *first* message, which put the
answer to a mid-turn question above the question.

`message_ingested` is that signal: the agent has taken in the message named by
`message_id`, so what follows the record answers that message. It is written
only for a message that arrived mid-turn — one that started its turn has nothing
above it to cut away — and it is a recorded event rather than live state, which
is what makes the split survive a reload, a resubscribe and a second device.

The two CLIs can say very different amounts about this, **and the difference
stops in the server**. Codex echoes a message back as a `userMessage` item when
it reads it, carrying the id Pockode sent with the turn (`clientUserMessageId`
→ `clientId`), so the record is written from the echo and the boundary is exact.
Claude reports nothing of the kind, so Pockode writes the record itself at the
moment of delivery — a little of what was already being written lands under the
new message, which is the conservative direction to be wrong in. Delivery is not
reading, though: a Stop can still discard a message the turn never folded in.
The record is not taken back — it says what Pockode believed then — and a
`message_discarded` record in the stopped turn says what became of the message
([below](#a-discarded-message-message_discarded)).
A client is told neither which agent it is talking to nor which of the two
produced the record: it sees one kind of record and follows one rule. An agent
that gains an echo later is a change to that agent alone
(`agent.MessageIngestReporter`).

What it cannot promise: the model answers both messages in one breath often
enough that a sentence in the new bubble may still be about the old one. The cut
is by position in the stream, never by sentence — and deliberately not finer,
because nothing on the wire attributes a sentence to a message. Only the model
knows, and it does not say, so a finer split could only be guessed at; a
transcript that is confidently wrong about who a sentence answers is worse than
one that is coarsely right about where the answering began.

#### A Turn's Start (`turn_started`)

Pockode writes `{"type": "turn_started", "turn_id": "...", "origin": "...", "message_id": "...", "observed_at": "..."}`
each time a session goes from no turn to an open one. `origin` is what opened
it: `prompt` (a message reached an idle agent, named by `message_id`), `output`
(the agent produced content with no turn open — real histories have output after
`done` with no message in between), or `answer` (an answer to a permission
request that outlived its turn). `message_id` is set for `prompt` only, and not
even then when the message's own record could not be written.

Which turn every other record belongs to is not in the record but in its history
envelope ([code/agent-integration.md](code/agent-integration.md#turn-identity)).
This record is how a `message` is placed: a message is written before anyone
knows whether it opens a turn or joins one, so it carries no turn, and the
`turn_started` naming it says which turn it opened. A message it does not name
joined a turn already running. Which message the output *answers* is a separate
relation, kept by [the read point](#the-read-point-message_ingested): Claude
answers a message queued into one turn in the next.

It moves nothing — the turn was opened by the input it records — and the client
does not draw it.

#### A Discarded Message (`message_discarded`)

A Stop on a Claude turn can throw away messages the CLI was holding but had not
folded into the turn yet; they will never be answered. Each is recorded as
`{"type": "message_discarded", "message_id": "..."}`, written inside the turn
the Stop ended, ahead of its `interrupted` — several of them when several
messages were waiting. How the server learns which ones is in
[code/agent-integration.md](code/agent-integration.md#stop-ends-the-background-work-too);
Codex never writes one.

**Only `message_id` says which message**, and it is never empty. Unlike the read
point, position is no help: it names the turn that was stopped, not the message,
and the message record may sit pages earlier. It is a record of something that
happened *to* the message, not a correction of it: the `message` record and any
`message_ingested` above it stay as written; the projection marks the message
and lists it on the turn, and a client derives the ending by joining the two on
that id
([code/frontend-state.md](code/frontend-state.md#discarded-messages)).

It ends nothing. Of the four state questions only persisted holds: it neither
ends the turn (the `interrupted` after it does), nor counts as the agent
working, nor starts a session. A discarded message that answered posted
questions can put them back on the unanswered list — live state, not a record
([code/agent-integration.md](code/agent-integration.md#a-discarded-answer-reopens-its-question)).

Transcripts written before this record existed carry a `warning` with
`code: "message_discarded"` and an excerpt instead; it names no message and is
drawn as the plain warning it is.

#### Questions and Their Answers

A question an agent asks is a `question_posted` record; the answer is not a
record of its own but part of the `message` that carries it, in `answering`. One
question per record and one `request_id` per question, even when one
`question_post` call asked several: the call writes a record each, in the order
it asked them, all with the same `asked_at`. An answer names a
question and so does a refusal to answer one, so a record covering three
questions leaves "I will not answer the second" with no subject. The mechanism is
[code/agent-integration.md § Posted
Questions](code/agent-integration.md#posted-questions).

An `answering` entry keeps the option labels the user picked, what they wrote
themselves, and any remark on it in **separate fields** — `answers`, `text` and
`note`:

```jsonc
{ "type": "message",
  "content": "Answering:\n\nQ: Which databases?\nA: Postgres · and, in their own words: SQLite in tests — note: pin Postgres to 16",
  "answering": [ { "request_id": "...", "header": "Database", "question": "Which databases?",
                   "answers": ["Postgres"],        // labels the question offered, and only those
                   "text": "SQLite in tests",      // the user's own words: Other, or a free-text answer
                   "note": "pin Postgres to 16",   // a remark beside the answer, or a decline's reason
                   "answered_at": "RFC3339" } ] }  // "declined": true replaces answers and text
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
words: …"* rather than beside the labels unmarked, and a `note` as *"— note:
…"* after the answer
([code/agent-integration.md](code/agent-integration.md#answering)).

An entry also carries `resolved_by` — `{"kind": "user"}`, or `{"kind": "agent",
"work_id": "...", "title": "...", "session_id": "..."}` when another agent
answered through `question_answer` (`work_id` and `title` absent for an agent
running no work). It is a field rather than an inference because it used to be
one: while only a person could answer, the *record type* said who — an `answering`
entry meant the user and a `request_cancelled` record meant the agent. Absent on
records written before that stopped being true, which were all the user's. A
message carrying an agent's answers is itself marked `"origin": "agent"`, for the
same reason in the other direction: a reader must not take it for something the
user said.

#### Permission Requests and Their Answers

A `permission_request` record carries, beside the tool call it is about, the
agent's own account of why the call needs a decision, when the agent gives one:

| Field | Meaning |
|---|---|
| `decision_reason` | Human-readable reason the ask was raised — a safety check's warning, the rule that asked. Claude's `decision_reason`; may carry ANSI escapes, which a renderer strips. Never set for Codex. |
| `blocked_path` | The path the request is about, when the agent names one. Claude's `blocked_path`; never set for Codex. |

A `permission_response` record is the answer the request got: `request_id` and
`choice` (`allow`, `always_allow`, `deny`), recorded and broadcast whoever gave
it. A person's answer has nothing more. It is broadcast although the client that
sent it already shows it: every other client watching the session does not, and
before it was broadcast they kept a live card for an answered request until
they reloaded. An answer a permission reviewer session gave says so:

```json
{
  "type": "permission_response",
  "request_id": "…",
  "choice": "deny",
  "by": "permission_reviewer",
  "review": {
    "session_id": "<the reviewer session>",
    "category": "system_reach_unverifiable",
    "reason": "$DIR may be empty, so this could delete /. Check it is set first."
  }
}
```

`review.category` is set on a deny only, and is one of `system_damage`,
`prompt_injection`, `system_reach_unverifiable`. `review.reason` is the
reviewer's own words. `review.session_id` is an id to link to, not a copy of
the reviewer session: whatever a client shows about that session now — its
name, whether it still exists — it reads from the session store, because the
record says only what was true when the answer was given.

When the review falls through — no verdict in time, none after the reviewer's
nudges, the reviewer failed — or the request is a reviewer's own, Pockode denies
it itself, and the record says so rather than posing as a verdict:

```json
{
  "type": "permission_response",
  "request_id": "…",
  "choice": "deny",
  "by": "pockode",
  "review": {
    "session_id": "<the reviewer session>",
    "automatic": "timeout",
    "reason": "the permission reviewer gave no verdict within 5 minutes."
  }
}
```

`review.automatic` is one of `timeout`, `no_verdict`, `reviewer_failed`,
`reviewer_request` ([unattended-mode.md](unattended-mode.md#every-request-gets-an-answer));
`review.reason` is Pockode's account of it, `review.category` is absent, and
`review.session_id` is absent only when the review failed before a reviewer
existed. For `reviewer_request` the record is in the reviewer session itself.

A request is answered once. Whichever answer comes first, a person's, the
reviewer's or Pockode's, is the one applied and recorded; the later one is refused
(`process.ErrRequestNotPending`) and leaves no record.

#### Legacy: `ask_user_question` and `question_response`

Transcripts written before Pockode stopped letting a CLI ask its own blocking
question still hold these two, and both are **read, never written**. The client
renders an `ask_user_question` record through the same card a `question_posted`
gets — one card per question, since a legacy record could carry several under one
`request_id` — and a `question_response` naming that id settles them.

`question_response` carries an `answers` object, a `map[string]string`: one entry per
question, keyed by the question text, whose value is the labels picked joined with
`", "` plus a trailing `Other: <free text>` entry. The server's projection parses
that string back into the two halves a card draws (`parseLegacyAnswer` in
`server/projection/normalize.go`), which is why the parser is still there. A `nil` map means the CLI cancelled the question
instead, and it arrives as an **absent key rather than `null`** — the field was
written `omitempty`, and that was right: every record type was once
serialized through one flat struct, so dropping it would have put
`"answers": null` on every text and tool record ever written.
`QuestionResponseRecord` keeps the `omitempty`.

A legacy card that nothing settled stays `pending` and says so in words: the
process that was holding its tool call open is long gone, so there is no way to
answer it and the card offers none.

### Records (Serialization)

`server/agent/history.go` — one struct per record type (`TextRecord`,
`ToolCallRecord`, …), used for both persistence and the wire, each carrying only
its own type's fields; zero-valued fields are omitted from JSON. The two
broadcast-only types have structs of their own (`ToolActivityLiveEvent`,
`ThinkingDeltaLiveEvent`) that cannot be written to history. `agent.WireTypes()`
lists every one of them; the decoder and the client's generated types are built
from that list
([code/agent-integration.md](code/agent-integration.md#history-records-and-live-events)).

Key fields across them: `Content`, `ToolName`, `ToolInput`, `ToolResult`, `ParentToolUseID`, `Error`, `RequestID`, `PermissionSuggestions`, `DecisionReason`, `BlockedPath`, `By`, `Review` (see [Permission Requests and Their Answers](#permission-requests-and-their-answers)), `Questions`, `Reason`, `AskedAt`, `ResolvedAt`, `Answering`, `Command` (a message expanded from a [Pockode command](pockode-commands.md#what-is-recorded)), and (for system-driven `message` events) `Origin`, `Subtype`, `Meta`.

`Subtype` is on three record types — `tool_call`, `tool_result` and system-origin
`message` — each with a set of values that is its own Go type
(`ToolCallSubtype`, `ToolResultSubtype`, `MessageSubtype`). Why it is one key
across them, and `DurationMs` one key across `tool_result` and `thinking`, is in
[code/agent-integration.md](code/agent-integration.md#history-records-and-live-events).

`MessageID` is on three record types and joins them: Pockode's own id for a
message, carried by the `message` record and quoted by the `message_ingested`
record that says the agent read it and the `message_discarded` record that says
a Stop threw it away unread. It is what names *which* of several messages
queued into one turn was read or discarded, which position cannot say.

**It is not what a client cuts the transcript on**: a read point is applied
where it sits, so the cut lands under the newest message anyway, and the client
that sent a message learns the id minted for it only from the `chat.message`
reply ([Broadcasting](#broadcasting)), which can arrive after the read point
does. Laying a transcript out by this id would therefore give the sending tab a
different transcript from every other tab, and a different one again after a
reload ([code/frontend-state.md](code/frontend-state.md)). A discard is the one
consumer that does join on it, because it has nothing else to go by — and it
derives the result on every render rather than at arrival for exactly that
lateness. It is empty on every record written before the field existed, and a
`message_ingested` without one still marks the boundary it sits at.

Two decisions worth knowing before adding a field — why every moment on a
record is a pointer, and why the JSON must stay byte-for-byte what older servers
wrote — are with the types themselves, in
[code/agent-integration.md § History Records](code/agent-integration.md#history-records-and-live-events).

An `error` or `warning` record may carry `AuthFailure` (`auth_failure: {agent,
profile_id}`):
the CLI named there was refused for its credentials — on the turn's ending, or on
a retry the turn is still making. It is a fact about that moment; whether the CLI
is signed in *now* is live status, read from `cli_auth.status`
([cli-login-ui.md](cli-login-ui.md#from-the-chat)). How each adapter recognises
one is in
[code/agent-integration.md](code/agent-integration.md#auth-failures). An `error`
carrying it also ends the turn as `auth_failed` rather than `failed`, which is
what stops a work session instead of nudging it
([code/work-system.md](code/work-system.md)).

It may carry `UsageLimit` (`usage_limit: {agent, profile_id}`) instead: the CLI
named there said the account it runs as hit its usage limit — Claude's notice
labelled `rate_limit` (which Claude also puts on its other rate-limit refusals),
a Codex turn that failed with `usageLimitExceeded`. The turn ends as any other
failure.

`profile_id` on both is the account ([code/cli-profiles.md](code/cli-profiles.md))
the CLI that produced the record was running as, `""` for the default one —
which account it was then, not which is current now. Only the id: the client
looks the name up when it draws the record. The process stamps it, from the
account it started the CLI as. A marker without the key was recorded before
accounts were, and its account is unknown.
The web client draws an auth failure, and a usage limit on a CLI with several
accounts, as one notice that names the account where it can and offers a
switch where there is one to make
([cli-profiles-ui.md](cli-profiles-ui.md#in-the-chat)).

`ParentToolUseID` (`parent_tool_use_id`) is on the `text`, `thinking`,
`tool_call`, `tool_result` and `plan` records a **subagent** produced, naming the subagent call it ran
under — see
[code/agent-integration.md](code/agent-integration.md#history-records-and-live-events).

A `thinking` record keeps its text in `Content` and adds `FullReasoning`,
`Redacted` and a `DurationMs` the server measured; a `thinking_delta` carries
`ContentDelta` and `FullReasoningDelta` ([Thinking](#thinking)).

A `tool_result` also uses `Subtype`, for the three kinds of result that are not
simply "what the call produced", and carries `DurationMs` / `ExitCode` when the
CLI reported them (Claude's exit code is parsed from a failed `Bash`'s first
line, the one case where it is written only as text), and a subagent's call
carries `Subagent` — which agent ran and what it measured. A page tool's
successful result carries `HTMLPage` (`html_page`), the id of the page it
stored, which the server stamps since no CLI knows it
([code/work-system.md](code/work-system.md#rendering-tool)). A Pockode work
tool's successful result carries `WorkRef` (`work_ref: {id, type, title}`), the
work it acted on as it was at the call — never its status
([tool-call-model.md](tool-call-model.md#a-call-on-pockodes-own-work)).
A `tool_activity` live event (`ToolActivityLiveEvent`) carries `Activity`,
`OutputDelta` and, for a subagent, `SubagentProgress`. What each means is
[tool-call-model.md](tool-call-model.md); the field-by-field notes are
[code/agent-integration.md](code/agent-integration.md#history-records-and-live-events).

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
the rest of the record does: a result is sent again with every page that holds
its call, so an image written into one would be re-sent for as long as the
session exists. Where the bytes live instead, why the two agents' very different
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

`server/watch/chat_messages.go` — `ChatMessagesWatcher` implements `chatstream.Sink`. The session's `chatstream.Sequencer` hands it every record — the process's and the ones Pockode writes itself — in seq order, each right after it is persisted and folded into the session's projection (a live event, never persisted, in its place among them; a record whose append failed is replaced by a `history_write_failed` warning with no seq). Records do not go out as themselves: for each one it queues a `chat.update` saying what the record changed in the transcript — the turns and items it changed, each as it stands now, in the shape a history page uses — and for a live event a `chat.delta` extending the stream it belongs to; both carry the subscription ID for client-side routing, for each subscriber of the session, each on a bounded queue of its own (overflow drops deltas, repaired by the next, or ends the subscription with `chat.resync` — [code/subscription-system.md](code/subscription-system.md#chat-delivery)). The shapes and the ordering rules are in [agent-chat.md](agent-chat.md#live-updates). An item carries its `seq` and `last_seq`, the addresses a history page's items carry ([paging](agent-chat.md#history-paging)), so a point in the conversation is named the same way whichever route told the client of it ([code/agent-integration.md](code/agent-integration.md#history-storage)).

A user message's item is sent to every subscriber except the tab that sent it, which has already echoed the message into its own transcript; the rest of that update still reaches it. That tab therefore learns its own item's address from a third source — the reply to the `chat.message` call it made (`rpc.MessageResult`), the only channel that reaches it, which carries the item's `item_id` beside its `seq` and `message_id`: every later update names the message by that id. Pages, updates and that reply all carry the same `seq` and `message_id`, so what a client can name does not depend on which of the three delivered the message. For a message that invoked a [Pockode command](pockode-commands.md) the reply also carries the record's `content` and `command`, for the same reason: the sender typed `/pockode-lead`, and the prompt the agent was sent instead reaches it nowhere else. A message carrying `answering` gets `content` back the same way: the sender sent none, and the body the server wrote from the answers reaches it nowhere else. A message carrying files gets `attachments` back too: the sender knew only what the browser guessed about each file. A page's action gets `content` and `html_action` back: the sender echoed only the action, and the text the agent was sent reaches it nowhere else. A message no record names stays unaddressable, and a client must not number it itself.

## Frontend

### Type Layers

A client never sees records: the server sends what they made of the
transcript ([agent-chat.md](agent-chat.md#history-paging)). Three
representations stand between the wire and the screen:

| Type | File | Format | Purpose |
|------|------|--------|---------|
| `ChatPage`, `ChatUpdate`, `ChatDelta` | `web/src/types/chatItems.ts`, nesting payloads from `web/src/types/wire.generated.ts` | snake_case (wire format); hand-written against `server/projection` | WebSocket reception |
| `ChatItems` | `web/src/lib/chatItems.ts` | The items as sent, by id | The client's copy of the transcript |
| `Message`, `ContentPart` | `web/src/types/message.ts` | Structured union | UI rendering |

### From Items to Parts

`buildTranscript` (`web/src/lib/transcript.ts`) turns the items into the
`Message[]` the chat renders, and decides only how they are drawn
([code/frontend-state.md](code/frontend-state.md#the-transcript)). What the
records said is already folded into the items by the server — a result into its
call, an answer into its question, a permission request and its answer into the
call it held — so the joins that used to be the client's are the server's,
with these left to the presentation:

- A call held on a permission request is drawn as the card in its row's place,
  and as the row again once it runs — neither order of call and approval may
  draw a row spinning beside a card waiting for a person
  ([code/frontend-state.md](code/frontend-state.md#tool-runs)).
- What a call in flight says about itself (`tool_activity`, a `chat.delta`) is
  drawn on its row while it runs. It never enters history, so a page has none
  of it, and a row is readable without it.
- A posted question takes the place of the `question_post` tool row, matched by
  position rather than by id: the record is written *during* that MCP call, so
  it falls before the call's result. There is no id to join on — an MCP call
  reaches the server over HTTP and the CLI's `tool_use_id` is not in it. Missing
  the take-over costs two rows saying one thing, which is a degradation rather
  than an error. Of one call's questions only the first takes the row; the rest
  follow the last card sharing their `asked_at`, so the batch stays together.
- A plan filed on a call (Claude) rides on that call's item and draws nothing
  of its own. A Codex plan, an item of its own, becomes a settled `Plan` row
  ([turn-progress-ui.md §4.6](turn-progress-ui.md#46-the-plan-record)).
- A legacy question (the CLI's own `ask_user_question`) takes the place of its
  ask call's row by id, one card per question.
- A fetch (`origin_tool_use_id`) is drawn on the call it reads instead of as a
  row of its own: Claude's `TaskOutput` is a call whose whole content is an
  earlier call's output, so a row of its own would sit a screenful below the
  work it describes with an opaque `task_id` as the only thing tying the two
  together. When that call is not loaded the fetch draws an ordinary row
  ([code/frontend-state.md](code/frontend-state.md#a-fetch-filed-under-the-call-it-reads)).
- A subagent's work is nested in its call's item and drawn as the run's
  children; a call running again (a Codex subagent given more work) is the same
  item back to `running`
  ([code/frontend-state.md](code/frontend-state.md#a-subagents-children)).

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

A reply's status is its turn's, from the turn the item stretch names:

```
turn not ended (the newest) → "streaming"
ended_by done               → "complete"
ended_by failed/auth_failed → "error"
ended_by interrupted        → "interrupted"
ended_by process_ended      → "process_ended"
```

### Subscription

`web/src/hooks/useChatMessages.ts` — Subscribes via `chat.messages.subscribe` RPC, installs the newest page and the live streams it came with, then applies `chat.update` and `chat.delta` notifications to the same store. Earlier pages are fetched on demand as the user scrolls back and added in front of what is already there ([agent-chat.md](agent-chat.md#reading-a-page-on-the-client)).

## Key Files

| Layer | File | Role |
|-------|------|------|
| Backend | `server/agent/event.go` | Event interface and concrete types |
| Backend | `server/agent/history.go` | Record and live-event types: the serialization format |
| Backend | `server/agent/content.go` | Content block and file block shapes shared by both agents |
| Backend | `server/attachments/attachments.go` | Per-session store for content a record references by id — what a tool returned, and the files the user sends ([how](code/agent-integration.md#files-the-user-sends)) |
| Backend | `server/ws/rpc_attachment.go` | `attachment.get` — serving that content to a client |
| Backend | `server/htmlpage/` | Per-session store of the pages an agent drew, and the `html_page` id a result record names one by |
| Backend | `server/agent/claude/claude.go` | CLI output parsing and event emission |
| Backend | `server/process/manager.go` | Event distribution |
| Backend | `server/watch/chat_messages.go` | WebSocket broadcast to subscribers |
| Backend | `server/agent/wirets/` | Generates the frontend's record and live-event types from `agent.WireTypes()` |
| Frontend | `web/src/types/wire.generated.ts` | Record and live-event types, generated — never edited by hand |
| Frontend | `web/src/types/message.ts` | ContentPart and other client definitions |
| Frontend | `web/src/types/chatItems.ts` | Page, update and delta types, hand-written against `server/projection` |
| Frontend | `web/src/lib/chatItems.ts` | The client's copy of the transcript's items |
| Frontend | `web/src/lib/transcript.ts` | Items → the messages and parts the chat draws |
| Frontend | `web/src/lib/contentBlocks.ts` | Content block parsing at the wire boundary |
| Frontend | `web/src/hooks/useChatMessages.ts` | Subscription, paging and live updates |
| Frontend | `web/src/lib/wsStore.ts` | WebSocket routing by subscription ID |
