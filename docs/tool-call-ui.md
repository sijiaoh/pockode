# Tool Call UI

How a tool call is drawn, on a phone first.
[tool-call-model.md](tool-call-model.md) decides what a tool run **is**; this one
decides how one looks and behaves. Read it first — every field named here
(`status`, `activity`, `output`, `placeholderResult`, `fromBackground`,
`fetches`, `durationMs`, `exitCode`, `seenAt`, and a subagent run's children) is
its `ToolRun`, and nothing below asks for data it does not define.

The surfaces are `ToolCallItem.tsx`, `TaskItem.tsx` (the subagent category),
`ToolGroupSummary.tsx` (the row a run of calls folds into) and
`PermissionRequestItem` in `MessageItem.tsx` — all three drawing their row
through `ToolRow.tsx`, which is where the grammar below lives — plus
`ToolInvocation.tsx` for the invocation a row and a card both show,
`ToolResultDisplay.tsx` for the result, `ProposedChange.tsx` for the file
change a result, the permission card and the turn's changes card all draw
(read by `lib/proposedChange.ts`), `ToolOutcomeSections.tsx` for the blocks
the two tool renderers share, `ToolSection.tsx` for the labelled,
clamped section every one of those blocks is drawn as, and
`TurnChangesCard.tsx` for [the files a turn changed](#the-turns-changes), all
under
`web/src/components/Chat/`. The transcript around them
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

**One row, one line, always — and a run of rows, one line too.** A tool call
is a line in a transcript, not a card. It does not wrap, it does not grow a second title line at `sm:`, and it
never re-flows when the window is resized. Twenty rows that are each one line
can be skimmed; twenty rows that are each one-or-three lines cannot. The only
thing that ever adds a line is the **second line**, and only for a run that has
something to say on it — see below. Consecutive calls between two pieces of
text then fold into **one summary row** ([groups](#groups)), with the rows the
reader must not miss pinned under it.

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

## The list

Consecutive rows — tool calls, subagent calls and permission cards, whatever
their state — are drawn as **one list**: a single `rounded-lg border
border-th-border` frame with a 1px `border-th-border` hairline between rows, and
no gap and no fill of its own, so the rows sit on the transcript's ground. Text,
a question card and every other part end the list and stand on their own, with
the message's `space-y-2` around them. One call alone is a list of one row, so
a row looks the same wherever it is.

```
The sender retries on 429 and 503. Two gaps:
┌─────────────────────────────────────────────┐
│ ›  ✓  Read   server/relay/sender.go         │
├─────────────────────────────────────────────┤
│ ›  ✗  Bash   go test ./relay/…              │  ← the row itself tinted red
│          --- FAIL: TestRetry (0.01s)        │
├─────────────────────────────────────────────┤
│ ›  ✓  Edit   server/relay/sender.go         │
└─────────────────────────────────────────────┘
Fixed both; tests pass.
```

It used to be a stack of cards, each `rounded bg-th-bg-secondary` with 8px
between them. Twenty calls were twenty boxes and nineteen gutters; a list says
the same with a hairline, and the frame says where the run of calls begins and
ends.

`PartBlocks` (`Chat/ToolList.tsx`) draws it, over `partBlocks` in
`lib/partTree.ts`, and the main transcript and a subagent's Process both go
through it, so a list reads the same at every depth. Two details are
load-bearing:

- **Each row carries its own `border-t`, and the first one's is pulled up under
  the frame** (`-mt-px` on the inner column, clipped by the frame's
  `overflow-hidden`). Not `divide-y`: that draws between DOM siblings whether or
  not they are displayed, so a hidden last row would leave a hairline on top of
  the frame's bottom edge — a doubled line.
- **The frame clips.** Anything a row draws outside its own box is cut off, so
  everything a row draws on its edge is drawn inside it: the focus ring is
  `ring-inset`, the pending card's frame is an inset outline, and the jump
  highlight on it is an inset shadow.

Each row's wrapper, not the list, is a scroll anchor candidate in the main
transcript, exactly as a part on its own is (`scrollAnchor.ts`): a list with
its rows open can be several screens tall, and holding it still would say
nothing about where inside it the reader is. A group's summary row is one too; a
row folded into it is not ([groups](#groups)).

## Groups

A turn of fourteen calls is fourteen rows, and on a phone that is two screens
of `Read`s between the question and the answer. So consecutive calls in a list
fold into one row that says what they did:

```
┌───────────────────────────────────────────────┐
│ ›  ✓  Edited 2 files · Ran 1 command · Read 2…│  ← the summary
├───────────────────────────────────────────────┤
│ ›  ✗  Bash   go test ./relay/…                │  ← pinned: failed
│          --- FAIL: TestRetry (0.01s)          │
├───────────────────────────────────────────────┤
│ ›  ⟳  Bash  background  npm run dev     4m 12s│  ← pinned: background
└───────────────────────────────────────────────┘
```

`rowEntries` (`lib/toolGroups.ts`) decides it, a pure function of the parts as
they are now; `PartBlocks` draws it, so a subagent's Process folds exactly as a
message does. Every part of a list falls into one of three kinds:

| Kind | Parts | In a group |
|---|---|---|
| **Breaker** | a subagent call, `ExitPlanMode`, and their cards — and, since they already end the list, text, a question card and every other part | ends the group and stands as itself |
| **Pinned** | a call that is `error`; one that is `background` or `fromBackground`, running or settled; a card that is not `allowed`, or is `allowed` while its row has not come back | belongs to the group, never folds |
| **Foldable** | every other call (`running` / `success` / `interrupted`), with its `allowed` card once its row is back; a thinking row, which folds but is not a call and counts toward nothing ([turn-progress-ui.md](turn-progress-ui.md#12-where-it-goes-and-groups)) | folds into the summary |

- **A call is one member, by id.** A card and the row it stands for share a
  `tool_use_id` and are counted, pinned and folded together.
- **Two foldable calls or no group.** With fewer the rows lie flat as they
  are: one call needs no summary, and a summary over one success and a failure
  costs a line and saves none.
- **Why a subagent breaks the run.** Its row already is a summary — its Process
  is the folded list — and its waiting card sits under it, which must stay in
  sight. A plan is written for the user to read, prose in all but shape.
- **Why background work stays pinned after it settles.** It settles long after
  the reader moved on; moving it into the summary then deletes a row above
  them — the height change [the second line](#the-second-line-problem-1) works
  to avoid — and its settled second line, *"Build succeeded in 4m12s"*, is what
  they came back for. The reducer's known corner, a call marked backgrounded
  only after its placeholder
  ([tool-call-model.md](tool-call-model.md#background-lives-on-tool_result-twice)),
  folds until its outcome arrives and then comes out; it is accepted, not
  patched over.
- **Why an approved card stays pinned until its row is back.** Claude does not
  resend the call after approval; until progress or a result rebuilds the row,
  the card is all there is of the call, and folding it would put a tick over a
  command still running.

**The summary row** is the tool row's box (`RowButton` in `ToolRow.tsx`) with a
different text column, so the two cannot differ in height. Settled, it is the
verbs of its **successful** foldable calls — a failed `Edit` changed nothing,
and it is pinned below anyway — in a fixed order by consequence, so the end a
narrow screen cuts is the least important: `Edited N files · Ran N commands ·
Read N files · Searched N times · Fetched N pages · Updated todos · Used N
tools · Thought for 1m 20s · N interrupted`. Files are counted once however
often they were touched (a Codex file change counts each of its files);
everything else counts calls, and a Codex `Bash` is read through the same
`singleCommandAction` as its row's title (`toolVerb` in `lib/toolSummary.ts`).
The glyph is a muted `Check`, or `Ban` when something was interrupted — never
green, never red; red is the pinned rows'. No accent title: that is what tells
it from a tool row.

While a foldable call runs, the summary is on that step, in the grammar a
subagent's second line already speaks: `6 steps · Bash  npm run build…  12s` —
every call in the group counted, then the newest running one worded as its own
row, with its elapsed time. One line either way, so it does not change height
when it settles. It does not spin while a card in the group waits on the user:
then the machine is waiting for them, and with nothing settled yet the row says
only `N steps`, with an empty glyph — neither busy nor done. Its text is `aria-hidden` while it moves,
and the spinner says `Tool calls running`.

**Rendering.** Every part is rendered once, in transcript order; the group adds
a summary entry before its first part and hides its foldable parts with the
`hidden` attribute. Nothing is copied or remounted — a pending card is in the
DOM once, so a jump to it lands, and a row folded and unfolded comes back as it
was. A hidden part is not a scroll anchor candidate: an element that is not
displayed measures as sitting at the top.

**Nothing opens a group but the user, and nothing folds what the user opened.**
A row's open body is held by the list (`rowExpansionContext.ts`), which keeps a
row the user opened in sight when its group forms or closes, until they close
it themselves — the run they were watching does not vanish because the next
call arrived. Only the user's own choice counts: a pending card opens itself,
and folding it once it is answered and its row is back is the point.

## The turn's changes

The tool rows say what a turn *did*; nothing said what it *left behind*. To
review a turn's edits the reader had to open every `Edit` row, folded into a
summary or not, and keep count of which file they were on. So a settled turn
that changed files ends with one more framed list, standing directly above the
turn-end row ([agent-chat.md](agent-chat.md#the-session-screen)):

```
The sender now backs off on 503 too.
┌──────────────────────────────────────────────┐
│ ▤  2 files changed                  +11  −2  │  ← the header: not a button
├──────────────────────────────────────────────┤
│ ›  deliver.ts  src/webhooks/sender  +7  −2   │
├──────────────────────────────────────────────┤
│ ›  backoff.ts  src/webhooks/sender  new  +4  │
└──────────────────────────────────────────────┘
[⧉] [⑂] […]
```

`turnChanges` (`lib/turnChanges.ts`) derives it, a pure function of one
assistant message's parts as they are now, like `rowEntries`;
`Chat/TurnChangesCard.tsx` draws it, and `MessageItem` places it. What counts
as a file change is asked of `proposedChange` (`lib/proposedChange.ts`) — the
one reader the tool body and the permission card already use — so a tool it
learns to read reaches the card with no list of names here.

**It is the list's grammar, told apart by its header alone.** The frame,
hairlines, `-mt-px` and `ring-inset` are [the list's](#the-list); every file
row is the tool row's box (`RowButton`, no glyph — everything listed
succeeded), so height, hover and the touch floor cannot differ. The header is
the one row that is not a button, with `FileDiff` in the chevron's column so
its text lines up with the file names — the same trick by which a group's
summary is told from a tool row: by what it lacks, not by a new colour or fill.

**Where and when.** Always last before the turn-end row — under the error,
`Interrupted` or `Process ended` line — so it is in one place however the turn
ended, and nowhere when nothing counted: no empty frame, no gap. It is shown
exactly when the actions are (`!pending`), so the two replace the tail line in
one render, at the tail where a height change pushes nothing. Not while the
turn runs: the group summary already says `Edited N files` then, and a frame
growing at the tail would push at the content streaming in above it. A
cut-short turn shows it like any other — that is the turn whose leftovers most
need reading. The one way it grows after settling is a subagent the turn left
in the background finishing edits: they are this turn's, and they land at the
tail, under nothing but the actions. The wrapper is a scroll anchor candidate
like a part: with rows open it can be screens tall.

**The unit is one assistant message** — what the transcript draws as a turn. A
read point that splits a reply into two messages gives each its own card;
those are two answers. A subagent's edits are read from its children at the
place of the call that ran it, unattributed: the user's question is what
changed, not who changed it.

**What counts** is a call that `succeeded`. A failed or denied call changed
nothing; one interrupted or still running may or may not have, and listing it
would send the reader to review a change that may not exist — the summary
row's rule. A subagent cut short keeps the edits it finished.

**A row** is, left to right: the chevron, the file name — with the chip, the
one primary-colour text on the row — the directory (`Detail`, fading out from
the left, so two `index.ts` stay apart as `…/Chat` and `…/Files`), a chip, and
the counts. The directory is relative to the work directory, empty at its
root, absolute outside it. On a narrow screen the directory goes first, then
the name truncates — never wider than 60% of the line, so a long one gives way
sooner; the chip and counts never move. The full path is on the body's first
line, `PathLine`, a tap away as in the tool body.

- **The chip** says what the turn did to the file, from whether it existed
  before the turn (its first change did not create it) and after (its last did
  not delete it): `new`, `deleted` (also for one created and deleted within the
  turn — it still has something to review), `renamed`, or `rewritten` — a Write
  over an existing file, or a file deleted and made again (when the deleting
  was a command this list cannot see, an edit creating a file it already
  changed says so). A file there throughout and only edited has none. The chip
  is the `background` chip's component; a deletion is not red, since it is a
  result, not an error.
- **The counts** are `+N` in `th-success` and `−N` (U+2212) in `th-error`,
  mono and tabular — the one exception to [failure being the only saturated
  colour](#the-rules), held to the numbers: a signed diff stat is a convention
  read the same as the diff viewer's, and the card is not in a stack of tool
  rows where red could read as a failed call. A side that is zero or unknown is
  left out; there is never a `−0`.

**One file changed several times is one row.** Its counts are the sum of its
changes. Files are listed in the order the turn first touched them, and a
rename moves a row's key to the new path without moving the row, so later
changes join it. A rename onto a file the turn had already changed merges the
two into one row, at the place of whichever the turn touched first, its
changes in the order made. Paths are
matched relative to the work directory when inside it, so two spellings of one
path are one file; a path outside it is matched whole in a namespace of its
own, since `/etc/hosts` split into segments reads exactly like
`<workDir>/etc/hosts` made relative.

**A tap opens the row in place**, at every width: `CollapsibleBody` → a plain
`bg-th-bg-secondary` box — no scroll box of its own, for the reason the tool
body [gave one up](#the-body-problems-2-and-3) — holding `PathLine` (with
*Open* into the Files tab, except for a deleted file or one outside the work
directory) and then one change per `Section`, in order, each drawn exactly as
on its tool row: `ProposedChange` clamped by `ClampedContent` with *Show all*
and *Full screen* (`Edit · deliver.ts`), `+N −M` and the one *Wrap long lines*
switch in its header, and a Write's content copied from there. Being the same
component, each diff also has the tool body's narrow gutter on a phone. A file
changed once heads its block `Change` (`Content` for a Write), as the tool
body does; with more than one, each is headed `1 · Edit`, `2 · Write`…; a
rewriting Write opens with *Whole file written — what it replaced is not in
this call* (not "the transcript": an earlier step may have written exactly
what it replaced). A Codex call that changed several files is split, each
row's diff holding its own file only; `CodexDiff`'s own status-and-path line
half repeats `PathLine`, and is kept rather than given a second rendering mode.
There is no net diff: an `Edit` carries fragments, not the file, so nothing
trustworthy can be composed from them — the changes are shown as made, as
[fetches](#a-fetch-reads-on-the-row-it-came-from) are, nothing merged and
nothing dropped. Not a sheet: on a desktop `Sheet` is 448px, narrower than the
reading column, and a reviewer moving file to file would open and close it for
each. Rows open independently, only by the user's hand, and opening one does
not scroll.

**Many files.** Up to seven are listed. Past that the card lists five and a
`Show N more files` row (a `RowButton` with `toggleable={false}`: once pressed
it is gone, so it has no state to report), which lists the rest and moves focus
to the first row it revealed rather than letting it fall to the page. Seven, not
five, so that `Show 1 more` and `Show 2 more` never appear. The header always
counts every file.

**Line counts are read off the inputs**, with no protocol of their own:

| Change | `+` | `−` |
|---|---|---|
| `Edit` | `diffLines` over `old_string` / `new_string`, each closed with a newline so a fragment's last line compares as a line — appending to `a` is `+1`, not a rewrite of `a` — and carriage returns set aside, so a CRLF file reads the same | same |
| `Edit` with an empty `old_string` | the new text's lines | `0` |
| `MultiEdit` | each edit as an `Edit`, summed | same |
| `Write` creating the file | the content's lines, a trailing newline opening none | `0` |
| `Write` over a file | the content's lines | unknown — the old content is not in the call |
| Codex | the `+` / `-` lines of each file's hunks, so the count is the diff the row opens on; no hunks (an empty file, a pure rename) is `0`, an unknown change type is unknown | same |

Whether a `Write` created or rewrote is only in its result's wording, measured
on Claude Code 2.1.286: `File created successfully at: …` and `The file … has
been updated successfully.` Any other wording — an older record, a CLI that
rephrased it — gets no chip and only `+N`: guessing either way would put a
false word on the card. Summing, `−` adds what is known and is left out only
when nothing is; the header's totals are the files' sums, read the same way.

What the counts do not promise, and the card does not pretend to:

- **They are not `git diff --stat`.** A line one change added and a later one
  rewrote counts twice; a `replace_all` edit counts as one replacement, since
  how many places matched is not in the transcript; a mixed `−` is only the
  known part.
- **Only tool calls are seen.** `rm`, `sed -i` or `git checkout` run through
  `Bash` change files the card cannot list; neither can `NotebookEdit`, which
  `proposedChange` does not read yet. Hence `files changed` counts changes it
  saw, not the state of the tree.

What they do promise is to stay put: everything comes from the persisted tool
calls and results, so a reloaded turn draws the card it ended with.

**Accessibility.** The card is a `role="group"` named by its header (`2 files
changed`) — not a region: one landmark per turn would drown the page's own. The
visible counts are `aria-hidden` beside an `sr-only` *"11 lines added, 2
removed"*. A file row hides its whole visible line and carries one `sr-only`
sentence, so its name reads as one: *"backoff.ts in src/webhooks/sender, new
file, 4 lines added"*, or *"config.ts in src, rewritten, 30 lines written"*
when nothing removed is known. It has `aria-expanded` and `aria-controls`
naming its body. Colour never carries anything alone: the counts are signed,
the chip is a word.

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
<button className="flex min-h-9 w-full flex-col justify-center px-2 py-1.5
                   text-left pointer-coarse:min-h-11 sm:px-2.5
                   hover:bg-th-overlay-hover">
  <span className="flex w-full items-start gap-1.5">
    <ChevronRight className={`size-3 shrink-0 … ${expanded ? "rotate-90" : ""}`} />
    {glyph}                                 {/* ToolStatusGlyph, or the card's CircleHelp */}
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-th-accent">{title}</span>
        {chip && <Chip>{chip}</Chip>}        {/* subagent type, MCP server */}
        {background && <Chip>background</Chip>}
        <Detail detail={detail} detailTail={detailTail} />
        {meta}
      </span>
      {secondLine && <SecondLine … />}
    </span>
  </span>
</button>
```

The row has no fill, corner or frame of its own: it is a line in
[the list](#the-list). Both icons keep `size-3` and the row keeps `text-xs`.

**One line sits in the middle of the floor; two lines fill it.** The button is a
column centred on the cross axis, and the two-column row inside it is
`items-start`. With one line the 16px line box is centred in the 36px or 44px
floor instead of hugging its top with the bottom half empty; with two, 32px of
lines plus `py-1.5` is exactly 44px, and the glyph still sits level with line 1
rather than between the lines — it belongs to line 1.

**The chevron is unconditional.** It used to be drawn only when there was a
result to show, with a blank spacer otherwise — which is why a running call, and
a call that answered with an image alone, could not be opened at all. Every row
has a body now, because every row has an **invocation** to show (below). The one
exception is the permission card, which keeps a condition: a request with no
input really does have an empty body (what Always Allow would write sits above
the buttons, not in it), and "there is always an invocation" is a fact about
tool rows, not about cards.

**Hit area.** The row is the only tap target on line 1, so it takes the floor
directly: `min-h-9 pointer-coarse:min-h-11`. It is not a `touch-target`
overlay — there is room to grow the box, and a real box is always simpler
(`web/src/index.css`, the `touch-target` comment). Controls *inside* the body
(file chips, a section header's buttons) keep the ≥8px separation that overlay
hit areas require.

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
| `background` | same spinner, plus a `background` chip after the name | inherits | activity line when there is one, else the last line fetched of it | invocation + live output + whatever has been fetched |
| `success` | `Check` | **`text-th-text-muted`** | second line only if it came from the background (below) | invocation + result |
| `error` | `X` | `text-th-error` | the row button tinted `bg-th-error/10` (`hover:bg-th-error/15`), detail text `text-th-error`, second line = the last line of the output — or the outcome, when the run came from the background | closed, like every other row |
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
`ask_user_question` — the CLI's own question, now read from old transcripts
only — finds the `tool_call` part with its `toolUseId` and takes its place,
because "all three describe one tool use". `permission_request` carries
`toolUseId` for exactly the same join. Generalising it removed the duplicate rows
and the index suffix with them.

**A question record takes its row the same way.** `question_post` succeeds
immediately — it is not blocked on the user, so it never wears the waiting rung —
but the question it posted becomes a card that the user reads and that carries a
status ([answering-ui.md §6](answering-ui.md#6-the-record-card-in-the-stream)).
The card replaces the row, like the other two — but it joins **by position**,
not on `tool_use_id`, and that is forced rather than chosen: a `question_post`
call reaches the server over HTTP from the MCP endpoint, whose body carries the
calling session and worktree and not the CLI's id for the tool use. So the
`question_posted` record has no `tool_use_id` to join on. What the server does
guarantee is *when* the record is written — during the call — so the record
always falls between that call's `tool_call` and its `tool_result`, and the last
unreturned call whose name ends in `question_post` is the one that posted it.
That is an invariant the server holds itself, rather than an assumption about
the order in which a CLI emits its own frames. A call that asked several
questions writes one record each, and only the first takes the row; the rest
follow the last card of their batch (the ones sharing its `asked_at`), so a
batch is never split by whatever else is running
([answering-ui.md §6](answering-ui.md#6-the-record-card-in-the-stream)).

A join that misses leaves two rows, which is untidy and not wrong. Drawing both
on purpose would be: `question_post  Which database…  ✓` directly above a card
saying the same thing in more words is the duplication this section removed once
already, re-introduced by a tool whose whole output *is* the card.

The difference from the permission card is what the card is allowed to do:
a permission card holds buttons because the call is waiting on them, a question
card holds none because the call is over and the answer goes somewhere else.

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
place a row is still a card — tinted `bg-th-warning/10` and framed by a 1px
`outline-th-warning` drawn just inside its edge — with `CircleHelp` in
`text-th-warning`: it is the only tool-shaped row in the transcript that is
blocked on the user, so it is the only one that gets to be loud before anything
has gone wrong. An outline rather than a border, so the frame does not shift
the card against the rows around it, and drawn inside because the list clips
whatever is outside; an outline rather than an inset ring, because an outline is
painted over the card's children and the row's hover cannot cover it. Its body
keeps the tint. Once answered it is an ordinary row: no tint, and a body on
`bg-th-bg-secondary` like a tool row's.

**The card's body is the row's Invocation.** `ToolInvocation`
(`Chat/ToolInvocation.tsx`) draws both, so the command a user approved and the
command the row later says ran are one rendering, not two that agree by
convention — sections, headers, clamps and all; the card's body has no scroller
of its own either. Below it, for a file tool, a *Proposed change* section draws the
diff or the file preview through `ProposedChange` — the same component the row's
result uses, which reads only the input and so can be drawn before the call
runs — header and all (`proposedChangeHeader`), so the count, the wrap switch
and *Full screen* [below](#the-body-problems-2-and-3) are on the card too. Last,
folded and muted, *Raw input*: the input as it arrived, minus Codex's
`command_actions`, copied from its header as JSON. It is left out where it would
only repeat the body: when the body already is the input (the JSON fallback, an
MCP tool's arguments listed by name, a string input), and for an
`ExitPlanMode` whose plan is its only key. A plan with anything beside it keeps
the raw input, since whatever else it asks for is approved with it.

**The decision is one full-width row**, `Deny | Always Allow | Allow`, with
Allow — the accent, primary action — always at the right-hand end and 1.4× the
width of the others, so it does not move when Always Allow is not offered. The
boxes grow to the floor (`min-h-9 pointer-coarse:min-h-11`, `gap-2`) rather
than borrow a `touch-target` overlay, since the card is free to grow; `text-sm`
on them is the card's one step up from `text-xs`, because they are a decision
and not a caption. Always Allow lost its green: it is the option whose effect
outlives the request, and the success colour was an invitation to press it.
What it will write is said directly above the row and outside the scrolling
body — every suggestion, not the first, because the server sends the whole list
back — so the explanation cannot scroll away while the button stays in view.
No key is bound to any of the three: Escape already interrupts the turn
([answering-ui.md](answering-ui.md#who-owns-escape)), and a stray key on a
prompt that runs arbitrary commands costs too much.

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
| `Task` / `Agent` (the CLI renamed it; history holds both) | the name | `description`, with `subagent_type` as a chip; without a description, `subagent_type`, else a Codex spawn's agent name or prompt ([below](#a-subagents-own-work)) | right |
| `TaskOutput` | `TaskOutput` | the `task_id`, in mono | right |
| `server:tool` (Codex MCP) or `mcp__server__tool` (Claude MCP) | the tool half | the server half as a chip, then the first scalar argument, else compact JSON | right |
| anything else | the name | first non-empty scalar in `input` | right |

Five decisions inside that table:

- **`TaskOutput` is in the table although many of them never draw a row.** A
  fetch of a task's output is filed under the call it reads and takes no row at
  all whenever that call is loaded ([below](#a-fetch-reads-on-the-row-it-came-from));
  the row is what is left otherwise, which on a transcript long enough to page
  is common rather than exceptional. The fallback happens to name the same field
  today — `task_id` is the first string in the input — but by the order
  `Object.values` returns rather than by any rule, so one more string in the
  input would silently rename the row. Mono because a task id is a machine key,
  not prose.
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
**activity** while it is live, the **last line fetched** of a live run nobody is
reporting progress on, the **outcome** of a run that finished in the
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
2. the **last non-empty line** of this call's machine output, from either of two
   sources: the newest **fetch** of it that came back with something
   ([below](#a-fetch-reads-on-the-row-it-came-from)) — read out of the envelope
   the fetch carries it in, see there — and failing that `run.output` — Codex's
   `commandExecution/outputDelta`. Literal output either way, so mono.
3. for a settled `fromBackground` run, the first line of the outcome. Prose.
4. for a settled foreground **failure**, the **last non-empty line** of the
   result. Literal output, so mono. Before this rung a collapsed failed row said
   only *that* the call failed — the border and the glyph — and the reason was
   behind the chevron, which is why the row used to open itself.

**Rung 2's two sources are one rung, not two.** Both are this call's own machine
output, and either one is the same sentence to a reader — *this is the last thing
that came out of it*. Two rungs would only be two ways of writing that down. On
today's engines they cannot even collide: `output` accumulates from Codex's
`outputDelta`, and only Claude has work that outlives a turn for anything to
fetch. So the order between them is written for a future engine that has both,
and the fetch wins on the principle that decides every other rung here — it is
the later word on the thing, a reading somebody deliberately took, and it is also
the only one of the two that survives a reload, `output` being live-only. A fetch
that **failed**, or that came back with nothing, does not reach this rung at all
— the second line is this *run's* latest word, and a fetch that failed is news
about the call that did the fetching, not about the task. And although the rung
sits inside the live branch, a fetched line is `live: false`, so it stays in the
row's accessible name: the flag describes the *text*, not the run, and this text
does not move again until the next fetch. Same reasoning as rung 3.

Rung 1 still outranks it, for the reason it outranks the raw output: a
`task_progress` line is the CLI's account of the present, and a fetch is a tail
of the past. **When rung 2 is therefore visible at all** was worth measuring, and
the answer is: on every backgrounded `Bash`. Claude emits `task_progress` for
`local_agent` and `local_workflow` runs and for a backgrounded `mcp_task`, and
for nothing else — shell tasks have no progress sender anywhere in the CLI
(measured against claude 2.1.263). So a backgrounded shell row has no rung 1 ever,
and a fetch of it is exactly what the user reads on the row. On a backgrounded
subagent the opposite holds while it is live, until its first step replaces the
rungs ([its second line](#the-second-line-steps-and-what-it-is-doing)), and the
fetch is in the body.

Rung 3 is above rung 4 and the order is load-bearing: a backgrounded failure's
outcome is the notification's own summary sentence, which says more than the
tail of a log the user never asked for. The last line rather than the first,
because it is the one rung 2 was already showing a moment earlier — the text
does not jump to the other end of the output as the run settles — and because a
build states its verdict at the end (`make: *** [build] Error 1`) while the head
is noise (`> vite build`).

It is drawn `text-th-text-muted` like every other second line, not red. The row
already carries three reds; a fourth would dilute "red means failed" into "red
means this row". The tint and the glyph say the call failed, the second line
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

Those two re-flows need one more rule. The transcript does hold a reader's place
through a height change above them, wherever they are reading
([agent-chat.md](agent-chat.md#where-the-view-sits)) — but holding it means
writing `scrollTop`, which ends momentum scrolling on iOS, and everything below
the change moves on the screen whatever is done about the reader. A row that
keeps one height asks for neither.

For a foreground run neither cost lands anywhere: the turn is blocked on it, so
it is the last thing in the transcript — a reader at the tail is following that
row itself, and a reader further up has it below them, where a height change
moves nothing they can see. **A background run is exactly the row that is not**,
because the conversation carries on above it for half an hour. So a background
run does not lose its second line when it settles:

> **The second line is the run's latest word.** While the run is live that is its
> activity. When a backgrounded run finishes, it becomes the first line of the
> outcome — and stays.

Which is also the better row: a settled background call that reads *"Build
succeeded in 4m12s"* without being opened is the thing the user went looking for.
It replays correctly too, because the outcome is persisted while the activity is
not. Only a run that finished in the foreground drops its line — or hands it to
rung 4, if it failed — and that row is at the tail by construction, so both
changes of height happen where nothing is below them.

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

**A replayed background run that is still going may show no second line at all**
— rungs 1 and 2's `output` half are both live-only — **and still reads
correctly**, because `status` alone carries it: spinner + `background` chip =
still going. That is the whole reason status is derived from persisted records
and activity is not. The two things that do replay onto that row are the outcome,
once it has finished, and any fetch of it: a fetch is a persisted `tool_result`,
so a reloaded page shows the fetched line from its first frame and never changes
height there.

### When a background run finishes

`task_notification` supersedes the placeholder. The row settles to
`success` / `error` (glyph and colour from the table), keeps the chip, keeps its
second line — now the first line of `summary` — and the body gains another
section. The body must not simply replace the placeholder text: the placeholder
is what the **agent** read, the notification is what
**happened**, and a body that shows only the second asserts the agent saw
something it never did. Labelled blocks, in this order:

```
Returned to the agent
  Command running in background with ID: bash_1
Fetched output
  tick 418 at 2026-09-17T14:07:11Z
Outcome  ·  after the turn
  Build succeeded in 4m12s
  /work/repo/.pockode/logs/build-1.log                                    Open
  Not fetched
```

The middle block is the next section; the order of the three is **a reading
order, not a clock**, and it is fixed — what the agent was handed, then what was
fetched of the work, then how it ended. Nothing could make it a clock even if
that were wanted: a history record carries no timestamp at all
([tool-call-model.md](tool-call-model.md#toolrun)), so any heading claiming a
time would be inventing one. It is also the true order in all but the contrived
case of a fetch made after the notification arrived.

**The three blocks are one component**, `ToolOutcomeSections.tsx`, used by both
`ToolCallItem` and `TaskItem` — the same reason `ToolRow` and `toolSummary` are
shared: one account of one thing, so the two renderers cannot word it
differently. It is named for the outcome rather than for the background because
the last block is drawn for foreground calls too, where its label is simply
`Result`. It draws nothing at all when all three are empty, which is the common
case, and it takes a `block` switch for the one difference between its two hosts:
`ToolCallItem`'s body is a single padded block that it sits inside, while
`TaskItem`'s is a stack of bordered blocks, so there it is one of those. Either
way each of its sections clamps itself rather than scrolling
([the body](#the-body-problems-2-and-3)); no ceiling at
all would let one fetch of a chatty task push the transcript down
by thousands of pixels.

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
happen is for it to land in the *Returned to the agent* block, or in a plain
`Result` block: the agent never read it, and no CLI ever said it. The record's
own text names its author, so a reader of the transcript is told where the claim
came from and not only that the work ended.

### A fetch reads on the row it came from

Claude's `TaskOutput` fetches what a task has produced so far. Drawn as a row of
its own it lands a screenful below the work it is about, carrying an opaque
`task_id` as the only thing tying the two together — the user is left to do the
join by eye. So it takes no row: when the server could say which call it reads,
the fetched text is drawn on **that** row, as rung 2 of its second line and as
the middle block of its body.

Whether it is absorbed at all is not a drawing decision — it is decided once,
when the `tool_call` arrives, by the reducer, and the reasons (including why a
row that did keep its own is never taken away afterwards) are in
[code/frontend-state.md](code/frontend-state.md#a-fetch-filed-under-the-call-it-reads).
What is decided here is everything after that.

**A row of its own is not the rare case.** Absorption needs the call it reads to
be in the loaded transcript, and a transcript long enough to page is routinely
cut between the two: measured on a real session, reloading after four more turns
put the page boundary above the backgrounded `Bash`, and two fetches that had
been read on its row before the reload came back as rows of their own. That is
the rule working, not failing — but *every fetch is on the row it reads* is not
a sentence this page can promise, and the layout below is what the user sees
either way.

**A fetch answers in an envelope, and only the row unwraps it.** `TaskOutput`
does not reply with bare output; it replies with a small document — against
claude 2.1.263, `retrieval_status`, `task_id`, `task_type`, `status`, and then
the task's own output inside `output`. So the last line of the reply as a whole
is a closing tag, which as rung 2 of the second line put the literal string
`</output>` on the row of every backgrounded shell call. The second line reads
what the envelope carries; the **body draws the reply as it arrived**, because
that block is the record of what a later call read and a tidied record is not
one. A reply in a shape this does not recognise is read whole, which is what it
did before and is never worse than a tag.

**Every fetch gets a block, in the order they arrived — oldest first, newest at
the bottom.** Not merged, not thinned to the newest one. `TaskOutput` does not
say whether it returns the whole output or only what is new since the last read,
and each of the two shortcuts is wrong under one of those readings: keeping the
newest alone loses text if the tool is incremental, and concatenating repeats an
entire log if it is not. Separate blocks are honest under both. In the ordinary
case of one fetch this costs nothing — the sub-headings appear only from two:

```
Fetched output  ·  3 fetches
  Fetch 1
    tick 1 …
  Fetch 2
    tick 207 …
  Fetch 3
    tick 418 …
```

They are numbered by position and keyed by the fetching call's own
`tool_use_id`: two fetches of one task very often carry the same text, and text
is no key.

One of the two readings has since been measured, for one of the three kinds of
task `TaskOutput` serves: a `local_bash` task answers with **everything printed
so far**, so a second fetch repeats the first one's lines in full and the blocks
above really do stack up copies of a growing log. The other two — `local_agent`
and `remote_session` — have not been measured, so this stays as it is: thinning
to the newest is only safe once all three are known to be cumulative, and
deciding that on the strength of one is how a body starts dropping text.

**The heading carries the count, or the one fetch's degenerate state:**

| The fetch | Heading | Body |
|---|---|---|
| came back with output | `Fetched output` | the text, in mono |
| came back empty | `Fetched output · nothing yet` | *The task has produced no output yet.* |
| failed | `Fetched output · fetch failed` | the error text, `text-th-error` |
| never came back | — | the block is not drawn at all |

Those suffixes are for a single fetch only; from two, the count wins and each
block says its own state. "Came back empty" means **neither prose nor blocks** —
a fetch that answered in content blocks this body cannot draw has answered, and
calling that "no output yet" would be a statement about the task that is simply
false. "Never came back" is an interrupted turn: the fetch was absorbed, its
result never arrived, and an empty heading would be the body inventing a section
for something that does not exist.

Three things a fetch must not do to the row it lands on:

- **Not change its status, and not turn it red.** A fetch read the task; it did
  not end it. A fetch that *failed* says something about the call that did the
  fetching and nothing whatever about the task, which may be running perfectly —
  so the red lives in the block, where it refers to the thing that actually
  failed, and the row keeps the glyph and colour it already had. This is the
  general rule with a new chance to break it: the renderer infers nothing, and
  whether the task is still running is the reducer's to say.
- **Not add a badge, and not count itself on the row.** The `background` chip
  already says this work outlived the turn, and a fetch is part of that work
  rather than a second fact beside it. The count is in the body's heading, which
  is a place someone is reading; on the row it would cost a slot permanently, on
  every backgrounded row.
- **Not open the body.** Same rule as a background run finishing, and the same
  reason: a fetch can arrive half an hour later, with the row far above the
  reader. Neither renderer opens itself for one today; this is written down so
  that nobody adds it.

Nothing on the row says a fetch is *in flight*, either. `TaskOutput` blocks for
30 seconds by default, and for those seconds the row is unchanged — the row's
status is the task's, and painting another call's progress onto it is the
inference this page forbids. Nothing else in the transcript moves either: a
message whose only part was the absorbed fetch has nothing left to draw, and it
is dropped outright once the turn closes, the same as any turn that never got a
first token. The cost is a transcript that looks idle for those seconds, and it
is accepted for the reason above — the agent fetched the output in order to do
something with it, and its next message is where that shows up.

The fetch's own invocation — `block`, `timeout` — is drawn nowhere. It is how the
reading was taken, not part of what the task produced, and the `task_id` is
already this row's identity. The fetched text is not truncated either: the 50-line
cap on live output exists because that block is redrawn as the output moves, and
a fetch is one record that the CLI has already cut to its own limit.

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

One `CollapsibleBody` → one padded block, with **no height and no scroller of
its own**. It used to be a `ScrollableContent max-h-[60vh]`, and on a phone that
box was under the thumb most of the time a tall body was open, so the drag
meant for the transcript scrolled the body instead. Now every section clamps
itself (`ClampedContent`, `web/src/components/ui/`): past `max-h-80` it is cut,
faded where it is cut, and opened in place by *Show all*. Clipped content
scrolls nothing, so every vertical drag stays the page's — and a keyboard that
tabs into the cut-off part opens it, because the browser would otherwise
scroll the clipped box to the focused control and leave it where no drag can
bring it back. Sideways a section
does scroll — a file's lines keep their width — and a box with nothing to
scroll vertically hands a vertical drag on to the page. What is read at length
rather than skimmed — a whole file (`Read`, `Write`) and a diff (`Edit`,
`MultiEdit`) — also offers *Full screen*, the shared `Sheet` in its
`fullScreen` form, once it runs past the clamp.

**Every section has a header bar** (`Section`, `Chat/ToolSection.tsx`, drawn
through `BlockHeader` in `components/ui/`): its name on the left, its actions on
the right. The copy button is one of those actions, never laid over the
content — in a code block's corner it sat on the end of the first line, which
on a phone is most of a command. `CodeHighlighter`'s corner button is turned off
(`copyable={false}`) wherever a header carries it. What a result's button copies
is `resultCopyText`: the text a reader would select, so a `Read` without its
line numbers and a command's output without its colour codes; a diff or a
checklist has no button. `BlockHeader` is meant for any block of content, not
only tool sections: a fenced code block in the agent's text (`CodeBlock`,
`components/ui/`) is the same bar, with the language on the left and the copy
on the right, over code that scrolls sideways in its own box so the bar stays
put. The text around it is `prose-sm` brought in for a conversation
(`prose-message`, `web/src/index.css`): headings one step above the body
rather than four, tighter paragraphs, a table in tight rows that scrolls in its
own box when it is wider than the phone — the transcript clips sideways, so a
table left to it would lose its right columns.

**The order is the tool's** (`toolBodyLayout`, `web/src/lib/`). For a tool whose
row has already said everything that was asked — `Read`, `Glob`, `Grep`,
`WebSearch` — the result comes first and the invocation is folded
under it, its header the disclosure: the input in full would only stand between
the reader and the answer they opened the row for. It is still there, which
keeps [everything the row truncates](#the-rules) in the body; and it starts
open when there is no result yet, because then the call is all the body has to
say. Everything else, `Bash` first among them, keeps the invocation on top: a
command is what has to be read before its output can be trusted. A `TodoWrite`
is its checklist and nothing else: the list is the input, and a successful
result only acknowledges it — a sentence telling the agent to keep using the
tool — so it is left out (`resultIsAcknowledgement`). A failed one keeps its
result, which is where it says why.

**Sections are named for what they hold**, not for the plumbing. The invocation
names itself by what it shows — *Command*, *File* / *Files*, *Request* for a
sentence, *Todos* for a checklist, *Parameters* for named fields and the JSON
fallback. The result is named by the tool: *Output* for `Bash`, *Content* for
`Read` and `Write`, *Change* for `Edit` and `MultiEdit`, *Matches* for `Glob`
and `Grep`, *Results* for `WebSearch`, *Page* for `WebFetch`, and *Result* for everything
else. A result that arrived after the turn is *Outcome · after the turn*
whatever the tool, as below.

In the default order, each section omitted when empty:

1. **Invocation — always present.** This is the answer to problem 2 and the
   reason every row now has a chevron.
   - `Bash`: `CodeHighlighter language="bash" wrap` with the full command —
     wrapped, selectable, and copied from the header.
     Claude's `description`, when present, sits
     above it as one muted line; Codex's `cwd`, when it is not the work
     directory, below it as `in <path>`.
   - File tools: the path on **one line** (`PathLine`), relative to the work
     directory when it is inside it and cut from the left as the row cuts it —
     the file name whole, the directories first to go — with an *Open* into the
     Files tab when it is under the work directory. The absolute path broken
     anywhere took four lines on a phone, most of them the work directory every
     path shares. The full path is still in the body, a tap away rather than
     behind a hover: tapping the line writes it out absolute and wrapped, and
     it is what the header's copy button copies. A Codex file change gives one
     such line per file it leaves behind — a rename's destination, since its
     source is gone.
   - `Grep` / `Glob`: pattern, path and flags as labelled lines.
   - `TodoWrite`: the checklist — a status icon per item, the done ones struck
     through. An input that is not a list of todos falls through to the
     fields below.
   - `ExitPlanMode`: the plan, through `MarkdownContent`, with no label —
     clamped all the same.
   - A Codex approval that described nothing but its `reason`, or an input
     that is a bare string: the text as a sentence.
   - MCP and unknown tools: the arguments as a `name  value` list
     (`FieldList`, shared with `Grep` / `Glob`) — a string as the text it is,
     unquoted and wrapped; anything else as its JSON, indented when it has
     structure of its own. A value sits beside its name when it fits and goes
     under it when it does not. The header copies the input as JSON, since that
     is what it gets pasted back into. An input with no fields to name — an
     array, an empty object — stays `CodeHighlighter language="json" wrap`,
     capped at the `HIGHLIGHT_LIMIT` the file viewer already uses, because
     shiki tokenizes on the main thread.
2. **Live output**, while running: the last 50 lines of `run.output` in a mono
   block, newest at the bottom, replaced by the result when it arrives. **No
   scroller of its own**, like every section — and its clamp keeps the *end* in
   view (`clampFrom="end"`), since the newest line is the one being watched. The
   50 lines are what a cap buys on top of that: a build that printed ten
   thousand of them does not become ten thousand DOM nodes in a row nobody has
   finished reading. The body does not auto-scroll either; the row's second line
   is the live glance, and the body is where someone reads at their own pace.
3. **What became of the call**: the three shared blocks in their fixed order —
   *Returned to the agent*, *Fetched output*, and then *Result* or, when the run
   came from the background, *Outcome · after the turn*
   ([above](#when-a-background-run-finishes)). The first two are drawn whole by
   `ToolOutcomeSections`; the last is a slot, because what a result looks like is
   this renderer's knowledge. Here it is `ToolResultDisplay` — whose file
   changes are `ProposedChange`, shared with the permission card — with three
   cheap additions that close problem 3 and need nothing from the new model:
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
   - `Bash`: the output **wraps** — a log line is read whole, and a sideways
     scroll hid the end of nearly every one on a phone. Its clamp keeps the
     *end* in view (`resultFromEnd`), because a test run's or a build's verdict
     is its last lines: `max-h-80` at the body's `text-xs` line height is the
     last 20 lines or so, and the button that opens the rest says how much
     there is — *Show all N lines*. A failed command's last five lines are
     marked as its error (a red rule, tint and text), since that is nearly
     always where it says why; five holds a compiler's last errors or a test
     runner's `FAIL` without painting a whole log red.
   - A diff (`Edit`, `MultiEdit`, a Codex file change): the header says how
     many lines it adds and removes, `+N −M`, and carries a switch that wraps
     long lines (*Wrap long lines*). The switch is one remembered choice for
     every diff in the chat (`diffSettingsStore`, beside the Git view's
     whitespace one) rather than a state per block: a reader on a phone who
     wants lines wrapped wants them wrapped in the next diff too. Off by
     default, because unwrapped lines keep the code's shape. A `Write` gets
     neither: a new file is content, not a diff, and every line of it would
     count as added whether or not it overwrote one. On a phone the diff has
     one narrow line-number column instead of two — see
     [Width and pointer](#width-and-pointer).
4. **Exit code**, when Codex reported a non-zero one, and — for a call whose
   result outlived the turn it was cut off in — one line saying so.

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
no shared second line on a failed run (`failed && !run.fromBackground`) —
with the body already open, rung 4 would only be a second and worse copy of what
is under it, the tail of a markdown report drawn in mono. What a failed subagent row says instead is
[its step count](#the-second-line-steps-and-what-it-is-doing), which copies
nothing in the body. A backgrounded failure keeps its outcome line (rung 3),
steps or not: it is the one failed row whose body is not supposed to open (next
paragraph), so the line is not a copy of anything on screen.

**A `background` run must not open itself** — a 30-minute task that unfolds
itself shoves the transcript around long after the user stopped caring, and the
reader's place is held through that at the price of a write to `scrollTop` each
time ([above](#the-second-line-problem-1)). It is also the one rule on this page
the code does not keep: `TaskItem`'s `autoExpandedRef` keys on
`run.status === "error"` alone and never reads `fromBackground`, so a
backgrounded subagent that fails opens its report anyway, wherever in the
transcript it sits. The gap predates rung 4 and is recorded rather than closed
in passing, because closing it is a behavioural decision and not a typo: that
report is still the only account of what went wrong, so the alternative to
opening it has to be a way of reaching it, not silence.

### The subagent body

`TaskItem` draws a different body, because a subagent answers in prose rather
than in output: its report as Markdown, then the three shared blocks, then the
subagent's own work behind a **Process** disclosure
([below](#a-subagents-own-work)), then the prompt it was given behind a
disclosure of its own. The blocks sit right under the report deliberately — the
report is the subagent's conclusion, and the raw output a later call fetched is
evidence for that same conclusion, so it belongs under it. Process comes after
both because it is how the subagent got there, which a reader wants less often
than what it found; the prompt comes last because it is the question, and the
reader opening this row already knows roughly what was asked from the row's own
detail.

```
┌────────────────────────────────────────────────────────────┐
│ ›  ✓  Task  Explore  Find retry handling            1m 12s │
│       12 steps                                             │
├────────────────────────────────────────────────────────────┤
│  The sender retries on 429 and 503, honouring …            │  report
│  …                                                         │
├────────────────────────────────────────────────────────────┤
│ ›  Process · 12 steps                                      │  closed
├────────────────────────────────────────────────────────────┤
│ ›  Prompt                                                  │  closed
└────────────────────────────────────────────────────────────┘
```

Until those blocks arrived this body had a hole in it, and the hole told a lie:

- A backgrounded subagent's report **does not come back as its call's
  result**. The call handed the agent a placeholder and the agent moved on; what
  arrives later is `task_notification`'s summary. `TaskItem` drew that text
  unlabelled, in the place a report goes — so a summary that arrived after the
  call had returned read as what the call returned, which is exactly what the
  *Returned to the agent* / *Outcome · after the turn* pair exists to prevent.
  The outcome now goes under its own label like everywhere else.
- The placeholder itself was drawn nowhere, so the text the agent actually read
  was the one thing missing from the body.

That outcome is the subagent's report all the same, delivered later. Measured
on claude 2.1.286, the summary is the subagent's last message word for word, and
the CLI hands the notification to the main agent, which reads it — the agent's
next words quote it. So a settled backgrounded subagent that ended well needs no
sentence about a missing report: the outcome under its own label is the report,
and nothing stands in front of it. One that failed or was stopped has the CLI's
verdict there instead, and its sentence points at it without blaming the
subagent for silence: *"The subagent ran in the background; how it ended is
under Outcome below."* The other empty-report sentences — still working, failed,
cut short — are unchanged and are still the answer everywhere else, including a
backgrounded subagent that has not settled yet: that one really is still working.

This is a common case, not the corner: on claude 2.1.286 the CLI backgrounds a
main-agent `Agent` call of its own accord, `run_in_background` or not — every
one in a run that launched two at once did.

## A subagent's own work

While a subagent runs, everything it says and every tool it calls arrives on the
same stream as the main agent's — a backgrounded one writes between the main
agent's own lines — and Pockode used to draw all of it flat: the subagent's
*"Looking at the sender for edge cases."* and its `Read` / `Grep` rows sat at the
same level as the main agent's own, and nothing on screen said whose they were.
That is the one way this transcript makes a reader misjudge *who did what*, so a
subagent's work is now drawn **under the call that spawned it**. Which records
belong to which call is the model's to say
([tool-call-model.md](tool-call-model.md#a-subagents-own-conversation)); this
section is what the row and its body do with them.

Two words, used exactly:

- **Children** are everything the subagent produced, text and calls alike, in
  arrival order. The body draws them as its **Process**.
- **Steps** are the children that are calls — every child `tool_use_id`,
  whatever it is drawn as at the moment: a tool row, a pending permission card
  standing in for one, or a question card that replaced one. Counting by id
  rather than by row is what keeps the count from dropping by one while a card
  waits and from never counting a question. Text is not a step: it is
  commentary on the steps, and a count that moved when the subagent narrated
  would stop measuring progress. A subagent the subagent spawned is one step,
  however much it did itself ([nesting](#a-subagent-inside-a-subagent)).

Codex's subagent spawn reaches this row as a subagent call too, and everything
in this section applies to it unchanged, save what Codex does not report: no
task description, ever. A spawn reported as `subAgentActivity` names no prompt
either, so its row is named after the agent the model gave the task to and its
body has no Prompt section; one reported as a `spawnAgent` call carries the
prompt, which names the row by its first line and fills the Prompt section
([code/agent-integration.md](code/agent-integration.md#subagent-threads)).

### The second line: steps and what it is doing

```
 ⟳  Task  Explore  Find retry handling                     47s
    6 steps · Grep "Retry-After" in server/
```

The collapsed row is how a user tells a subagent that is getting somewhere from
one that is stuck, without opening anything. Two facts do that: *how far* it has
come — the step count — and *what it is doing now*, which is its **latest
child**. So a subagent's second line replaces the shared rungs with its own; the
first row that matches wins:

| Run | Second line |
|---|---|
| no steps | the shared rungs, unchanged — `run.activity` while live, the background rungs, else no line |
| live (`running` / `background`) | `N steps · <latest child>` |
| `interrupted` | `N steps · <latest child>` — frozen where it was cut |
| settled, from the background | `N steps · <first line of the outcome>` |
| `success` / `error` | `N steps` |

`1 step`, singular. The rules inside that table:

- **The latest child is worded the way it is worded on its own.** A call reads
  as its own row would — `toolSummary` title, then its detail through the same
  `Detail` component, so a path still loses its directories before its file
  name; a call standing behind a card reads the same, since the card uses the
  same derivation. A text reads as its first non-empty line, with any leading
  Markdown block marker (`#`, `>`, a list bullet) dropped, and the inline
  markers a report opens with as often as not — `**Findings:**`, a code span, a
  link's target — dropped too. Not `__` or a single `*`: as likely an
  identifier's own. A subagent between two
  calls is usually writing, and *"Checking the 503 path next."* is exactly what it
  is doing at that moment — which is why the second half reads children although
  the count only counts steps.
- **Steps outrank `run.activity`**, which is why only the no-steps row reads it.
  For a subagent Claude's `task_progress` line is `Running <description>`
  (measured, claude 2.1.263 —
  [the task lifecycle](code/agent-integration.md#the-task-lifecycle)), which is
  the row's own detail said again. It is better than nothing only before the
  first step has arrived. Children also replay — they are persisted, and the
  activity is not — so a reloaded row reads the same as the live one did.
- **Its shape.** One flex line, `items-baseline gap-1.5`, inside the row's
  existing `text-th-text-muted` second-line slot: the count `shrink-0`, a `·`,
  then the latest child — a call's title in `text-th-text-secondary` (not the
  accent the row's own title wears: two accent titles on one row would make the
  child read as the row), then `Detail`, which truncates. A text child is one
  `truncate` span, not mono. `6 steps · ` never yields width; on a 320px phone the
  latest child is cut to a few characters and the count is still there, because
  the count is the half that answers *is it moving*.
- **It is never red, even when the latest child failed.** `Detail` is passed no
  error here. A failed call inside a subagent is the subagent's trial and error,
  exactly as one in the main transcript is
  ([the body](#the-body-problems-2-and-3)); the row's colour is the subagent's own
  outcome, and the failed call is red on its own row in the Process.
- **A settled run keeps its count and drops the latest child.** On `success` and
  `error` the report is the account of what happened, and the last thing the
  subagent touched is noise next to it; `12 steps` is the fact worth keeping on
  a collapsed row. `interrupted` keeps the child because there it *is* the news:
  where it was when it was cut. A run that settled from the background, success
  or failure, keeps its outcome line as every background row does
  ([above](#the-second-line-problem-1)) — a backgrounded failure does not
  rely on its body opening, because it must not
  ([the body](#the-body-problems-2-and-3)). Keeping a line in every case is also
  what holds the row's height when it settles, and that matters more for a
  subagent than for any other foreground call: the main agent routinely spawns
  several at once, so a subagent row that finishes first is **not** at the
  tail — its siblings are still running under it.
- **`error` gets a line now.** The shared rung 4 (the tail of the output) is
  still withheld, for the reason [above](#the-body-problems-2-and-3) — the body
  opens itself and the report is right there — but the count is not a copy of
  anything in the body's first screen, so it stays.
- **`aria-hidden` while live, exposed once settled**, as every second line
  ([above](#the-second-line-problem-1)). Both halves move while live: the count
  and the latest child.

A row with **no steps** draws what it drew before this section existed. That
covers two real cases with one rule: a subagent that answered without calling
anything, and every transcript recorded before children were attributed —
their subagent records sit flat beside the call
([below](#what-is-not-filed)). Writing `0 steps` on those would be false for the
second kind. The price is that a step-less subagent which showed its activity
line while live loses it when it settles — the one re-flow left, on a subagent
that never called a tool, which is rare.

### Process

```
├────────────────────────────────────────────────────────────┤
│ ⌄  Process · 6 steps                                       │
│ ┃ Looking at the sender for edge cases.                    │  subagent text
│ ┃ ›  ✓  Read   server/relay/sender.go                      │
│ ┃ ›  ✓  Grep   "Retry-After" in server/                    │
│ ┃ ›  ✗  Bash   go test ./relay/…                           │  red on its own row
│ ┃       --- FAIL: TestRetry (0.01s)                        │
│ ┃ The 503 path ignores the header. Checking why.           │
│ ┃ ›  ⟳  Read   server/relay/backoff.go                     │
├────────────────────────────────────────────────────────────┤
```

A disclosure in the shape the Prompt one already has — a `<button>` with
`aria-expanded`, chevron, muted label, `p-2`, `border-t` — titled
`Process · N steps` with the same `N` as the row, or `Process` alone when every
child is text. It is drawn only when it has at least one child to draw (the next
rule, and a pending card drawn under the row instead
([below](#when-a-step-asks-the-user)), can leave it none) or unfiled children to mention
([below](#what-is-not-filed)).

**The report is not drawn twice.** A subagent's last message *is* its report,
handed to the main agent as the call's result when the subagent ran inside its
call and as `task_notification`'s summary when it ran in the background. A
backgrounded subagent also streams that message as a child, so its Process
would end on the outcome drawn above it again. The Process therefore leaves out
a **last child that is the same text** as the report or outcome the body shows
(whitespace aside), or that last child's final paragraph when it is exactly
that text — messages in a row are joined into one part, a blank line apart, and
the report is only the last of them — compared, not assumed, because the stream does not always
carry it (all measured on claude 2.1.286): a subagent that ran inside its call
hands its last message back without streaming it, and a resumed one
(`SendMessage`) streams words under the call that first spawned it that are not
that call's report at all. A failed run's result is the CLI's error, so nothing
matches it. While the run is live there is nothing to match, and the second line
reads the newest words like any other latest child. Text is not a step, so the
count is the same either way.

**The report is the subagent's, not the frame around it.** What a subagent that
ran inside its call returns is addressed to the model (claude 2.1.286): a
`[Subagent hand-back]` preamble saying the text is model output, the report with
every line indented two spaces, then the `agentId` and `<usage>` lines the agent
needs to resume it. The body draws the report out of that frame
(`subagentReport`); a result in any other shape is drawn as it came, so a CLI
that rewords the frame costs the unwrapping and never the report. A subagent's
own subagent that ran this way streamed none of its work in the measured run —
its frames reached only its sidechain transcript — so its row has a report and
no Process.

**It is closed until the user opens it, and nothing opens it.** Not a failure,
not an interruption, not the subagent finishing. `TaskItem` opens its body when
the subagent fails, because the report is the only account of what went wrong;
the Process is a tap further down, and opening it too would put a subagent's
forty rows into the transcript at the moment the user is reading the report. If
the report is empty, its sentence sits above the closed Process — with only the
outcome blocks, when there are any, between them — which is where the reader
goes next. Its open state is local and survives the run settling, like the
Prompt's.

**Children in arrival order, each drawn by the renderer it would have in the
main transcript.** A call is a `ToolCallItem`, a subagent call a `TaskItem`, a
permission or question record its own card — the same components and rules as
at the top level, because a `Grep` is a `Grep` whoever ran it, with one
exception: **a nested `TaskItem` does not open itself on failure.** Inside an
open Process it is mid-transcript by definition, so opening it is a height
change under the reader for a failure the outer subagent has already dealt
with — its red row says it failed, and the outer report is the account. The
Process is a **list of parts**, the same shape a message's content is, so it is
drawn by the same `PartBlocks` and its consecutive calls fold into a summary
exactly as a message's do ([groups](#groups)).

**It does not scroll on its own.** The `TaskItem` body is a stack of blocks
whose report and prompt are clamped like a tool section, and this is the one
block that is not: the rows inside it open into bodies of their own, and a cut
around them would hide a row the reader opened behind a *Show all*. A scroller
is out for the reason [the body](#the-body-problems-2-and-3) gives — a drag on a
phone goes to whichever box is under the thumb. So the Process grows
to its full height, and the cost — a long subagent is many rows once opened —
is accepted because it is only paid by someone who asked for it, and
[grouping](#groups) folds most of it back into a line.

**While the run is live it grows at the bottom**, newest last, and it does not
scroll itself to follow. The row's second line is the live glance; an open
Process is for reading at the reader's pace, which is the same split the live
output block makes.

#### Telling the subagent's words from the main agent's

Inside a Process every line belongs to the subagent, and it must not be
possible to mistake one of them for the main agent's — that mistake is what this
section exists to end. None of the cues is a new colour:

- **A rail.** The children sit in `ml-2 border-l-2 border-th-border pl-2`, so
  the Process is a column visibly hung from its own heading, and the main
  transcript's text never has one. A rail rather than a card because the
  children's rows are already a framed list, and a card around a list is a box
  around a box.
- **The rows are a list of their own.** The column sits on the `TaskItem` body's
  `bg-th-bg-secondary` with no fill of its own, and its rows are drawn by the
  same `PartBlocks` as the main transcript's: a framed list, with the message's
  `space-y-2` between it and the subagent's text. The frame and the hairlines
  give each row its edges, which is why the column no longer needs a ground of
  its own to set rows off from it — it used to take the agent's bubble fill for
  that, back when every row was a filled card. The column keeps a `pr-2`, so a
  list in it does not run its frame into the frame of the list the Task row
  itself sits in.
- **The subagent's text is a note, not a message.** The main agent's text is
  `MarkdownContent` — `prose prose-sm` in `text-th-text-primary`. The
  subagent's is the same component in a **note** variant: body at the row's
  `text-xs`, in `text-th-text-secondary`, with tight paragraph margins. A
  variant rather than a wrapper's classes, because `prose-sm` and the prose
  colour variables are set on the component itself and win over anything
  inherited, and because its inline code is a fixed `text-sm` that has to scale
  with the note rather than stand out of it. No bubble, no avatar, no message
  chrome: a subagent's text is commentary between its steps, and drawing it at
  the weight of an answer is what made it read as the main agent talking.
- **Tool rows are the same rows.** One-line rows at `text-xs` in the same list,
  folding into the same groups; the rail is what says whose they are. Restyling
  them would be a second visual language for the same call, and one more thing
  grouping would have to know.
- **It is named for a screen reader too.** The column is `role="group"` with an
  `aria-label` naming whose it is (`Explore subagent's process`, from the row's
  chip; `Subagent's process` on a row with none, as every Codex spawn is). The cues above are all visual, and a screen-reader user
  hearing the subagent's text as plain prose would be making exactly the mistake
  this section ends.

The report is the exception and is drawn as it is today, Markdown at full
weight: it is the subagent's answer to the main agent, it is what the main agent
read, and it is outside the rail.

#### A subagent inside a subagent

Claude's `task_started` carries `spawn_depth`, so a subagent spawning its own is
a case the CLI itself names. It needs nothing new: the inner call is a child
like any other, drawn as a `TaskItem`, with its own second line, its own report
and its own closed Process — recursion of the one component, not a second
design.

- **The outer row counts it as one step**, and when it is the latest child the
  outer line reads it as the inner call's row does
  (`Task  Explore  Read the backoff policy`), not as the inner subagent's latest
  child. The outer row says what the *outer* subagent is doing, which is waiting
  on its own subagent; the inner row, one tap down, says what that one is doing.
  Reaching through would put a step the outer subagent never took on its line.
- **Each level costs one rail's indent, up to three.** The rail's `ml-2 pl-2`
  plus its border is 18px; three levels cost about 54px, which on a 360px phone
  still leaves the innermost rows well over 250px — room for a title and a
  meaningful detail. From the fourth level the rail is drawn without further
  indent, so a pathological depth narrows nothing past that — the rail and each
  level's own list frame still say where each level starts.

#### When a step asks the user

A subagent's call can need permission, and its card would be inside a Process
that is closed by default — a session that looks busy while it is waiting on
someone who cannot see why. So **a pending permission card is never inside a
Process**: it is drawn **in the outermost Task item, between the row and the
body**, outside the collapsible, visible whether the row is open or not. The
outermost, because a card from a subagent's subagent would otherwise be under a
row that is itself inside a closed Process; the top-level Task row is the one
row in the transcript the user can always see. Being inside that item's DOM is
also what tells a screen reader whose request it is.

```
│ ⟳  Task  Explore  Find retry handling                     47s │
│    6 steps · Bash  rm -rf build/                              │
│ ┌ ?  Bash   rm -rf build/                                   ┐ │  the card, as everywhere
│ │    [Allow]  [Deny]  …                                     │ │
│ └───────────────────────────────────────────────────────────┘ │
```

It is the ordinary card, same component and same rules
([the permission card](#the-permission-card-takes-the-rows-place)): it takes its
call's row as it would anywhere, and only *where it is drawn* changes while it
waits. Under the row and not at the transcript's tail, because the Task row is
what the card is about and parallel subagents could each be asking. More than
one can be waiting in the same slot — parallel calls in one subagent, or a
nested subagent's beside its parent's — and they stack in transcript order, a nested subagent's cards where that
subagent sits. Each
card names its own call; the Task row's second line may or may not name the
same one (a later sibling call, or a nested subagent, can be the latest child),
and nothing here needs it to. Once answered, a card leaves the slot: whatever it
and its call become afterwards are drawn in the Process, in arrival order, as
they would be in a message — the one height change here, and it happens under
the user's own tap.

The Task row keeps its spinner while a card waits, and this is the one place a
spinner sits beside a pending card, which
[the permission card](#the-permission-card-takes-the-rows-place) otherwise
forbids. It is allowed here because it is not the lie that rule exists for: the
call that is blocked is the card itself, not the row, and the row is the main
agent's call into a subagent that is genuinely still in flight. What made the
old spinner false was that it stood for the waiting call, possibly a screenful
away from the card; this one stands for its parent, with the card directly under
it saying why it is not moving.

A **question card** is filed wherever the call it replaced is — in the Process,
when that call was a subagent's. It holds no buttons
([above](#the-permission-card-takes-the-rows-place)) and the answering happens
elsewhere ([answering-ui.md](answering-ui.md)), so a closed Process hides
nothing anybody is waiting on. The record itself carries no parent; it follows
the call its position join picks, and that join cannot tell apart two
`question_post` calls from different agents that are open at the same moment —
the limit it always had, now visible as which Process the card lands in.

#### States

| Task status | Row | Process |
|---|---|---|
| `running` | spinner, `N steps · <latest child>` | grows; its live children spin |
| `background` | spinner + chip, same line while children arrive | as running, for as long as children arrive |
| `success` | muted check, `N steps` | settled |
| `error` | red, opens its body (not when nested), `N steps` | closed; a failed call, if any, is red on its own row |
| `interrupted` | `Ban`, `N steps · <latest child>` | settled |

**A settled subagent leaves nothing spinning under it**, save a child in
`background`, which settles by its own notification as any backgrounded call
does. Those are the model's rules
([tool-call-model.md](tool-call-model.md#a-subagents-own-conversation)), applied
by the reducer
([code/frontend-state.md](code/frontend-state.md#a-subagents-children)); the
renderer infers nothing.

#### What is not filed

- **Records of transcripts recorded before children were attributed** carry
  nothing to file them by, and stay where they are. They read exactly as before.
- **A child whose call is not in the loaded transcript** — the page boundary fell
  between a subagent call and its work — has no row to go under, and is drawn
  flat where it arrived, as old transcripts are, rather than under a stand-in
  row naming a call the client cannot show. When the page holding the call
  loads, the flat children stay where they are, by the rule a fetch already
  follows ([code/frontend-state.md](code/frontend-state.md#a-fetch-filed-under-the-call-it-reads)):
  a row is never taken away from under the reader. The call's row still counts
  them — `N` counts every loaded child with its id, filed or not, because a
  count that silently shrank across a page boundary would understate the work —
  and its Process ends with one muted line saying how many are further down,
  where they loaded first. While any are flat, the subagent's later work goes
  flat after them rather than being filed above words that came first — so the
  flat ones are the newest, and the row's latest child is read from them.

## Width and pointer

Almost nothing here is width-dependent, and that is the design rather than an
omission.

| Tier | What changes |
|---|---|
| compact (<640) | the baseline described above, and a diff's line numbers in one narrow column |
| `sm:` (640–1023) | `p-2` → `sm:p-2.5` and nothing else |
| `lg:` (≥1024) | nothing — the transcript column does not change shape |

**No width tier gets a second title line, a tooltip, or a wider truncation
budget.** A rule like "wrap the command at `sm:`" makes the same call look like
a different thing on a tablet and a phone, and it would mean the phone — the
primary device — is the one place the full text is unreachable. The body is the
answer at every width, so there is one answer.

**The one layout change is the diff's gutter.** The diff library draws an old
and a new line number side by side, about a third of a phone's width before any
code. Below `sm` that gutter is one column as wide as the widest number, and
each row keeps the number of the side it is on — a removed line its old one,
every other line its new one; the `+` / `−` in front of the code already says
which side that is. The library writes its gutter width inline, so the override
is in `web/src/index.css` with the other diff overrides, not in a component.
It applies to every `DiffViewer`, the Git view's included — a gutter that eats
a third of the screen is the same problem there. Above `sm` the two columns
stay: there is room for them, and the old number is worth having.

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
  request, in the body. A fetched line is exposed even on a still-running row,
  because that text is standing still — the flag follows the text, not the run.
- The `background` chip is real text, so it is read as part of the row.
- A subagent's Process is a `role="group"` named for the subagent, and a pending
  permission card it raised sits inside the Task item's own DOM, so both say
  whose they are without the visual cues
  ([a subagent's own work](#telling-the-subagents-words-from-the-main-agents)).

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
5. A failed `Bash`: red `X`, red detail, the row tinted red (its body is not),
   **closed**, with the last line it printed under the title. Open it for the
   rest.
6. A codex `commandExecution`: detail derived from `commandActions` when there is
   one, `durationMs` on the right, `exitCode` in the body.
7. An approved `Bash`: **one** row, not two — the card takes the pending row's
   place and the engine's next report gives it back, and while the card is
   pending nothing around it is spinning. Check both orders: Claude announces the
   call first, Codex may ask first.
8. An MCP tool returning one long line of JSON, on a phone: readable without
   dragging sideways. That is what the bare `<pre>` fallback used to do.
9. A `TaskOutput` against a live backgrounded `Bash`: **no new row anywhere** in
   the transcript, and no empty bubble where it would have been. The `Bash` row
   still spins, still wears its chip, and its second line is now the last line
   fetched, in mono. Open it: *Returned to the agent*, *Fetched output*,
   no *Outcome* yet. It did **not** open by itself.
10. Fetch the same task twice more: `Fetched output · 3 fetches` with `Fetch 1`
    to `Fetch 3`, newest last, nothing merged and nothing dropped. Then let it
    finish — the fetched blocks stay where they are and the outcome appears under
    them.
11. A fetch that fails: still no new row, the origin row **not** red and not
    settled, `Fetched output · fetch failed` with the error text red inside the
    body, and the second line still whatever it was.
12. A `TaskOutput` against a task that already settled — the adapter has
    forgotten it, so nothing resolves: an ordinary row of its own, titled
    `TaskOutput` with the task id in mono. Then page backwards until the origin
    row loads: that row **stays where it is**.
13. A backgrounded subagent after its notification: the summary is under
    *Outcome · after the turn*, not passed off as what the call returned, with
    no empty-report sentence above it, and not drawn again at the end of the
    Process. A fetch of it is readable in the same body, cut to its clamp
    with *Show all* rather than inside a scroll box.
14. Reload the page on any of the above: every fetched block is still there and
    the row's second line is present from the first frame — a fetch is persisted,
    unlike the activity line.
15. A subagent at work, collapsed: `N steps · <latest child>`, the count going
    up with each tool call and the second half changing as it works — its text
    as prose, its tool calls as their own row would word them. None of its text
    or rows anywhere in the main transcript, as long as the spawning call is
    loaded ([what is not filed](#what-is-not-filed)).
16. Two subagents spawned together: each row counts only its own steps. Let the
    upper one finish first: its line becomes `N steps` **without the row
    changing height**, while the lower one keeps moving.
17. Open the finished one: report, then `Process · N steps` **closed**, then
    `Prompt` closed. Open Process: the subagent's text in small secondary type on
    a rail, its tool rows exactly as main-transcript rows, nothing scrolling
    inside the Process itself, and the report **not** repeated at its end.
    Reload: the same row, the same count.
18. A subagent step that needs permission, with the Task row collapsed: the card
    is visible directly under the Task row, not hidden in the closed Process —
    and for a subagent's subagent, under the top-level Task row. Approve it: the
    card leaves that slot and the step runs inside the Process.
19. Interrupt a subagent mid-run: `Ban`, the line frozen on its latest child,
    and no spinner left anywhere inside its Process.
20. A transcript recorded before this change: subagent rows and their work read
    exactly as they did, with no `0 steps` anywhere.
21. A turn with text, five calls, text, one call: two framed lists, hairlines
    between rows and no gaps, the text outside both. A one-line row has its
    line in the middle of its 44px on a phone, not along the top; a two-line row
    fills it with the glyph level with line 1. Open a row in the middle: its
    body opens in place on `bg-th-bg-secondary`, and the rows below move down.
    The same inside an open Process. A pending card in a list: its warning
    frame complete on all four sides, also while hovered, and the jump highlight
    visible inside it.
22. On a 375px phone, a turn of fourteen calls with two failures between two
    texts: one summary row with the two red rows directly under it, both on the
    first screen. Open the summary: every call in order, the failures in their
    place and not repeated, each row opening on its own.
23. While the group runs: `N steps · <current call>  <elapsed>` on one line,
    and the verb summary when it settles, **without the row changing height**.
    A failed `Edit` is not in `Edited N files`.
24. One foldable call, with any number of failures beside it: no summary.
25. A pending card in a group: pinned under the summary, which does not spin.
    Allow it: the card stays until its row comes back, then both fold. Deny it:
    the card and the failed row both stay.
26. A backgrounded `Bash`: folded while it is an ordinary running call, pinned
    from the moment it goes to the background, still pinned when it settles —
    second line becomes the outcome, height unchanged.
27. A subagent call between calls splits them into two groups; its Process
    folds its own calls the same way.
28. Open a running `Bash` to watch it, then let the next call arrive: it stays
    open and in place; close it and it folds. A hidden row is never where the
    view is held, and a group whose last row is hidden leaves no doubled line.
29. On a 375px phone, open a `Read` of a long file and drag the page up and down
    across its body: the transcript moves, the body never does. *Content* is on
    top, cut and faded, with *Show all* and *Full screen*; *File* is folded under
    it. Copy from the *Content* header: no line numbers in what was copied.
30. On a 375px phone, with nothing scrolled sideways: an `Edit` of a deep file
    shows `src/…/name.ts` on one line beside *Open*; a `TodoWrite` opens on its
    checklist alone; an MCP call lists its arguments by name; a `go test` that
    failed shows its last lines wrapped, the final five in red, with *Show all N
    lines* under them.
31. On a 375px phone, open an `Edit`: its *Change* header reads `+N −M`; the
    gutter is one narrow column and the code takes most of the width. Turn on
    *Wrap long lines*: long lines wrap with no sideways scroll, and the next
    diff — in this row, another row or a permission card — is wrapped too.
32. On a 375px phone, a reply with a heading, a wide table and a long code
    line: the heading reads one step above the body, not a banner; the table
    scrolls sideways on its own while the text around it stays put; the code
    block's language and copy button sit in a bar above the code, and the code
    scrolls under it without carrying the bar along.
33. A turn that edits two files and creates one: when it settles, the card
    and the actions replace the tail line together — `3 files changed`, the
    created file `new` with no `−`. While it ran there was no card. Interrupt
    or fail one like it: the card is in the same place, under the status line,
    listing only what succeeded; a turn with no successful change has no card
    and no gap.
34. On a 375px phone, two `index.ts` in deep directories: one line each, told
    apart by their last directory, chip and counts whole; in the body,
    `PathLine` relative, and the full path once it is tapped. The same file
    edited three times is one row with the summed counts, opening on
    `1 · Edit` to `3 · Edit`; edited once, `Change`. A `Write` over a file: `rewritten`, `+N` only, and the line saying so above its diff.
35. Nine changed files: five rows and `Show 4 more files`; press it and focus
    lands on the sixth row. Seven: all listed. Reload: the same card.
36. On a 375px phone, open a card row onto a diff of hundreds of lines and drag
    up and down over it: the transcript moves, never the diff alone. The diff
    is cut and faded with *Show all* and *Full screen* under it, `+N −M` and
    the wrap switch in its header; a `Write`'s block copies its content.

## Out of scope

- **The turn's changes, live or reconciled.** No card while the turn runs, no
  net diff, no counts checked against git, no `Bash` side effects, no jump from
  a card row back to its tool call, and nothing in `web-cluster`
  ([the turn's changes](#the-turns-changes)).
- **A full-screen tool detail route.** happy's answer to long content is
  navigation, and it is a good one, but Pockode's row already owns a body that
  opens long content in place; adding a route for the same content would mean
  deciding which of the two any given tool goes to. *Full screen* on a long file
  or diff is a sheet over the transcript, not a route — closing it leaves the
  reader where they were.
- **Per-call token cost.** Usage has an owner
  ([usage-display-ui.md](usage-display-ui.md)) and a row is not it.
- **Re-theming.** Every colour here is an existing `th-` token; no new one is
  introduced, and none is needed.
- **`BashOutput` and `KillShell`.** They are the same shape as `TaskOutput` and
  the rules above would apply to them unchanged, but whether they should be
  absorbed is a decision about each of them, not a consequence of this one.
- **A fetch's content blocks reaching the attachment strip.** The strip is
  partitioned from `run.contents`, so a file block that arrived inside a fetch
  stays in the body. `TaskOutput` answering with an image does not happen in
  practice, and wiring a fetch into the attachment system is its own decision.
  What matters is that the body never calls such a fetch empty
  ([above](#a-fetch-reads-on-the-row-it-came-from)).
