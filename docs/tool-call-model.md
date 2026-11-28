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
  server's projection derives it and the client's transcript is the only author
  of the run the view draws; the view switches on it and guesses nothing.
- **Timestamps are on the call**, which is what lets a running row show elapsed
  seconds — the cheapest possible "this is still going" signal — and a finished
  one how long it took. Pockode's are the server's, not the client's; see
  [observed times](#observed-times-and-reported-durations) below.
- **A title and a detail are two different fields.** One names the kind of call,
  the other identifies this particular one, and only the second truncates.
- **Long content is solved by navigation, not by layout.** Pockode's answer is a
  body rather than a screen, but the rule — the row never grows — is the same.

Two things happy does that Pockode deliberately does not. It folds the permission
request into the tool call; Pockode keeps it its own part, with its own lifetime
and its own buttons. And it maintains a `sidechains` map to nest a subagent's
whole conversation under the call that spawned it. Pockode did not take that at
first and now does, in a smaller form
([below](#a-subagents-own-conversation)).

Notably, happy does **not** track background shells either: `BashOutput` and
`BashStop` are separate unconnected rows. On problem (1) there was no prior art
to copy, and the design below is Pockode's own.

**claude-code-chat** (`refs/claude-code-chat`) never joins a result to its call
at all — it matches a result to "the last tool use" by position. Its one
transferable idea is progressive reveal, and Pockode's `ClampedContent` — a
section cut to a height budget and opened in place by *Show N more lines* — is a better version
of it that already shipped.

## What the two engines actually emit

### The call and its result

| | Claude | Codex |
|---|---|---|
| Identity | `tool_use.id` on an `assistant` message | `item.id` on `item/started` |
| Name | `tool_use.name`, the real tool name | item type, mapped to Pockode's names (`commandExecution`→`Bash`, `fileChange`→`Edit`, `imageView`→`Read`, MCP → `server:tool`, and the rest [below](#codex-items-beyond-commands-patches-and-mcp)) |
| Input | `tool_use.input`, verbatim | rebuilt per item type (`toolCallOf`) |
| Result | `tool_result` block on a `user` message | `item/completed` |
| Failure | `tool_result.is_error` | item `status` ∈ `inProgress`/`completed`/`failed`/`declined` |
| Duration | for a subagent, `WebFetch` and `WebSearch` only, in the frame's `tool_use_result` | `durationMs` on `commandExecution`, `mcpToolCall`, `dynamicToolCall` |
| Exit code | in the result text: a failed `Bash`'s first line, `Exit code N`, which the adapter parses into `exit_code` ([how](code/agent-integration.md#history-records-and-live-events)) | `exitCode` on `commandExecution` |
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
  only the flag and the text (and a duration for a handful of tools, a
  subagent among them), so the flag is the one thing both engines can always
  fill.
- **Codex has `declined`**, a first-class "the user refused" status; Claude
  expresses the same thing as ordinary result text.

**The two engines do not agree on when a call is announced relative to the
approval that gates it.** Claude sends the `tool_call` first and then asks;
Codex may ask before it announces the item at all. Both orders are real and both
have to work — an assumption of either one alone produces a row spinning above
or below a card that is waiting for a person. The server's projection folds
both orders into one item, and how the client draws it is in
[code/frontend-state.md](code/frontend-state.md#tool-runs); the fact is
recorded here because it is a property of the engines, not of the client.

**Claude 2.1.263 does not re-send the `tool_call` after approval** (measured,
three runs: one `tool_call`, one `permission_request`, one `tool_result`). An
older CLI did. Nothing here may assume a second announcement arrives.

### Codex items beyond commands, patches and MCP

Until codex-cli 0.171.0's items were wired up, `toolCallOf` read four item
types and dropped every other tool-shaped one on the floor, so a turn that
searched the web, generated an image or waited on a subagent showed nothing at
all for it — not even a row saying it happened. The `ThreadItem` union of
0.171.0's app-server schema (`codex app-server generate-json-schema`) holds
these tool-shaped items besides the four, and each becomes a tool call under a
Pockode name, by the same rules as the others: the input rebuilt field by field
(`server/agent/codex/tool_items.go`), the result from `item/completed`, failure
from `status`:

| Item | Pockode name | Input | Result |
|---|---|---|---|
| `webSearch`, `action.type` `search` or `other`, or no action | `WebSearch` | `query`, and `queries` when the action names several | the `results` entries that name a `url`, as Claude's result shape (`Links: [{title, url}]`); empty when there are none. The item has no `status`, so it never fails |
| `webSearch`, `action.type` `openPage` / `findInPage` | `WebFetch` | `url`, and `pattern` for `findInPage` | empty: Codex hands the page to the model and reports none of it |
| `imageGeneration` | `GenerateImage` | `prompt`, only when the start carries `revisedPrompt` — 0.171.0's does not | the `revisedPrompt` as a text block, then the image at `savedPath` as a file block, copied into the attachment store the way `imageView`'s is (`viewedImage`); a `failure` worded from its kind — `usageLimitExceeded` says the limit was reached and, with `resetsAt`, when it resets |
| `sleep` | `Sleep` | `duration_ms`, the wait asked for | empty. The item's `durationMs` is what was asked, not a measurement, so it is not passed as one: the row's time is the observed one |
| `collabAgentToolCall`, any `tool` but `spawnAgent` | `AgentControl` | `action` (the `tool`: `wait`, `sendInput`, `sendMessage`, `followupTask`, `resumeAgent`, `interruptAgent`, `closeAgent`, `listAgents`), `agents` (each receiver's agent path, where its spawn named one; `null` in its place otherwise — a thread id is no name), `prompt` when there is one | the receivers' states (`agentsStates`) as one line each, `<agent path>: <status>` (`agent` for one with no path), the named receivers first and any other state after them; failure from `status` |
| `dynamicToolCall` | `<namespace>:<tool>`, or `dynamic:<tool>` with no namespace — an MCP-shaped name, since that is what it is: a tool the client offered | `arguments`, as for MCP | the `inputText` items joined; an image or audio item is not drawn and is counted in a last line (*1 image not shown*); failure from `status` / `success` |

Five decisions inside that table:

- **A web search reuses Claude's names, not a name of its own.** It is the same
  call a reader already knows from Claude — a query, or a page — and the row,
  the group summary's `search` / `fetch` verbs and the host naming all apply
  unchanged. Its result is written in Claude's result shape for the same
  reason: the one reading of a search result the frontend has
  (`lib/webSearchResult.ts`) then draws Codex's links too. What Codex does not
  report — a page's text, or a search with no usable entries — the body says
  is not reported rather than drawing an empty section
  ([tool-call-ui.md](tool-call-ui.md#the-remaining-tool-kinds)).
- **`results` is read, though the schema calls it opaque.** The design first
  left it unread on the strength of the schema's word; measured on 0.171.0, a
  search's entries were `{type: "text_result", title, url, snippet, domain,
  ref_id}`, and a body saying Codex reported nothing would have been false.
  Only an entry's `url` and `title` are read, and an entry without a `url` is
  passed over, so a change in the shape costs links, never a broken row. A
  page open's one entry is the page itself, its snippet a line count
  (*Total lines: 455*), so it adds nothing and is not read.
- **A web search is announced on completion.** Measured on 0.171.0,
  `item/started` carries `query: ""` and `action: null`, so there is nothing to
  name the call by when it starts. It is announced at `item/completed`,
  immediately followed by its result: a row that appears settled is honest, a
  running row with nothing to name it by followed by a second announcement is
  not — nothing in this model expects one ([above](#the-call-and-its-result)).
  A start that does name its query or page is announced there, and not again.
  The cost is a search cut off before it completes: it leaves no row, as it
  left none before.
  An image generation is announced at `item/started` either way — it ran 14s
  when measured — with no prompt: 0.171.0's start carries `revisedPrompt:
  null` and no `savedPath`, its completion both, plus `result`, the image again
  as base64, which the schema does not list and which is not read.
- **A generated image is not a file change.** It is written under Codex's own
  directory (`~/.codex/generated_images/<thread>/<item>.png`), not the work
  directory, and it is an artefact the agent made rather than an edit to
  review, so it goes where `imageView`'s image goes — the row's attachment —
  and not into the turn's changes. A completion with no `savedPath` is a file
  block marked unavailable, said rather than decoded from the base64 copy.
- **`dynamicToolCall` cannot arrive today.** Dynamic tools are tools the
  client registers on `thread/start`, and Pockode registers none. It is mapped
  anyway because the cost is one case and the alternative is a call that
  vanishes the day one is registered — which is exactly the bug this section
  closes. `sleep` and the agent calls are mapped from the schema too: the CLI
  could not be made to produce them on demand, so their shapes are the
  schema's, not a measurement's.

Not tool calls, and still not drawn: `plan` (the agent's own plan text — the
`turn/plan/updated` stream is the plan's channel), `contextCompaction`,
`enteredReviewMode` / `exitedReviewMode`, `hookPrompt`, and
`functionCallOutput`, which 0.171.0 added: the output of a call announced as
some other item, with no call of its own to join to. What it carries in
practice is unmeasured, and it is logged at debug and dropped until it is.

### Live progress

| | Claude | Codex |
|---|---|---|
| Incremental output | **none** | `item/commandExecution/outputDelta` → `{itemId, delta, threadId, turnId}` — true stdout/stderr deltas |
| One-line status | `system` / `task_progress` | `item/mcpToolCall/progress`.`message` |
| Other progress fields | `task_progress` also carries `tool_use_id`, `last_tool_name`, `usage{total_tokens, tool_uses, duration_ms}`; a subagent's become `subagent_progress` on `tool_activity` | — |

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

Codex has no notion of a backgrounded tool call: a codex turn blocks on its
command. (A Codex subagent's spawn can outlive the turn, but it is settled by the
child's own turn ending, not by anything here —
[code/agent-integration.md](code/agent-integration.md#subagent-threads).) Everything in this section is Claude's, and the model has to work
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
flavours, and one of which can also point at another run — split on the rule the
project applies everywhere: *an event says what was true at one moment, state
says what is true now.*

| Record | Persisted | Says |
|---|---|---|
| `tool_call` | yes | the agent asked for this, with this input |
| `tool_call` + `origin_tool_use_id` | yes | …and what it asked for is the output of *that* earlier call |
| `tool_result` | yes | this came back to the agent |
| `tool_result` + `subtype: "background_started"` | yes | …and it is a placeholder; the work is still running |
| `tool_result` + `subtype: "background_result"` | yes | the real outcome of that work, as the CLI reported it |
| `tool_result` + `subtype: "background_lost"` | yes | …or the outcome Pockode wrote itself, because the CLI never will |
| `tool_result` + `work_ref` | yes | …and the call acted on *this* work item, which was titled so at that moment ([below](#a-call-on-pockodes-own-work)) |
| `tool_activity` | **no** | what a call that has not returned is doing right now |
| `text` / `tool_call` / `tool_result` + `parent_tool_use_id` | yes | …and it happened inside *that* subagent call, not in the main conversation |

And one derived object, `ToolRun`: the server's projection folds the records
into a tool item ([agent-integration.md](code/agent-integration.md#the-history-projection)),
the client's transcript builds the run from it, and the UI renders that without
inferring anything.

### `ToolRun`

```ts
interface ToolRun {
    id: string                 // tool_use_id / codex item id
    name: string               // engine-neutral: Bash, Edit, Read, server:tool, …
    input: unknown             // complete, never truncated
    status: ToolRunStatus
    /** The latest one-line status of a call still running. Live state: absent from history. */
    activity?: string
    /** The tail of a running call's output, if the engine streams one. Live state. */
    output?: string
    /** How many first lines `output` has lost to the client's 200-line cap. Live state. */
    outputDroppedLines?: number
    result?: string
    /** The placeholder a backgrounded call handed back, kept beside the outcome. */
    placeholderResult?: string
    contents?: ContentBlock[]
    /** Set when the result above is a background outcome, not what the agent read. */
    fromBackground?: boolean
    /** Its background work died with the CLI process: nothing came back. Replay-safe. */
    lostWithProcess?: boolean
    /** What later calls fetched of this call's task, oldest first. Replay-safe. */
    fetches?: ToolFetch[]
    /** How long the call took, when the engine says so. Replay-safe; only ever the engine's. */
    durationMs?: number
    exitCode?: number
    /** When the call started running, on the server's clock. Replay-safe — see below. */
    startedAt?: number
    /** When the result that settled it was observed, on the server's clock. Replay-safe. */
    endedAt?: number
    /** The same start on this client's clock, for a live counter — see below. */
    seenAt?: Date
    /** A subagent call's own text and calls, in arrival order. Replay-safe. */
    children?: ContentPart[]
    /** The work item a Pockode work tool acted on, as of the call. Replay-safe. */
    workRef?: WorkRef
}

type ToolRunStatus = 'running' | 'background' | 'success' | 'error' | 'interrupted'

interface ToolFetch {
    id: string                 // the tool_use_id of the call that fetched this
    /** running until its result arrives; interrupted when what ends a running run ended it first. */
    state: 'running' | 'returned' | 'interrupted'
    result?: string            // read exactly as a run's own outcome is: contents first
    contents?: ContentBlock[]  // both absent on a returned fetch = it came back empty
    isError?: boolean          // the fetch failed, not the task it was reading
    /** The fetch waits for the task to finish (`block` not false), rather than reading at once. */
    waits: boolean
    /** The fetch's start on this client's clock, for its own counter — read as a run's seenAt is. */
    seenAt?: Date
}

interface WorkRef {
    id: string
    type: 'story' | 'task' | 'job'
    title: string              // as it stood when the call was made — never re-read
}
```

Status is derived from the records by the server's projection, and sent as the
tool item's `status`, which the run's is read from:

| Status | Derived from |
|---|---|
| `running` | a call with no result yet |
| `background` | newest result carries `background_started` |
| `success` | a result with `is_error` false |
| `error` | a result with `is_error` true — including a `background_lost`, which is one by construction, when it reaches a run still `background` |
| `interrupted` | the turn was cut short, or the process ended under background work; a result arriving afterwards does not undo it |

How the item's statuses are read onto the row's, and which are drawn as a card
instead, is in [code/frontend-state.md](code/frontend-state.md#tool-runs).
Deliberate omissions,
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
- **No permission field.** It stays its own part, with its own lifetime and its
  own buttons.
- **No status field on any record.** Every input to the derivation above is
  already in the history the projection folds.

### Observed times and reported durations

A run's timing has two authors, and the model keeps them in separate fields so
neither can be mistaken for the other:

- **`durationMs` is what the engine reported** — codex on commands and MCP
  calls, Claude for a subagent, `WebFetch`, `WebSearch` and a backgrounded
  task's outcome ([agent-integration.md](code/agent-integration.md#history-records-and-live-events)
  has which keys, and why each is read only for its own tool). It is the
  engine timing its own work.
- **`startedAt` / `endedAt` are what Pockode observed** — the `observed_at` the
  server stamps on a record as it comes off the CLI, on the server's clock
  (same section). They are the same live, on reload and a year later, because
  they are history, not something a client measured.

| | Observed as |
|---|---|
| `startedAt` | the `tool_call`'s `observed_at` — or, for a call that waited on a permission card, the `observed_at` of the `permission_response` that let it run, which is later. Absent when that answer carries none: counting from the call would count the user's wait |
| `endedAt` | the `observed_at` of the `tool_result` that settles the run — for a backgrounded call the outcome, never the `background_started` placeholder |

Neither is ever taken from the turn's or the process's ending: `done`,
`interrupted` and `process_ended` say when Pockode gave up on a call, not when it
finished, and a `background_lost` carries no `observed_at` at all. So an
interrupted call whose result never came has no `endedAt`. A record written
before the stamps existed has no `observed_at`, and its run no observed duration
— nothing is reconstructed from when a client received it.

**`seenAt` is the same start on this client's clock**, which is the only thing a
live counter can subtract from `Date.now()`. A start this client watched arrive
is the moment it arrived; a start known only from history is `startedAt` carried
over through the `server_time` reading its history page came with
([agent-chat.md](agent-chat.md)). Without either it is absent and no counter is
drawn: a server time subtracted from the phone's clock would show drift as work.

Which figure a row shows, and when, is the UI's decision
([tool-call-ui.md](tool-call-ui.md#elapsed-and-duration-meta));
`toolRunDurationMs` (`web/src/lib/toolRun.ts`) applies the precedence — the
engine's figure when there is one, otherwise `endedAt − startedAt`.

### A call about an earlier call

Claude's `TaskOutput` fetches the output of a task started earlier. Its input
names a `task_id` — the CLI's own key for the task — and nothing else, so on its
own it joins to nothing: the transcript's key is the `tool_use_id`, and the map
between the two exists only inside the adapter, where `task_started` delivered
both at once ([the task lifecycle](code/agent-integration.md#the-task-lifecycle)).

So the adapter answers the question while it still can, and the `tool_call`
record carries `origin_tool_use_id`: **the call this call is about.** A client
that has it can show the fetched output on the row that started the work instead
of as an unconnected row quoting an opaque id.

Three things this is deliberately not:

- **Not a second join key.** One tool run is still one `tool_use_id`, and the
  fetch is a tool run of its own like any other. This field points *from* one run
  *to* another; it does not merge them.
- **Not a `tool_result` on the original call.** That was the tempting shortcut
  and it is wrong twice over: a later result supersedes an
  earlier one, so the original call's real outcome would be overwritten by
  something the agent never read — and it would settle on the wire what the row
  should show, which is the frontend's decision everywhere else in this document
  (same reason as "No `title` or `detail` field").
- **Not reliable, by construction.** The adapter forgets a task the moment it
  reports its outcome, and remembers nothing across a restart, so a fetch against
  a task that already settled — or that a previous process started — resolves to
  nothing and the field is absent. **Absent is the ordinary case, not an error
  path**: a client has to read a fetch with no origin as a perfectly good call
  that simply stands alone.

Codex has no backgrounded call whose outcome a later tool fetches, so it has no
tool shaped like this one.

**A stop is a call about an earlier call too.**
`TaskStop` — `KillShell` before claude renamed it, which history still holds
(2.1.330 lists `KillShell` and `KillBash` as aliases of `TaskStop`) — names a
task the same way, by `task_id` (`shell_id` on the old name, still accepted as
a deprecated field), and the adapter resolves it through the same map and
stamps the same `origin_tool_use_id`. It arrives while the task is still
running, so it resolves whenever the task was started by this process. Unlike
a fetch it is **never filed under its origin**: stopping work is something the
agent did, with consequences, and it keeps a row of its own; the field only
lets that row point at the work it stopped
([tool-call-ui.md](tool-call-ui.md#the-remaining-tool-kinds)). The origin row
learns that it was stopped from its own `task_notification`, as it always did
— never from the stop.

**Which CLIs still fetch.** Measured on claude 2.1.330, the `init` frame offers
`TaskStop` and neither `TaskOutput` nor `BashOutput`; the CLI keeps both, with
`AgentOutput` and `BashOutputTool`, in a set of names it no longer offers. So
this section, and the in-flight fetch below, are for the older CLIs Pockode
still runs and for every history they wrote. How 2.1.330 reads a background
task's output instead — a `Read` of its `output_file`, or `Monitor` — is
unmeasured, and filing such a read under its origin is a separate decision.

**A fetch in flight is state its item holds.**
`TaskOutput` blocks for up to 30 seconds by default, and a fetch filed under its
origin draws no row, so for those seconds nothing said the agent was waiting
on it. The entry is therefore created `running` when the `tool_call` is filed,
and becomes `returned` when its result arrives — carrying nothing for an empty
answer, which is a returned fetch and not a missing one. It becomes
`interrupted` exactly where a running run would: the turn's interrupt, a Stop's
sweep, the process ending — on a `background` run too, whose task outlives the
turn while the call reading it does not. A result reaching an interrupted fetch
is kept and does not make it `returned`, as with a run. Being the fetch's own
item, its state is the projection's like any run's: a fetch whose turn ended
without its result reads `interrupted`, while one reloaded in the middle of its
own turn is still `running`. `waits` is read off the fetch's own input (`block`, true
when absent) and only chooses a word. `seenAt` is a run's `seenAt` for the
fetch's own item: when this client saw it start, or its `started_at` carried
over through the history page's `server_time` on a reload, and absent
without either — then no counter is drawn
([above](#observed-times-and-reported-durations)).

What the frontend does with it — when a fetch is filed under the row it names,
and when it keeps a row of its own — is in
[code/frontend-state.md](code/frontend-state.md#a-fetch-filed-under-the-call-it-reads).

### A call on Pockode's own work

Pockode's work tools (`story_create`, `task_start`,
`step_done`, … — [code/work-system.md](code/work-system.md#work-tools)) act on
a work item, and the row for one wants to say which item and link to it. The
input names it for most calls (`id`, `work_id`, `story_id`), but a creation
names none — the id exists only once the call has returned, inside the
executor's result prose (`Created task "…" (ID: …)`) — and no input carries the
title.

So the server stamps the result, exactly as it stamps a page tool's result with
its page ([`HTMLPage`](agent-event.md#records-serialization),
`process.pageCalls`): a `workCalls` beside it notes a Pockode work tool's
`tool_call` by name, and when its result arrives successful, writes
`work_ref: {id, type, title}` onto the `tool_result` before it is recorded or
broadcast. For a call whose input names the work, the id is the input's and the
type and title are read from the work store when the `tool_call` is noted — so
a `work_delete` still says what it deleted. For a creation the id is the one
the result reports — read by a parser kept beside the executor's own wording
(`work.IDFromCreateResult`, tested against it, as `htmlpage.IDFromResult` is) —
and the type and title are read once the result is in.

That is an event and stays one:

- **It says what was true when the call was made**, and stays true. The title
  is the one the work had then; renaming the work later leaves the record — and
  the row — saying the old one, the rule a work event line already follows
  ([code/work-system.md](code/work-system.md#rendering-in-the-transcript)).
- **It carries no status, no step and no activity.** Not even the status the
  call itself just set: `story_start` leaves a story `active`, and a record
  saying so would be wrong the moment the story stops. Whatever is shown about
  the work *now* is read from the work store by `id`, by whoever shows it.
- **Absent is ordinary.** A failed call, a call whose id names no work, a
  comment edit (its input names a comment, not a work), and every record
  written before this existed carry none, and a client reads the input's id
  instead, where there is one.

Only the main server can stamp it: the MCP process is a proxy and the executor
never learns the CLI's tool call id, which is the same reason pages are stamped
there. Both engines go through it, so a Codex `pockode:task_create` is stamped
like a Claude `mcp__pockode__task_create`. `workRef` on `ToolRun` is copied
from the record and nothing else.

As built:

- **The pieces.** `agent.PockodeTool` reads the bare tool name off either
  engine's (`htmlpage.IsPageTool` takes the bare name too now);
  `work.ToolTarget` is the table of which tool names its work by which argument
  (`id`, `work_id`, `story_id`) and which two create one; `work.CreateResult`
  is the executor's wording and `work.IDFromCreateResult` reads it back from
  the end, since the quoted title before the id may hold anything. The work
  store reaches the process through `Manager.SetWorkLookup`; a manager given
  none stamps nothing.
- **Which calls are stamped.** The twelve whose input names a work, and the two
  creations. A comment edit, `story_list` and the role tools act on no work
  and never are.
- **The title is read when the `tool_call` arrives**, which both engines send
  before the MCP call runs (Claude's assistant message ahead of its tool
  execution, Codex's `item/started`). Were a CLI ever to report the call only
  after running it, a `work_delete` would find nothing and go unstamped, and a
  retitling `work_update` would record the new title — absent or late, never
  a wrong work.
- **A client reads `work_ref` strictly**: an id and a known type, or nothing.
  A missing title reads as empty rather than dropping the work, since the id
  is still where *Open* leads.

### `tool_activity` is not persisted

It is the only event Pockode broadcasts without writing to history, and that is
the point: a progress line is *the latest value*, and a snapshot of it in the
transcript becomes a lie the moment the next one arrives — the same argument that
keeps token usage out of the stream
([agent-event.md](agent-event.md#what-is-not-an-event)).

That needed a fourth question beside the three predicates `EventType` already
answered, and **a new event type now has to answer all four**:

| Question | `tool_activity` | Why |
|---|---|---|
| Persisted (encodes as an `agent.Record`, not an `agent.LiveEvent`) | **false** | see above |
| `AwaitsUserInput` | false | nothing is blocked on the user |
| `IndicatesAgentActivity` | true | it only ever arrives while a call is live |
| `ActivatesSession` | false | it is the CLI reporting, not the agent contributing |

**Persisted has no default at all, while the other three are allowlists.** The
three are allowlists because of what a wrong inclusion costs on the expensive
side: `AwaitsUserInput` and `ActivatesSession` confiscate the user's escape hatch
or end a wait that is not over, and nothing downstream corrects either
([code/agent-integration.md](code/agent-integration.md#what-an-event-says-about-process-state)).
Persisted is decided by the type the event encodes as, so a new event type
cannot be written without choosing — and recording is the choice to reach for:
an event says what was true at one moment, and that stays true.

`IndicatesAgentActivity` being true says the turn is alive without saying the
agent contributed anything to it, which is exactly what a progress line is. It
does **not** buy a parked turn more time: the background budget is a flat cap on
how long a turn may stay parked, not a silence budget ([The Lease
Table](code/agent-integration.md#the-lease-table)). Because that predicate is
written as a union with `ActivatesSession`, answering it `true` while
`ActivatesSession` stays `false` means naming the type in it explicitly — which
is what an allowlist is for.

**A client that subscribes mid-run has missed everything it was not listening
for**, and on a phone that is the normal case, not an edge. So the chat watcher
keeps each in-flight call's stream — its newest activity line, its subagent
progress and the output it has streamed — and hands it to a client that
subscribes, with the deltas after continuing it exactly
([agent-chat.md](agent-chat.md#live-updates)). It is bounded by the calls
actually in flight: a stream ends when the call's item is no longer in flight —
which the projection says, not a `tool_result` — so a backgrounded call's
placeholder result does not end it, since all the progress worth keeping arrives
after it. The output kept is bounded too (its tail, past a megabyte): the whole
of it arrives with the result.

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
for not adding a message type: the projection already joins a `tool_result` to
its call by id, overwriting is exactly the wanted behaviour, and history is
append-only so the later record wins on every path without anyone ordering it.
A new type would fork both for no behavioural gain.

Being a result does not make the outcome record a turn signal. It says how the
work ended, not anything the model said, so it neither ends a
background wait nor opens a turn; what the model writes after it does
([Background Waits](code/agent-integration.md#background-waits)). The same holds
for `background_lost` below.

The `subtype` is what keeps it honest. The placeholder is what the *agent* read;
the outcome is what *happened*. A row that shows the second without saying so is
asserting the agent saw something it did not, so both are kept and the UI labels
which is which.

`output_file` is a path on the server's machine, which is what `FileBlock.Path`
already describes — display, and an offer to open it in the Files tab when it is
under the work directory ([agent-event.md](agent-event.md#records-serialization)).
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

Nothing needs a fourth status. By the time the record arrives the row is normally
settled already: the process's own `process_ended` interrupted the background
work it took down, and a later result does not undo an interrupt
([code/frontend-state.md](code/frontend-state.md#tool-runs)). The record is the
explanation, and where that ending is not loaded or was never written,
`is_error` makes the run `error`. The record does not restate that the call was
a background one, and the client does not infer it from an earlier
`background_started` either: it treats both background subtypes as saying so
themselves. That is not belt-and-braces. A call
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
ids with no count reach the rows only, and a record written before `lostCalls`
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

### A subagent's own conversation

This was out of scope once, on the grounds that no problem here asked for it.
That was wrong, and the owner reversed it: the real stream interleaves a
subagent's text and tool calls with the main agent's, and drawn flat they are
indistinguishable — the one place the transcript makes a reader misjudge *who
did what*. The drawing is
[tool-call-ui.md](tool-call-ui.md#a-subagents-own-work); what it needs from the
model is this:

- **The join is the spawning call's `tool_use_id`.** Every `assistant` and
  `user` message Claude emits for a subagent carries `parent_tool_use_id`
  naming the `Task` / `Agent` call it runs under (`null` for the main agent).
  It is the same key every other record here joins on, so no second one is
  introduced.
- **It is persisted with the record** — `parent_tool_use_id` on `text`,
  `tool_call` and `tool_result` — not reconstructed on the client.
  Replay has to file a subagent's work exactly as the live stream did, and a
  record that does not say whose it is cannot be filed by anything later. A
  record without it is the main agent's — which is also what every transcript
  written before this reads as, and they stay flat. A record whose parent is not
  loaded stays where it is too: the call may be on an earlier page, or one no
  client draws.
- **A run owns its children in arrival order: text and tool runs alike**, each
  child an ordinary part that would otherwise sit in the message. They are not
  a second kind of tool run; a child tool run is a `ToolRun` with every rule
  above, and a child that is itself a subagent call owns children of its own.
  Claude's `task_started` carries `spawn_depth`, so that recursion is a case the
  CLI names.
- **Steps are derived, not sent**: the count of child calls (by `tool_use_id`,
  whether a row or a card stands for one at the moment), and the newest child,
  are read off the children — the same reason there is no `title` field.
- **A settled subagent settles what it leaves running.** A child still
  `running` when its parent settles is `interrupted` with it; a backgrounded
  child keeps its own lifecycle and settles by its own notification. The rules
  belong to the server's projection; how the client draws the nesting is
  [code/frontend-state.md](code/frontend-state.md#a-subagents-children).

Codex names the parent too: a subagent runs in a thread of its own, and the
adapter stamps that thread's items with the id of the spawn call it saw start
it. The spawn itself is drawn as a `Task` call carrying the agent's path or its
prompt in place of a description, and settled by the child's turn ending, so a Codex
subagent nests exactly as a Claude one does
([code/agent-integration.md](code/agent-integration.md#subagent-threads)).

## Out of scope

- **`functionCallOutput`**, until what it carries is measured
  ([above](#codex-items-beyond-commands-patches-and-mcp)). Every other
  tool-shaped Codex item is now a tool call.
- **Per-call token cost.** Claude's `task_progress.usage` and
  `task_notification.usage` report it. Usage is session state with an owner
  ([usage-display-ui.md](usage-display-ui.md)), and attributing it per call is a
  separate feature, not a field on a row.
- **A total of a turn's or a group's calls.** Each run now has a duration, and
  a sum of them is a turn-level summary — its own feature, not a field on a
  row.
