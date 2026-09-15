# Token Usage UI

How a user reads what a session and a work item have spent, in
`web/src/components/Chat/` and `web/src/components/Project/`: where the numbers
live, what each one means, how they are formatted, and what the screen shows when
an agent reports nothing.

It also introduces the surface that carries them on the session side — a **session
info panel** behind one button on the action bar. Usage is its first section and
deliberately not its last, so the section contract here is the one later features
follow (*The panel is a list of sections*).

Related: [agent-chat.md](agent-chat.md) for the session screen this adds a control
to, [code/agent-integration.md](code/agent-integration.md#usage-reporting) for
where the figures come from and why they are not events,
[code/work-system.md](code/work-system.md#usage-aggregation) for the work tree the
totals are summed over, [sidebar-ui.md](sidebar-ui.md) for the list that
deliberately shows none of this.

## The rules

**Only what the agent reported.** Tokens and price are read off the CLI's own
output. Nothing here is derived from a price table, and a missing number is shown
as missing rather than as a zero — a computed `$0.00` and "this agent does not
report price" look identical on screen and mean opposite things.

**Context belongs to a session, spend belongs to both.** A context window is the
state of one live conversation; it cannot be added up, so it lives in that
session's info panel and never on a work item. Cumulative tokens and price can be
added up, so a work item carries them twice: its own session, and its whole
subtree.

**On the session side, every figure is behind a tap.** The action bar gets one
icon-only button and no numbers. The bar is the session's controls, it is already
full at 360px, and a figure parked there would be the one thing in this design
that costs width from something a user is trying to do.

**Never a list.** Both surfaces are detail surfaces. The sidebar's session rows
and the work list show nothing, and their wire shapes carry nothing
(`session.list`, `work.list`).

**Two numbers always carry their own labels.** Wherever own and total appear
together, each column is named in the UI. Nothing about "smaller number on the
left" is self-evident, and on a story whose tasks have barely started the two
numbers are nearly equal.

## Data contract

The server owns these figures (`server/session/usage.go`, `server/work/usage.go`);
this is their wire shape as the client sees it. Read from it, do not restate it:
the four counters are always present, everything else is present exactly when an
agent reported it.

```ts
/** What the agents reported. Nothing here is ever computed from a price table. */
interface TokenUsage {
	/**
	 * Anthropic's convention: input counts only what was actually sent, with
	 * cache reads and cache writes counted beside it rather than inside it (the
	 * Codex parser subtracts its cached tokens back out, server-side). So the
	 * four add up without double-counting — which is what lets the client sum
	 * them.
	 */
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	/** Absent when the agent reports no price at all, as Codex does. */
	cost_usd?: number;
}

interface SessionUsage extends TokenUsage {
	/**
	 * A level, not a total: compaction makes it fall while the totals climb.
	 * Absent, or zero, means no level has been measured yet — never that the
	 * conversation is empty. It can exceed `context_window`, and is not clamped.
	 */
	context_tokens?: number;
	/** The window that level sits in. Absent means this agent never reported one. */
	context_window?: number;
}
```

**The headline total is summed client-side** — `input + output + cache_read +
cache_write`, one helper in `web/src/utils/tokens.ts` mirroring
`session.TokenUsage.Total()`. The server derives it the same way and deliberately
stores no copy; a `total_tokens` on the wire would be a third copy of one fact.

**"Nothing reported yet" is all four counters at zero**, which is what the empty
states below are keyed on. `usage` itself is always there — an empty session carries an
empty `Usage`, not a missing one.

Work detail carries an aggregate over the same counters, and nothing else an
aggregate does not need — no context fields, because a subtree has no window:

```ts
interface WorkUsage {
	/** This work item's own session. Absent when it has none, or it spent nothing. */
	own?: TokenUsage;
	/** This work item plus every descendant at any depth. */
	total?: TokenUsage;
	/**
	 * Descendants counted into `total`, at any depth; 0 when there are none.
	 * Required, and the only thing that decides whether the page shows one column
	 * or two — `Work` carries no usage, so the client cannot count or sum the
	 * subtree itself.
	 */
	descendant_count: number;
	/**
	 * Sessions inside `total` that spent tokens but reported no price. Non-zero
	 * makes the cost figure a floor, and the UI says so (*Work states*).
	 */
	unpriced_session_count?: number;
}
```

Both `own` and `total` are sums over the very session records the session screen
reads. Nothing is counted at the work level, so a task's own column and its
chat's usage panel can never disagree.

### Where it rides

`SessionUsage` is on `SessionDetail` as `usage`, mirroring `SessionMeta.Usage`.
That type is already detail-only — `SessionListItem` is a separate wire shape for
exactly this kind of reason — so nothing further is needed to keep it out of the
sidebar.

`WorkUsage` goes on **`WorkDetailSubscribeResult` and
`WorkDetailChangedNotification`, beside `work` and `comments` — not on `Work`.**
`Work` is one shape shared by the list and the detail (`web/src/types/work.ts`),
so a field added there would ship the aggregate to every row of the work list on
every change: the thing the requirement rules out, arriving by accident.

### A fork starts at zero

A forked session's usage begins empty, by design: the tokens behind its copied
history were spent by the session it came from, and counting them twice would
make every sum over sessions wrong. So a fork can show a long conversation and a
small total, and the UI must not let that read as a bug — see *Session states*
for the one line of copy that handles it.

## Formatting

`web/src/utils/tokens.ts`, tested like `bytes.ts` is.

**`formatTokens(n)`** — three magnitudes, one decimal only where it carries
information (the rule `formatBytes` already follows, and the carry-over case it
handles applies here too: `999_950` must print `1M`, not `1000K`).

| Input | Output | Why |
| --- | --- | --- |
| `0` | `0` | |
| `842` | `842` | Below a thousand the exact count fits |
| `1_000` | `1K` | No `1.0K`: a trailing zero decimal is noise |
| `1_536` | `1.5K` | |
| `99_900` | `99.9K` | |
| `128_400` | `128K` | Past 100 the decimal says nothing |
| `1_250_000` | `1.3M` | |
| `12_400_000` | `12.4M` | |

**`formatCost(usd)`** — always two decimals, because that is how a price is read:
`$0.00` for exactly zero, `<$0.01` for anything smaller than a cent but above it,
`$3.42`, `$1,284.30` (grouped above a thousand). The `<$0.01` floor exists so a
real spend never renders as nothing.

**`formatContextPercent(used, window)`** — `Math.round`, integer, `%` suffix, with
one floor: anything above zero that rounds to `0%` prints `<1%`. A window that has
something in it must not read as empty.
Rounding can print `100%` slightly before the window is full; that is the correct
warning to give. Nothing caps it either: a level above the window prints above
100%, because how full an agent lets its own context get is a fact about that
agent, and a figure clamped to `100%` would hide it at exactly the moment it
matters.

**Abbreviated on the glance surface, exact in the panel.** The work card is
abbreviated, and that is the value it reports: `title` is unreachable under a
thumb, so nothing important may live only there. The grouped exact counts live
where there is room for them — the session info panel, which shows `1,248,301`
rather than `1.2M` in every row. Spoken labels always carry the grouped count
(`1,248,301 tokens`), on every surface. A `title` carrying the same grouped count
is welcome on a fine pointer, but nothing may depend on it.

A work item's totals have no panel and stay abbreviated. Deliberate: a subtree
total is read as a proportion ("the tasks cost three times what the story did"),
and the per-session exact figures are one Open Chat away.

All figures render with `tabular-nums`, so a number that ticks upward mid-turn
does not shuffle the ones beside it.

## The session screen: the session info button and its panel

The session has no detail page — its screen is the chat. What it gets instead is
one more control on the session action bar, the strip that already holds this
session's engine and mode: **an info button, whose panel is where facts about this
session live.** Usage is the first of those facts and not the last, which is why
the button is named after the session and not after tokens: a control labelled
"usage" would have to be renamed or duplicated the first time anything else
belongs in there.

```
┌──────────────────────────────────────────────┐
│  ⌁ sonnet · high │ ◇ │ ⓘ │             ■   │   <- session action bar
└──────────────────────────────────────────────┘
   engine           mode  info              stop
```

**The button is icon-only**, lucide `Info` at `size-4`, geometry copied from
`ModeSelector`'s trigger — `size-9 pointer-coarse:size-11`, `rounded border
border-th-border bg-th-bg-tertiary`, `active:scale-95`, `focus-visible:ring-2`.
Both axes are written, as the hit-area floor requires of an icon-only control.
`aria-label="Session info"`, `aria-haspopup="dialog"`, `aria-expanded`. The label
is the control's name and nothing more — it names no value, because the button
shows none.

Adding it also puts a third hit area on the strip, so the row goes from `gap-1.5`
to `gap-2`. 6px between neighbouring controls was already under the 8px
coarse-pointer floor, and the automated guard never said so: it measures between
interactive tags, and this row's children are components
([responsive-ui.md](responsive-ui.md#the-automated-gates), blind spot 2). At 360px
the wider gap still fits — the engine chip's model name is `max-w-[88px] truncate`
already.

**It is permanent.** Unlike the engine and mode chips it is never disabled, and
unlike the numbers inside it, it does not wait for data: a control that appeared
after the first turn would be a control the user has to discover twice, and it is
the door to everything the panel will hold later, not a usage indicator. Permanent
for a session, that is — the bar renders with no session open too (the route names
none), and there the button is absent rather than describing nothing. Waiting for
a session's data and waiting for a session are different waits.

That makes the panel's empty state real, and it is one line — see *Session
states*.

### Nothing about usage on the bar itself

The action bar is already crowded — engine, mode, and the stop button, on a strip
that has to survive a 360px viewport — so the button carries **no number, no
percentage, no badge and no colour** from the session's usage. Its icon stays
`th-text-secondary` in every state.

That is a deliberate cost: when the window is nearly full, the user learns it by
opening the panel rather than by glancing at the bar. Worth paying here, because a
figure on the bar would re-label the button as a meter — the one thing this
button, which exists to host the next four features too, must not become — and it
would have to compete for width with each of them. If context pressure later turns
out to need announcing without a tap, the honest way to do it is its own signal
(an inline warning above the input bar, where the app already puts things the user
must see), not a number bolted onto this button.

**Tapping opens the panel** through `ResponsivePanel`, configured as
`EngineSelector` configures its own — `title="Session info"`, `triggerRef`,
`isExpanded` from `useIsExpanded()`, `desktopPosition="left"`,
`desktopPlacement="above"`, the default `w-72` and the default heights (one
section needs no more room than the Engine panel's three). It hangs off the same
bar, so it gets the same drawer-below / dropdown-above treatment.

Two facts about that container a section has to honour:

- **It supplies no padding and no scrolling.** Children go in a
  `<div className="overflow-y-auto pb-2">`, and each section owns its own `px-3`,
  exactly as the Engine panel does.
- **Only the drawer has a visible title.** At and above the expanded tier the
  dropdown carries the title in `aria-label` alone, with no header and no close
  button — which is the other reason the `USAGE` heading exists from day one: on a
  desktop it is the only label the section will ever have.

### The panel is a list of sections

```
┌ Session info ────────────────────────── ✕ ┐
│                                            │
│  USAGE                                     │
│  Context                          46%      │
│  ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░                      │
│  92,134 of 200,000 tokens                  │
│                                            │
│  Session total               1,248,301     │
│    Input                        88,412     │
│    Output                       31,203     │
│    Cache read                1,116,274     │
│    Cache write                  12,412     │
│                                            │
│  Cost                            $3.42     │
│                                            │
│ ─────────────────────────────────────────  │
│  (the next section lands here)              │
└────────────────────────────────────────────┘
```

One section per heading, in the heading style this container already uses — the
Engine panel's `legend`: `px-3 pt-3 pb-1 text-[11px] font-medium uppercase
tracking-wide text-th-text-muted`. From the second section on, a
`border-t border-th-border mt-2` above it. Not `WorkDetailOverlay`'s `text-xs`
page heading: the panel's neighbour is the Engine panel, and that is what it has
to look like.

`ChoiceList`'s `Section` is the right *look* and the wrong *element* — it is a
`fieldset` with a `legend`, built for the pick-one-of lists it ships with. A
read-only block of figures is not a group of form controls, so this borrows its
typography and stays an `h3` with a plain `div`. Worth saying out loud, because
importing it would be the obvious move and would put a fieldset around text.

A section is one component that renders its own heading, its own body and its own
empty state; the panel composes them and owns nothing but the order. That is the
whole extension contract — a later feature adds a component and one line, and
touches no usage code.

The heading is there from the start, with one section under it. A lone unlabelled
block would have to grow a heading later, and the diff that does it would be
indistinguishable from a redesign.

Inside the Usage section, three blocks: **Context**, **Session total** with its
breakdown, **Cost**. Each is a label row with the figure right-aligned; breakdown
sub-rows are indented and `text-th-text-muted`. The context bar is
`h-1.5 w-full rounded-full bg-th-bg-tertiary` with an inner fill, carrying
`role="progressbar"`, `aria-valuemin/max/now` and
`aria-valuetext="92,134 of 200,000 tokens"`. `progressbar` rather than ARIA's
`meter`, which is the role screen readers actually announce.

The bar has one end the percentage does not: its fill saturates at full width,
while the figure beside it goes on past `100%` (the level can exceed the window,
and is never clamped). The two carry the same fact until the window is full, and
past it the number is the one that keeps reporting.

`aria-valuemax` is the window or the reading, whichever is larger. Once the level
overshoots, a fixed max would put `aria-valuenow` out of range, and an
out-of-range value is one a screen reader may discard or renormalise — on exactly
the session whose reading most needs announcing. Growing the range caps nothing:
the percentage, the `x of y tokens` line and `aria-valuetext` all still carry the
real figures against the real window.

The bar's fill and the percentage beside it are the only place the thresholds are
read: `th-accent` below 75%, `th-warning` at 75–89%, `th-error` at 90% and up,
where compaction is imminent. Colour is never the only carrier — the percentage
and the `x of y tokens` line say the same thing in words.

**The breakdown is not a fourth decision.** A sub-row shows when its counter is
above zero, so a Codex session that fills two of the four shows two rows, and
nobody reads `Cache write 0` on an agent that has no cache.

### Session states

The button has none: it is always there, always neutral, always opens. Every state
below is a state of the Usage section inside the panel.

| State | Usage section |
| --- | --- |
| Detail not loaded yet (opened during a session switch) | One muted line: `Loading…` |
| All four counters zero | One muted line: `Nothing reported yet.` — plus the Context block, if a window was reported |
| Counters, window and a context reading all reported | All three blocks |
| Window reported, no level measured yet | Context block replaced by one muted line: `Context not measured yet.` |
| No context window reported | Context block replaced by one muted line: `Context window not reported by this agent.` |
| No cost reported | Cost block absent entirely — no row, no dash, no `$0.00` |
| Session was forked (`forked_from` present) | One muted sub-line under the total: `Since this session was forked.` — including when the total is the empty line, which is when the copied history on screen behind the panel makes it easiest to misread |

The missing-window row is defensive, not common: both shipped CLIs do report one
(`modelUsage.contextWindow` on Claude, `tokenUsage.modelContextWindow` on Codex,
per `server/agent/*/usage.go`). It is defined anyway, because a CLI version that
stops reporting it must not take the rest of the panel down with it.

The empty line is the price of a permanent button, and it is the right price: an
empty panel would read as a broken one, and `0` figures would claim the agent
reported zeros when it reported nothing at all. The Context block survives an
empty total because a window can be known before anything is spent — a resumed
session reports its window on the first frame.

**A known window with no level is its own state, not `0%`.** The window arrives
with the agent's first frame and a level only once a request has been measured,
so a session sits here at the start of its first turn; so does one whose stored
reading was dropped as unmeasurable
([why](code/agent-integration.md#usage-reporting)). Drawing it as `Context 0% /
0 of 1,000,000 tokens` would be worse than the wrong number it replaced: a bad
reading looks bad, an invented `0%` looks fine and is still a lie.

The fork line answers *A fork starts at zero*: the copied history is on screen
right behind the panel, so a total covering only part of it needs one clause saying
which part. It costs nothing on a session that was never forked, where the line is
absent.

## The work detail page: the Usage section

A card in `WorkDetailOverlay`, between Steps and Tasks — a fact about this item,
above the list of items it aggregates. It reuses the section shape every block on
that page already has: `h3 text-xs font-medium uppercase text-th-text-muted`, body
in `rounded-lg bg-th-bg-secondary px-3 py-2`.

```
USAGE
┌────────────────────────────────────────────┐
│              This story    Incl. 5 tasks   │
│  Tokens          124K              1.2M    │
│  Cost           $0.42             $3.87    │
└────────────────────────────────────────────┘
Total covers this story and every task beneath it.
```

Layout: `grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1`, figures
`text-right tabular-nums`. Right-aligned in fixed columns is what makes the pair
comparable at a glance; two left-aligned numbers of different widths are not.

It fits the narrow end: on a 360px viewport the card has ~304px inside the page's
`p-4` and its own `px-3`, against a widest row of `Tokens` + two abbreviated
figures (~150px of text) and `gap-x-3` twice. Abbreviation is what buys that
room — the grouped exact figures would not fit three columns here, which is the
other half of why they live in the session panel.

Whether two columns show is decided by the **shape of the tree, not by the
numbers**: a story with five tasks that have not spent anything yet still shows
both columns, with equal figures. Keying it off `total > own` would make the
second column and its header appear the moment a task's first turn landed —
the page reorganising itself under the user as a side effect of an agent working.

**Which of the two is louder is decided, not left to the reader.** Total is the
figure the page is about: `text-th-text-primary font-medium`. Own is context:
`text-th-text-secondary`. The header row is mandatory whenever both columns show
— `text-[10px] uppercase text-th-text-muted`, first column empty.

**Copy.** The own column is named after what the user is looking at: `This story`
or `This task`, from `work.type`. The total column is `Incl. 5 tasks`, from
`descendant_count` — singular `1 task`, and the count, not a vague "subtasks",
because the number is the one thing that makes the second column's scope
checkable against the list right below it. The footnote
below the card, `text-xs text-th-text-muted`, is always present when two columns
are: `Total covers this story and every task beneath it.` — the word *beneath*
doing the work of saying it is not just the direct children. It names the item
the same way the own column does, so a task reads `Total covers this task and
every task beneath it.`: the two would otherwise contradict each other on the
one page that shows both.

No context window here, in any state. A work item has no single window, and the
session's own screen is one tap away through Open Chat.

### Work states

| State | What shows |
| --- | --- |
| `own` and `total` both absent | No Usage section at all |
| `descendant_count` is 0 | One column, no header row, no footnote: the figure alone, in the total's weight — with no descendants the two figures are the same number |
| Own absent, total present (this item never ran; its children did) | Both columns; own cell is an em dash in `text-th-text-muted`, `aria-hidden` beside an `sr-only` `not reported` — never `0`, and never an `aria-label` on a bare span, which is not reliably announced |
| Cost reported nowhere in the subtree | Cost row absent entirely |
| Cost in total but not in own | Cost row present, own cell `—` |
| `unpriced_session_count > 0`, with a cost row | Total cost renders `$3.87+`, and a second footnote line follows: `Price is missing for 2 sessions — their agent does not report one.` — singular `1 session — its agent`, as the column header pluralises |
| `unpriced_session_count > 0`, with no cost row | Nothing extra: the sentence exists to qualify the `+`, and a subtree no agent priced has no figure for it to point at |

The `+` and its footnote are the whole reason the counter is in the contract: a
subtree mixing an agent that prices its turns with one that does not would
otherwise report a total that looks complete and is not. `+` rather than `≥`
because the app already spends that idiom on "this many, and more" in
`formatBadgeCount`, and a mathematical operator in a price column invites being
read as part of the figure.

The card needs no loading state of its own: `WorkDetailOverlay` already holds the
whole page behind one spinner until the detail arrives, and the usage rides in
that same result.

Numbers update live — the page already subscribes through
`useWorkDetailSubscription`. They change in place, with no transition and no
animation: `tabular-nums` keeps the column still, and a figure that pulses every
few seconds while an agent works turns the card into a distraction.

## What to test

Three things, following the pyramid — the formatter carries most of it:

- **`formatTokens` / `formatCost` / `formatContextPercent`**, from the tables
  above, including the carry-over (`999_950`), the `<$0.01` floor and the `<1%`
  floor. Unit tests, and the bulk of the coverage.
- **The button and its panel**, by what a user can perceive: the button is there
  before anything has been reported and opens a panel saying `Nothing reported
  yet.`; the panel's rows carry the grouped figures; no cost reported leaves no
  cost row. Not the bar width or the threshold colour — those are styles over
  arithmetic the unit tests already cover.
- **The work card's states**: hidden with nothing spent, one column at
  `descendant_count: 0`, two labelled columns otherwise, the dash for an absent
  own, the `+` and its footnote when `unpriced_session_count` is non-zero.

## Out of scope

- **Lists.** No session row, no work row, no badge, no sort by spend.
- **Estimation.** No price table, no per-model arithmetic, no "approximately".
- **History.** No per-turn or per-day breakdown, no charts. One cumulative figure
  per scope is what the requirement asks for.
- **Anything on the action bar.** No context figure, no percentage, no badge: the
  bar is full, and this round adds exactly one icon-only button to it.
- **The session info panel's other sections.** How a section is built and where it
  goes is settled here; what the next one contains is not this design's business.
- **`web-cluster`.** It has no chat screen and no work tree; nothing here reaches
  it, and none of these components belong in `@pockode/shared` yet.

---

**Why this file lives here.** `docs/` holds per-feature design documents and
`docs/code/` explains a core module's code, so the split is by what the reader
came for: how the numbers are produced and aggregated is in
[code/agent-integration.md](code/agent-integration.md#usage-reporting) and
[code/work-system.md](code/work-system.md#usage-aggregation), and what a user is
shown is here. It is one document rather than a paragraph in each of the two
screens it touches because the rules it sets — abbreviated on a glance surface and
exact in a panel, absent rather than zero, never in a list — have to hold across
both, and a rule split between two pages is a rule that will be applied on one of
them.
