# Turn Progress UI

How the transcript says that a turn is alive and what the agent thought on the
way. Two elements, one grammar:

- **The thinking row** — what the agent thought, as one muted, foldable line in
  the transcript: `Thought for 12s`, opening on the full text.
- **The tail line** — the one line at the end of the reply being written while
  the turn runs: `Working  1m 4s`, or `Thinking… <latest line>` while the agent
  is thinking. It is gone when the turn settles.

The surfaces around them are [tool-call-ui.md](tool-call-ui.md) (the list,
groups, the turn's changes) and [lifecycle-ui.md](lifecycle-ui.md) (`Activity`,
the attention strip, Stop). This document only adds to them, and every rule
below that touches one of theirs says which.

## The problem

During a long think, or a long command, the screen holds a Stop button and
nothing else that moves. A reader cannot tell a turn that is working from one
that hung, and everything the agent reasoned on the way is thrown away: the
Claude adapter skips `thinking` blocks, and the codex adapter has no case for a
`reasoning` item and drops its delta notifications unread. Comparable products
answer both with one folded line — *Thought for Ns* — that costs a line and
gives the reader a pulse.

## The rules

**The tail line says one thing: the turn is producing, and for how long.** It
never names a tool, a command, a file or a blocker. Those are said by the rows
above it and by the attention strip below, and a second copy of any of them is a
copy that can disagree (§4 has the boundary in full).

**Thinking is a part of the reply, stored as a record; "is it thinking right
now" is not stored at all.** A settled thinking is history — what was thought,
and for how long — and goes into the transcript like a tool call does. Whether a
turn is running is live state owned by the session's `TurnState`
([lifecycle.md](lifecycle.md#session-one-reducer)), and the tail line reads it
from there and nowhere else. Nothing on screen infers liveness from the last
record, which is the rule [AGENTS.md](../AGENTS.md) states and the mistake
`isProcessRunning` used to make
([lifecycle-ui.md §2.4](lifecycle-ui.md#24-recovering-a-dangling-turn-after-a-restart)).

**A number is shown only when it was measured.** A duration that was not
recorded is left out, never estimated by the client from when records reached
it — the rule the tool row's meta already follows
([tool-call-ui.md](tool-call-ui.md#elapsed-and-duration-meta)).

**Times have one format.** Both elements use the live tool counter's: whole
seconds below a minute (`12s`), then two units (`4m 12s`, `1h 12m`). Not the
finished tool row's tenths (`1.2s`): a thinking time and a turn clock are read
as a pulse, not compared to the decimal.

## 1. The thinking row

```
┌───────────────────────────────────────────────┐
│ ›  ✻  Thought for 12s                         │  ← muted title, no accent
├───────────────────────────────────────────────┤
│ ›  ✓  Read   server/relay/sender.go           │
└───────────────────────────────────────────────┘
The sender retries on 429 and 503.
```

### 1.1 What it is

A row in [the list](tool-call-ui.md#the-list): the tool row's box (`RowButton`),
so its height, hover, focus ring and touch floor cannot differ from a tool
row's. It is told from a tool row by what it lacks, the way a group's summary
is: **no accent title and no detail** — the title is `text-th-text-secondary`,
the glyph is lucide `Brain` in `text-th-text-muted`, and the meta slot stays
empty (the duration is in the title, where it reads as a sentence).

| Case | Title | Chevron / body |
|---|---|---|
| text, duration known | `Thought for 12s` | opens on the text |
| text, duration unknown | `Thought` | opens on the text |
| redacted, no text | `Thought for 12s` + chip `hidden` | no chevron, not a button — §1.4 |
| empty (no text, not redacted) | `Thought for 12s` | no chevron, not a button — §1.4 |

A duration is rounded **up** to whole seconds, so a think that happened is never
`0s`. That is the opposite of the finished tool row, which hides a sub-second
time: a 40ms `Read` is noise, but a row that says `Thought for` needs a number
or none at all.

**Consecutive thinking parts are one row** — the engine splitting one pause into
two blocks is not something the reader can use. Parts that are not drawn at all
(§1.4, last paragraph) are set aside first, so they neither break a run nor
cost a sum its number. The merged row:

- shows the sum of the durations only if every part has one, and `Thought`
  otherwise — a sum over some of them would understate it;
- is a button and has a body if any part has text. The body holds the texts in
  order with a rule between them; a redacted part stands in its place as the
  muted line *Hidden by the model provider.*; an empty part contributes nothing;
- is the `hidden`-chip row of the table above only if no part has text and at
  least one is redacted.

### 1.2 Where it goes, and groups

In transcript order, where the engine produced it — usually before a tool call
or before the answer text. It is a list member, so a thinking next to tool calls
shares their frame, and one standing alone before text is a list of one row,
exactly as one call alone is.

In [groups](tool-call-ui.md#groups) a thinking part is **foldable, but it is
not a call**:

- **It never breaks a run.** Claude interleaves thinking with tool calls
  (think → `Read` → think → `Edit` …), and codex sends a reasoning item before
  most calls; if thinking ended a group, a fourteen-call turn would never fold.
- **It does not count toward the two-call minimum**, and is not a step in the
  running form's `N steps` nor in a subagent's second line. With codex, a
  thinking before nearly every call would otherwise fold every single call into
  a summary that hides its own title — the very case the minimum exists for. So
  a thinking and one call lie flat as two rows; a group that forms for two calls
  takes the thinking among them with it.
- **The summary's settled verbs gain one last entry**, after `Used N tools` and
  before `N interrupted` — least consequential, so it is the end a narrow screen
  cuts: `Thought for 1m 20s`, the sum over the folded thinking, under the
  merged row's rule (every part measured, or the entry says `Thought`).

[The turn's changes](tool-call-ui.md#the-turns-changes) does not change:
thinking edits nothing, and the card lists files.

### 1.3 Opening it

A tap opens it in place, at every width, like a tool row: `CollapsibleBody` →
`ScrollableContent max-h-[60vh]` on `bg-th-bg-secondary`. The text is rendered
through `MarkdownContent` at `text-sm` in `text-th-text-secondary`: codex
summaries are Markdown with a bold heading per part, and Claude's thinking is
prose that sometimes uses lists. Not a sheet, for the reason the changes card
gives: on a desktop the sheet is narrower than the column being read.

A codex reasoning item carries two lists of parts: `summary` (written for a
reader) and `content` (the raw reasoning, usually empty for OpenAI models). Each
list's parts are joined as paragraphs. The body shows the summary; if `content`
is non-empty too, it follows under a muted `Full reasoning` label. With only one
non-empty, that one is the body, unlabelled. Nothing is dropped and nothing is
labelled twice.

Nothing opens the row but the user, and nothing closes what they opened — the
list's `rowExpansionContext` rule. A tail line the user opened while it said
`Thinking…` (§2.3) settles into a row that is open.

### 1.4 Redacted and empty thinking

**Redacted** (`redacted_thinking`: the model provider encrypted the block) keeps
its row, because *that the agent thought, and for how long* is the pulse the
reader came for. It has a `hidden` chip — the `background` chip's component —
and no body: a row that opens on "there is nothing here" is a tap spent to learn
nothing, so the reason is in its accessible name (§5) and the row is not a
button.

**Empty** — a thinking block with no text, or a codex reasoning item whose
`summary` and `content` are both empty — draws the same row without the chip.
It is not hidden; nothing was shared.

An empty part with no duration is not drawn at all: a bare `Thought` with
nothing behind it is noise.

### 1.5 Where the duration comes from

The duration is a fact about a finished thinking, so it is **measured by the
server while the thinking happens and written once, on the thinking record**;
replay draws it from there. That is what lets a reloaded, reconnected or
year-old transcript still say `Thought for 12s`, and the client never measures
it.

| Engine | Measured as |
|---|---|
| codex | `completedAtMs` of the item's `item/completed` minus `startedAtMs` of its `item/started` — the engine's own clock, which both notifications carry |
| claude | from the thread's last transcript output before the block — a text, a tool call, a tool result, or the message that opened the turn — to the block's arrival. A subagent's thread starts at the call that spawned it |

For Claude, *transcript output* is deliberate. The CLI also writes
`thinking_tokens` estimates while it thinks, and its subagents' lines and its
bookkeeping frames share the same stdout; measuring from the last line of any
kind would yield `0s` nearly every time. The figure includes the model's time to
its first token, so it is "how long the agent was quiet before saying this",
which is what the reader lived through.

**Why this is not the arrival-time guess the tool model rejects.**
[tool-call-model.md](tool-call-model.md#toolrun) gives Claude tool rows no
duration because the only clock a *client* has is when it received a record,
which is meaningless on replay. Here the server takes the reading live, at the
one moment it means something, and stores the result as data — what
`durationMs` is for codex. Doing the same for Claude's tool calls would be
possible and is not part of this design.

A thinking whose engine path gave nothing to measure has no duration, and the
row says `Thought` (§1.1).

## 2. The tail line

```
… the last rows of the reply being written …
⟳  Working                                1m 4s     ← the tail line
```

```
⟳  Thinking… Checking how the sender retries   1m 4s
```

### 2.1 Where it is

**In the turn-end slot of the reply being written** — the place the turn-end
row (`MessageActions`: Copy, Fork, `…`) takes once the turn settles, and where
its spinner stands today. The tail line replaces that spinner; there is never a
second one. It is part of the transcript, so it scrolls with it: a reader
following the tail sees it under the newest content; a reader scrolled up is not
chased by it — Stop, in the composer, says the turn is open at every scroll
position.

There is at most one reply being written, so there is at most one tail line:

- **Before the agent has written anything** it is the only content of the
  optimistic placeholder under the user's message (`hasUnansweredEcho`,
  [lifecycle-ui.md §2.3](lifecycle-ui.md#23-chat-composer-and-stop)).
- **A message sent mid-turn** stays under the reply it was sent into until the
  agent reads it ([the read point](code/agent-integration.md#the-read-point)): the
  tail line stays at the end of that reply, *above* the unread message, because
  that reply is where the work is happening. At the read point a new reply opens
  under the message and the tail line moves into it, its clock unchanged.

**Its row** is unframed, on the list row's columns, so it lines up with the rows
above it: the chevron column (empty unless there is a body to open, §2.3), the
glyph column, the label where a row's title starts, the clock in the meta slot.
Its height is the turn-end row's (both hold `min-h-9`, `pointer-coarse:min-h-11`),
and **the slot keeps that height while the line is hidden**: when the turn
blocks and resumes, nothing above or below moves; when the turn settles, the
turn-end row takes the same height.

### 2.2 When it shows

While the session's activity is `running`
([lifecycle-ui.md §1.1](lifecycle-ui.md#11-activity)) — `turn.phase == running`
— and, before the server has said so, while the optimistic placeholder is up.
Nothing else shows it and nothing else hides it.

| Turn | Slot | Who says it instead |
|---|---|---|
| `idle` | the turn-end row | — |
| `running` | the tail line | — |
| `blocked(permission)` | empty, height kept | the attention strip's permission row and the card |
| `blocked(background)` | empty, height kept | the attention strip's background row |
| placeholder up, server not yet reporting | `Working`, no clock | — |

**Under `blocked` this changes what is drawn today**: the turn-end row's spinner
keeps turning while a turn waits on a permission or a background task. It stops
because a blocked turn is not producing, and a spinner over a two-hour
background wait is exactly what
[lifecycle-ui.md §1.1](lifecycle-ui.md#11-activity) removed; the strip states
the wait instead. When the turn goes back to `running` the line comes back with
the turn's clock, which kept running underneath.

### 2.3 What it says

Two states, one line. The glyph and the clock stay put across the switch, and
only the words change — it is one line saying what the turn is doing now, not
two elements taking turns.

| State | Glyph | Label | Meta |
|---|---|---|---|
| working | `Spinner`, `text-th-accent` | `Working` | turn clock |
| thinking | `Spinner`, `text-th-accent` | `Thinking…`, then the latest line when there is text | turn clock |

Label in `text-th-text-secondary`, latest line and clock in
`text-th-text-muted`, `text-xs` — the strip's and the fork banner's size,
because it is a statement about the transcript, not content. Under
`prefers-reduced-motion` the glyph is a still `CircleDot` (the `running` glyph,
[lifecycle-ui.md §1.1](lifecycle-ui.md#11-activity)); the clock and the words
already say the turn is alive, and the shared `Spinner` does not stop itself.

**When it says `Thinking…`** — only on a signal from the main agent that it is
thinking *now*, which ends with that thinking's record — or with anything else
the main agent says next, since output proves the thinking is over even if its
record never comes:

- **codex**: a reasoning item has started and its text is arriving
  (`item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`). The *latest
  line* is the last non-empty line of the text so far, Markdown markers
  stripped — a summary part's bold heading is usually exactly that line — cut
  with an ellipsis at the column's edge. It may change several times a second
  and is drawn as it comes.
- **claude**: the CLI's `thinking_tokens` frames, which it writes while thinking
  without the partial-message stream. They carry a token estimate and no text,
  so Claude's line says `Thinking…` with no latest line and has nothing to open.
  They are the main thread's: a subagent writes none (measured on claude
  2.1.289), and a subagent thinking is not the main agent thinking (§3). Not
  every think writes them — a short one goes straight to its block — so the
  line may go from `Working` to a settled row without saying `Thinking…`.
  Claude's thinking
  *text* only arrives whole, with its block; showing it live would need the
  partial-message stream, which changes how every text block is read — a
  separate decision, not taken here.

When the thinking completes, its record settles as a thinking row (§1) directly
above the line, and the line goes back to `Working`. Outside a group the reader
sees the words become `Thought for 12s` and a fresh `Working` line appear under
them. Inside a formed group the row folds into the summary at once — its
`Thought for …` entry grows — unless the user had opened it.

**While it has text, the line is a disclosure** like the row it will become: the
whole line becomes the button (`RowButton`, so the tap target is the line, not
the chevron), a chevron appears, and a tap opens the text so far below the line,
growing in place. At the tail this pushes nothing. After a reconnect in the
middle of a thinking the deltas before it are gone (§2.4), so the open body
begins with the muted line *Earlier thinking appears in full when it finishes.*
— which it does, in the settled record.

**The turn clock** counts from the moment the turn opened, which the server
holds as live turn state, and it must not depend on the phone's clock agreeing
with the server's. So `TurnState` carries how long the turn has been open *as of
the moment the state is sent* (`open_elapsed_ms`,
[lifecycle-ui.md §1.3](lifecycle-ui.md#13-where-it-is-computed)), and the client
counts on from when it received it — not `since`, which is the current
*phase's* start and resets on every block and resume. Because the reading comes
from the server, a reload or a reconnect mid-turn shows the same clock it would
have shown anyway. It ticks every second at every length (`1m 4s` must not sit
for a minute, so this is its own tick, not the tool counter's minute-long one)
and is not shown under 3s, like a tool row's. Without a reading the clock is
left out and `Working` stands alone — the strip's rule for `since`.

### 2.4 Reconnecting, reloading, restarting

| What happened | What the reader sees |
|---|---|
| reconnect / reload mid-turn | the tail line, with the server's clock, from the subscription's `TurnState`; `Working` until the next thinking signal — earlier deltas were never stored, and the line does not pretend otherwise |
| reconnect mid-thinking, then it completes | its row settles with the server-measured duration, as if nothing had happened |
| the turn ends while you were away | no tail line; the reply has its turn-end row |
| the server restarted mid-turn | the turn is gone, so `phase` is `idle` and there is no tail line; the dangling reply is finalised by [lifecycle-ui.md §2.4](lifecycle-ui.md#24-recovering-a-dangling-turn-after-a-restart) |
| Stop during a live thinking | the line goes with the turn. Codex does not complete the item it cut off (measured on codex-cli 0.160.0), so there is no record and no row — the same on replay as live |

## 3. Subagents

A subagent's thinking is a thinking row in its
[Process](tool-call-ui.md#process), under the same rules, folded the same way.
A subagent has no tail line — its call row's spinner and second line already
are its pulse
([tool-call-ui.md](tool-call-ui.md#the-second-line-steps-and-what-it-is-doing)).
A subagent thinking does not move the main tail line to `Thinking…`: the main
line speaks for the main agent, and the subagent's row is where its work is
being described.

## 4. What it does not say

Every state the chat can be in already has an owner. The tail line takes the one
that had none — *running, with nothing to show yet* — and nothing else:

| Fact | Owner | Tail line |
|---|---|---|
| the turn is producing | **the tail line** (and the sidebar row's spinner, the same fact in a list) | the one thing it says |
| which call is running and for how long | the tool row / group summary | never names a call |
| a permission request blocks the turn | strip permission row, card | hidden |
| a background task holds the turn | strip background row | hidden |
| questions are waiting | strip question row | unaffected; both are drawn, they answer different questions |
| a message sent mid-turn is unread | strip receipt row | unaffected; the receipt is about the message, the line about the turn |
| the turn can be stopped | Stop in the composer | no Stop of its own |
| how the turn ended | the turn-end row, error / `Interrupted` lines | gone |

The tail line and a running tool row can be on screen together, both moving.
That is not duplication — one is a call, one is the turn — and it is what was
there already: the turn-end row's spinner stood under running tool rows before
this design, and the tail line is that spinner given words and a clock.

## 5. Accessibility

- **The thinking row** is a `<button>` with `aria-expanded` when it has a body.
  Its name is the sentence: *"Thought for 12 seconds"*. A redacted one, not a
  button, reads *"Thought for 12 seconds, content hidden by the model
  provider"*; an empty one *"Thought for 12 seconds, no content shared"*.
- **The tail line** carries a `role="status"` beside it, not around it, whose
  text is *"Agent is running"* — `ACTIVITY_VIEW.running`'s label, so this line
  and the session row's spinner are announced alike — and it is announced when
  the line appears, not when it switches between working and thinking: codex
  flips the two around almost every call, and a live region that spoke each flip
  would chatter. The words, the clock and the latest line are `aria-hidden`, and
  so is the `Spinner`, wrapped — it renders a `role="status"` of its own, and a
  second status nested in this one would be announced too. The thinking text so
  far is readable on request by opening the line, which is then a `<button>`
  with `aria-expanded` and a name of its own, *"Agent's thinking so far"* — its
  visible words are hidden, so without one it would be an unnamed button; the
  status sits beside that button so a press does not re-announce it.

## 6. Width and pointer

Nothing is width-dependent. Both elements are one line at every tier, a body
opens in place at every tier, and the latest line truncates at the column's
edge rather than wrapping. The thinking row and the tail line hold the row's
`pointer-coarse:` height floor. As for tool rows, nothing is behind hover
([tool-call-ui.md](tool-call-ui.md#width-and-pointer)).

## 7. Deliberately not done

- **Claude's thinking text, live** — needs the partial-message stream (§2.3).
- **A "no output for N minutes" warning.** The turn clock measures the turn,
  not the agent's health; a stall detector is a claim about the CLI that this
  line has no data to back.
- **Thinking token counts.** `thinking_tokens` is a per-delta estimate; it is
  read as a signal (§2.3) and its numbers stay unshown. Usage is its own surface
  ([usage-display-ui.md](usage-display-ui.md)).
- **Storing "currently thinking" as session state.** It lasts seconds, it only
  changes the tail line's words, and losing it on reconnect costs one word
  until the next signal. Making it state would be a field kept in sync for that.
