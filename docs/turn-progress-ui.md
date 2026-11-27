# Turn Progress UI

How the transcript says that a turn is alive and what the agent thought on the
way. Two elements, one grammar:

- **The thinking row** — what the agent thought, as one muted, foldable line in
  the transcript: `Thought for 12s`, opening on the full text.
- **The tail line** — the one line at the end of the reply being written while
  the turn runs: `Working 1m 4s`, or `Thinking… 1m 4s · <latest line>` while
  the agent is thinking. It is gone when the turn settles.

The same line also says what is running and how far the plan has come (§4),
as two counts and one stretch of words, and a tap on it opens one panel with
the details:

```
⟳ Working 3m 17s · ☑ 3/7 · ⧉ 2 · Now: Writing the retry tests  ›
```

- **The plan** — the main agent's latest plan: the `3/7` chip, and the panel's
  checklist.
- **The agents** — the subagents still working, wherever their rows are: the
  `⧉ 2` chip, and the panel's list that goes to each one.

When the turn settles, one more line says what the work came to — `Worked 2m 13s
· 14 tool calls · 3 files changed`, between the work and the answer: the
header of the turn's changes card, or a line alone when the turn changed no
file ([tool-call-ui.md](tool-call-ui.md#the-work-line)); the rules below hold
for it.

The surfaces around them are [tool-call-ui.md](tool-call-ui.md) (the list,
groups, the turn's changes) and [lifecycle-ui.md](lifecycle-ui.md) (`Activity`,
the attention strip, Stop). This document only adds to them, and every rule
below that touches one of theirs says which.

## The problem

Before this design, a long think or a long command left the screen holding a
Stop button and nothing else that moved. A reader could not tell a turn that
was working from one that hung, and everything the agent reasoned on the way
was thrown away: the Claude adapter skipped `thinking` blocks, and the codex
adapter had no case for a `reasoning` item and dropped its delta notifications
unread. Comparable products answer both with one folded line — *Thought for
Ns* — that costs a line and gives the reader a pulse.

## The rules

**The tail line says one thing: the turn is producing, and for how long.** It
never names a tool, a command, a file or a blocker. Those are said by the rows
above it and by the attention strip below, and a second copy of any of them is a
copy that can disagree (§5 has the boundary in full). The chips and words
in it that do name agents and a plan (§4) are not copies: they read the same
state the rows are drawn from, through the same wording.

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

**Times have one format.** Both elements, and the work line they settle
into, use the live tool counter's: whole
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

Alone, with no call beside it, the same row is drawn bare (§1.2):

```
✻ Thought for 12s ›
The sender retries on 429 and 503.
```

### 1.1 What it is

A row in [the list](tool-call-ui.md#the-list). Beside tool calls it is drawn
in the tool row's box (`RowButton`), so its height, hover, focus ring and touch
floor cannot differ from a tool row's; alone it is drawn bare (§1.2). It is
told from a tool row by what it lacks, the way a group's summary is: **no
accent title and no detail** — the title is `text-th-text-secondary`,
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
shares their frame. One standing alone before text is a list of one row, as one
call alone is — but **a list that holds nothing but thinking is not framed**:
no border, no hairline, and its row is drawn bare (`BareRow`):

- **On the text's left edge.** The glyph starts where the reply's text starts —
  the line the turn-end row's first icon stands on — with no chevron column
  before it. A frame's columns exist so its rows line up with each other; a
  row with no rows around it has nothing to line up with but the text.
- **The chevron after the words**, `Thought for 12s ›`, rotated when open, and
  only when there is a body to open (§1.1).
- **A box fitted to its words**, not spanning the column: with no frame around
  it, a full-width hover would be a bar floating in the transcript. The hover
  fill and the focus ring reach 8px out past the glyph and the chevron while
  the glyph stays on the text's edge; 8px because the narrowest gutter the row
  is drawn in is a subagent's Process (§3), whose rule the fill must not cover —
  for the same reason the ring is inset. Past the third level a Process has no
  gutter ([tool-call-ui.md](tool-call-ui.md#process)), and there the
  translucent fill crosses the rule on hover; that depth gets no special case.
  Its height is a tool row's, `min-h-9`, `pointer-coarse:min-h-11`, so the
  touch floor holds.
- **A row that is not a button keeps the same box**, so a `Thinking…` that
  gains text and becomes openable does not move by a pixel.
- **What it opens is a box of its own** under the row (`BareBody`): bordered,
  rounded, on `bg-th-bg-secondary`, from the text's left edge to the column's
  right — edge to edge with a framed list, holding the body §1.3 describes.

The tail line (§2) is drawn the same way, with the same body.

The frame came off because of what it cost on a phone. Nearly every reply opens
with a thinking, so nearly every reply opened with a bordered `Thought for 1s` —
about 60px of box on a phone for a line that says almost nothing, and on a
desktop an empty full-width frame. And the live `Thinking…` tail line it settles
from (§2.3) is unframed, so a frame appearing around it the moment it settled
was a jump on the one line the reader was watching. Bare, on the same edge and
at the same height as the tail line, `Thinking…` becomes `Thought for 12s` in
place. A thinking among tool calls keeps their frame, since there the frame is
the calls'.

In [groups](tool-call-ui.md#groups) a thinking part **folds, but it is not a
call**:

- **It never breaks a run.** Claude interleaves thinking with tool calls
  (think → `Read` → think → `Edit` …), and codex sends a reasoning item before
  most calls; if thinking ended a group, a fourteen-call turn would never fold.
- **It does not count toward the
  [two-settled-call minimum](tool-call-ui.md#groups)**, is in none of the
  summary's verb segments, and is not a step in a subagent's `N steps`. With
  codex, a thinking before nearly every call would otherwise fold every single
  call into a summary that hides its own title — the very case the minimum
  exists for. So a thinking and one call lie flat as two rows; a group that
  forms takes the thinking among its calls with it.
- **The summary gains one last segment**, after the
  [verbs](tool-call-ui.md#the-summary-row) and before `N interrupted` — least
  consequential, so it is the end a narrow screen cuts: `Thought for 1m 20s`,
  the sum over the folded thinking, under the merged row's rule (every part
  measured, or the entry says `Thought`). It is never the summary's only
  entry, since a group forms only on settled calls.

[The turn's changes](tool-call-ui.md#the-turns-changes) does not change:
thinking edits nothing, and the card lists files.

### 1.3 Opening it

A tap opens it in place, at every width, like a tool row: `CollapsibleBody` →
a padded box on `bg-th-bg-secondary` with no scroller of its own. A long text is
a main block, cut and faded at its end and opened in place or full screen like
a subagent's report (`HeaderlessMainBlock`; the transcript has [one vertical
scroll surface](tool-call-ui.md#one-vertical-scroll-surface)). The text is rendered
through `MarkdownContent` because codex summaries are Markdown with a bold
heading per part, and Claude's thinking is prose that sometimes uses lists —
in its `note` variant, the style a subagent's narration between its steps uses:
a tool row's size, in secondary colour. The same body is what the tail line
opens on as *the thinking so far* (§2.3). It was `text-sm` in
`text-th-text-secondary`, and on a phone that was not far enough from the
answer: 14px and one shade lighter, in abyss-light it could not be told from
the reply below it, and thinking opened in the middle of a reply must not read
as the main agent speaking. Not a sheet, for the reason the changes card
gives: on a desktop the sheet is narrower than the column being read.

A codex reasoning item carries two lists of parts: `summary` (written for a
reader) and `content` (the raw reasoning, usually empty for OpenAI models). Each
list's parts are joined as paragraphs. The body shows the summary; if `content`
is non-empty too, it follows under a muted `Full reasoning` label — a main
`Section`, clamped the same way, whose header pins while it is open
([tool-call-ui.md](tool-call-ui.md#the-pinned-section-header)). With only one
non-empty, that one is the body, unlabelled. Nothing is dropped and nothing is
labelled twice.

Nothing opens the row but the user, and nothing closes what they opened — the
list's `rowExpansionContext` rule. A thinking that settles while the status
line's panel is open on its text (§2.3) settles into a row that is open.

### 1.4 Redacted and empty thinking

**Redacted** (`redacted_thinking`: the model provider encrypted the block) keeps
its row, because *that the agent thought, and for how long* is the pulse the
reader came for. It has a `hidden` chip — the `background` chip's component —
and no body: a row that opens on "there is nothing here" is a tap spent to learn
nothing, so the reason is in its accessible name (§6) and the row is not a
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
| claude | from the thread's last transcript output before the block — a text, a tool call, a tool result, a previous thinking block, or the message that opened the turn — to the block's arrival. A subagent's thread starts at the call that spawned it |

For Claude, *transcript output* is deliberate. The CLI also writes
`thinking_tokens` estimates while it thinks, and its subagents' lines and its
bookkeeping frames share the same stdout; measuring from the last line of any
kind would yield `0s` nearly every time. The figure includes the model's time to
its first token, so it is "how long the agent was quiet before saying this",
which is what the reader lived through.

**Why this is not an arrival-time guess.** The only clock a *client* has is
when it received a record, which is meaningless on replay. Here the server
takes the reading live, at the one moment it means something, and stores the
result as data — what `durationMs` is for codex. Tool rows follow the same
principle by a different route: the server stamps when each call and result
arrived (`observed_at`), and the duration is the difference of the two stored
times
([tool-call-model.md](tool-call-model.md#observed-times-and-reported-durations)).
Thinking keeps a stored figure instead because nothing in history marks when it
began: its start is whatever the thread last output, which only the server,
watching the stream, can tell.

A thinking whose engine path gave nothing to measure has no duration, and the
row says `Thought` (§1.1).

## 2. The tail line

```
… the last rows of the reply being written …
⟳ Working 1m 4s                       ← the tail line
```

```
⟳ Thinking… 1m 4s · Checking how the sender retr… ›
```

### 2.1 Where it is

**In the turn-end slot of the reply being written** — the place the turn-end
row (`MessageActions`: Copy, Fork) takes once the turn settles, and where
that row's spinner used to stand. The tail line (`TurnTail`) replaced that
spinner; there is never a second one. It is part of the transcript, so it
scrolls with it: a reader following the tail sees it under the newest content;
a reader scrolled up is not chased by it — Stop, in the composer, says the turn
is open at every scroll position.

There is at most one reply being written, so there is at most one tail line:

- **Before the agent has written anything** it is the only content of the
  optimistic placeholder under the user's message (`hasUnansweredEcho`,
  [lifecycle-ui.md §2.3](lifecycle-ui.md#23-chat-composer-and-stop)).
- **A message sent mid-turn** stays under the reply it was sent into until the
  agent reads it ([the read point](code/agent-integration.md#the-read-point)): the
  tail line stays at the end of that reply, *above* the unread message, because
  that reply is where the work is happening. At the read point a new reply opens
  under the message and the tail line moves into it, its clock unchanged.

**Its row** is drawn bare, as a thinking alone in its list is (§1.2): the glyph
on the reply text's left edge, where the turn-end row's first icon will stand,
so the line settling into that row makes no sideways jump.

**The slot holds exactly one line for the whole open turn**, the turn-end
row's height (both hold `min-h-9`, `pointer-coarse:min-h-11`), in every phase —
running, either block, the placeholder — whatever the line shows or whether it
shows at all. The plan and the agents (§4) are chips inside that line, not
lines of their own, so they come and go on their own conditions and move
nothing; a turn that blocks and resumes moves nothing; and when the turn
settles the turn-end row takes the same height. An agents chip that outlives
the turn moves to the right of that row (§4.3), so settling moves nothing
either.

### 2.2 When it shows

While the session's activity is `running`
([lifecycle-ui.md §1.1](lifecycle-ui.md#11-activity)) — `turn.phase == running`
— and, before the server has said so, while the optimistic placeholder is up.
Nothing else shows the tail line and nothing else hides it. The chips have
their own rules (§4.2, §4.3) and outlast a block; the table below is about the
spinner, the label and the clock.

| Turn | Slot | Who says it instead |
|---|---|---|
| `idle` | the turn-end row | — |
| `running` | the tail line | — |
| `blocked(permission)` | the chips alone, if any; else empty — height kept, on a reload too | the attention strip's permission row and the card |
| `blocked(background)` | the chips alone, if any; else empty — height kept, on a reload too | the attention strip's background row |
| placeholder up, server not yet reporting | `Working`, no clock | — |

**Under `blocked` this changed what was drawn before**: the turn-end row's
spinner kept turning while a turn waited on a permission or a background task.
The line stops because a blocked turn is not producing, and a spinner over a
two-hour background wait is exactly what
[lifecycle-ui.md §1.1](lifecycle-ui.md#11-activity) removed; the strip states
the wait instead. When the turn goes back to `running` the line comes back with
the turn's clock, which kept running underneath.

**A reload keeps the spinner, label and clock off during either wait**, as live does: the
subscribe-time settle leaves the reply of an open turn `streaming`, whatever it
is blocked on
([lifecycle-ui.md §2.4](lifecycle-ui.md#24-recovering-a-dangling-turn-after-a-restart)
says why).

### 2.3 What it says

Three states, one line. The glyph stays put across the switch, and only the
words change — it is one line saying what the turn is doing now, not elements
taking turns.

| State | Glyph | Label | Clock | After the clock |
|---|---|---|---|---|
| working | `Spinner`, `text-th-accent` | `Working` | turn clock | — |
| thinking | `Spinner`, `text-th-accent` | `Thinking…` | turn clock | the latest line, as the free text below, when there is text |
| waiting for output | `Spinner`, `text-th-accent` | `Waiting for output…` (`Reading output…` for a fetch that does not wait) | turn clock | `Go to call`, beside the line |

**The rest of the line.** After the label and the clock come the plan chip
(`ListChecks` and `3/7`), when there is a plan (§4.2), and the agents chip
(`Bot` and the live count), while an agent is live (§4.3), or at `0` while
the open panel still lists agents that settled — so an open panel always has
its line to be closed by, a blocked one included — both
`text-th-text-secondary`, `tabular-nums`, and never giving way. Then one
stretch of muted free text, from exactly one source, the first that has
something: the plan's words (`Now: … +1`, `Next: …`, `All done`); the latest
thinking line, while the agent is thinking and the thinking has text; the
named agent and what it is doing now (§4.3). The plan outranks the thinking:
codex switches between working and thinking around nearly every call, and a
thinking line on top would flip the words several times a minute. Each part
stands behind a muted `·` that goes with it. The free text gives way first;
the label truncates only once it is gone; the clock and the chips never do.
While blocked there is no label and no spinner, and the line leads with its
first chip.

**When it says `Waiting for output…`** — while the
main agent's newest call is a `TaskOutput` filed under the call it reads and
still `running` ([tool-call-ui.md](tool-call-ui.md#a-fetch-in-flight)). Such a
fetch draws no row, so nothing at the tail moved for up to 30 seconds and the
row it reads was often screens up. The state ends with the fetch, and with the
main agent's next text, thinking or call; thinking still being streamed outranks
it, since it began after the fetch. The reducer holds it as the bubble's
`awaitedFetch` ([code/frontend-state.md](code/frontend-state.md#a-fetch-filed-under-the-call-it-reads)).
It names no call, no command and no
task — the line's rule holds: it says what the turn is doing, which is waiting.
`Go to call` is the transcript's jump to the row the fetch is filed under
([tool-call-ui.md](tool-call-ui.md#from-a-file-to-the-calls-that-changed-it)),
a text button in `text-th-accent` with a `touch-target` hit area. It stands
beside the line rather than in it, since the line may itself be a button. A
fetch that kept a row of its own is a running row
at the tail and leaves the line at `Working`. A subagent's fetch is not the main
agent's and does not move it (§3).

**The clock follows the label**, not the latest line: the latest line changes
length several times a second and would drag a clock after it across the row,
while after the label the clock moves only when the word switches or gains a
digit. And `Thinking… 12s` reads as the `Thought for 12s` it settles into. The
`·` keeps the clock and the latest line, both muted, from reading as one phrase,
as it separates the entries of a group summary.

Label in `text-th-text-secondary`, latest line and clock in
`text-th-text-muted`, `text-xs` — the strip's and the fork banner's size,
because it is a statement about the transcript, not content. Under
`prefers-reduced-motion` the glyph is a still `CircleDot` (the `running` glyph,
[lifecycle-ui.md §1.1](lifecycle-ui.md#11-activity)); the clock and the words
already say the turn is alive, and the shared `Spinner` does not stop itself. A
running tool row and a running group summary make the same swap
([tool-call-ui.md § Status](tool-call-ui.md#status)).

**When it says `Thinking…`** — only on a signal from the main agent that it is
thinking *now*, which ends with that thinking's record, with the turn — or
with the main agent's next text or tool call (a Codex plan update counts, being
drawn as one, §4.6), since output proves the thinking is over even if its
record never comes:

- **codex**: a reasoning item has started (`item/started`, which says
  `Thinking…` before any words), then its text arrives
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

**The line is a disclosure whenever its panel has a section** (§4): a plan,
agents, or thinking with text. The whole line is the button (so the tap target
is the line, not the chevron), the chevron is last, and a tap opens the panel
below the line, in place. Otherwise it is the same box, static, so gaining or
losing the toggle moves nothing. The thinking's section, *Thinking so far*,
holds the body a settled thinking opens on (§1.2) — so a body opened while
`Thinking…` looks the same once it is `Thought for 12s`.
Only the end it is cut from differs: live, each text is read from its newest
line — cut and faded at its top, its button above it — and, uncut or
opened, follows that line as it grows, as *Output so far* does
([tool-call-ui.md](tool-call-ui.md#keeping-the-readers-place)); settled, it is
read from its start. The chevron moves right as the latest line grows and stops where the line
starts to truncate, as a cursor would. At the tail this pushes nothing. After
a reconnect in the middle of a thinking the deltas before it are gone (§2.4),
so the open body begins with the muted line *Earlier thinking appears in full
when it finishes.*
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
for a minute), on the one tick every live call's counter reads too
([tool-call-ui.md](tool-call-ui.md#live-run)), so the clocks on screen change
together, and is not shown under 3s, like a tool row's. Without a reading the
clock is left out and `Working` stands alone — the strip's rule for `since`.

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
A Process list holding nothing but a thinking draws it bare too (§1.2), on the
Process text's left edge, inside its rule.
A subagent has no tail line — its call row's spinner and second line already
are its pulse
([tool-call-ui.md](tool-call-ui.md#the-second-line-steps-and-what-it-is-doing)).
A subagent thinking does not move the main tail line to `Thinking…`: the main
line speaks for the main agent, and the subagent's row is where its work is
being described. Which subagents are still running, wherever their rows are, is
the agents chip's (§4.3), and it is read from the same runs.

## 4. What is running, and the plan

```
… the last rows of the reply being written …
⟳ Working 4m 12s · ☑ 3/7 · ⧉ 3 · Now: Writing the retry tests  ›
┌ (a tap) ─────────────────────────────────────────────────────┐
│ Plan · 3/7          the checklist                            │
│ Agents · 3 running  an entry per agent                       │
│ Thinking so far     while the agent is thinking, with text   │
└──────────────────────────────────────────────────────────────┘
```

Parallel and background subagents had no overview. Nothing counted them or
said which were still going, and nothing went to them. A backgrounded
subagent's row sits wherever it was spawned, often several screens above,
while the conversation goes on under it. A plan was only a new `TodoWrite` row
per update, so following one on a phone meant scrolling back to the newest
row and opening it. Claude Code's agent panel and Codex's subagent panel exist
for this; the two chips and their panel are Pockode's answer, and the plan's
rows stay in the transcript as its history.

### 4.1 Where they go, and the rules they change

**In the tail line.** Not in a bar fixed above the composer, and not in
lines of their own:

- **The fixed area is the tightest space there is.** On a 375×560 phone with
  the keyboard up the transcript has about 87px left
  ([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)), and
  the attention strip is one row by rule. A bar standing for as long as an
  agent runs would take that space for the whole turn.
- **The tail is where a reader of a live turn already is.** The transcript
  follows the tail while the reader stays there, and the scroll-to-bottom
  button brings them back to it from anywhere in one press.
- **Lines of their own cost too much.** A plan line and an agents line under
  the tail line took ≈100px more on touch — ≈140px with the tail line — of a
  ≈400px phone transcript for the whole turn, and the agents line repeated,
  word for word, the subagent row right above it. As chips in the one line
  they cost no height, and the details are one tap away in the panel.
- **The case where the reader is *not* at the tail has its own answer.** That
  case is a turn parked on background work, often for an hour. The strip's
  background row, which is fixed, names what the turn is waiting on (§4.5).

**What this keeps, and what it changes on purpose:**

- **The tail line still names no call.** Its chips and words do name agents
  and plan items, and that does not break the rule's reason (a second copy is
  a copy that can disagree). They are not copies: the agents chip reads the
  same `ToolRun`s the rows are drawn from, worded by the same functions as the
  rows (`toolSummary`, the subagent row's latest child), and the plan chip
  reads the same plan that the plan rows carry (`ToolRun.plan`, §4.6). §5 has
  the updated boundary.
- **Hidden while blocked holds for the spinner, the label and the clock
  only.** They say
  "producing", which a blocked turn is not. The chips say nothing about the
  turn producing: the plan is what the agent said its plan is, and the agents
  are runs that really are live — and a background wait is when they are
  needed most. So a block hides neither: the plan chip lasts as long as the
  open turn (§4.2), and the agents chip as long as an agent runs (§4.3).
- **Measured numbers only, as before.** `3/7` counts plan items, and
  `⧉ 3` counts live runs. An agent's elapsed time is its row's own counter,
  left out where its row leaves it out (no `seenAt`). There is no percentage,
  no time remaining and no guessed number of steps.

**The panel.** One `BareBody` under the line, in a `CollapsibleBody`, with
up to three sections in a fixed order, each under a muted heading and divided
by `divide-th-border`: *Plan · 3/7* (§4.2), *Agents · 2 running* (§4.3),
*Thinking so far* (§2.3). Thinking is last because it comes and goes around
nearly every codex call, and at the bottom that moves nothing but what is
under the panel.

**Who holds "open".** The line is outside any `ToolList`, so
`rowExpansionContext` has nothing to hold it in, and the line moves to a new
bubble at every read point, which remounts it. So one flag sits in
`useTurnOverview`, which `useChatMessages` calls and hands on as
`TurnTail.panel` (`{ expanded, onToggle }`). Only the user opens it. It
closes when the turn settles, when the next turn opens, on another session,
and when its last section goes — not when one of several does, such as the
agent clearing its list. A panel left open with nothing in it would open by
itself on whatever came next: the next thought, around nearly every codex
call.

**Live state from state, history from history.** Whether an agent is running is
the reducer's `ToolRun.status`, the one value every subagent row is drawn from
([code/frontend-state.md](code/frontend-state.md#tool-runs)). Nothing here reads
"running" off a record. The plan is the other case: it is something the agent
said at one moment, so it is a record (§4.6), and the newest one *is* the
current plan. The chip reads the record and stores nothing about it.

### 4.2 The plan

**Which plan.** The newest main-agent plan, by record order (§4.6), in a reply of the **open
turn**, read while a turn is open (`turnOpen`, which also counts a send the
server has not answered yet). At most one bubble is open at a
time (`openAssistantIndex`), and a read point *closes* the reply above it and
opens a new one (`openedAtReadPoint`). So the open turn's replies are found
like this: take the open bubble; while the reply just taken has
`openedAtReadPoint`, take the assistant reply before it as well. A plan written
before a mid-turn send therefore still counts after the agent reads the send.
Only top-level runs count, in §4.3's sense: a reply's own parts with no
`parentToolUseId`. A subagent's own plan is in its children, or left flat
naming its parent, and either way it is not the main plan, with one exception
for Claude's Task tools, whose records are filed on a top-level run (below).
If the turn's
first reply is on a page that is not loaded, its plans are not either, and the
chip shows what is loaded. It goes when the turn settles, with the tail line:

- **A plan from an earlier turn does not show.** Claude's task list outlives
  the turn and Codex's plan sits in the model's context, but "Now: Writing
  tests" at the top of a new turn the agent has not planned yet would claim
  something nobody said this turn. The chip comes back with the turn's first
  update. Between turns there is nothing "now" about a plan: the rows hold it,
  and the work line says what the turn did.
- **A subagent's plan is its own.** A Codex plan update from a child thread is
  a `Plan` row in that subagent's Process. A Claude subagent's `TodoWrite`
  produces no record (§4.6): its rows in its Process are its plan's history.
  Neither reaches the chip.
- **Except Claude's task list, which is the session's.** On claude 2.1.330
  every agent in a session writes the same task list, so a subagent's
  `TaskCreate` / `TaskUpdate` / `TaskList` change the main plan. Their record
  names the top-level subagent call they ran inside (§4.6), which is a
  top-level run, so it counts here like any other. A subagent resumed this
  turn (a `SendMessage` to it) is still filed under the call that first
  spawned it, in an earlier turn's reply, so a top-level run outside the open
  turn counts too, for a record newer than the user message that opened the
  turn (its `anchorSeq`). Without that seq, only the turn's own replies count.
- **No plan, no chip.** That includes every Claude 5 session on claude 2.1.330,
  which offers no plan tool to those models (§4.6).

**What it says** — the chip, then the free text when the plan has its words
(§2.3):

| Plan | Chip and words |
|---|---|
| one item in progress | `3/7 · Now: Writing the retry tests` |
| several in progress | the first, then a muted `+N`: `3/7 · Now: Writing tests +1` |
| none in progress, some pending | `3/7 · Next: Update the docs`, the first pending item |
| every item completed | `7/7 · All done` |
| no items (the agent cleared the list) | no chip, no section |

- **The count is completed / total.** Items Claude marked `deleted` are not in
  the plan at all (§4.6).
- **An item's words** are its `active_text` (Claude's `activeForm`, the present
  continuous the CLI shows while the item runs) when it is in progress and has
  one. Otherwise they are its `text`. `Next:` always uses `text`, since nothing
  is happening on that item yet.
- **Its shape.** Lucide `ListChecks` at `size-3` in `text-th-text-muted`,
  then `3/7` in `text-th-text-secondary` `tabular-nums` `shrink-0`. The count
  never gives way; the words are the line's free text and give way first.
- **An update changes the words in place.** There is no animation and no
  highlight, and the chip coming or going moves nothing but the words after
  it.

**The panel's first section, *Plan · 3/7*,** holds the checklist the `TodoWrite` row's
body already draws (`kind: "todos"` in `ToolInvocation`: a status icon per item,
done items struck through), so the plan reads the same on the row and here. A
Codex `explanation`, when it is not empty, comes first as one muted paragraph.
The checklist is never cut, as on the row
([tool-call-ui.md](tool-call-ui.md#budgets)). While open it follows each new
record, and stays open across updates.

### 4.3 The agents

**Which agents.** Every **top-level subagent run** in the loaded transcript
whose `status` is `running` or `background`, each taken as its row draws it —
a settled Claude subagent that a `SendMessage` resumed is running again, on the
resuming call (`liveResumes` / `resumedRun`,
[tool-call-ui.md](tool-call-ui.md#a-subagents-own-work)), so it counts and is
named as live:

- **A subagent run** is a call the `TaskItem` renderer draws: Claude's `Task` /
  `Agent`, or a Codex spawn (`spawnAgent`, `subAgentActivity`). Both CLIs reach
  the reducer as the same `ToolRun`, so the chip has no per-engine branch.
- **Top-level** means a part in a reply's own content with no
  `parentToolUseId`. That excludes runs filed under another subagent, and also
  runs left flat with a `parentToolUseId`, whether their parent is not loaded or
  an earlier sibling went flat
  ([code/frontend-state.md](code/frontend-state.md#a-subagents-children)). A subagent's own subagent is
  one step of its parent's
  ([tool-call-ui.md](tool-call-ui.md#a-subagents-own-work)), and it shows as
  that parent's latest child.
- **Phase-independent.** The chip is drawn whenever that set is not empty: in
  any phase of an open turn, including both waits, and also after the turn
  settles while a backgrounded subagent outlives it (a turn whose background
  budget ran out goes idle with its tasks still going,
  [code/frontend-state.md](code/frontend-state.md#tool-runs)). In that last
  case there is no reply being written, so the chip, with the named agent as
  its words — `⧉ 1 · code-reviewer  Checking the 503 path… ›` — goes on the
  **right of the turn-end row** of the **last assistant message in the
  transcript** (the run may be in an older reply, and the chip is about now,
  not about that reply), and opens a panel of the agents alone. With no Copy
  or Fork on that row it stands alone in the same box. It leaves when the run
  settles: by its notification, or at the latest by `process_ended`, which the
  restart repair writes at the next server start if the server died without
  writing one
  ([code/frontend-state.md](code/frontend-state.md#tool-runs)).

**What it says:**

```
⟳ Working 4m 12s · ⧉ 3 · Explore  Read sender.go           ›
⟳ Working 4m 12s · ⧉ 1 · code-reviewer  Checking the 503 path…  ›
```

- The live count behind `Bot`, in `text-th-text-secondary`, `shrink-0`. Then,
  when neither the plan nor the thinking has words (§2.3), the **named
  agent**: its title, as the row's title (the agent, without the row's
  45% cap; the line has its own truncation), then **what it is doing now**.
  That is `subagentNow(run, unfiled)` in `web/src/lib/subagentRun.ts`: the
  latest child (`unfiled?.latest ?? latestChild(run.children)`), else `subagent_progress.last_tool_name` as a
  bare call, else nothing. `subagentLine` builds its live `tail` from the same
  function, so the row and the line cannot word it differently. The row then
  adds its last fallback, `run.activity`, which for a subagent is
  `Running <description>`, the row's own detail again
  ([tool-call-ui.md](tool-call-ui.md#the-second-line-steps-and-what-it-is-doing)).
  The line does not take that fallback. It passes the `unfiled` children
  the row passes (`useUnfiledChildren`). A call is worded by its title and
  `Detail`, a text by its first line. When `subagentNow` returns nothing, the
  words stop at the named agent's title (`⧉ 3 · Explore`).
- **The named agent is the last live one in transcript order**, which is the
  one spawned most recently. It is not ordered by `startedAt`, which a
  permission answer can move and old records lack. It changes only
  when an agent starts or ends, not on every step. "Whichever moved last" would
  flip between three parallel agents several times a second, on a line nobody
  can read at that rate. Each agent's own progress is on its entry and its row.
- **The chip's icon is lucide `Bot` in `text-th-text-muted`, not a spinner.**
  The line's glyph already spins and the agents' rows spin, so a third spinner
  adds nothing. `Bot` is the subagent mark the rows already carry.
- The count never gives way. As the line's free text (§2.3), the agent's title
  gives way after the child, and the child gives way first; the title truncates
  with an ellipsis.

**The panel's agents section** lists them:

```
⟳ Working 4m 12s · ⧉ 3 · Explore  Read sender.go            ⌄
┌──────────────────────────────────────────────────────────┐
│ ⟳ ⧉ Explore   Find retry handling                   47s  │
│     6 tool uses · Grep "Retry-After" in server/          │
│ ⟳ ⧉ code-reviewer  Review the diff  background   12m 4s  │
│     14 tool uses · Checking the 503 path next.           │
│ ✓ ⧉ Plan   Draft the migration                    2m 2s  │  ← settled while open
│     9 tool uses · Three steps: add the co…  31.2K tokens │
└──────────────────────────────────────────────────────────┘
```

- **An entry is the subagent row's header, drawn again from the same run.** It
  has the status glyph, the agent mark and title, the detail, the `background`
  chip, the meta counter and the second line, all from the components the row
  uses (`ToolRowFirstLine` / `ToolRowSecondLine`, the header `TaskItem` builds
  with `subagentHeader`, `toolSummary`). It has no chevron column
  (`RowButton`'s `noLead`), no body, and no
  [step window](tool-call-ui.md#the-step-window): its second line is the one a
  row without a window draws, naming what the agent is doing now, and the
  steps are what a press opens. Because it is the same code over the same
  `ToolRun`, the entry and the row cannot say different things.
- **Order is transcript order**, the order of the rows. It is stable, so an
  entry never changes place under a finger.
- **An entry that settles while the panel is open stays** where it is,
  settled: its glyph and second line become what its row became. Entries leave
  only when the panel is closed. The chip counts live runs only, so the chip and
  the list can disagree for that moment, and the list shows why. A list that
  dropped an entry the moment it finished would move every entry below it under
  a press. When the last live agent ends while the panel is open, the section
  stays, headed *Agents · none running*, and the chip with it at `⧉ 0`, until
  the user closes the panel; after the turn, the chip on the turn-end row
  reads `⧉ 0 · No agents running`. The panel closing with the turn, or with
  the next turn opening (§4.1), takes the list with it.
- **Who holds it.** The ids the list shows while the panel is open sit in
  `useAgentsOverview`, which reads the panel's flag (§4.1) and is handed on
  as `TurnTail.agents`, for the same reason: the line moves between bubbles
  and slots, which remounts it.

- **A press on an entry opens the subagent's transcript**
  ([subagent-transcript-ui.md](subagent-transcript-ui.md)), the layer its row's
  ⤢ opens: what the reader came for is the agent's work, and that is where it
  is read whole and followed live. It goes through the same opener
  (`SubagentTranscriptContext`), so the layer opens with the whole path down to
  the agent and focus comes back to the entry when it closes — or, if the entry
  has gone meanwhile (the list closed, the line moved slots), to what stands for
  the same run in the chat, its ⤢ or else its row
  ([subagent-transcript-ui.md](subagent-transcript-ui.md#back-at-each-depth)).
  An entry whose subagent has no work to show yet — the condition under which its row has no
  ⤢ (`hasProcess` in `subagentRun.ts`, shared by both) — **goes to its row**
  instead: the transcript's jump by `tool_use_id` (`ToolJumpContext`, the
  reveal path *Go to call* uses,
  [tool-call-ui.md](tool-call-ui.md#from-a-file-to-the-calls-that-changed-it)),
  which opens whatever hides the row, scrolls it to just under the pinned bars,
  rings it in `th-accent` and focuses it. Where nothing provides the opener
  (a `MessageList` outside `ChatPanel`), every entry goes to its row. Every
  entry is loaded by
  construction: it is a run in the reducer, and the reducer holds only loaded
  pages.

**Where the plan and the agents are derived and drawn.** `useChatMessages`
builds the `TurnTail` value. It calls `useTurnOverview` over the messages and
the send-aware `turnOpen`, which holds the panel's flag and calls
`currentPlan` and `useAgentsOverview`; the derivations live in
`web/src/lib/turnOverview.ts`. It adds one more field, `overviewMessageId`
(`overviewMessageId()` there): the id of the assistant message whose slot draws
the chips. The id is worked out outside the `TurnTail` memo, which then depends
on the id rather than on `messages`, because the tail is a context every
bubble's slot reads. It is:

- the open bubble (`openAssistantIndex`), while a turn is open;
- otherwise, the last assistant message in the transcript, while an agent is
  live **or the panel is open** (`panel.expanded`), so that
  `⧉ 0 · No agents running` can stay until it is closed;
- otherwise, none.

`TurnTail` reads the context and draws the chips and the panel only in the
slot of the message whose id is `overviewMessageId`. `MessageItem` draws a
`TurnTail` for every pending bubble, including a superseded one still
`streaming`, so the id check is what keeps them in one bubble. In the settled
branch `TurnEnd` draws `MessageActions` with the agents chip on its right on
that one message. Because it comes
through the context, the plan or an agent changing re-renders the one slot
that shows them and no other bubble (the reason `TurnTailContext` exists). An
entry is drawn from the run itself, the object the reducer holds — taken as its
row draws it, a resumed one on its resume.

### 4.4 Phone and desktop

Nothing depends on width, as in the rest of this document (§7). There is one
line at every tier, and its counts never give way: at 320px it reads
`⟳ Waiting for o… 1h 12m · ☑ 12/14 · ⧉ 3 ›  Go to call` — the halves that
answer "how long", "how far" and "how many" survive. The panel opens in place
at every tier, under the line:

- **Not a sheet, not a popover.** On a desktop a sheet is narrower than the
  column being read (the changes card's reason). A popover over the transcript
  would cover the rows it lists. At the tail, opening in place pushes nothing
  down.
- **One line at every width.** Merging the lines only on a phone (§4.1) would
  be a second layout to keep true.
- **Touch floor** `pointer-coarse:min-h-11` on the line and on every entry.
  Nothing is behind hover.

### 4.5 Naming what a background wait waits on

The strip's background row
([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)) names
what the turn waits on, from the same reducer state the agents chip reads: the runs whose `status` is
`background`, not counting those filed under another `background` run (the
outer one stands for them). Any tool counts here, not only subagents, because a
backgrounded `Bash` holds the turn just as a subagent does. `AttentionStrip`
takes the `messages` and works the tasks out itself (`backgroundTaskRuns`), so a
task held in its open list still shows its current state. The copy and the list
are written there. This is the one fixed surface §4 touches. It
covers the one case in which the reader is reliably away from the tail.

The strip is drawn by `ChatPanel`, outside the transcript, so it cannot read
`ToolJumpContext`, which `MessageList` provides only inside its own list. It
reaches the jump the way the permission row does, through `MessageListHandle`:
`jumpToCall(toolUseId)` beside `jumpToRequest`; a subagent's transcript is
opened through the same opener the chat provides, which `ChatPanel` owns. The jump
honours the strip's `jumpDisabled` like the permission row's jump, for the same
reason: the jump closes the answer panel on its way. That close-then-jump step
lives in `ChatPanel`, as one pending jump of either kind,
`{ kind: "request", requestId }` or `{ kind: "call", toolUseId }`. A jump to a
row closes the subagent's transcript first if one is up, since the row is in
the chat under it.
The press closes the panel and sets it, and a layout effect in the same commit
jumps, once, unless the transcript is still `inert`. In that case the jump is
dropped, not held: whatever still covers the transcript is not the panel this
press closed, and the row is there to press again. Calling `jumpToCall`
directly from the press would skip the close and send focus into an inert transcript.

### 4.6 The plan record

Three producers make one record kind, so the client has one rule for reading
the plan:

```
{ "type": "plan",
  "steps": [ { "id": "3",                                   // Claude Task tools only
               "text": "Write the retry tests",
               "active_text": "Writing the retry tests",   // optional
               "status": "pending" | "in_progress" | "completed" } ],
  "explanation": "…",          // optional, Codex only
  "tool_use_id": "toolu_…",    // the call that produced it, Claude only
  "plan_id": "…",              // Codex only: the record's own id, `<turnId>:plan:<n>`
  "parent_tool_use_id": "…",   // a Codex child thread's plan; Claude writes none
  "provider_message_id": "…" } // what its neighbours carry; none on a Codex child thread's
```

Exactly one of `tool_use_id` and `plan_id` is set. A plan with nothing in it
(an empty `TodoWrite`, a fold whose every task was deleted) is still a record,
and carries no `steps` field at all, like every empty `EventRecord` field; the
client reads it as `steps ?? []`. `provider_message_id` is there so a fork
anchor on a plan is the same as its neighbours': the result frame's uuid on
Claude, as its `tool_result` has, and the `turnId` on Codex's main thread, as
its items have. A step's `id` is the CLI's
task id. Only a record from the Task-tool fold carries one, because only that
fold is keyed by id; it is what lets a seed name the tasks the next
`TaskUpdate` touches (below). `plan_id` exists because a
Codex plan has no call to be keyed by, and the reducer keys every row (below).
The adapter numbers the turn's plan updates, so the id is the same on every
replay.

It is persisted like every event record. The adapter emits `agent.PlanEvent`,
and the record carries what the plan was *at that moment*: an event, never
updated afterwards. The newest one is the current plan, so the line needs no
store.

**Which plan tools Pockode reads.** Pockode does not change the CLI's tool set
to feed this line. Which tools the model gets is for the CLI and the user to
decide, and a host that turned plan tools on for a UI line would be steering the
agent through the transcript. Pockode reads whatever plan the CLI produces, and
with no plan the line is not drawn. Measured on claude 2.1.330 (from the
binary, not from docs):

- With `CLAUDE_CODE_ENABLE_TASKS` unset (the default), the plan tools are the
  incremental `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`, and
  `TodoWrite` is off.
- With `CLAUDE_CODE_ENABLE_TASKS=false`, `TodoWrite` is on instead.
- Either set is offered only to models up to the 4.x line, or when the host's
  tool list names one of them, or with `CLAUDE_CODE_ENABLE_TODO_TOOLS`. A
  Claude 5 model under Pockode's flags gets neither, so it has no plan chip.

**Per producer:**

| Producer | When a record is emitted | Steps from |
|---|---|---|
| codex `turn/plan/updated` | each notification. Its `threadId` decides the owner: the session's own thread is the main plan; a child thread's record names the child's spawn as `parent_tool_use_id` (`subagentCalls`, as items are filed). A child thread whose spawn this process never saw has its plan dropped: with no owner to name it would read as the main plan | `plan[].step` → `text`; `status` `inProgress` → `in_progress`; `explanation` kept when non-null |
| claude `TodoWrite` | every successful `tool_result`, main thread only (a call with no `parent_tool_use_id`; each agent's `TodoWrite` list is its own). A denied or failed call changed nothing | the call's `todos[]`: `content` → `text`, `activeForm` → `active_text` |
| claude `TaskCreate` / `TaskUpdate` / `TaskList`, from any agent in the session | each result that actually changes the adapter's fold (below). One that changes nothing the fold holds (a `TaskUpdate` of only `owner` or `description`, a `TaskList` equal to the fold) writes no record | the fold |

**The Task tools are folded on the server.** No single call carries the list:
`TaskCreate {subject, description, activeForm?}` adds one task and learns its
id only from its result (`{task: {id, subject}}`), and
`TaskUpdate {taskId, status?, subject?, activeForm?}` changes one, where
`status: "deleted"` removes it. Folding them on the client would need every
call since the list began, and those are on pages the client may never load;
the adapter sees each one live. So the Claude adapter keeps a `planTracker`
per process (`server/agent/claude/plan.go`), a layer after `parseLine` in
`streamOutput`, keyed by task id, in creation order. Each record goes directly
after the `tool_result` that produced it.

The fold is the session's, not the main agent's. On claude 2.1.330 every agent
in a session resolves the same task list, so a subagent's Task calls feed the
same fold. Their record names the top-level subagent call they ran inside,
walking up through nested spawns, and carries no `parent_tool_use_id`, so the
client counts it as the main plan (§4.2).

A result carries little of its call: `activeForm` (and `TodoWrite`'s
`todos[]`) are only in the *input*. So the tracker holds the input of each plan
call (a main-thread `TodoWrite`, any agent's Task call) by `tool_use_id` until
that call's result arrives, and lets go of it then, also when the result was
lost to an oversized line. Where the result text says something the input also
says, the text wins: the CLI repairs a call's input before running it (an
alias such as `id` or `task_id` for `taskId`, `title` or `name` for
`subject`, `active_form` for `activeForm`, the whole input wrapped in
`task: {…}`), and the text is its account of what it actually did. The
patterns below are claude 2.1.330's:

- **`TaskCreate`** adds `{id, subject → text, activeForm → active_text,
  pending}`. The id and the subject are read from `tool_use_result`
  (`task.id`, `task.subject`) only when the frame holds that one result:
  `tool_use_result` is one per frame and names no `tool_use_id` (`claude.go`),
  and parallel `TaskCreate`s often share a frame. Otherwise both come from the
  text, `Task #<id> created successfully: <subject>` (the CLI parses its own
  results by the part before the colon), less the note the CLI may append,
  ` The app marks these items in progress…`. With neither, nothing is added,
  and the next `TaskList` repairs the fold. `activeForm` comes from the input,
  under either name and either shape.
- **`TaskUpdate`** applies only when its text starts `Updated task #<id>`, and
  the id is read from that text. A refused update is *not* flagged `is_error`
  on claude 2.1.330: its text is the error instead (`Task not found`,
  `Task #N not found`, `Failed to delete task`, a completion a hook blocked), so
  the text is what says whether anything changed. It then applies the status,
  subject and active form the input names, and `deleted` drops the task. Of
  the repairs above, the CLI makes only `id` / `task_id` and `active_form` for
  a `TaskUpdate`, so its subject is read as `subject` alone. An
  id the fold does not hold is logged and dropped: the task was created in a
  frame the fold could not attribute, or before a seed older than the CLI's
  list (below). The next `TaskList` repairs it.
- **`TaskList`** *replaces* the fold with the tasks it lists, in the CLI's
  order. It is the CLI's own snapshot, so it corrects anything the fold missed.
  It is read only from `tool_use_result`, `{tasks: [{id, subject, status,
  owner?, blockedBy}]}` (claude 2.1.330's output schema), and so only when the
  frame holds that one result. Its text has no form stable enough to parse, so
  with a shared frame the fold is left as it was. The snapshot carries no
  `activeForm`: a task the fold already had keeps its `active_text`, and a task
  new to the fold has none.
- **`TaskGet`** changes nothing.

**The seed.** The CLI keeps its task list on disk across a process restart,
but the fold is memory. So a process that resumes the CLI's session **seeds**
its fold from the session's newest plan record, and the first update after a
restart carries the earlier tasks with it. The adapter cannot read history, so
`process.Manager` hands in a reader, `agent.StartOptions.PlanSeed`
(`func(ctx) []PlanStep`), which `agent.LatestPlanSeed` answers from the
history:

- **Only a plain resume calls it** (`resume && !fork`). The CLI keys its task
  list by its own session id and numbers each list from 1, so a fork, a fresh
  session, or a recovery that gave up the old id gets a list of its own, where
  the seed would be another list's tasks with colliding ids. Codex never calls
  it, and a session that was never activated gets no reader at all.
- **Only a fold snapshot seeds.** The seed is the newest main-thread Claude plan
  record's steps when every step has an `id`. When the newest is a `TodoWrite`
  list, which has no task ids, there is no seed.
- **It reads the history after the previous process is done writing it.** The
  reader is built under `processesMu`, so it knows the session's earlier
  processes that are still draining (`exiting`: a lease or a retirement takes a
  process out of the map before it has written its last plan), and waits for
  them, for at most 2s (`defaultPlanSeedWait`): the new process reads none of
  its output until the seed returns, so an old CLI slow to exit would hold back
  the resumed turn's text and permission requests too. Past that it starts
  without a seed. The history is then read in the adapter's goroutine, with the process's
  own context and without the lock. A history that cannot be read logs a
  warning and costs only the seed: the process still starts.
- **A seed found to be another list's is dropped.** The CLI never reuses a task
  id within a list, deleted ones included, so a `TaskCreate` whose id is a
  seeded one, or numerically at or below one, proves the seed came from another
  list (such as a fork's copied history). The seeded tasks are then removed,
  once. A `TaskList` settles the question too, since it replaces the fold.

This reads a record back into live state, which AGENTS.md warns against, and
it is acceptable here for one reason. The seed is not taken as the current
plan. It is only what the agent last said, kept so that the next update can
name tasks the fold would otherwise not know. The truth is the CLI's own list,
and each `TaskList` replaces the seed with it.

**Where the reducer files it, and how it is drawn:**

- **With a `tool_use_id`** (Claude), it becomes no part. It is set on the
  call's run as `ToolRun.plan` (steps, explanation, and the record's place in
  record order, below), found by id at any depth, the way a fetch is filed on the run it reads
  ([code/frontend-state.md](code/frontend-state.md#a-fetch-filed-under-the-call-it-reads)).
  A later record for the same call replaces it. A record whose call is not
  loaded is dropped: its row is not on screen, and the line reads only the
  open turn's loaded replies anyway. Nothing new is drawn, because the call's
  row is the history, and a part that rendered nothing would leave a gap in
  `MessageItem`'s `space-y-2` stack. The `TodoWrite` row stays as it is
  ([tool-call-ui.md](tool-call-ui.md#title-and-detail)), and so do the Task
  tools' rows.
- **With a `plan_id`** (Codex), it becomes an ordinary settled `tool_call`
  part. Its `ToolRun` has `id` = `plan_id`, `name: "Plan"`,
  `input: { steps, explanation }`, `status: "success"`, the record's
  `parent_tool_use_id` (which files it into a subagent's children by the usual
  rule), and `plan` set as above. Being an ordinary run is what lets lists,
  groups and the row draw it with no special case:
  - `toolSummary` names it `Plan`, with detail `n done / m` (the `TodoWrite`
    wording);
  - `ToolInvocation` gives it `kind: "todos"` from `steps`, with the
    explanation first;
  - `toolGroups` counts it in the `todo` category, so it folds into the same
    `Updated todos` segment;
  - the work line counts it as a tool call, and a reply holding only plan
    updates gets a work line. This is deliberate: it is Codex's `update_plan`,
    a call the model made, and a Claude `TodoWrite` is counted the same way.
    Leaving it out would make the same act count on one CLI and not on the
    other.

  It is drawn because nothing else in the transcript says that Codex planned.

**What the plan chip reads** is the `ToolRun.plan` latest in record order
among the top-level runs §4.2 reads (the open turn's replies, and a resumed
subagent's earlier spawn), whichever CLI wrote it. This is record order, not call order. With the fold every record is a
cumulative snapshot, and when two calls' results come back in the other order,
the later call holds the older snapshot. A live record's `seq` arrives with it,
as every persisted record's does, and is the record's place (`order`). A
record with no `seq` (one the server could not persist) can only have arrived
live, so it is placed just after what was loaded when it arrived: newer than
that, and older than every record persisted after it. Ranking it above every
`seq` instead would keep a stale plan on the chip for the rest of the turn. How
the reducer works out that place, and why it reads the `seq` off the record
rather than from its caller, is in
[code/frontend-state.md](code/frontend-state.md#a-plan-filed-on-the-call-that-wrote-it).

### 4.7 Reconnecting, reloading, and both CLIs

| What happened | Plan chip | Agents chip |
|---|---|---|
| reload / reconnect mid-turn | the newest plan record in the open turn's loaded replies | from the replayed runs: `status` replays, so the set is right from the first frame; second lines fill in from the subscribe reply's newest activity per call, as the rows do |
| the turn blocks on a permission or a background task | stays | stays |
| the turn settles | goes | goes, unless a background subagent is still live (§4.3) |
| Stop | goes with the turn | foreground runs settle `interrupted` as the turn ends. Background runs settle as Stop's stop notifications for them arrive, or with `process_ended` ([code/agent-integration.md](code/agent-integration.md#stop-ends-the-background-work-too)), and the chip goes when the last one does |
| the server restarted mid-turn | the turn is gone, and the chip with it | foreground runs settle against the turn ([lifecycle-ui.md §2.4](lifecycle-ui.md#24-recovering-a-dangling-turn-after-a-restart)). Settling against the turn leaves `background` runs alone; they settle on the `process_ended` the restart repair writes. The chip goes when they do |
| Claude, a Claude 5 model | no plan tools, no chip (§4.6) | as everywhere |
| Codex | `turn/plan/updated` | spawns are subagent runs. Codex has no background runs, so nothing waits in a background wait |

**A live run on a page that is not loaded is not counted.** The chip counts
what this transcript holds, the way every surface built on the reducer does.
The case is a backgrounded subagent started more than a page of history ago in
a long session. Its row is not on screen either, and the strip's background row
falls back to its unnamed copy (§4.5). This is accepted for now. The fix, if it
becomes common, is for the subscribe reply to list the in-flight calls it
already tracks so the client can page their rows in. Taking the count from the
server instead would give the count and the rows two different sources, which
is exactly what §4.1 rules out.

### 4.8 Accessibility

- **The status line** is a `<button>` with `aria-expanded` while it has a
  panel to open. Its visible words are `aria-hidden`, and its name is built
  from the facts that do not move while they are live, never from the free
  text: *"Working, plan 3 of 7, 2 agents running, details"*; an absent part is
  left out (`statusLineLabel`). The agents chip after the turn is named the
  same way, *"1 agent running, details"*. Neither is a live region: a plan
  update is not something to read out unasked, and the line's status already
  says the agent is running.
- **An entry** is a `<button>` whose name starts with its visible words,
  *"Explore, Find retry handling, running, open its transcript"* — or *"…, go
  to its row"* where it goes to the row (WCAG 2.5.3, as
  *Go to call* does). The status word (`toolStatusWord`: *running*, *running in
  the background*, or the settled glyph's word) stands in for the glyph the
  label hides, so an entry held after it settled does not sound live. Its
  moving second line is `aria-hidden` as on the row. Either way focus moves to
what it opened — the transcript, or the row, whose own name is read.

## 5. What it does not say

Every state the chat can be in already has an owner. The tail line takes the one
that had none, *running, with nothing to show yet*, and nothing else. Its two
chips (§4) take two more that had no owner: *which agents are still going* and
*where the plan stands*. Both read the rows' own state, so neither is a copy of
a row:

| Fact | Owner | Tail line |
|---|---|---|
| the turn is producing | **the tail line** (and the sidebar row's spinner, the same fact in a list) | the one thing it says |
| which call is running and for how long | the tool row / group summary | never names a call; points at one only while the main agent waits on a fetch that has no row (§2.3) |
| which subagents are still running, and what each is doing | each subagent's row; **the agents chip** and its panel gather them, read from the same `ToolRun`s | never names one |
| the plan, and how far it has come | the plan's rows (history); **the plan chip** and its panel, the newest record | never |
| a permission request blocks the turn | strip permission row, card | spinner, label and clock hidden; the chips stay |
| a background task holds the turn, and which | strip background row, which names it (§4.5) | spinner, label and clock hidden; the chips stay |
| questions are waiting | strip question row | unaffected; both are drawn, they answer different questions |
| a message sent mid-turn is unread | strip receipt row | unaffected; the receipt is about the message, the line about the turn |
| the turn can be stopped | Stop in the composer | no Stop of its own |
| how the turn ended | the turn-end row, error / `Interrupted` lines | gone |
| how long the turn worked, how many calls, what it changed | [the work line](tool-call-ui.md#the-work-line), once settled | gone — `Working 2m 12s` is the turn so far, `Worked` the reply's measured span |

The tail line and a running tool row can be on screen together, both moving.
That is not duplication — one is a call, one is the turn — and it is what was
there already: the turn-end row's spinner stood under running tool rows before
this design, and the tail line is that spinner given words and a clock.

## 6. Accessibility

The status line's name and the panel's entries are in §4.8; this section is
about the thinking row and the tail line's announcement.

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
  far is readable on request by opening the line's panel; the line is then a
  `<button>` with `aria-expanded` and a name of its own (§4.8) — its visible
  words are hidden, so without one it would be an unnamed button; the status
  sits beside that button so a press does not re-announce it.

## 7. Width and pointer

Nothing here is width-dependent; the one exception nearby is a subagent's
step window, which a phone draws a line shorter
([tool-call-ui.md](tool-call-ui.md#how-many-lines)). Both elements, with the tail line's chips (§4.4),
are one line at every tier, and a body opens in place at every tier. On a
narrow screen the tail line's free text gives way first, then its label: each
truncates with an ellipsis rather than wrapping, and the clock, the chips and
the chevron are always shown. The thinking row and the
tail line hold the row's `pointer-coarse:` height floor. As for tool rows,
nothing is behind hover
([tool-call-ui.md](tool-call-ui.md#width-and-pointer)).

## 8. Deliberately not done

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
- **Making Pockode's CLI flags turn plan tools on.** A Claude 5 session has no
  plan chip (§4.6). Which tools the model gets is for the CLI and the user, not
  for a transcript line.
- **Background commands on the agents chip.** It counts agents, as the story
  that asked for it does. A backgrounded `Bash` is named where it holds the
  turn, in the strip (§4.5), and its row carries its spinner and chip; a count
  of agents and commands together would need a noun for both.
- **Counting runs on pages not loaded** — §4.7.
- **A plan chip between turns.** The plan belongs to the turn that wrote it
  (§4.2).
