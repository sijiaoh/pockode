# Tool Call UI

How a tool call is drawn, on a phone first.
[tool-call-model.md](tool-call-model.md) decides what a tool run **is**; this one
decides how one looks and behaves. Read it first — every field named here
(`status`, `activity`, `output`, `placeholderResult`, `fromBackground`,
`durationMs`, `exitCode`, `seenAt`) is its `ToolRun`, and nothing below asks for
data it does not define.

The surfaces are `ToolCallItem.tsx`, `TaskItem.tsx` (the subagent category) and
`PermissionRequestItem` in `MessageItem.tsx` — all three drawing their row
through `ToolRow.tsx`, which is where the grammar below lives — plus
`ToolResultDisplay.tsx` for the body, all under `web/src/components/Chat/`. The transcript around them
is [agent-chat.md](agent-chat.md); the width ladder and the pointer gates are
[responsive-ui.md](responsive-ui.md) and are used here, never re-derived.

## The three problems, as drawing problems

1. **A backgrounded call was never finished.** The row showed the placeholder
   forever. The user could not see that something was still running, nor what it
   last did.
2. **A long title was truncated into nowhere.** `truncate` cut the summary, and
   the expanded body showed the *result* — so a 200-character `Bash` command
   appeared nowhere in the UI at all.
3. **The body was bare for most tools.** Six tool names had a real view; `Grep`,
   `Glob`, `WebFetch`, `WebSearch` and every MCP tool fell through to a bare
   `<pre>` that carried no `whitespace-pre-wrap`, unlike the one
   `ContentBlocksDisplay` uses, so a one-line JSON result became a horizontal
   scroll on a phone.

## The rules

**One row, one line, always.** A tool call is a line in a transcript, not a
card. It does not wrap, it does not grow a second title line at `sm:`, and it
never re-flows when the window is resized. Twenty rows that are each one line
can be skimmed; twenty rows that are each one-or-three lines cannot. The only
thing that ever adds a line is the **second line**, and only for a run that has
something to say on it — see below.

**Nothing is hidden behind hover.** Not a tooltip, not a reveal. A phone has no
hover, and a hover-revealed control is permanently hidden wherever hovering does
not exist ([responsive-ui.md](responsive-ui.md#hover-can-only-ever-add-never-restore)).
Everything a user may need is either on the row or one tap below it. This is why
the answer to problem 2 is not a `title=` attribute.

**Everything the row truncates is verbatim in the body.** The row is a summary
and is allowed to lie about length; the body is not allowed to lie about
anything. This is the whole of problem 2: the text was never missing, it just
had nowhere to be.

**Failure is the only saturated colour in a stack of rows.** A transcript is
mostly successful `Read`s. If success is green, red stops being loud, and the
one row the user has to notice is the one that failed.

**The renderer infers nothing.** It switches on `run.status` and draws the
table below. Every "is this still running" question is answered by the reducer
([tool-call-model.md](tool-call-model.md#toolrun)), for every tool-shaped row
alike — that single author is what the merge of subagent rows into tool rows
bought.

## The row

```
┌─────────────────────────────────────────────────────────────┐
│ ›  ⟳  Bash   npm run build --workspace=@pockode/sh…   1m 04s │
│       vite v7.1.14 building for production…                 │
└─────────────────────────────────────────────────────────────┘
  ^  ^  ^      ^                                          ^
  │  │  │      └ detail (truncates)                       └ meta
  │  │  └ name
  │  └ status glyph
  └ chevron
```

Structurally two columns, not five: a fixed leading column holding the chevron
and the glyph, and a `min-w-0 flex-1` text column holding line 1 and the second
line. The second line then aligns under the name for free, and the alignment
cannot drift from whatever the leading column is sized to.

```tsx
<button className="flex w-full items-start gap-1.5 rounded p-2 text-left
                   min-h-[36px] pointer-coarse:min-h-11 sm:p-2.5
                   hover:bg-th-overlay-hover">
  <ChevronRight className={`size-3 shrink-0 … ${expanded ? "rotate-90" : ""}`} />
  {glyph}                                   {/* ToolStatusGlyph, or the card's CircleHelp */}
  <span className="min-w-0 flex-1">
    <span className="flex items-baseline gap-1.5">
      <span className="shrink-0 text-th-accent">{title}</span>
      {chip && <Chip>{chip}</Chip>}          {/* subagent type, MCP server */}
      {background && <Chip>background</Chip>}
      <Detail detail={detail} detailTail={detailTail} />
      {meta}
    </span>
    {secondLine && <SecondLine … />}
  </span>
</button>
```

Both icons keep `size-3` and the row keeps `text-xs`, `rounded`,
`bg-th-bg-secondary` and `p-2` — a re-shaping of the row that was there, not a
new visual language. `items-start` rather than `items-center` because the glyph
belongs to line 1 when there are two lines.

**The chevron is unconditional.** It used to be drawn only when there was a
result to show, with a blank spacer otherwise — which is why a running call, and
a call that answered with an image alone, could not be opened at all. Every row
has a body now, because every row has an **invocation** to show (below). The one
exception is the permission card, which keeps a condition: a request with no
input and no suggestions really does have an empty body, and "there is always an
invocation" is a fact about tool rows, not about cards.

**Hit area.** The row is the only tap target on line 1, so it takes the floor
directly: `min-h-[36px] pointer-coarse:min-h-11`. It is not a `touch-target`
overlay — there is room to grow the box, and a real box is always simpler
(`web/src/index.css`, the `touch-target` comment). Controls *inside* the body
(file chips, the copy button) keep the ≥8px separation that overlay hit areas
require.

## Status

Seven states were asked for. `ToolRun` has five; the remaining two turn out to
be one thing drawn by a different component. That is a fact about the model, so
it is answered here rather than papered over with a sixth glyph:

| Asked for | Where it lives |
|---|---|
| 等待中 (waiting) | Two different things wear that word. A call blocked on the **user** is the permission card below — and it must *take the tool row's place*, not sit beside it. A call that has been emitted and has simply not produced anything yet is `running` with no activity line, which is the honest reading: the CLI has it. |
| 运行中 | `running` |
| 后台运行中 | `background` |
| 成功 | `success` |
| 失败 | `error` |
| 被中断 | `interrupted` |
| 需要权限 | the pending `PermissionRequestItem` — same row grammar, one rung louder (below) |

The glyph column is the single place status is stated:

| Status | Glyph | Colour | Row | Body |
|---|---|---|---|---|
| `running` | `Spinner` (`variant="current"`, `size="h-3 w-3"`, with the tool name in its `srText`) | inherits | activity line when there is one | invocation + live output |
| `background` | same spinner, plus a `background` chip after the name | inherits | activity line when there is one | invocation + live output |
| `success` | `Check` | **`text-th-text-muted`** | second line only if it came from the background (below) | invocation + result |
| `error` | `X` | `text-th-error` | `border border-th-error/40` on the container, detail text `text-th-error`, second line = the last line of the output — or the outcome, when the run came from the background | closed, like every other row |
| `interrupted` | `Ban` | `text-th-text-muted` | second line only if it came from the background (below) | invocation + whatever came back |

Two of those are deliberate departures:

- **Success is muted, not green.** A subagent row used to use `text-th-success`
  for `done`, which was defensible while it was its own thing — a subagent call
  is rare and finishing it is an event. A tool row is not rare; a session has
  hundreds, nearly all successful, and a green tick on each turns the transcript
  into a wall of confirmation and costs the red `X` its salience. Subagent rows
  went muted with the rest when they became tool runs
  ([tool-call-model.md](tool-call-model.md#tasks-are-tool-runs)), so there is one
  answer rather than two.
- **`background` is not a finished state.** It is `running` wearing a badge: the
  spinner keeps turning, because the work *is* still going, and the chip says
  why the conversation moved on without it. Giving it its own glyph would be
  saying the call ended, which is the exact lie this replaced.

The chip is the same shape a subagent type or an MCP server wears, and lives in
`ToolRow` so there is one of it:

```tsx
<span className="shrink-0 rounded bg-th-accent/20 px-1.5 py-0.5 text-th-text-primary">background</span>
```

It **stays after the run settles**. "This ran in the background" is a permanent
fact about the call, and it is what tells a reader that the result under the row
arrived after the agent had already moved on.

### The permission card takes the row's place

`PermissionRequestItem` keeps its own lifetime, its own buttons and its own
`{ type: "permission_request" }` part — merging it into the tool call buys
nothing ([tool-call-model.md](tool-call-model.md#what-comparable-projects-do)).
Two rules govern how it sits in the transcript.

**An unanswered card is that call's row.** It *takes the place* of the
`tool_call` part with the same `tool_use_id` rather than appearing beside it —
and when the card comes first, as it can on Codex, the call adds no row of its
own. Before this, the card was appended beside the row, which is why the part key
was `` `${part.tool.id}-${index}` `` instead of the id alone: the same id could
be in the list twice and the index was what kept React from collapsing them.
Adding a spinner to that first row is what turned the duplication from untidy
into false — it would say the machine is busy while the machine is waiting for
the user. The precedent was already in the reducer, one case away:
`ask_user_question` finds the `tool_call` part with its `toolUseId` and takes its
place, because "all three describe one tool use". `permission_request` carries
`toolUseId` for exactly the same join. Generalising it removed the duplicate rows
and the index suffix with them.

**Taking the row means the reducer has to give it back**, and that rule is not in
this design because it is not a drawing decision: claude 2.1.263 does **not**
re-send the `tool_call` after approval (measured; an earlier CLI did, and an
earlier draft of this document assumed it still would). Without giving the row
back, an approved command's entire output would land as an orphan and be dropped.
How the row is rebuilt, and why progress may only rebuild it once the card is
answered, is [code/frontend-state.md](code/frontend-state.md#tool-runs).

That is what makes the waiting rung honest. A row that shows a spinner while the
call is actually blocked on a dialog two rows down is telling the user the
machine is busy when the machine is waiting for *them* — on a phone, where the
card may be below the fold, that is the difference between a session that looks
stuck and one that looks answerable.

**The row grammar is shared.** Chevron, glyph, name, detail, in that order, at
those sizes, with the same `toolSummary` derivation and the same `Detail`
component — a user who approved `rm -rf …` and then reads the row that ran it
should be looking at the same string truncated the same way. The card is the one
place a row wears a warning border (`border border-th-warning bg-th-warning/10`)
with `CircleHelp` in `text-th-warning`: it is the only tool-shaped row in the
transcript that is blocked on the user, so it is the only one that gets to be
loud before anything has gone wrong.

A denial settles the card from the user's own response
(`choice === "deny"` in the reducer), not from anything an engine says — and that
same tap is what produces codex's `declined` item status and Claude's refusal
result text afterwards. So whatever the engine then reports lands as an ordinary
settled run and needs no rung of its own: the card directly above it has already
said why. "The user refused" is told once, where the refusing happened.

## Title and detail

Split in two, happy's way: a **title** naming the kind of call, and a **detail**
identifying this particular one. Only the detail truncates.

Derived on the frontend from `name` + `input`, never sent on the wire
([tool-call-model.md](tool-call-model.md#toolrun)). It is
`toolSummary(name, input, workDir)` in `web/src/lib/` rather than a component
helper — derivation logic with a table in it, not a rendering concern — and every
surface that draws a tool-shaped row calls it, so a card and the row that runs
afterwards cannot word the same call differently.

| Tool (Pockode-normalized name) | Title | Detail | Truncates from |
|---|---|---|---|
| `Bash` | `Bash` | the **command**, newlines collapsed to ` ⏎ ` — or, when Codex parsed the command into exactly one action, that action's path or query | right |
| `Read` / `Write` / `Edit` / `MultiEdit` | the name | the path relative to the work directory, split so the file name survives | **left** |
| `Grep` | `Grep` | `"pattern"` + ` in <path>` when scoped | right |
| `Glob` | `Glob` | the pattern | right |
| `WebFetch` / `WebSearch` | the name | host + path / the query | right |
| `TodoWrite` | `TodoWrite` | `n done / m` | — |
| `Task` / `Agent` (the CLI renamed it; history holds both) | the name | `description`, with `subagent_type` as a chip | right |
| `server:tool` (Codex MCP) or `mcp__server__tool` (Claude MCP) | the tool half | the server half as a chip, then the first scalar argument, else compact JSON | right |
| anything else | the name | first non-empty scalar in `input` | right |

Four decisions inside that table:

- **`Bash`'s detail is the command, not `description`.** The description used to
  win whenever Claude supplied one, and a paraphrase — *"Build the web package"* —
  is not what ran. On a phone this row is frequently the only audit a user
  performs. The description is not lost: it is the first line of the body.
- **No character slicing.** The code used to cut at 50 characters *before* CSS
  truncated again — a truncation policy that ignores how wide the screen is, and
  two truncations that disagree. The detail is passed whole and CSS cuts it at
  the width it actually has.
- **Both MCP spellings are split.** Codex normalizes to `server:tool` while
  Claude passes its own `mcp__server__tool` straight through, and an unsplit
  40-character machine name would sit in the title slot, which never truncates,
  and evict the detail that actually identifies the call.
- **Paths truncate from the left**, and the detail is the path *relative to the
  work directory* rather than `formatFilePath`'s `Button.tsx (src/components)`.
  The two cannot both be had: that form puts the file name first, and splitting
  it at the last `/` would cut inside the parentheses. `formatFilePath` is still
  what renders the file lists in a `Grep` or `Glob` result, where there is no
  truncation to survive. `truncate` removes the tail, and a path's
  tail is its file name — the one part that identifies it. There is no
  dependable CSS for leading ellipsis (`direction: rtl` reorders punctuation), so
  `Detail` splits the string instead:

```tsx
// head = everything up to the last "/", tail = the file name (+ any :line suffix)
<span className="flex min-w-0 flex-1 items-baseline">
  <span className="truncate text-th-text-muted">{head}</span>
  <span className="max-w-[70%] shrink-0 truncate text-th-text-secondary">{tail}</span>
</span>
```

The directories fade out from the left, the file name stays, and it is a rung
brighter because it is the identifying part. The 70% cap keeps a pathological
file name from evicting the directories entirely. Non-path details pass `tail`
as empty and get a plain `truncate`.

**Status outranks the two rungs.** On an `error` row both spans take
`text-th-error`; the head/tail contrast exists to point at the identifying part
of a path, and it must not survive as a second colour language on the one row
whose colour already means something.

## The second line (problem 1)

Under line 1, while — and only while — the run has something to say there: its
**activity** while it is live, the **outcome** of a run that finished in the
background, and the **last line** of one that failed. A settled foreground run
has a second line only when it failed.

```tsx
<span aria-hidden={live} className={`block truncate text-th-text-muted ${mono ? "font-mono" : ""}`}>
  {text}
</span>
```

**What it says**, in priority order:

1. `run.activity` — Claude's `task_progress` line, Codex's
   `mcpToolCall/progress.message`. Prose, so no mono.
2. the **last non-empty line** of `run.output` — Codex's
   `commandExecution/outputDelta`. Literal stdout, so mono.
3. for a settled `fromBackground` run, the first line of the outcome. Prose.
4. for a settled foreground **failure**, the **last non-empty line** of the
   result. Literal output, so mono. Before this rung a collapsed failed row said
   only *that* the call failed — the border and the glyph — and the reason was
   behind the chevron, which is why the row used to open itself.

Rung 3 is above rung 4 and the order is load-bearing: a backgrounded failure's
outcome is the notification's own summary sentence, which says more than the
tail of a log the user never asked for. The last line rather than the first,
because it is the one rung 2 was already showing a moment earlier — the text
does not jump to the other end of the output as the run settles — and because a
build states its verdict at the end (`make: *** [build] Error 1`) while the head
is noise (`> vite build`).

It is drawn `text-th-text-muted` like every other second line, not red. The row
already carries three reds; a fourth would dilute "red means failed" into "red
means this row". The border and the glyph say the call failed, the second line
says what it said.

Nothing else. It is one line, it truncates, and the full text is in the body.

Rules that are not obvious and are the difference between this being useful and
being jitter:

- **It never clears on an update.** An empty delta, or a delta that is only a
  newline, leaves the last non-empty line standing. A line that blinks in and out
  re-flows every row below it. At settle it is handed over to the outcome, or
  removed — see below, which of the two is not a free choice.
- **Updates coalesce to one per animation frame**, and are held *merged per
  call* rather than queued: the activity is a latest value and the deltas
  accumulate, which is also what bounds the pending set by the number of calls in
  flight instead of by how much a build printed. That bound is load-bearing
  because `requestAnimationFrame` does not fire in a hidden tab, and a phone
  spends much of a long run with the tab hidden. Both engines resend everything
  in the completed result, so a frame merged away costs nothing
  ([tool-call-model.md](tool-call-model.md#live-progress)).
- **`aria-hidden` while it is live, exposed once it settles.** The row is a
  `<button>`, so anything inside it is part of its accessible name — and a button
  whose name changes several times a second is re-announced at every focus and is
  worse than no progress at all. So the moving line is hidden: the spinner
  (`role="status"`) says the call is running, the glyph says how it went, and the
  full output is in the body, which is reachable. The background outcome line is
  the opposite case — it is stable, it is the answer the user was waiting for,
  and it stays in the row's name. (A live region here would read every stdout
  line aloud, which is why neither variant is one.)
- **The line appears at most once per run, and disappears at most once.** Not
  once per update: the whole point of never clearing it is that the row's height
  is stable for as long as the run lives. It is also not reserved with a blank
  line — a stack of rows each carrying an empty second line is worse than the two
  re-flows.

Those two re-flows need one more rule, because `MessageList` does not protect a
reader from them. Its `ResizeObserver`
compensates for content growth in exactly two situations: it re-pins the tail
when the reader is following it, and it re-anchors a history page still settling
above (`web/src/components/Chat/MessageList.tsx`). A row that changes height
**above a reader who has scrolled away from both** simply shifts what they are
reading.

For a foreground run that is fine: the turn is blocked on it, so it is the last
thing in the transcript and the tail-follow case covers it. **A background run is
exactly the row that is not**, because the conversation carries on above it for
half an hour. So a background run does not lose its second line when it settles:

> **The second line is the run's latest word.** While the run is live that is its
> activity. When a backgrounded run finishes, it becomes the first line of the
> outcome — and stays.

Which is also the better row: a settled background call that reads *"Build
succeeded in 4m12s"* without being opened is the thing the user went looking for.
It replays correctly too, because the outcome is persisted while the activity is
not. Only a run that finished in the foreground drops its line — or hands it to
rung 4, if it failed — and that row is at the tail by construction, so both
changes of height fall to the tail-follow case above.

**After a reconnect** the line survives exactly as far as the backend carries
it. `tool_activity` is not persisted, so history replay has none of it; what
closes the gap is the newest activity per in-flight call, handed to a client in
the subscribe reply ([agent-chat.md](agent-chat.md#history-paging)) — and on a
phone reconnecting mid-run is the normal case, not an edge. **The row is the same
either way**: the field arrives filled instead of empty, and a row with an empty
one is still correct, because the spinner and the chip come from `status`. That
is why the row needed no second version for the reconnect case and needs none if
a future engine stops reporting progress at all.

`OutputDelta` accumulates client-side into `run.output`; both the second line
(last non-empty line) and the body block (last 50 lines) read that accumulation,
not the individual deltas, so a delta dropped under load costs a moment of
liveness and nothing more.

**A replayed background run that is still going shows no second line at all**
and still reads correctly, because `status` alone carries it: spinner +
`background` chip = still going. That is the whole reason status is derived from
persisted records and activity is not. A replayed background run that has
finished does have its second line, because that one came from the outcome.

### When a background run finishes

`task_notification` supersedes the placeholder. The row settles to
`success` / `error` (glyph and colour from the table), keeps the chip, keeps its
second line — now the first line of `summary` — and the body gains a second
section. The body must not simply replace the placeholder text: the placeholder
is what the **agent** read, the notification is what
**happened**, and a body that shows only the second asserts the agent saw
something it never did. Two labelled blocks, in this order:

```
Returned to the agent
  Command running in background with ID: bash_1
Outcome  ·  after the turn
  Build succeeded in 4m12s
  /work/repo/.pockode/logs/build-1.log                                    Open
  Not fetched
```

`output_file` arrives as a `FileBlock` with `omitted: not_fetched`, and
`partitionFileBlocks` sends it to the body rather than to the strip. There it is
a **reference line**: the full path in mono at the weight of a line of body
text, the reason under it, and the same Open the Files tab gets from
`FileBlock.Path` elsewhere ([agent-event.md](agent-event.md#eventrecord-serialization))
when the path is under the work directory. No card, no border, no icon — it is a
pointer, not an answer.

It used to be a `w-56` chip with a large glyph in the strip, on every
backgrounded row, permanently. On the common half of them — a CLI writes its
background log wherever it likes, often outside the work directory — there was
no Open either, so it was a card-shaped thing that could not be tapped. The full
path rather than the file name the block also carries: the body does not
truncate, so the tail of the path is the name already.

It is not inlined: a background log is unbounded, and the user asked for the
outcome. The line says `Not fetched` rather than "can't be previewed" — nothing
failed, the log was deliberately not read — and stops there rather than telling
the reader to open something that may have no button.

**When the outcome is one Pockode wrote.** A background task dies with the CLI
process, and the outcome then delivered at the next session start carries
`background_lost` instead ([tool-call-model.md](tool-call-model.md#a-third-subtype-with-a-different-author)).
It draws like any other background outcome — `error` glyph, chip kept, the same
*Outcome · after the turn* block — because that is what it is. What must not
happen is for it to land in the *Returned to the agent* half, or in a plain
`Result` block: the agent never read it, and no CLI ever said it. The record's
own text names its author, so a reader of the transcript is told where the claim
came from and not only that the work ended.

## Elapsed and duration (meta)

Right-aligned, `shrink-0`, `text-th-text-muted`, after the detail.

- **Finished run:** `run.durationMs`, when the engine reported one. Codex does,
  Claude does not — so this appears on codex rows and not on claude ones, and
  that asymmetry is honest: the number is data, and inventing it from arrival
  times would be wrong on replay. Hidden under 1s; a `Read` that took 40ms does
  not need a number.
- **Live run:** a counter from `run.seenAt`, and **only when `seenAt` is set** —
  it is live-only by construction, so a year-old transcript draws no stopwatches
  ([tool-call-model.md](tool-call-model.md#toolrun)). It appears once the run has
  been live 3s, so ordinary fast calls never flash a number, and ticks at 1s
  under a minute, then at 1 minute.
- Format: `1.2s`, `47s`, `4m 12s`, `1h 12m`. One unit below a minute, two above.
- It is its own component with its own interval, so a ticking counter re-renders
  the counter and not the row. At most a handful of runs are live at once.

Codex's `exitCode` belongs in the **body**, not here: it is only interesting when
it is non-zero, and then the glyph has already said so.

## The body (problems 2 and 3)

One `CollapsibleBody` → `ScrollableContent max-h-[60vh]`, as today. Sections in
this order, each omitted when empty:

1. **Invocation — always present.** This is the answer to problem 2 and the
   reason every row now has a chevron.
   - `Bash`: `CodeHighlighter language="bash"` with the full command — wrapping,
     selectable, and with the copy button that component already brings
     (`web/src/lib/shikiUtils.tsx`). Claude's `description`, when present, sits
     above it as one muted line.
   - File tools: the full path, with an *Open* into the Files tab when it is
     under the work directory.
   - `Grep` / `Glob`: pattern, path and flags as labelled lines.
   - MCP and unknown tools: `CodeHighlighter language="json"` over the
     pretty-printed input. No lazy-render gate of its own: `CollapsibleBody`
     renders nothing before the first expand, so a second gate would save
     nothing. Highlighting is capped at the `HIGHLIGHT_LIMIT` the file viewer
     already uses, because shiki tokenizes on the main thread.
2. **Live output**, while running: the last 50 lines of `run.output` in a mono
   block, newest at the bottom, replaced by the result when it arrives. **No
   scroller of its own** — `ScrollableContent` already owns one scroll box here,
   and a scroll area inside a scroll area is a trap on a touch screen, where a
   drag that was meant for the transcript is swallowed by whatever is under the
   thumb. The 50 lines are what a cap buys instead: a build that printed ten
   thousand of them does not become ten thousand DOM nodes in a row nobody has
   finished reading. The body does not auto-scroll either; the row's second line
   is the live glance, and the body is where someone reads at their own pace.
3. **Result**: `ToolResultDisplay`, unchanged in structure, with three cheap
   additions that close problem 3 and need nothing from the new model:
   - `Grep` / `Glob`: the result is a file list — rendered as one, paths through
     `formatFilePath`, each with an *Open* into the Files tab, capped at 100 with
     a count of the rest. A repo-wide `Glob` answers with thousands, and it used
     to arrive as one long unwrapped line. `Grep` only in the mode that answers
     with paths: its `content` and `count` modes prefix every line with
     `path:line:`, and a short match with no space in it is indistinguishable
     from a path — drawn as a file row it would offer to open one that does not
     exist. Those modes stay as wrapped text.
   - MCP and unknown tools whose result parses as JSON: pretty-print and
     highlight instead of printing it flat.
   - `WebFetch`: the result is Markdown, and `MarkdownContent` exists.
4. **Background outcome**, as above.

The attachment strip stays between the row and the body, and what goes in it is
what the result **is**: when a tool answers with a screenshot, the screenshot is
the answer, and an answer folded behind a chevron has not been shown. A block
marked `not_fetched` is not that — it is a *pointer* at a file nobody read — so
it is drawn as a reference line in the body instead
([above](#when-a-background-run-finishes)).

**Nothing opens a tool call's body but the user.** Trial and error is how an
agent works: a turn routinely contains several failed calls, and four bodies
unfolding themselves bury the answer the user is reading. What replaced the
auto-expand is rung 4 of the second line — a failed row now says how it failed
without being opened.

`TaskItem` keeps its auto-expand (`autoExpandedRef`, once, so the user's own
decision to collapse it stands), because the two cases are not the same one: a
subagent failing is rare rather than routine, and its report is the only account
of what went wrong anywhere in the UI. For the same reason `TaskItem` passes
`secondLine={failed ? null : toolSecondLine(run)}` — with the body already open,
rung 4 would only be a second and worse copy of what is under it, the tail of a
markdown report drawn in mono. That `null` covers rung 3 as well, so a
backgrounded subagent that fails loses its outcome line too — one line of the
same gap the next paragraph is about, and small beside the body opening above
it.

**A `background` run must not open itself** — a 30-minute task that unfolds
itself shoves the transcript around long after the user stopped caring, and
`MessageList` compensates for growth only at the tail, which a background row is
by construction not at ([above](#the-second-line-problem-1)). It is also the one
rule on this page the code does not keep: `TaskItem`'s `autoExpandedRef` keys on
`run.status === "error"` alone and never reads `fromBackground`, so a
backgrounded subagent that fails opens its report anyway, wherever in the
transcript it sits. The gap predates rung 4 and is recorded rather than closed
in passing, because closing it is a behavioural decision and not a typo: that
report is still the only account of what went wrong, so the alternative to
opening it has to be a way of reaching it, not silence.

## Width and pointer

Almost nothing here is width-dependent, and that is the design rather than an
omission.

| Tier | What changes |
|---|---|
| compact (<640) | the baseline described above |
| `sm:` (640–1023) | `p-2` → `sm:p-2.5` and nothing else |
| `lg:` (≥1024) | nothing — the transcript column does not change shape |

**No width tier gets a second title line, a tooltip, or a wider truncation
budget.** A rule like "wrap the command at `sm:`" makes the same call look like
a different thing on a tablet and a phone, and it would mean the phone — the
primary device — is the one place the full text is unreachable. The body is the
answer at every width, so there is one answer.

**No `pointer-fine:` reveal anywhere in this design.** Nothing is hover-only, so
there is no fallback branch to get wrong. `pointer-coarse:` appears once, on the
row's height floor. Neither gate is consulted from JS: these are reachability
decisions, and reachability is a CSS variant
([responsive-ui.md](responsive-ui.md#the-two-pointer-gates)).

## Accessibility

- The row is a `<button>` with `aria-expanded` — unconditional now, since there
  is always a body.
- The glyph carries the status as text: `aria-label` on the settled icons
  (`success` / `failed` / `interrupted`), `srText` on the spinner. Colour is
  never the only carrier — an `error` row also has a border and red detail text.
- The second line is `aria-hidden` while it is moving and exposed once it has
  settled, so the row's accessible name stays put while stdout moves and still
  carries the outcome afterwards (see above). What a screen reader is told is the
  spinner while it runs, the glyph when it settles, and the whole output on
  request, in the body.
- The `background` chip is real text, so it is read as part of the row.

## What a reviewer should check

1. A `Bash` row with a 300-character command: one line, truncated from the right,
   full command in the body, copyable.
2. A `Read` of a deeply nested file: the file name is still visible; the
   directories are what disappeared.
3. A backgrounded call, live: spinner + chip + activity line, elapsed counter
   after 3s. Reload the page mid-run: spinner + chip, no activity line, no
   stopwatch, and nothing claiming it succeeded.
4. The same call after `task_notification`: glyph settles, chip stays, the
   second line becomes the outcome **without the row changing height**, and the
   body shows both the placeholder and the outcome under their own labels.
   Scroll far away from it first — that is the case this rule exists for. The
   log it wrote is a reference line inside that body — full path, `Not fetched`,
   no card above the body — with an Open only when the path is under the work
   directory.
5. A failed `Bash`: red `X`, red detail, bordered row, **closed**, with the last
   line it printed under the title. Open it for the rest.
6. A codex `commandExecution`: detail derived from `commandActions` when there is
   one, `durationMs` on the right, `exitCode` in the body.
7. An approved `Bash`: **one** row, not two — the card takes the pending row's
   place and the engine's next report gives it back, and while the card is
   pending nothing around it is spinning. Check both orders: Claude announces the
   call first, Codex may ask first.
8. An MCP tool returning one long line of JSON, on a phone: readable without
   dragging sideways. That is what the bare `<pre>` fallback used to do.

## Out of scope

- **A full-screen tool detail route.** happy's answer to long content is
  navigation, and it is a good one, but Pockode's row already owns a body with a
  60vh scroller; adding a second surface for the same content would mean deciding
  which of the two any given tool goes to.
- **Nesting a subagent's conversation under its call** — as in the model doc.
- **Per-call token cost.** Usage has an owner
  ([usage-display-ui.md](usage-display-ui.md)) and a row is not it.
- **Re-theming.** Every colour here is an existing `th-` token; no new one is
  introduced, and none is needed.
