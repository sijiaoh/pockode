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
a row looks the same wherever it is. The one list without a visible frame is one
holding nothing but thinking rows: it has no border, and its row is drawn bare
on the text's left edge, while a thinking beside tool calls shares their frame
(`RowList` in `Chat/ToolList.tsx`; how and why, in
[turn-progress-ui.md §1.2](turn-progress-ui.md#12-where-it-goes-and-groups)).

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
  `overflow-clip`, [not `overflow-hidden`](#the-sticky-title-line)). Not `divide-y`: that draws between DOM siblings whether or
  not they are displayed, so a hidden last row would leave a hairline on top of
  the frame's bottom edge — a doubled line.
- **The frame clips.** Anything a row draws outside its own box is cut off, so
  everything a row draws on its edge is drawn inside it: the focus ring is
  `ring-inset`, the pending card's frame is an inset outline (redrawn by an
  open row's bar, [which would cover it](#the-sticky-title-line)), and the jump
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
message does. Every part of a list falls into one of these kinds:

| Kind | Parts | In a group |
|---|---|---|
| **Breaker** | a subagent call, `ExitPlanMode`, and their cards — and, since they already end the list, text, a question card and every other part | ends the group and stands as itself |
| **Pinned** | a call that is `error`; one that is `background` or `fromBackground`, running or settled, unless it was interrupted; a card that is not `allowed`; an `allowed` card whose row has not come back, or whose call is still running | belongs to the group, never folds |
| **Settled** | a call that is `success` or `interrupted`, with its `allowed` card if it had one — an `interrupted` one even once a background result reaches it, since the interrupt came first | folds into the summary, and is the only kind that decides whether there is a group |
| **Running** | a `running` call that never had a card | folds into a group its settled neighbours form — the newest is the step the summary is on; otherwise lies flat |
| **Thinking** | a thinking row — not a call, and counts toward nothing ([turn-progress-ui.md](turn-progress-ui.md#12-where-it-goes-and-groups)) | folds into a group the calls form |

- **A call is one member, by id.** A card and the row it stands for share a
  `tool_use_id` and are counted, pinned and folded together.
- **Two settled calls or no group.** Only settled calls count; running and
  pinned calls and thinking do not. With fewer the rows lie flat as they are,
  running ones included: one call needs no summary, a summary over one success
  and a failure costs a line and saves none, and why a running call cannot
  count is [the next section](#why-a-group-forms-only-on-settled-calls).
- **Why a subagent breaks the run.** Its row already is a summary — its Process
  is the folded list — and its waiting card sits under it, which must stay in
  sight. A plan is written for the user to read, prose in all but shape.
- **Why background work stays pinned after it settles.** It settles long after
  the reader moved on; moving it into the summary then deletes a row above
  them — the height change [the second line](#the-second-line-problem-1) works
  to avoid — and its settled second line, *"Build succeeded in 4m12s"*, is what
  they came back for.
- **Why an approved card stays pinned until its call settles.** Claude does not
  resend the call after approval; until progress or a result rebuilds the row,
  the card is all there is of the call, and folding it would put a tick over a
  command still running. Once the row is back the reader who approved the
  command watches it run to the end, card and row in sight under the summary;
  when it settles both fold.

### Why a group forms only on settled calls

**What is already on screen folds away only on a fact that cannot be undone;
what has never been on screen may appear directly in the summary.** A settled
call stays settled. A running one does not stay running: it may yet turn into
a permission card, a failure or background work, each of them pinned. When
running calls counted toward the minimum, a settled `Read` and a `Bash` in
flight formed a group, and the moment the `Bash` became a permission card the
group fell below two and dissolved — every row folded a moment ago popped
back out under the reader's eyes, a flash on the one line they were watching.

So a group exists only once two calls have settled, and a running call only
folds into one that already does. What is left is accepted, not patched over:

1. **A call inside a group turns pinned.** A running call folded into the
   summary becomes a card, a failure or a background row. The group stands on
   its settled calls; the call comes into sight as one pinned row under the
   summary, and nothing folds away. A `question_post` is the exception: its
   question card replaces the row and, being no row, ends the list there, so
   calls that settled after it in parallel start a list of their own, and a
   side left with fewer than two settled calls lies flat again. It takes a
   question asked in parallel with other calls, and is rare.
2. **A running call already in sight folds.** With parallel calls, one may be
   showing flat while it runs and then fold when others settle into a group
   around it.
3. **The reducer's known corner.** A call marked backgrounded only after a
   `success` placeholder
   ([tool-call-model.md](tool-call-model.md#background-lives-on-tool_result-twice))
   counts as settled until it is marked, then turns pinned; a group that had
   exactly two settled calls dissolves. It is rare and accepted.

**The summary row** is the tool row's box (`RowButton` in `ToolRow.tsx`) with a
different text column, so the two cannot differ in height. Settled, it is the
verbs of its **successful** calls — a failed `Edit` changed nothing,
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

While a running call is folded, the summary is on that step, in the grammar a
subagent's second line already speaks: `6 steps · Bash  npm run build…  12s` —
every call in the group counted, then the newest running one worded as its own
row, with its elapsed time. One line either way, so it does not change height
when it settles. It does not spin while a card in the group waits on the user:
then the machine is waiting for them. The tick says only that every folded call
is over — the card is pinned below, in sight — so a waiting card neither takes
it away once that is true nor brings it early: while folded calls still run
behind the card, the glyph is empty, neither busy nor done, and `K running`
leads what has settled — `1 running · Edited 2 files · Read 3 files` — first
because it is the one entry a narrow screen must not cut. A group always has
settled calls, so the settled form is never empty. The spinning form's text is
`aria-hidden` while it moves, and the running glyph says `Tool calls running`;
`K running` changes only with the count, so it is read out as it is.

**Rendering.** Every part is rendered once, in transcript order; the group adds
a summary entry before its first part and hides its folded parts with the
`hidden` attribute. Nothing is copied or remounted — a pending card is in the
DOM once, so a jump to it lands, and a row folded and unfolded comes back as it
was. A hidden part is not a scroll anchor candidate: an element that is not
displayed measures as sitting at the top. For the same reason a part the reader
was anchored on that folds away gives up the anchor, and a fresh one is taken
where the view sits ([agent-chat.md](agent-chat.md#where-the-view-sits)).

**Nothing opens a group but the user, and nothing folds what the user opened.**
A row's open body is held by the list (`rowExpansionContext.ts`), which keeps a
row the user opened in sight when its group forms or closes, until they close
it themselves — the run they were watching does not vanish because the next
call arrived. Only the user's own choice counts: a pending card opens itself,
and folding it once it is answered and its call has settled is the point.

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
on its tool row: `ProposedChange` clamped by `ClampedContent` with *Show N
more lines* under it; `+N −M`, the one *Wrap long lines* switch and the
[full screen](#full-screen) ⤢ in its header (the viewer titled
`Edit · deliver.ts`); and a Write's content copied from there. Being the same
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
That is the closed row; an open one wraps the same button in a bar that sticks
to the top of the transcript, and its second line moves out of the button to
under the bar ([the sticky title line](#the-sticky-title-line)).

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
directly: `min-h-9 pointer-coarse:min-h-11`, restated as `--row-height` for
what stacks under a pinned bar ([why twice](#the-sticky-title-line)). It is not
a `touch-target` overlay — there is room to grow the box, and a real box is
always simpler (`web/src/index.css`, the `touch-target` comment). Open, the
button is only line 1 — the bar keeps the floor for it, and the second line
under it is not part of the target. Controls *inside* the body
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
| `running` | `RunningGlyph`: a `Spinner` (`variant="current"`, `size="h-3 w-3"`), or under `prefers-reduced-motion` a still `CircleDot` in `text-th-accent`; `role="status"` named `<tool> running` either way | inherits (the dot: accent) | activity line when there is one | invocation + live output |
| `background` | the same glyph, plus a `background` chip after the name | inherits | activity line when there is one, else the last line fetched of it | invocation + live output + whatever has been fetched |
| `success` | `Check` | **`text-th-text-muted`** | second line only if it came from the background (below) | invocation + result |
| `error` | `X` | `text-th-error` | the row button tinted `bg-th-error/10` (`hover:bg-th-error/15`), detail text `text-th-error`, second line = the line of the output that says why it failed, or the tool's reason for refusing the call — or the outcome, when the run came from the background ([rungs 3 and 4](#the-second-line-problem-1)) | closed, like every other row |
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
  running glyph stays, because the work *is* still going, and the chip says
  why the conversation moved on without it. Giving it its own glyph would be
  saying the call ended, which is the exact lie this replaced.

The running glyph is one component, `RunningGlyph` in `ToolRow.tsx`, used by
every tool row and by a group's summary while it runs. Under
`prefers-reduced-motion` it does what the turn's tail line does
([turn-progress-ui.md §2.3](turn-progress-ui.md#23-what-it-says)): the motion
is decoration and `Spinner` does not stop itself, so it is swapped for a still
`CircleDot` — in accent, so beside the muted ticks of settled rows it still
reads as live. The `role="status"` and its label sit on the wrapper, not on
either glyph, so the name survives whichever one is showing.

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
painted over the card's children and the row's hover cannot cover it — except
by a child with a z-index, which an open card's sticky bar is, so the card
restates its tint and frame for the bar
([the sticky title line](#the-sticky-title-line)). Its body
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
and the [full screen](#full-screen) ⤢ are on the card too. Last,
folded and muted, *Raw input*: the input as it arrived, minus Codex's
`command_actions`, copied from its header as JSON. It is left out where it would
only repeat the body: when the body already is the input (the JSON fallback, an
MCP tool's arguments listed by name, a string input), and for an
`ExitPlanMode` whose plan is its only key. A plan with anything beside it keeps
the raw input, since whatever else it asks for is approved with it.

**The decision is one full-width row**, `Deny | Always Allow | Allow`, with
Allow — the accent, primary action — always at the right-hand end, so it does
not move when Always Allow is not offered. The row is one line at any width:
Deny and Always Allow take their label's width (`whitespace-nowrap`, `px-3`) and
Allow takes what is left. They used to share the width by ratio, Allow 1.4× the
others, and at 360px *Always Allow* wrapped — one button two lines tall beside
two that were one. The boxes grow to the floor (`min-h-9
pointer-coarse:min-h-11`, `gap-2`) rather than borrow a `touch-target` overlay,
since the card is free to grow; `text-sm` on them is the card's one step up from
`text-xs`, because they are a decision and not a caption. Always Allow lost its
green: it is the option whose effect outlives the request, and the success
colour was an invitation to press it. What it will write is said directly above
the row and outside the scrolling body — every suggestion, not the first,
because the server sends the whole list back — so the explanation cannot scroll
away while the button stays in view. No key is bound to any of the three: Escape
already interrupts the turn
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
| `Grep` | `Grep` | `"pattern"` + ` in <path>` when scoped — the path relative to the work directory when inside it, and no ` in …` at all when it *is* the work directory | right |
| `Glob` | `Glob` | the pattern | right |
| `WebFetch` / `WebSearch` | the name | host + path / the query | right |
| `TodoWrite` | `TodoWrite` | `n done / m` | — |
| `Task` / `Agent` (the CLI renamed it; history holds both) | the name | `description`, with `subagent_type` as a chip; without a description, `subagent_type`, else a Codex spawn's agent name or prompt ([below](#a-subagents-own-work)) | right |
| `TaskOutput` | `TaskOutput` | the `task_id`, in mono | right |
| `server:tool` (Codex MCP) or `mcp__server__tool` (Claude MCP) | the tool half | the server half as a chip, then the first scalar argument, else compact JSON | right |
| anything else | the name | first non-empty scalar in `input` | right |

Six decisions inside that table:

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
- **A `Grep` scope is named from the work directory.** Claude nearly always
  passes `path` absolute, and on a 375px row the detail then had room for the
  home directory and nothing after it — the pattern, then `in /Users/me/…`,
  never the part that says where. Inside the work directory the scope is
  relative (`in src/lib`); the work directory itself is omitted, since every
  search runs there anyway; a path outside it is left as it came. Compared by
  segments (`isSameNativePath`, `utils/path.ts`), so a trailing separator or the
  other separator does not make the work directory look like somewhere else.
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
background, and the line that says **why** one failed. A settled foreground run
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
   Claude's own notification sentence, `Background command "<description>"
   <outcome>`, is cut to its outcome and capitalised — `Completed (exit code
   0)`; any other phrasing is shown as it came, and the body's *Outcome* keeps
   the whole sentence.
4. for a settled foreground **failure**, the line of the result that says why
   (`failureLine` in `lib/toolRun.ts`): the **last line naming a failure** —
   `error`, `fail`, `panic`, `✗` or `×`, in any case — skipping lines that say
   where rather than why: Node's `at …` frames, Python's `File "…", line N`,
   Go's bare `path.go:N +0x…` frames (whose file may well be `panic.go`), and
   the `Errors  Files` header of the table tsc ends a many-file failure with.
   With no such line, the last non-empty one. Literal output, so mono. A call
   the **tool refused** is the exception — see below. Before this rung a
   collapsed failed row said only *that* the call failed — the border and the
   glyph — and the reason was behind the chevron, which is why the row used to
   open itself.

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
tail of a log the user never asked for. Rung 3 drops the description from
Claude's sentence because it is the command, already the row's first line, and
at 375px it pushed the outcome — the one word the user came back for — off the
end of the line.

Rung 4 reads from the end, because a build states its verdict there
(`make: *** [build] Error 1`, go test's `FAIL pkg`) while the head is noise
(`> vite build`). It used to be simply the last non-empty line, and on a phone
that held for builds and failed for the two failures seen most: a test runner
ends on its timing (vitest's `Duration 1.31s`) and an uncaught Node error ends
on a stack frame, so the collapsed row named a duration or a file offset and
said nothing about why. Hence the search back for a line naming the failure,
and the frames skipped even when they match — `at failTest (…)` is where, not
why. The fallback keeps a failure with no such word (a bare `exit status 2`)
as it was.

**A refused call is not program output.** Claude answers an input its tool will
not act on — an `Edit` whose `old_string` is not in the file, a `Write` to a
file not read yet — with `<tool_use_error>…</tool_use_error>`. The tag is the
CLI's envelope, not anything the tool said, and it is stripped wherever the
result is drawn or copied: the second line (`toolUseErrorText`), the body and
the copy button (`shownResult`). The text inside is a sentence about the input
that opens with its reason, followed by the input quoted back, so the second
line takes its **first** non-empty line, in prose rather than mono. On device
the row used to end in `import { send }</tool_use_error>` — the tail of the
quoted input, with the tag.

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
  `<button>`, so anything inside it is part of its accessible name — and a
  button whose name changes several times a second is re-announced at every
  focus and is worse than no progress at all. So the moving line is hidden: the
  running glyph (`role="status"`) says the call is running, the glyph says how
  it went, and the full output is in the body, which is reachable. The
  background outcome line is the opposite case — it is stable, it is the answer
  the user was waiting for, and it stays in the row's name. (A live region here
  would read every stdout line aloud, which is why neither variant is one.)
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
> activity. When a backgrounded run finishes, it becomes the outcome (rung 3) —
> and stays.

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

`task_notification` supersedes the placeholder. The row settles to `success` /
`error` (glyph and colour from the table), keeps the chip, keeps its second line
— now `summary` as [rung 3](#the-second-line-problem-1) reads it — and the body
gains another section. The body must not simply replace the placeholder text:
the placeholder is what the **agent** read, the notification is what
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
itself (`ClampedContent`, `web/src/components/ui/`): past its budget it is cut,
faded where it is cut, and opened in place by the button on that side. Clipped content
scrolls nothing, so every vertical drag stays the page's — and a keyboard that
tabs into the cut-off part opens it, because the browser would otherwise
scroll the clipped box to the focused control and leave it where no drag can
bring it back. Sideways a section
does scroll — a file's lines keep their width — and a box with nothing to
scroll vertically hands a vertical drag on to the page. Every main block
([budgets](#budgets)) also offers to be read on a screen of its own once it is
cut — a ⤢ in its header ([full screen](#full-screen)) — and one too long to
open in place at all offers only that ([huge content](#huge-content)).

### Budgets

A flat clamp had no notion of a body's total: a long command over long output
was two full clamps, more than a phone's whole transcript, while on a landscape
phone one clamp alone was taller than the transcript. So a section's height is
set by its **role** (`budget` on `Section`), in lines of the body's `text-xs`,
which are `1rem`:

| Role | Budget | Sections |
|---|---|---|
| main | `clamp(8 lines, 45% of the transcript, cap)` — cap 20 lines on a coarse primary pointer, 30 otherwise | Output, Content, Change, Matches, Results, Page, Result, *Outcome · after the turn*, *Output so far*, the `ExitPlanMode` plan, a permission card's *Proposed change*, a file's diff in [the turn's changes](#the-turns-changes), a subagent's report, *Full reasoning*, a command's *Sent to the agent* |
| supporting | 8 lines | Command, File / Files (several paths, or one folded under a result), Parameters, Request, a search's arguments, *Returned to the agent*, *Fetched output*, Error, a permission card's *Raw input*, a subagent's prompt |
| none | never cut | the `TodoWrite` checklist (a single file's path line on its own is not a section at all) |

The 45% is of the **transcript**, not the window: `MessageList` keeps its
scroller's height in `--transcript-height`, and outside a transcript the
window's stands in. A main block and its supporting block together are then
about half a screen plus eight lines, which leaves the row's own title and the
block after it in view on a phone.

**Tolerance.** A section is cut only when more than six lines would be hidden;
anything up to that is shown whole. A button that reveals two lines costs more than
the two lines, and pushes the same distance. The box is allowed budget + six
lines while uncut, so content that fits there never needs measuring twice.

**The button is on the side that is cut.** Content read from its start fades at
the bottom with the button below it; content read from its end (a command's
output, *Output so far*) fades at the top with the button between the header and
the content, where the hidden part is. It says how much it hides, in the unit the
content is drawn in: *Show 340 more lines*, *Show 340 earlier lines*, *Show 85
more files* for a search's file list. The count is the hidden share of the
height applied to the content's own total, which is exact for content drawn in
even rows and close for a log with a few wrapped lines. Content with no unit a
reader counts in — Markdown, a list of fields, a command — says *Show all*, and so do lines that wrap onto more than two rows each
on average: a command that printed one minified JSON answer printed one line,
and *Show 1 earlier line* over a screenful would say nothing. Opened, the button reads *Show less* and puts the clamp
back.

The buttons are a line high with a `touch-target` overlay for the hit area,
not boxes as tall as it: at 44px the two between a command and its output
alone took an open `Bash` row past a 375×667 phone's 562px transcript (606px;
558px now). Why that is allowed, and the clearance it costs a foldable section
below one, are in [responsive-ui.md](responsive-ui.md#which-technique-and-when).

### Huge content

Opening a ten-thousand-line log in place builds ten thousand lines of DOM for
a reader who will scroll past three screens and lose the block anyway. So a
main block whose content is **huge** — estimated taller than three
transcripts (`HUGE_SCREENS`, `lib/hugeContent.ts`) — never opens in place:
the transcript draws a slice of it, and only the [viewer](#full-screen) draws
it whole. At 375×667 that is about 105 rows, on a 900px desktop transcript
about 170 — deliberately early, since past three screens the viewer reads
better than the page.

**Estimated, never measured** — the point is not to draw it to find out. In
rows of `text-xs`, wrapped rows and a diff's rows counted only until past the
threshold:

| Content | Rows |
|---|---|
| output, Markdown (they wrap in the transcript) | Σ ⌈line length ÷ characters per row⌉, a final newline not counted; rough for Markdown, whose prose is not mono, and enough to tell three screens from one |
| code, JSON (unwrapped) | lines |
| a diff | its rows: hunk headers, context, added and removed (`patchRows`) |

**Judged once** (`useHugeContent`, `Chat/HugeContent.tsx`), before paint, when
the block first has content: the transcript's height (`--transcript-height`;
the tallest enclosing scroller's while `MessageList` has not published it yet) and the
characters a mono row holds in the block's box are taken then and kept — the
characters once more when a block first judged under a folded row (no width
yet) is first shown. Content that changes is judged again against those same numbers, never a resize: a
keyboard opening or a rotation must not flip a block between the two ways of
reading it. A block the reader has already opened in place stays open, with
only its header's ⤢; *Show less* puts it back as huge. The one commit before the
first judgment draws nothing rather than all of what may be huge — it is never
painted.

**Never huge**, because something else already bounds the DOM, or the slice
would lose what matters:

- **A file list.** The transcript caps it at 100 rows; it keeps *Show N more
  files* in place, and its ⤢ opens the viewer on **every** path.
- **Live output.** The transcript draws its last 50 lines (item 2
  [below](#the-body-problems-2-and-3)).
- **A result with attachments** between its text: the slice would be text
  alone, and the images and files between it would vanish.

**What the transcript draws** (`sliceContent`) is the end read first — the head,
or for content [read from its end](#budgets) the tail — 40 lines, more than the
largest main budget plus its tolerance so the fade has content under it, and at
most 16,000 characters, since one line of minified JSON can be a megabyte. It is
cut at whole units: lines for output and code; for Markdown the first blank line
past 40 that is not inside a fence (a fence still open at the cut is closed, so
what follows it is not drawn as code); for a diff its first whole hunks, file by
file — a hunk over 40 rows that would overrun the slice (a new file's single
hunk) is cut instead, its `@@` counts rewritten to the lines kept. A failed command's
red tail survives only in a tail slice, where its last lines are.

**The clamp** (`ClampedContent`'s `huge`) is always cut and never measured:
no *Show N more* or *Show less*, never pinned, and focus moving past the fade
does not open it: the rest is not in the DOM, and when the browser scrolls the
clipped box to a control in the slice past the fade — a link in a page — the box
is put back at its top. Its one
button is on the cut side, as the in-place button would be:

```
│ Output                       ⧉       ⤢ │
│ ⤢ Open full output · 12,408 lines        │  ← above: content read from its end
│ ░░░░░░░ faded ░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ✓ 812 passed                             │
```

- It is the clamp's text button with a leading `Maximize2`, and opens the
  viewer. Above the content it is moved `pointer-coarse:mt-4` clear of the
  header's buttons ([responsive-ui.md](responsive-ui.md#which-technique-and-when)).
- Its label is `Open full <noun> · <n> <unit>` (`hugeOpenLabel`): a plural block
  reads *Open all matches* / *Open all results*; the count is lines, a diff's
  rows, with thousands separators; Markdown, which has no unit a reader counts
  in, has none: *Open full page*, *Open full plan*.
- A headed block keeps its header ⤢ as well. A headerless one — the plan, a
  subagent's report (`HeaderlessMainBlock`) — has this one button, in place of
  both *Show all* and its *Full screen*.

### Keeping the reader's place

Opening or closing a block changes the height of everything below it, and the
transcript holds the view still over the [part](#the-list) the reader is in —
which, for a block inside that part, is the part's top. That is right for
content read from its start and wrong for content read from its tail: opening
*Show 1984 earlier lines* on a test log grew the box downward from the part's
top, and the reader looking at its verdict was left on its first line with the
verdict 31,000px below (measured at 375×667: the box's bottom went from 583px
to 32,346px). So the block says where it is to be held, through the
transcript's own anchor (`TranscriptView.holdAt`, the same call a row folding
from its bar makes — [folding from the bar](#folding-from-the-bar)):

| Action | Held |
|---|---|
| *Show N more* (cut at its end) | the box's top |
| *Show N earlier* (read from its tail) | the box's bottom: the content grows upward, and the line the reader was on stays where it was |
| *Show less* | the button, which is on the edge that is cut — any of it in sight counts, since a tap lands on the overlay round it |
| *Show less* with the button out of sight (under the pinned title or the [pinned section header](#the-pinned-section-header), or off screen when closed from that header) | the section's header — or, for a block with none (a subagent's report and prompt, the `ExitPlanMode` plan), the block's own top: where it is when it is in sight — a pinned header is just under the row's title — and otherwise brought to just under the pinned row title (`coveredAbove`, the same height a fold lands under) |

Keyboard focus opening a block takes the same landing; the browser then
brings the focused control into view if the landing left it out, as it would
for any focus. Holding is asked of the
anchor rather than written to `scrollTop` here, so the next thing that moves the
transcript keeps the place rather than undoing it, and a reader following the
tail goes on following it when the place held is the end. What cannot be held is
not: a place above the transcript's top or past its end is the nearest one it
can reach.

**Live output follows its tail** (`follow`, on *Output so far*), whenever it
grows — uncut, or opened; cut, its box is the budget and the tail is already
what it shows. While its bottom is in sight, growth that would carry the bottom
out of the view holds it at the last place it was seen instead, so new lines
push the old ones up, as a terminal does; growth that stays in the view moves
nothing. The view scrolling up between two growths — the reader leaving —
stops that, and scrolling back down with the bottom in sight starts it again,
as does opening or closing the block. It is the view's `scrollTop` that says
so, not where the block sits: the button that appears above output once it is
cut pushes the block down without anyone scrolling. A transcript reading its
own tail needs none of this, and nothing here leaves it.

### The pinned section header

A section opened past its budget can run for screens, and a reader in the
middle of it had lost which block it was — a command's or its output's — and
both ways to close it, one at each end. So while a section is open past its
budget, and only then, its header sticks directly under the row's
[pinned title](#the-sticky-title-line), carrying its copy button, its
[full screen](#full-screen) ⤢ — someone several screens into an opened log is
exactly who wants to leave for the viewer — and a collapse control
(`ChevronsDownUp`). A section that fits, or one cut and not opened, is
drawn as before; a foldable section folded away lets its header go. One
section is open around any point of the body, so there are at most two pinned
bars: the row's and this.

- **It is the section's own header** (`Section`, `Chat/ToolSection.tsx`), in a
  `section-bar` box (`web/src/index.css`): `position: sticky; top:
  var(--row-height)`, so it sits exactly under the row's bar, whose height
  that is, and its containing block is the section, so the section's end
  carries it off. `useStuckBar` marks it `data-stuck` while it is pinned, for
  the hairline under it; the hook reads the bar's own `top`, so the same
  pinned test serves both. The row bar's blanking under a deeper pinned bar
  asks for a `.row-bar[data-stuck]`, so a pinned section header in a row's
  body does not blank that row's own title.
- **Stacking.** The header is `z-index: 1` and the row's bar is now 2 (3
  focused): when the section's end carries the header out, it passes under
  the row's title, not over it. The scroll-to-bottom button moved to `z-3`
  with it.
- **Clear of the row's bar.** `section-bar` keeps `--section-bar-clear` above
  its line, so a thumb a little high on its buttons does not land on the bar
  over it — the row's whole toggle — and fold the row
  ([responsive-ui.md](responsive-ui.md#which-technique-and-when) has the
  overlay's reach and the values).
- **Ground.** The header repaints the body's ground, `--section-ground`,
  defaulting to `--th-bg-secondary` — every drawer's — which a pending
  permission card's body restates as its warning wash over the row's ground.
- **Where nothing is pinned above it, it pins at the top**
  (`--section-bar-top: 0`):
  - A thought's body, which scrolls on its own (`max-h-[60vh]`) — a settled
    thought's and the live one in the turn's tail alike, both
    `ThoughtScroller`: an opened *Full reasoning* pins at that scroller's top,
    and opening and closing it keep the place in that scroller, not the
    transcript ([agent-chat.md](agent-chat.md#where-the-view-sits)). The
    scroller has no vertical padding of its own, which would leave a gap above
    the pinned header.
  - The turn's changes card, whose file rows do not stick: an opened diff's
    header pins at the transcript's top. The card clips its rounded frame
    with `overflow-clip`, not `overflow-hidden`, for the same reason
    `ToolList` does ([the sticky title line](#the-sticky-title-line)):
    `hidden` made the card the scroll container the header stuck to, and the
    card never scrolls.
- **Its collapse control is *Show less*.** It calls the clamp's own close
  (`ClampHandle.close`), so it lands exactly as the button would
  ([keeping the reader's place](#keeping-the-readers-place)): the button held
  where it is when any of it is in sight below the header, and otherwise —
  the usual case, the reader being somewhere in the middle — the section's
  header, which pinned is already just under the row's title, stays there.
  Pressed with the header at rest on screen, the header stays where it is
  rather than being brought up to the title. A button under the pinned header
  counts as out of sight, as one under the row's title does. Closing takes the control
  away, so focus goes to the clamp's own button rather than falling to the
  page, without scrolling to it.
- **The header unpins in the same commit as the clamp closes**: the clamp says
  so from the handler that closes it (`onOpenChange`), not from an effect, so
  the landing measures the header back in the flow rather than stuck partway
  down a section that has just shrunk.
- **A scroll margin under both.** Inside a pinned header's section, focus
  moving up scrolls to the header's own `top` (`--row-height`, or 0 where it
  pins at the top) plus the header — its clearance, its `1.5rem` line and the
  `pb-1` under it (`:where(.section-bar ~ *) *`). That gap to the body
  is the header's padding rather than the section's `space-y`, because a
  pinned box keeps its margin inside its section: carried off, it stopped 4px
  short of the section's end and the last line of output showed under it.

The subagent's report, its prompt and the `ExitPlanMode` plan have no header,
and so nothing to pin; they close from their own button.

The block is `p-2` with `space-y-3` between its sections, and a code block in
a section draws **no box of its own** — no padding, no background
(`.tool-section .code-block` in `web/src/index.css`), so a command lines up
with the label above it and the output beside it. The box's `0.75rem 1rem`
padding was only indentation there: every theme's `--th-code-bg` is its
`--th-bg-secondary`, the body's own ground, so the box was invisible and its
padding set the command 16px in and doubled the gap between two blocks. The
background goes with the padding rather than staying, because a pending
permission card's body is tinted, and a padless box on it would put the command
against its own edges. A fenced block in Markdown keeps its box: it has a
header bar to sit under.

**Every section has a header bar** (`Section`, `Chat/ToolSection.tsx`, drawn
through `BlockHeader` in `components/ui/`): its name on the left, its actions on
the right. The copy button is one of those actions, never laid over the content
— in a code block's corner it sat on the end of the first line, which on a phone
is most of a command. `CodeHighlighter`'s corner button is turned off
(`copyable={false}`) wherever a header carries it. What a result's button copies
is `resultCopyText`: the text a reader would select, so a `Read` without its
line numbers, a command's output without its colour codes, and a refused call
without its `<tool_use_error>` tag ([above](#the-second-line-problem-1)); a diff
or a checklist has no button. The actions run in one order — the block's own
(the wrap switch), copy, the [full screen](#full-screen) ⤢, and the pinned
collapse control while there is one — so ⤢, the last that stays, sits at the
same place in every header, and the one that comes and goes is outside it. All
are 24px boxes whose hit areas reach past them, so the cluster is spaced to
keep those apart (`gap-3 pointer-coarse:gap-5` in `BlockHeader`;
[responsive-ui.md](responsive-ui.md#which-technique-and-when) has the
arithmetic). When the line runs short — a change's `not applied +120 −45`
beside four buttons, deep in a subagent's Process — the label gives way first,
down to `3ch`, then the meta, `not applied` before the counts, which never
shrink: they are what the block amounts to. The one block with no header is a single file's
path (*File tools*, below), which carries its copy button at the end of its own
line. `BlockHeader` is meant for any block of content, not only tool sections: a
fenced code block in the agent's text (`CodeBlock`, `components/ui/`) is the
same bar, with the language on the left and the copy on the right, over code
that scrolls sideways in its own box so the bar stays put. The text around it is
`prose-sm` brought in for a conversation (`prose-message`, `web/src/index.css`):
headings one step above the body rather than four, tighter paragraphs, a table
in tight rows that scrolls in its own box when it is wider than the phone — the
transcript clips sideways, so a table left to it would lose its right columns.

**A wide table keeps its columns readable and scrolls.** It used to be squeezed
into the content width and never overflow at all, so on a phone each cell stood
four or five lines tall, one word to a line. Now each header cell sets its
column's floor (`MarkdownHeaderCell`, `components/ui/MarkdownContent.tsx`):
`min-width: max(9em, <header characters × 0.6>ch)` — 9em so a column of prose is
not squeezed to its longest word, and the header term so a long header widens
its column to about two lines instead of standing four lines tall over short
cells. The table then overflows into its own horizontal scroll, and while there
is more to the right its right edge fades (a `mask-image` gradient, dropped at
the end), since nothing else on a touch screen says a box scrolls sideways.

**Inline code wraps as a whole token.** It is an inline-block no wider than
the line, so a token that fits on a line of its own moves there whole; only a
token longer than a line breaks inside, after a `/` where it has one (a `<wbr>`
after each run of slashes, so `https://` stays together) and anywhere as the
last resort. Inside a table cell it is `overflow-wrap: break-word` instead, so
the column's minimum width is its longest token and the table scrolls rather
than cutting the token. It used to be `break-all`, which split
`src/webho|oks/…` mid-name even on a desktop. It is `0.9em` at the text's own
weight: in em so it follows a table cell's or a note's smaller text (which
retired the note's own `font-size: inherit` override), and not the 600 weight
Typography gives it, which out-shouted bold beside it — the ground and the mono
face already set it apart.

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
names itself by what it shows — *Command*, *File* / *Files* (one unfolded
file is a line with no header, below), *Request* for a
sentence, *Todos* for a checklist, *Parameters* for named fields and the JSON
fallback. The result is named by the tool: *Output* for `Bash`, *Content* for
`Read` and `Write`, *Change* for `Edit` and `MultiEdit`, *Matches* for `Glob`
and `Grep`, *Results* for `WebSearch`, *Page* for `WebFetch`, and *Result* for everything
else. A result that arrived after the turn is *Outcome · after the turn*
whatever the tool, and a failed file change gains an *Error* section above its
*Change* or *Content*, as below.

In the default order, each section omitted when empty:

1. **Invocation — always present.** This is the answer to problem 2 and the
   reason every row now has a chevron.
   - `Bash`: `CodeHighlighter language="bash" wrap` with the full command —
     wrapped, selectable, and copied from the header. Claude's `description`,
     when present, sits above it as one muted line; Codex's `cwd`, when it is
     not the work directory, below it as `in <path>`. A wrapped block — this
     one, the JSON fallback below, the permission card's *Raw input* — breaks
     **only at whitespace**: each run of non-space characters is one
     inline-block `.code-word` (`wordWrapTransformer` in `lib/shikiUtils.tsx`,
     on shiki's tree, since a word may be two tokens of two colours), and only a
     word longer than the line breaks inside itself. Left to the browser a line
     also broke after a hyphen, and `--reporter=verbose` split into `--` and
     `reporter=verbose` read as two arguments — on the screen where a command is
     audited before it is approved. A continuation line hangs 2ch past its own
     line's indent (`--hang`), so it reads as the rest of its line and, in
     indented JSON, not as a shallower key. Text past `HIGHLIGHT_LIMIT`
     ([file.md](file.md#viewer-ui)), which shiki is not given, is split into
     lines only: a span per word would spend on the DOM what withholding it
     saved.
   - File tools: the path on **one line** (`PathLine`), relative to the work
     directory when it is inside it and cut from the left as the row cuts it —
     the file name whole, the directories first to go — with an *Open* into the
     Files tab when it is under the work directory. The absolute path broken
     anywhere took four lines on a phone, most of them the work directory every
     path shares. The full path is still in the body, a tap away rather than
     behind a hover: tapping the line writes it out absolute and wrapped, and
     it is what the copy button copies. A Codex file change gives one
     such line per file it leaves behind — a rename's destination, since its
     source is gone.
     **One file that is not folded** — an `Edit`, `MultiEdit` or `Write`, a
     single-file Codex change, any single-file call on a permission card, all
     through `ToolInvocation` — is
     that line and nothing else: path, *Open*, and a copy button (`Copy path`)
     at its end, one 44px row on a coarse pointer, with no visible `File`
     header; the line is a `role="group"` named `File`, so a screen reader
     keeps the name. The header only said what the path plainly is, and on a
     phone the header and the path's own line stood between the row and the
     diff the reader opened it for. A `Read`'s *File*, folded under its result,
     and a multi-file *Files* keep the header, which is what folds or lists
     them. The diff's first line now sits about 92px below the row at 375px on
     a coarse pointer (8px padding + 44px path row + 12px gap + 24px *Change*
     header + 4px), 84px on a fine one, down from about 120px. The target was
     about 60px, and it stays missed on purpose: the 44px path row is the
     touch floor, the 12px gap is the one every section of the body keeps,
     and the *Change* header is what tells the diff from the path above it, so
     the only way to 60px is to merge rows again — not worth another round.
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
   finished reading. As it grows it follows its tail while that is in sight,
   and stops once the reader scrolls up away from it
   ([keeping the reader's place](#keeping-the-readers-place)); the row's second
   line is the live glance, and the body is where someone reads at their own
   pace.
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
     is its last lines, and the button above it says how many
     earlier lines there are ([budgets](#budgets)). A failed command's last five lines are
     marked as its error (a red rule, tint and text — `FAILURE_TEXT` in
     `ToolResultDisplay.tsx`), since that is nearly always where it says why;
     five holds a compiler's last errors or a test runner's `FAIL` without
     painting a whole log red.
   - A diff (`Edit`, `MultiEdit`, a Codex file change): the header says how
     many lines it adds and removes, `+N −M` with a zero side left out (`+1`,
     not `+1 −0`) — `LineCountsLabel` in `ProposedChange.tsx`, the one count
     the tool body, the permission card and [the turn's
     changes](#the-turns-changes) all draw — and carries a switch that wraps
     long lines (*Wrap long lines*). The switch is one remembered choice for
     every diff in the chat (`diffSettingsStore`, beside the Git view's
     whitespace one) rather than a state per block: a reader on a phone who
     wants lines wrapped wants them wrapped in the next diff too. Off by
     default, because unwrapped lines keep the code's shape. A `Write` gets
     neither: a new file is content, not a diff, and every line of it would
     count as added whether or not it overwrote one. On a phone the diff has
     one narrow line-number column instead of two — see
     [Width and pointer](#width-and-pointer).
   - A file change that **failed** (`Edit`, `MultiEdit`, `Write`): an **Error**
     section comes before the change, holding the result — the tool's reason,
     tag stripped — drawn as a failed command's last lines are (`FAILURE_TEXT`);
     then the *Change* or *Content*, its header reading `not applied` and its
     counts muted rather than green and red. The view is drawn from the input,
     so a refused change looks exactly like one that landed, and the result —
     the only place the reason is — was shown nowhere: on device an `Edit` whose
     `old_string` was not in the file opened on a `+1 −2` diff that read as
     applied, with the error never on screen.
4. **Exit code**, when Codex reported a non-zero one, and — for a call whose
   result outlived the turn it was cut off in — one line saying so.

The attachment strip stays between the row and the body, and what goes in it is
what the result **is**: when a tool answers with a screenshot, the screenshot is
the answer, and an answer folded behind a chevron has not been shown. A block
marked `not_fetched` is not that — it is a *pointer* at a file nobody read — so
it is drawn as a reference line in the body instead
([above](#when-a-background-run-finishes)).

A file in the strip that is not drawn as an image, here and in a user's
message, is `AttachmentChip` (an image is a thumbnail, whose tooltip carries
the same detail), which
sets its own compact type — name `text-sm`, detail `text-xs` — rather than
taking the surrounding text's, so in a bubble it does not compete with the
message or outgrow the composer's entry for the same file. Its detail
(`attachmentDetail`, `utils/attachment.ts`) is dimensions and size,
`2000×1333 · 433 KB`, with the type only when the name does not already say it:
a name with an extension does, and so does the type standing in as the name of a
block that names no file; a name without an extension keeps it (`PNG · 357 B`).
A badge read off the MIME subtype beside an extension was noise that turned a
`.log` into `PLAIN`, and the composer's entry showed the size alone, so a file
changed its description by being sent. In a user's bubble the strip has no
divider above it (`divided={false}` in `MessageItem.tsx`): a rule the bubble's
width under a paragraph read as that paragraph's underline, so spacing alone
sets the files off.

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

### Full screen

A clamp keeps the transcript moving, and that is the wrong thing for the
reader who came to read the block: a log, a file, a long report. So every main
block ([budgets](#budgets)) offers a screen of its own **once it is cut** — more
than budget + six lines, the same test that puts up its *Show* button — and
keeps offering it after *Show N more* has opened it in place. A block that fits
has none, and a supporting block (Command, Parameters, Error…) never has one.
There is no list of tools: the rule is the budget.

**The button is a ⤢ in the section's header** (`Maximize2`, a 24px box —
`Section`, `Chat/ToolSection.tsx`), the last persistent action
([the header bar](#the-pinned-section-header)), on the pinned header too.
`ClampedContent` tells the section when it is cut (`onCutChange`) from a layout
effect, so the button never flashes in late. The two main blocks with no
header — the `ExitPlanMode` plan and a subagent's report
(`HeaderlessMainBlock`) — keep a *⤢ Full screen* text button in their clamp's
row, beside *Show all*: growing a header for one icon would cost 24px on every
plan. [Huge content](#huge-content) adds its own *Open full …* button on the
cut side.

#### Who owns the viewer

A sheet inside the block would die with it, and blocks are replaced while they
are read: *Output so far* unmounts the moment the result arrives, a permission
card the moment it is answered. So there is one viewer per transcript,
`FullScreenHost` (`Chat/FullScreenHost.tsx`), rendered inside the transcript's
`CoveredSurface` in `ChatPanel` so an overlay taking the chat closes it
([answering-ui.md](answering-ui.md#who-owns-the-dismissing-click) has why). A
block publishes a `FullScreenSource` (`lib/fullScreen.ts`) under a **key** for
as long as it is mounted, and the viewer shows whatever is published under the
key it was opened with:

| Key | Block |
|---|---|
| `<run>:result` | a tool row's outcome, live or final — *Output so far* and *Output* share it, so an open viewer carries on into the result |
| `<run>:plan` · `card:<toolUseId>:plan` · `card:<toolUseId>:change` | the row's plan; a permission card's plan and *Proposed change*, apart from the row's because both can be on screen |
| `turn:<run>:<path>:<index>` | a diff in [the turn's changes](#the-turns-changes) — a Codex change can list one path twice |
| `report:<run>` · `thought:<hash>` · `sent:<message>` | a subagent's report; *Full reasoning*, keyed by a hash of its opening (200 characters, or its first six lines if they end sooner) so it carries over from the turn's tail into its row; a command's *Sent to the agent* |

A key left with no publisher closes the viewer — but only if it is still
unpublished a frame later, since publishers legitimately unmount and remount
across commits. The source is content, not the transcript's rendering, because
the viewer draws it differently: unclamped, with its own wrap, and from the
latest text.

#### Layout

```
375px coarse                                  desktop: same structure
┌───────────────────────────────────────────┐
│ Bash · pnpm test                       ✕  │  the Sheet's title
│ pnpm test --run --reporter=verbose…   ⌄   │  subject
├───────────────────────────────────────────┤
│ Output  12,408 lines      ↩     ⧉     🔍  │  toolbar
├───────────────────────────────────────────┤
│ [fail_________________] 3 / 17   ↑   ↓  ✕ │  find, only while open
├───────────────────────────────────────────┤
│ … content, a scroller of its own …        │
└───────────────────────────────────────────┘
```

It is the shared `Sheet` in its `fullScreen` form, which gained two generic
props for it: `subtitle`, drawn under the title, and `initialFocusRef`.

- **Title**: the row's own summary, `Bash · pnpm test`, `Read · ToolSection.tsx`
  (`toolSummaryLine`) — a subagent's report and a permission card's blocks take
  their row's too, and the plan its row title. The rest name themselves:
  `<tool> · <file name>` for a diff in the turn's changes, `Reasoning`,
  `/<command> · Sent to the agent`.
- **Subject**: what the tool acted on, in full, for the tools that act on one
  thing (`fullScreenSubject`) — `Bash`'s command, a file tool's path, the
  `Grep` / `Glob` pattern, the `WebFetch` URL, the `WebSearch` query. It is
  shown even when the title holds it, since the title is cut to a few words on a
  phone. Folded it is one truncated mono line — a path cut from the left, as
  `PathLine` cuts it — ending in a chevron, a `touch-target` button with
  `aria-expanded`. Pressed, the whole text appears **below** it, a path
  absolute, wrapped, selectable and capped at `40dvh` with its own scroll: text
  inside a button cannot be selected on a touch screen, and a command is copied
  out of here as often as it is read.
- **Toolbar**: the block's own header, so the reader sees the block they opened —
  its label, its meta (a change's `+N −M`, `not applied`), the count
  (`12,408 lines`, `3,204 files`), then *wrap*, *copy* and *find*, find last,
  nearest the thumb. The buttons are at the Sheet close button's rung,
  36px (`size="lg"`). Under a subject the toolbar is moved `pointer-coarse:mt-2.5`
  clear of the subject's hit area.
- **Content**: `p-3 sm:p-4`, the transcript's `text-xs` mono for lines, and
  Markdown in `prose-message` at a measure for prose
  ([width and pointer](#width-and-pointer)).
- **Copy** copies the whole text (the block's own copy text), never the window
  drawn.

#### Per kind of content

| Kind | Drawn | Wrap switch | Opens at |
|---|---|---|---|
| output (`Bash`, plain text results, *Sent to the agent*) | by the line, virtualized; colour kept; a result with attachments as its text alone, the images left to the transcript | the viewer's own, **on** | the end if the block is read from its end, else the top |
| code (`Read`, a `Write`'s content, JSON) | by the line, virtualized; shiki colours | the viewer's own, **off** | the top |
| a diff (`Edit`, `MultiEdit`, a Codex change) | `ProposedChange`, whole | the transcript's remembered one (`diffSettingsStore`) | the top |
| files (`Glob`, `Grep`'s file lists) | by the row, virtualized; **every** path, each with *Open* | none | the top |
| Markdown (`WebFetch`, the plan, a report, reasoning, a `.md` file) | `MarkdownContent`, whole; plain wrapped text past `HIGHLIGHT_LIMIT` | none: it reflows | the top |

- **Wrap.** Only the diff's choice is remembered, and it is the same switch every
  diff in the chat shares. Output wraps by default because the transcript always
  wraps it, and code does not, to keep its shape; neither is remembered, since
  unwrapping one log for its columns is an occasional move.
- **A `Write` is never a diff here.** `ProposedChange` draws one through
  `FileContentDisplay`, which highlights everything and draws it whole, so a
  generated 5,000-line file goes to the viewer as code (or Markdown), with its
  `not applied` in the toolbar's meta.
- **A diff's gutters** are the transcript's: one narrow column below `sm`, two
  above ([width and pointer](#width-and-pointer)). It is not virtualized — the
  diff library draws a diff whole — which is affordable because diffs come from
  edit inputs and are rarely thousands of rows.
- **A failed command** keeps its last five lines red (`FAILURE_TEXT`).
- **Live output** shows the reducer's whole 200-line buffer, not the
  transcript's 50. Once lines have been dropped from its head
  (`ToolRun.outputDroppedLines`) a muted line heads it: *Earlier output arrives
  with the result*. It follows its tail while the reader is at the end and stops
  when they scroll up — the transcript's rule. When the result arrives under the
  same key the viewer stays, now with everything, and the reader's line, counted
  from the end, stays where it was.

**Virtualized** (`VirtualLines`, on `@tanstack/react-virtual`): only the rows
around the view are drawn, so a 10,000-line log opens at once with a few dozen
rows mounted. Each drawn row is measured, so wrapped rows of any height scroll
true; unwrapped rows all take the widest line's width in `ch` (wide characters
as two), so the block scrolls sideways as one. Colour is worked out once over the
whole text and only drawing is windowed, because both carry state across
lines: output is parsed by a **fresh `AnsiUp` per output**, fed a line at a time,
so a colour left on carries over and never leaks into the next output
(`parseOutput`, `Chat/FullScreenLines.tsx`); code goes through shiki's
`codeToTokens` once (`highlightLines`, `lib/shikiUtils.tsx`), plain past
`HIGHLIGHT_LIMIT`, and wrapped keeps the transcript's hanging indent. The place
is kept in lines, not pixels: opening at the end, following it, the hand-off
from live output to the result and toggling wrap all hold the line being read,
and a gesture already under way is never pulled back.

#### Find

The browser's find cannot see lines that are not drawn, so the viewer has its
own, for every kind (`FullScreenFind.tsx`, `lib/find.ts`). The toolbar's 🔍
(`aria-expanded`, pressed while open) or **Ctrl/Cmd+F** anywhere in the viewer
— taken from the browser with `preventDefault`, and recognised on non-Latin
layouts by the key's position — opens the bar and focuses its field; either
again refocuses it and selects the query.

- **The field**: `Find in <noun>`, `enterKeyHint="search"`, `text-base` on a
  coarse pointer so iOS does not zoom. Matching is literal, case-insensitive,
  **line by line** (a character whose lowercase changes length then costs only
  its own line), 100ms after typing. The subject is not searched.
- **What is searched**: output, code and files in their text model — the same
  parse that is drawn, so lines not mounted are found and counted; Markdown in
  its rendered text; a diff in its code cells only, never its line numbers or
  `@@` headers, searched again when the diff library swaps in highlighted nodes.
- **Highlights** are the CSS Custom Highlight API (`::highlight(find-match)` at
  20% accent, `::highlight(find-current)` at 45% plus an underline, so hue is not
  the only cue): ranges over the text that is drawn, so no `<mark>` is put into
  shiki's or the diff library's DOM, and for virtualized content only over the
  rows mounted, refreshed as rows mount. A browser without the API still counts
  and steps.
- **The current match** after typing is the first at or after the top line in
  view. A match already in view stays where it is; otherwise it is brought a
  third of the way down the part of the view the keyboard leaves
  (`visualViewport`), and sideways into view when lines are unwrapped.
- **Next / previous**: Enter / Shift+Enter, or the ↓ / ↑ buttons, wrapping at both ends,
  focus kept in the field so a phone's keyboard stays up. While an IME is
  composing, Enter does nothing (`isComposing || keyCode === 229` — Safari
  sends the committing Enter after `compositionend`).
- **The count**: `3 / 17`, `No matches` (neutral, not an error), the buttons
  disabled with no match or no query. A visually hidden `aria-live="polite"`
  region says `3 of 17 matches` after typing settles and on each step, never as
  content grows.
- **Growing content**: live output is searched again with every change, and the
  total updates silently. The current match is held by its absolute line while
  the head is dropped, and by its distance from the end across the hand-off to
  the result; a match whose line was dropped hands over to the next. With no
  current match, new ones do not take the reader's place (`– / 17`).
- **Closing**: its ✕ or Escape. The highlights go, the query is kept for this
  viewer and restored, selected, on reopening, and focus returns to 🔍. Escape
  is claimed on the viewer's column, so it works from the content as well as the
  field; the first press closes find and the next closes the viewer
  ([answering-ui.md](answering-ui.md#who-owns-escape)). Mid-composition it only
  cancels the composition. From the subject or ✕, which are the sheet's header
  and outside that column, it closes the viewer at once.

#### Opening, focus and closing

- **Focus on open** goes to the content's scroller (a `<section>` named by the
  noun, `tabIndex=0`, through `initialFocusRef`), so arrows, Page Up / Down and
  Home / End scroll at once.
- **Closing**: ✕, Escape, the **back gesture** — Android's back, iOS's edge
  swipe, the browser's Back — or the key going away. Back-to-close is
  `useBackToClose` (`web/src/hooks/`), used only here: the viewer pushes a
  same-href entry through the router's own history (never a raw `pushState`,
  which would bypass TanStack's index and state) and closes on its `BACK` / `GO`
  notification. Every other close takes that entry back, once, but only if it is
  still the current one, so a page opened over the chat keeps its own entry, at
  the cost of one later Back that changes nothing on screen. A file row's *Open*
  closes the viewer first and navigates only once that entry is gone, or the
  Back would undo it.
- **The transcript is where it was.** The page is scroll-locked under the sheet
  and focus returns to the opener without scrolling. What changes behind it — a
  diff wrap toggled in the viewer, live output growing — is held by the
  transcript's anchor as always, and a block opened in place stays open. If the
  opener is gone (*Output so far* became *Output*), focus goes to the control
  now opening the same key rather than falling to the page.

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

## The sticky title line

```
┌────────────────────────────────────────────┐  ← the transcript's top edge
│ ⌄  ✗  Bash   go test ./relay/…             │  the row's bar, pinned
├────────────────────────────────────────────┤  hairline, only while pinned
│   …the body, three screens in…             │
```

An open body can run for screens — a long `Read`, a log, a subagent's
Process — and a reader in the middle of one had lost both which call it
belonged to and the only way to put it away, which was back at its top. So an
open row's first line sticks to the top of the transcript until its body ends,
and folding it from there leaves the reader on the row
([below](#folding-from-the-bar)). `ToolRow` draws it, with the `row-bar`
utility in `web/src/index.css` and `useStuckBar` beside it.

**It is the row's own button that sticks**, wrapped in a `row-bar` box —
`position: sticky; top: 0; z-index: 2` — whose containing block is the row's
wrapper, so the end of the row carries it off. There is no copy of the row:
one control, one focus and one accessible name, wherever it is drawn. Only an
open, toggleable `ToolRow` gets the bar; a closed row is drawn exactly as
before, and a group summary, a thinking row and the turn's changes card draw
`RowButton` directly and do not stick.

**The second line leaves the button while the row is open.** A pinned bar is
one line, so the second goes on in the flow under it — in `RowColumns` with
blank leading columns, so it still sits under the name, and in the row's red
on a failed row. The bar keeps the whole floor for line 1, centred in it as a
one-line row is ([the row](#the-row)), so a two-line row grows when it opens
and its line 1 moves down 4px on a fine pointer and 8px on a coarse one. That
is the one way an open row is drawn differently from a closed one.

**The bar repaints the ground it passes over**, because pinned it is drawn
over the body and the rows after it. Its fill is `--row-tint` laid over
`--row-ground`, which defaults to the transcript's `--th-bg-primary`; a
container that puts rows on another ground says so, rather than the bar
guessing:

| Container | Sets |
|---|---|
| a subagent's Process body, a Pockode command's card | `row-ground-secondary` (`--row-ground: var(--th-bg-secondary)`) |
| a pending permission card | `--row-tint` (its 10% warning wash) and `--row-frame` (its outline's colour) |

The card needs the frame restated because its outline is painted under a child
with a z-index, so the bar would cut it along the top and sides — and a
pending card opens itself. The bar draws `--row-frame` on its own left, right
and top edges as inset shadows, pinned or not. A failed row's red is the
button's own, inside the bar, and needs nothing. The bar inherits a rounded
container's top corners and keeps its bottom ones square: the body always
follows an open bar, and a pinned bar's rounded bottom corners would show the
content it covers through them.

**The hairline under it is drawn only while it is pinned.** At rest the bar
sits in its row — the second line, or the body's own `border-t`, right under
it — and a line there would cut the row in two or double the border.
CSS cannot ask whether a sticky box is stuck, so `useStuckBar` sets
`data-stuck` on the bar: while its row has started above the scroller's top
edge *and* the bar still sits at that edge, with half a pixel of slack. A bar
the end of its row has begun to carry out is no longer stuck. It is read on
the scroller's scroll, on the row changing size — a row hidden by its
parent folding reads as zeros and must not keep the flag — and on the
scroller's content changing size, since a row above it growing inside the same
Process moves it without a scroll (nothing inside a body is an anchor the
view is held by), directly in each
callback rather than a frame later, and only while the row is open, so a
transcript of closed rows listens to nothing.

**Nested, one bar is shown: the innermost.** A row inside an open Process
sticks to the same top as the subagent's row around it and comes later in the
tree, so it paints over it — but it is indented (the Process rail, a pending
card's inset) and cannot paint past its own list's clip, so the outer bar's
chevron and title would show beside it. An outer bar whose row holds a pinned
bar (`:has(~ * .row-bar[data-stuck])`) therefore blanks: its contents go to opacity 0
with no pointer events, and it fills with the ground the inner bar is indented
into — `--th-bg-secondary` when the pinned bar is inside a
`row-ground-secondary` body, its own ground otherwise (a subagent's pending
card sits under its row, on the transcript's ground,
[not in the Process](#when-a-step-asks-the-user)). Opacity rather than
`visibility`, so a focused outer row keeps its focus. Keyboard focus is the
exception to the blanking: Shift+Tab from the inner button reaches the outer
one without scrolling anything, both being at the top, so a bar holding
`:focus-visible` is not blanked but raised to z-index 3, over the inner bar,
until focus leaves it. When the inner bar is carried out it is no longer
stuck, and the outer one shows again under it as it goes.

**What it asks of everything around it:**

- **No scroll container between a row and the transcript's scroller.** A
  sticky box sticks to its nearest one. The framed list is `overflow-clip`,
  not `overflow-hidden`: both cut the rows to the rounded frame, but `hidden`
  makes the list a scroll container, and the bars stuck to the list — which
  never scrolls — and did nothing. Any wrapper added around rows later is under
  the same rule.
- **Stacking.** The bar's z-index 2 (3 while it holds keyboard focus) is over
  the body and the rows after it, and over a [pinned section
  header](#the-pinned-section-header) at 1. The scroll-to-bottom button is `z-3` and
  comes later in the tree, to stay over a bar passing under it, and
  the answer panel's `z-10` is over both
  ([answering-ui.md](answering-ui.md#it-is-modal-over-one-rectangle-and-nothing-else)).
- **A scroll margin under the bar.** Focus moving up a pinned row's body
  (Shift+Tab) scrolls the control only to the top edge, which is where the bar
  is. Everything inside what follows a bar has
  `scroll-margin-top: var(--row-height)`, in the base layer at no specificity
  (`:where(.row-bar ~ *) *`), so an element's own `scroll-mt-*` still wins.
- **Nothing of the scroll anchor.** The candidates are the row wrappers, which
  are not positioned and hold no candidate of their own, and a sticky box being
  pinned moves nothing in layout ([the list](#the-list)).

**`--row-height`** is the row's floor — `2.25rem`, `2.75rem` under
`any-pointer: coarse` — and so the pinned bar's height, declared on `:root`
for whatever is stacked under a pinned bar to name; today that is the scroll
margin above and a [pinned section header](#the-pinned-section-header)'s
`top`. It repeats `ROW_BOX`'s `min-h-9 pointer-coarse:min-h-11` in
`ToolRow.tsx`, and that duplication is deliberate: the touch-target scan
(`web/tests/touchTarget.test.ts`) reads the classes, and a `min-h` sized by a
variable would drop the row out of its census without failing. Each side says
so; change both.

### Folding from the bar

The bar's button is the row's `onToggle`, so a tap there folds the row. Left at
that, the body would vanish from under the reader and they would be left on
whatever followed it — possibly screens past the call they folded.
`useFoldLanding` measures the row at the tap, while it is still open, and once
the fold is laid out asks the transcript to hold a place:

| Folded | Lands |
|---|---|
| from its pinned bar (the row starts above what can be seen) | the row's top at the top of the view |
| … inside an open row that is still pinned | just under that row's bar: every bar sticks to the same top, so the innermost open row around it is what covers the view's top |
| with its title on screen | the title exactly where it was |
| out of sight, into its closed group | the group's summary at the top of the view, when the summary is above what can be seen |

The title is held, rather than the row's top, because the two do not move
together: the open bar centres line 1 in the floor, and a closed two-line row
puts it at the top of its box. Holding the row's top would move the title the
4px / 8px the other way.

A row the user kept open while its group was closed is hidden by its own fold
([groups](#groups)), and a hidden element measures as zeros — no place at
all. So it lands on where it went: the nearest preceding slot marked
with `foldPlaceProps` (`data-fold-place`, on the summary's wrapper in
`ToolList.tsx`). When the summary is already on screen nothing is asked —
the transcript's own anchor keeps everything above the reader still.

The place goes to the transcript as `holdAt`, through `TranscriptViewContext`,
rather than as a write to `scrollTop` here, so nothing else holding the view
undoes it, and a reader following the tail stays on it when the place is the
end ([agent-chat.md](agent-chat.md#where-the-view-sits)). Outside a
transcript there is no context and a row only folds. Near the end the view is
clamped, so a fold there cannot always keep the title where it was. Focus stays
on the button, which is the same element, and Enter and Space go through the
same click.

**Opening is not compensated**: line 1 still moves down 4px / 8px when a
two-line row opens. Holding it would mean anchoring on every open, which takes
a reader following the tail off it.

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
around them would hide a row the reader opened behind a *Show N more*. A scroller
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
  `MarkdownContent` — `prose prose-sm` in `text-th-text-primary`. The subagent's
  is the same component in a **note** variant: body at the row's `text-xs`, in
  `text-th-text-secondary`, with tight paragraph margins. A variant rather than
  a wrapper's classes, because `prose-sm` and the prose colour variables are set
  on the component itself and win over anything inherited. (Inline code needs
  nothing of its own here: it is sized in em, [so it follows the
  note](#the-body-problems-2-and-3).) No bubble, no avatar, no message chrome: a
  subagent's text is commentary between its steps, and drawing it at the weight
  of an answer is what made it read as the main agent talking.
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
| `sm:` (640–1023) | `p-2` → `sm:p-2.5`, the [full screen](#full-screen) viewer's `p-3` / `px-3` → `sm:p-4` / `sm:px-4`, and nothing else |
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
stay: there is room for them, and the old number is worth having. The full
screen viewer's diffs are the same `DiffViewer`, so they follow it.

**The viewer's rendered Markdown is capped at `max-w-3xl`**, centred, which is
a measure for prose rather than a tier: below it nothing changes, and on a
desktop a page of prose 1,900px wide is unreadable. Logs, code, file lists and
Markdown too long to render keep the whole width.

**No `pointer-fine:` reveal anywhere in this design.** Nothing is hover-only, so
there is no fallback branch to get wrong. `pointer-coarse:` appears on the
row's height floor — and the same query once more in CSS, on `--row-height`,
which restates that floor ([the sticky title line](#the-sticky-title-line)) —
and on the heights of the *Open* buttons (`min-h-[36px]` → `min-h-11`) and the
[full screen](#full-screen) viewer's toolbar (`min-h-10` → `min-h-11`);
otherwise only to keep hit areas apart: the gaps in a header's, the toolbar's
and the find bar's button clusters, the clearance above a foldable section's
header, and the clearances under a header for a [huge](#huge-content) block's
button and under the viewer's subject for its toolbar
([responsive-ui.md](responsive-ui.md#which-technique-and-when)). The one
`pointer-coarse:` that is not about reach is the find field's `text-base`,
16px so iOS does not zoom into it. Neither gate is consulted from JS for these: they are reachability
decisions, and reachability is a CSS variant
([responsive-ui.md](responsive-ui.md#the-two-pointer-gates)).

**One pointer question is about size, not reach:** a main section's
[budget](#budgets) caps at 20 lines where the primary pointer is coarse and 30
elsewhere. A phone's transcript is short enough that 20 lines is already a long
thumb-scroll past, while a desktop's holds more before a block stops being
glanceable. It asks `useHasCoarsePointer` (the primary pointer — a phone, not a
touchscreen laptop), and it is a height, not a hit area, so it is not bound by
the reachability rule above. Width plays no part: the transcript's own height
already says how much room there is. The viewer's file list asks the same hook
for the same kind of reason — not to decide anything, only to estimate each
row's height (an *Open* button is 44px under a thumb, 36px otherwise) before
the virtualizer measures it.

## Accessibility

- The row is a `<button>` with `aria-expanded` — unconditional now, since there
  is always a body.
- The glyph carries the status as text: `aria-label` on the settled icons
  (`success` / `failed` / `interrupted`), and the running glyph is a
  `role="status"` named `<tool> running`. Colour is
  never the only carrier — an `error` row also has a border and red detail text.
- The second line is `aria-hidden` while it is moving and exposed once it has
  settled, so a closed row's accessible name stays put while stdout moves and still
  carries the outcome afterwards (see above). What a screen reader is told is the
  spinner while it runs, the glyph when it settles, and the whole output on
  request, in the body. A fetched line is exposed even on a still-running row,
  because that text is standing still — the flag follows the text, not the run.
- While the row is open the second line is not in the button
  ([the sticky title line](#the-sticky-title-line)), so it leaves the button's
  accessible name and, once settled, is read as the text right after it. The pinned bar is
  the row's own button, not a copy, so there is still one control to reach and
  one name for it; folding from it leaves focus on it.
- The `background` chip is real text, so it is read as part of the row.
- A section's *Show* / *Show less* button carries `aria-expanded` and
  `aria-controls` (the clamped box), and its accessible name completes the
  visible text with what it opens: *Show 340 earlier lines of output*,
  *Show less of output*, *Show all of plan*. Keyboard focus entering the cut-off part opens the
  section ([the body](#the-body-problems-2-and-3)), landing where a press
  would ([keeping the reader's place](#keeping-the-readers-place)).
- An opened section's pinned header carries a collapse control with the same
  name, *Show less of output*, `aria-expanded="true"` and `aria-controls` the
  same box; closing from it leaves focus on the section's own button
  ([the pinned section header](#the-pinned-section-header)).
- The header's ⤢ is named *Open output in full screen* — the block's noun, not
  its label lowercased, so *Full reasoning* reads *Open reasoning in full
  screen* — with `aria-haspopup="dialog"`. A huge block's button keeps its
  visible words and drops the middot, *Open full output, 12,408 lines*
  ([huge content](#huge-content)).
- The viewer takes focus into its content scroller, a region named by the noun,
  so the dialog's name is read as focus enters it and the keys scroll at once.
  Tab runs subject → ✕ → wrap → copy → find → the find bar → content, trapped.
  The subject line is a button whose name is its visible text, with
  `aria-expanded` / `aria-controls` over the full text below it. Find's count is
  repeated in a polite live region, and Escape, Ctrl/Cmd+F and the back gesture
  all close or open what they say ([full screen](#full-screen)). Focus goes back
  to the opener on close, or to whatever opens the same key now.
- A subagent's Process is a `role="group"` named for the subagent, and a pending
  permission card it raised sits inside the Task item's own DOM, so both say
  whose they are without the visual cues
  ([a subagent's own work](#telling-the-subagents-words-from-the-main-agents)).

## What a reviewer should check

1. A `Bash` row with a 300-character command: one line, truncated from the right,
   full command in the body, copyable. Where it wraps, it wraps at spaces:
   no `--flag` split after its hyphens, and each continuation line indented
   past the start of its line.
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
   **closed**, with the line that says why under the title — for a failed
   vitest run its summary line (`Tests  2 failed | 2 passed (4)`), not
   `Duration …`; for an
   uncaught Node error the `Error: …` line, not a stack frame. Open it for the
   rest. A backgrounded `Bash` that finished reads `Completed (exit code 0)`
   (or its failure) under the command, not `Background command "…"`.
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
    with *Show N more lines* rather than inside a scroll box.
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
24. One settled call, with any number of failures or running calls beside
    it: no summary. A `Read` that succeeded, then a `Bash` that asks for
    permission: the two rows stay flat while the `Bash` runs and when its card
    replaces it — no summary appears and vanishes. Inside a group of two
    settled calls, a `Bash` shown as the current step that fails: the summary
    turns to its verbs and the failure comes into sight under it; nothing else
    moves.
25. A pending card in a group: pinned under the summary, which does not spin.
    Allow it: the card stays, and its row comes back under it and runs in
    sight; when the call settles both fold. Deny it: the card and the failed
    row both stay. With a folded call still running beside the settled ones
    when the card arrives: no tick and no spinner, the row reads
    `1 running · <verbs>`, and the spinner returns if it is still running once
    the card is answered.
26. A backgrounded `Bash` in a group: folded while it is an ordinary running
    call, pinned from the moment it goes to the background, still pinned when
    it settles — second line becomes the outcome, height unchanged.
27. A subagent call between calls splits them into two groups; its Process
    folds its own calls the same way.
28. Open a running `Bash` to watch it, then let the calls around it settle
    into a group: it stays open and in place; close it and it folds. A hidden
    row is never where the view is held, and a group whose last row is hidden
    leaves no doubled line.
29. On a 375px phone, open a `Read` of a 60-line file and drag the page up and down
    across its body: the transcript moves, the body never does. *Content* is on
    top, cut and faded, with *Show N more lines* under it and ⤢ in its header; *File* is folded under
    it. Copy from the *Content* header: no line numbers in what was copied.
30. On a 375px phone, with nothing scrolled sideways: an `Edit` of a deep file
    opens on `src/…/name.ts`, *Open* and a copy button on one row, with no
    `File` header above it, and the command or path in any section starts
    flush with its section's label; a `TodoWrite` opens on its
    checklist alone; an MCP call lists its arguments by name; a `go test` that
    failed shows its last lines wrapped, the final five in red, with *Show N
    earlier lines* above them; opened, the same button reads *Show less*.
31. On a 375px phone, open an `Edit`: its *Change* header reads `+N −M` (an
    edit that only adds reads `+N`, never `−0`); the
    gutter is one narrow column and the code takes most of the width. Turn on
    *Wrap long lines*: long lines wrap with no sideways scroll, and the next
    diff — in this row, another row or a permission card — is wrapped too.
32. On a 375px phone, a reply with a heading, a wide table and a long code
    line: the heading reads one step above the body, not a banner; the table
    keeps its columns at least about 9em wide — a long header at about two
    lines, no cell four lines tall — and scrolls sideways on its own while the
    text around it stays put, its right edge faded until scrolled to the end;
    the code block's language and copy button sit in a bar above the code, and
    the code scrolls under it without carrying the bar along. Inline code in
    the text and the table is never split mid-name: a path that fits moves to
    the next line whole, a longer one breaks after a `/`, and it is no bolder
    than the text around it.
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
36. On a 375px phone, open a card row onto a diff of about 60 lines and drag
    up and down over it: the transcript moves, never the diff alone. The diff
    is cut and faded with *Show N more lines* under it, `+N −M`, the wrap
    switch and ⤢ in its header; a `Write`'s block copies its content.
37. An `Edit` the tool refused (an `old_string` not in the file): the row's
    second line is the reason in prose, with no `</tool_use_error>` on it.
    Open it: an *Error* section in red above *Change*, the *Change* header
    reading `not applied` with muted counts, and nothing in the body or the
    copy carrying the tag.
38. A `Grep` with an absolute `path` inside the work directory: the row reads
    `"pattern" in src/lib`; with `path` the work directory itself, just
    `"pattern"`.
39. With reduced motion on: every running row, and a running group summary,
    shows a still accent dot where the spinner was.
40. On a 375px phone, open a failed `Bash` with a long output and scroll into
    it: its title stays pinned at the top in its red, with a hairline under it,
    and its second line scrolls away under it; at the end of the body the bar
    is carried off. Open a subagent's Process and a row inside it: one bar at
    the top, the inner one, and the subagent's back under it as the inner one
    leaves. A pending card's bar keeps the warning wash and its frame. Tap a
    pinned bar: the row folds and its top lands at the top of the view (inside
    a Process, just under the subagent's bar), focus on it. Fold a row whose
    title is on screen: the title does not move. Fold one kept open in a closed
    group, from its bar: the group's summary lands at the top. Fold a pinned
    row while following a running turn: the view stays at the end and goes on
    following it. The walkthrough's `sticky`, `sticky-fold` and `sticky-tail`
    scenes shoot all of these.
41. On a 375×667 phone, open a `Bash` with a 20-line command and a 60-line
    output (the walkthrough's `fullRun`; thousands would be
    [huge](#huge-content)): the command is cut at 8 lines with *Show all* under it,
    the output at about 45% of the transcript with *Show N earlier lines* above
    it, and both fit on one screen. A block 5 lines over its budget shows whole
    with no button. Turn the phone landscape: a cut output is at most about
    half the transcript (rotated after opening: opened in landscape, 60 lines
    are already [huge](#huge-content)). A `TodoWrite`'s checklist is never cut.
42. In that `Bash`, with the output's last line mid-screen, press *Show N
    earlier lines*: the last line stays exactly where it was and the log grows
    upward. *Show less* leaves its button where it was pressed; closed with its
    button out of sight, the section's header lands just under the pinned title.
    *Show all* on the command keeps the command's top. The walkthrough's
    `keep-place` scene logs each edge before and after.
43. Open that output with *Show N earlier lines* and scroll into it: the
    *Output* header pins directly under the row's title with a hairline, the
    copy button, ⤢ and a collapse control; there are never more than those two
    bars. Scroll to the output's end: the header is carried off under the row's
    title, not over it. Press the collapse control mid-output: the output is cut
    again and its header lands just under the row's title, focus on *Show N
    earlier lines*. A section that fits, or one cut and not opened, never pins.
44. On a 375×667 phone, a 30-line *Output* has ⤢ in its header and no *Open full* button; a 5-line
    one has no ⤢; a 30-line *Command* never has one. The plan and a subagent's
    report, cut, have *⤢ Full screen* beside *Show all*.
45. On a 375×667 phone and on a desktop, a `Bash` that printed 10,000 lines:
    never opens in place — its last lines faded under *⤢ Open full output ·
    10,000 lines*, no *Show* button, never pinned. The viewer opens at its last
    line with its command under the title; tap the command for all of it. Scroll
    to the top: line 1. Turn wrap off: the block scrolls sideways as one.
46. In that viewer, find `FAIL`: the count, a highlight on each match and a
    stronger one on the current, Enter / Shift+Enter and the ↓ / ↑ buttons wrapping at the
    ends and jumping to lines that were not drawn, the match a third of the way
    down. With a Chinese or Japanese IME, committing a word with Enter jumps
    nowhere and Escape mid-composition closes nothing. Escape closes find, focus
    on 🔍; Ctrl/Cmd+F reopens it with the query back, selected; then Escape
    closes find again, and the next one the viewer.
47. A `Glob` of 3,000 files: 100 rows in place with *Show N more files*, and
    ⤢ opens all 3,000; *Open* on one closes the viewer and opens the file.
48. Open a running command's *Output so far* full screen and let it finish: the
    viewer stays, now holding the whole output, and the reader's line stays put;
    past 200 lines it first says *Earlier output arrives with the result*.
49. Close the viewer with Back (Android back, iOS edge swipe, browser Back): it
    closes, the page stays, and the transcript is where it was — also after
    toggling diff wrap in a viewer, which every transcript diff follows. ✕ and
    Escape leave no extra history entry behind: Back afterwards does what it did
    before the viewer opened.

## Out of scope

- **The turn's changes, live or reconciled.** No card while the turn runs, no
  net diff, no counts checked against git, no `Bash` side effects, no jump from
  a card row back to its tool call, and nothing in `web-cluster`
  ([the turn's changes](#the-turns-changes)).
- **A full-screen tool detail route.** happy's answer to long content is
  navigation, and it is a good one, but Pockode's row already owns a body that
  opens long content in place; adding a route for the same content would mean
  deciding which of the two any given tool goes to. [Full screen](#full-screen)
  on a long block is a sheet over the transcript, not a route — closing it
  leaves the reader where they were, and the history entry it takes exists only
  so Back can close it.
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
