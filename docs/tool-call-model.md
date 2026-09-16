# Tool Calls: One Model for Two Engines

What Pockode means by "a tool call", across both agent CLIs. It is implemented:
the records below are on the wire and in history, and `ToolRun` is what the
transcript renders. How one is *drawn* is [tool-call-ui.md](tool-call-ui.md);
this document decides what one **is**.

The transcript is in [agent-chat.md](agent-chat.md), the event stream in
[agent-event.md](agent-event.md), and the two CLI adapters in
[code/agent-integration.md](code/agent-integration.md). This document covers only
the tool-call slice of all three, and defers to those three for anything wider.

Every claim here about an external CLI's behaviour was measured against
**claude 2.1.263** and **codex-cli 0.153.0**, and says so where it matters. That
is not ceremony: an earlier version of this document asserted that Claude re-sends
a `tool_call` after approval — true of an older CLI, false of 2.1.263 — and
building on it would have dropped the output of every approved command.

## What was wrong

Three problems, and only one of them was a drawing problem:

1. **A backgrounded call was never finished.** Claude can start work that
   outlives the tool call that asked for it. The call's `tool_result` is a
   placeholder — *"Command running in background with ID: …"* — and the real
   outcome arrives later on a channel Pockode dropped entirely. The row kept
   showing the placeholder forever.
2. **A long title was truncated into nowhere.** The row cut the summary and the
   body showed the *result*, not the input, so a long `Bash` command appeared
   nowhere at all. This needed no new data — `tool.input` is complete and always
   was — and is answered in [tool-call-ui.md](tool-call-ui.md).
3. **A running call said nothing about itself.** A tool call had no status field
   at all, not even the `is_error` the wire already carried, so a failed `Bash`
   and a successful one rendered identically.

(1) and (3) were missing model, and that is what this document is about.

## What comparable projects do

**happy** (`refs/happy`, `packages/happy-app/sources`) keeps one `ToolCall` type
(`sync/typesMessage.ts`) for every engine it supports, and is the closest prior
art. Four of its decisions are taken here:

- **State is a field on the call, not something the renderer infers.** The
  reducer is the only author; the view switches on it and guesses nothing.
- **Timestamps are on the call**, which is what lets a running row show elapsed
  seconds — the cheapest possible "this is still going" signal. Pockode can only
  take half of this; see `seenAt` below.
- **A title and a detail are two different fields.** One names the kind of call,
  the other identifies this particular one, and only the second truncates.
- **Long content is solved by navigation, not by layout.** Pockode's answer is a
  body rather than a screen, but the rule — the row never grows — is the same.

Two things happy does that Pockode deliberately does not. It folds the permission
request into the tool call; Pockode keeps it its own part, with its own lifetime
and its own buttons. And it maintains a `sidechains` map to nest a subagent's
whole conversation under the call that spawned it — real, and much larger than
this model needs.

Notably, happy does **not** track background shells either: `BashOutput` and
`BashStop` are separate unconnected rows. On problem (1) there was no prior art
to copy, and the design below is Pockode's own.

**claude-code-chat** (`refs/claude-code-chat`) never joins a result to its call
at all — it matches a result to "the last tool use" by position. Its one
transferable idea is progressive reveal, and Pockode's `ScrollableContent` is a
better version of it that already shipped.

## What the two engines actually emit

### The call and its result

| | Claude | Codex |
|---|---|---|
| Identity | `tool_use.id` on an `assistant` message | `item.id` on `item/started` |
| Name | `tool_use.name`, the real tool name | item type, mapped to Pockode's names (`commandExecution`→`Bash`, `fileChange`→`Edit`, `imageView`→`Read`, MCP → `server:tool`) |
| Input | `tool_use.input`, verbatim | rebuilt per item type (`toolCallOf`) |
| Result | `tool_result` block on a `user` message | `item/completed` |
| Failure | `tool_result.is_error` | item `status` ∈ `inProgress`/`completed`/`failed`/`declined` |
| Duration | — | `durationMs` on `commandExecution`, `mcpToolCall`, `dynamicToolCall` |
| Exit code | in the result text | `exitCode` on `commandExecution` |
| Parsed intent | — | `commandActions[]`: `read` / `listFiles` / `search` / `unknown`, each with the sub-command and its path or query |

Both engines announce a call and then report on it, so "a call with no result is
running" holds on either. What is asymmetric is everything around that:

- **Claude's input is verbatim; Codex's is reconstructed.** `toolCallOf` builds
  the input object field by field, so anything it does not name is gone before
  the frontend ever sees it — which is how `commandActions`, `exitCode` and
  `durationMs` used to be lost. Adding a field there is the whole cost of
  getting one back.
- **Codex reports the outcome as data, Claude as prose.** A codex
  `commandExecution` carries a status, an exit code and a duration; Claude has
  only the flag and the text, so the flag is the one thing both engines can
  always fill.
- **Codex has `declined`**, a first-class "the user refused" status; Claude
  expresses the same thing as ordinary result text.

**The two engines do not agree on when a call is announced relative to the
approval that gates it.** Claude sends the `tool_call` first and then asks;
Codex may ask before it announces the item at all. Both orders are real and both
have to work — an assumption of either one alone produces a row spinning above
or below a card that is waiting for a person. What the reducer does about it is
in [code/frontend-state.md](code/frontend-state.md#tool-runs); the fact is
recorded here because it is a property of the engines, not of the client.

**Claude 2.1.263 does not re-send the `tool_call` after approval** (measured,
three runs: one `tool_call`, one `permission_request`, one `tool_result`). An
older CLI did, and a comment in the reducer still described that world. Nothing
here may assume a second announcement arrives.

### Live progress

| | Claude | Codex |
|---|---|---|
| Incremental output | **none** | `item/commandExecution/outputDelta` → `{itemId, delta, threadId, turnId}` — true stdout/stderr deltas |
| One-line status | `system` / `task_progress` | `item/mcpToolCall/progress`.`message` |
| Other progress fields | `task_progress` also carries `tool_use_id`, `last_tool_name`, `usage{total_tokens, tool_uses, duration_ms}` | — |

Which field of `task_progress` actually carries that line changed between the
schema and the shipped CLI, and the adapter reads whichever is there
([The Task Lifecycle](code/agent-integration.md#the-task-lifecycle)). What the
model needs from it is only that it is *one line*, *prose*, and *the latest
value*.

`tool_progress` frames are a dead end and are worth naming so nobody
re-investigates them: they carry `elapsed_time_seconds`, a `heartbeat` flag and a
`task_id` — never output — and the Bash variant is emitted only when
`CLAUDE_CODE_REMOTE` or `CLAUDE_CODE_CONTAINER_ID` is set, which Pockode does not
set.

Both delta channels are safe to drop under load: the whole output also arrives on
the completed item, so a missed delta costs a moment of liveness and nothing else.

### Background work — Claude only

Codex has no notion of a tool call that outlives its turn: a codex turn blocks on
its command. Everything in this section is Claude's, and the model has to work
when none of it ever arrives.

Claude runs a full task lifecycle on `system` frames, and the edges carry a
`tool_use_id`, which is the join back to the call. The frames, what each says,
and what the adapter does with each are in
[code/agent-integration.md](code/agent-integration.md#the-task-lifecycle). The
CLI's own schema states the case outright: *"A backgrounded task's tool_result is
the placeholder text and its real result arrives as this notification, so this is
where a host learns which files that tool call produced; join to the originating
call via `tool_use_id`."* That sentence is the whole of problem (1).

Two measured facts shape the model itself, and both contradict what this document
assumed before the code was written (the rest of the frame-by-frame detail is in
the adapter doc linked above):

- **`task_started` arrives before the call's `tool_result`.** So a placeholder
  can be stamped as one at the moment it is parsed, and the model needs no way to
  amend a record after the fact.
- **A non-backgrounded subagent `Task` also gets a `task_notification`, and it
  arrives before that call's own `tool_result`.** So a notification is not
  by itself an outcome worth recording: only a call flagged `is_backgrounded`
  gets one, and every other call reports through its ordinary result. Recording
  both would write one ending into history twice.

## The model

**One tool run per `tool_use_id`.** That id is Pockode's join key on both
engines, it already was, and nothing here needs a second one.

A tool run is described by three kinds of record — one of which comes in four
flavours — split on the rule the project applies everywhere: *an event says what
was true at one moment, state says what is true now.*

| Record | Persisted | Says |
|---|---|---|
| `tool_call` | yes | the agent asked for this, with this input |
| `tool_result` | yes | this came back to the agent |
| `tool_result` + `subtype: "background_started"` | yes | …and it is a placeholder; the work is still running |
| `tool_result` + `subtype: "background_result"` | yes | the real outcome of that work, as the CLI reported it |
| `tool_result` + `subtype: "background_lost"` | yes | …or the outcome Pockode wrote itself, because the CLI never will |
| `tool_activity` | **no** | what a call that has not returned is doing right now |

And one derived object, `ToolRun`, that the message reducer maintains and the UI
renders without inferring anything.

### `ToolRun`

```ts
interface ToolRun {
    id: string                 // tool_use_id / codex item id
    name: string               // engine-neutral: Bash, Edit, Read, server:tool, …
    input: unknown             // complete, never truncated
    status: ToolRunStatus
    /** The latest one-line status of a call still running. Live state: absent on replay. */
    activity?: string
    /** The tail of a running call's output, if the engine streams one. Live state. */
    output?: string
    result?: string
    /** The placeholder a backgrounded call handed back, kept beside the outcome. */
    placeholderResult?: string
    contents?: ContentBlock[]
    /** Set when the result above is a background outcome, not what the agent read. */
    fromBackground?: boolean
    /** How long the call took, when the engine says so. Replay-safe; Claude sends none. */
    durationMs?: number
    exitCode?: number
    /** When this client first saw the call. Live only — see below. */
    seenAt?: Date
}

type ToolRunStatus = 'running' | 'background' | 'success' | 'error' | 'interrupted'
```

Status is derived from the records, never sent:

| Status | Derived from |
|---|---|
| `running` | a call with no result yet |
| `background` | newest result carries `background_started` |
| `success` | a result with `is_error` false |
| `error` | a result with `is_error` true — including every `background_lost`, which is one by construction |
| `interrupted` | the turn was cut short; a result arriving afterwards does not undo it |

The exact reducer rules, and what replay can and cannot settle, are in
[code/frontend-state.md](code/frontend-state.md#tool-runs). Deliberate omissions,
each with a reason:

- **No `title` or `detail` field.** Both are derived from `name` and `input` on
  the frontend (`web/src/lib/toolSummary.ts`). A display string on the wire is a
  second representation of data already there, and it freezes a formatting
  decision into history that a later version cannot change. Where an engine hands
  over *data* that makes a better title — codex's `commandActions` — that data is
  passed through in `input` and the title derived from it.
- **No `declined` status.** Codex has one and Claude does not; both deliver a
  result text saying the user refused, and Pockode renders the refusal on the
  permission card that caused it. A rung nothing renders differently is a rung
  that only has to be kept in sync.
- **No `startedAt` / `endedAt`.** happy has them, and Pockode cannot copy that: a
  history record carries no timestamp at all (`AppendToHistory` writes the record
  and nothing else), so the only clock a client has is when it received
  something. That is right for a call it is watching and meaningless for one it
  replayed — every run in a year-old transcript would start its stopwatch at page
  load. `seenAt` is therefore explicitly live-only, and the real duration of a
  *finished* call is a different thing: `durationMs`, which codex reports as data
  and claude does not report at all. Putting a timestamp on every record would
  fix both, and it is a change to the history format that this story did not
  justify.
- **No permission field.** It stays its own part, with its own lifetime and its
  own buttons.
- **No status field on `EventRecord`.** Every input to the derivation above is a
  record the client already has.

### `tool_activity` is not persisted

It is the only event Pockode broadcasts without writing to history, and that is
the point: a progress line is *the latest value*, and a snapshot of it in the
transcript becomes a lie the moment the next one arrives — the same argument that
keeps token usage out of the stream
([agent-event.md](agent-event.md#what-is-not-an-event)).

That needed a fourth predicate beside the three `EventType` already answered, and
**a new event type now has to answer all four**:

| Predicate | `tool_activity` | Why |
|---|---|---|
| `Persisted` | **false** | see above |
| `AwaitsUserInput` | false | nothing is blocked on the user |
| `IndicatesAgentActivity` | true | it only ever arrives while a call is live |
| `ActivatesSession` | false | it is the CLI reporting, not the agent contributing |

**`Persisted` is a denylist while the other three are allowlists**, and the
asymmetry is deliberate rather than an oversight to be tidied up. The other three
are allowlists because a wrong inclusion strands a session or confiscates the
escape hatch, and nothing downstream corrects it
([code/agent-integration.md](code/agent-integration.md#what-an-event-says-about-process-state)).
Here the default is the safe one: an event says what was true at one moment and
that stays true, so a new type nobody thought about is recorded. The cost of
forgetting is one stored record nobody reads, not a hole in history.

`IndicatesAgentActivity` being true has a second effect that is wanted rather
than tolerated: the background-wait deadline is refreshed on any such event, so a
background task that is visibly reporting progress stops counting against the
30-minute silence budget ([Background
Waits](code/agent-integration.md#background-waits)). Because that predicate is
written as a union with `ActivatesSession`, answering it `true` while
`ActivatesSession` stays `false` means naming the type in it explicitly — which
is what an allowlist is for.

**A client that subscribes mid-run has missed everything it was not listening
for**, and on a phone that is the normal case, not an edge. So the process also
keeps the newest activity per in-flight `tool_use_id` and hands it to a client
that subscribes ([agent-chat.md](agent-chat.md#history-paging)). The map is
bounded by the calls actually in flight: an entry is dropped when the run
*settles*, and not on a backgrounded call's first result, since that one is the
placeholder and all the progress worth keeping arrives after it. Only the
activity line is kept, never the output deltas: one chunk of stdout is not the
tail of anything, and the tail a reconnecting client wants arrives with the next
delta or with the result.

### Background lives on `tool_result`, twice

Claude's `task_notification` for a backgrounded call becomes a second
`tool_result` record for the same `tool_use_id`, carrying `summary` as the text,
`is_error` from `status != "completed"`, and `subtype: "background_result"`. A
killed task reports an empty `summary`, so the adapter writes a sentence from the
status rather than recording a blank outcome — a record that says nothing is not
better than one that says the task was stopped.

That alone is not enough, and the reason is replay. **A backgrounded call already
has a result** — the placeholder the agent read — so a run that is still working
would derive as `success` from history, and a page scrolled back to would show a
task that finished when it has not. The status cannot come from the activity
event either, because that one is never persisted.

So the fact that the first result was a placeholder is persisted with it: when
`task_started` has marked this `tool_use_id` backgrounded, the adapter stamps
that first `tool_result` `subtype: "background_started"`. It is a settled
historical fact — *this call handed back a placeholder* — and it stays true
forever, which is exactly what belongs in a record. A run whose newest result
carries that subtype is `background`; the outcome record supersedes it and
settles the run.

Reusing the type rather than adding one is the same argument `MessageOrigin` made
for not adding a message type: the reducer already joins a `tool_result` to its
call by id, overwriting is exactly the wanted behaviour, `prependHistoryPage`
already replays tool results over older pages as "update it wherever it is", and
history is append-only so the later record wins on every path without anyone
ordering it. A new type would fork all three for no behavioural gain.

The `subtype` is what keeps it honest. The placeholder is what the *agent* read;
the outcome is what *happened*. A row that shows the second without saying so is
asserting the agent saw something it did not, so both are kept and the UI labels
which is which.

`output_file` is a path on the server's machine, which is what `FileBlock.Path`
already describes — display, and an offer to open it in the Files tab when it is
under the work directory ([agent-event.md](agent-event.md#eventrecord-serialization)).
It is not read into an attachment: a background task's log can be arbitrarily
large, and the user asked to see the outcome, not to have the log pushed at them.

#### A third subtype, with a different author

A background task dies with the CLI process that owns it, and the CLI never
reports an outcome for it — not at the time (the event channel is closing behind
the process) and not on the next start. Pockode reports it instead, at the next
start of that session, as a `tool_result` with `subtype: "background_lost"` and
`is_error` true ([Background Waits](code/agent-integration.md#background-waits)
for the delivery mechanics).

**`background_lost` is kept apart from `background_result` because the two have
different authors.** One is what the CLI said; the other is what Pockode observed
of a process it killed or watched die. Wearing the same subtype would claim the
agent's own tooling reported an ending it never did. That is the line the product
decision drew: Pockode may assert an outcome no CLI reported, and must say where
the assertion came from. The result text says so too, for whoever is reading the
transcript rather than the schema.

Nothing needs a fourth status: `is_error` is true, so the run derives `error`.
The record does not restate that the call was a background one, and the client
does not infer it from an earlier `background_started` either: it treats both
background subtypes as saying so themselves. That is not belt-and-braces. A call
can become a background task *after* its own result was parsed (`task_updated`
carries `is_backgrounded`), which leaves a backgrounded call with no
`background_started` on its run — and its lost outcome would then read as an
ordinary result the agent had read, which is the one thing this subtype exists to
prevent.

**The record it is built from has two fields that come from two unrelated
streams, on purpose.** `background_tasks_lost.json` holds `lostTasks` (how many
were running, counted from the `background_tasks_changed` level) and `lostCalls`
(which calls they belonged to, from the task lifecycle's own set of backgrounded
`tool_use_id`s). The CLI's schema says outright that the ordering between those
two streams is unspecified and that they must not be correlated, so neither half
is derived from the other. The price is that the halves can disagree, which is
why **each stands alone**: a count with no ids produces the summary warning only,
ids with no count settle the rows only, and a record written before `lostCalls`
existed still reads as the old summary-only behaviour. Unifying them into one
source would be the obvious tidy-up and would be building on an ordering the CLI
refuses to promise.

### Tasks are tool runs

`TaskRun` and its `{ type: "task" }` part folded into this model. A subagent call
*is* a tool call — Claude even carries its `tool_use_id` on `task_started`
alongside `subagent_type` and `prompt` — and keeping both meant two status
machines, two settle-on-interrupt paths and two renderers for one thing.
`TaskItem` stays as the renderer for the subagent category; `TaskRun`'s extra
fields (`description`, `subagentType`, `prompt`) are derived from `input` the way
every other title is, and `resultAfterInterrupt` is now
`status === 'interrupted' && result !== undefined` — one fact read off two
fields instead of a third that can fall out of step with them.

## Out of scope

- **Nesting a subagent's conversation under its call.** happy does it; it needs a
  sidechain tracer and a recursive renderer, and neither problem here asks for it.
- **Codex item types Pockode still drops** — `webSearch`, `dynamicToolCall`,
  `collabAgentToolCall`, `subAgentActivity`, `sleep`, `imageGeneration`. Each is
  tool-shaped and each would fit this model unchanged, which is the point of
  having one; adding them is its own decision about what belongs in a transcript.
- **Per-call token cost.** Claude's `task_progress.usage` and
  `task_notification.usage` report it. Usage is session state with an owner
  ([usage-display-ui.md](usage-display-ui.md)), and attributing it per call is a
  separate feature, not a field on a row.
- **A timestamp on every history record.** It would give every replayed run an
  honest duration and retire the `seenAt` / `durationMs` split above. It is a
  history format change and wants its own decision.
