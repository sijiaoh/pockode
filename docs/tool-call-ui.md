# Tool Call UI

How a tool call is drawn, on a phone first.
[tool-call-model.md](tool-call-model.md) decides what a tool run **is**; this one
decides how one looks and behaves. Read it first — every field named here
(`status`, `activity`, `output`, `placeholderResult`, `fromBackground`,
`lostWithProcess`, `fetches`, `durationMs`, `exitCode`, `startedAt`, `endedAt`, `seenAt`, `workRef`, and a subagent
run's children) is its `ToolRun`, and nothing below asks for data it does not
define.

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
`TurnChangesCard.tsx` for [the files a turn
changed](#the-turns-changes) and `WorkFigures.tsx` for [its
size](#the-work-figures), `toolJumpContext.ts` for [going from a change to
its call](#from-a-file-to-the-calls-that-changed-it), and
`HtmlRenderCard.tsx` over `HtmlFrame.tsx` for [a page the agent
drew](#a-page-the-agent-drew-html_render), all
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
things that ever add a line are the **second line**, and only for a run that has
something to say on it — see below — and a live subagent's
[step window](#the-step-window), a few lines sized by its list and the
screen's width, which fold only where nobody sees them. Consecutive calls between two pieces of
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
a question card, [a page the agent drew](#a-page-the-agent-drew-html_render)
and every other part end the list and stand on their own, with
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
nothing about where inside it the reader is. For the same reason an open row's
sections are candidates beneath it — one result can be screens long too — while
a closed row's body, being `hidden`, offers none. A group's summary row is a
candidate as well; a row folded into it is not ([groups](#groups)).

## Groups

A turn of fourteen calls is fourteen rows, and on a phone that is two screens
of `Read`s between the question and the answer. So consecutive calls in a list
fold into one row that says what they did:

```
┌───────────────────────────────────────────────────────┐
│ ›  ✓  Edited sender.go · Ran go vet +1 · Read 3 files │  ← the summary
├───────────────────────────────────────────────────────┤
│ ›  ✗  Bash   go test ./relay/…                        │  ← pinned: failed
│          --- FAIL: TestRetry (0.01s)                  │
├───────────────────────────────────────────────────────┤
│ ›  ⟳  Bash  background  npm run dev            4m 12s │  ← pinned: background
└───────────────────────────────────────────────────────┘
```

`rowEntries` (`lib/toolGroups.ts`) decides it, a pure function of the parts as
they are now; `PartBlocks` draws it, so a subagent's Process folds exactly as a
message does. Every part of a list falls into one of these kinds:

| Kind | Parts | In a group |
|---|---|---|
| **Breaker** | a subagent call, `ExitPlanMode`, and their cards — and, since they already end the list, text, a question card and every other part | ends the group and stands as itself |
| **Pinned** | a call that is `error`; one that is `background` or `fromBackground`, running or settled, unless it was interrupted; one `lostWithProcess`, interrupted or not; a card that is not `allowed`; an `allowed` card whose row has not come back, or whose call is still running | belongs to the group, never folds |
| **Settled** | a call that is `success` or `interrupted` (but not `lostWithProcess`), with its `allowed` card if it had one — an `interrupted` one even once a background result reaches it, since the interrupt came first | folds into the summary, and is the only kind that decides whether there is a group |
| **Running** | a `running` call that never had a card | folds into a group its settled neighbours form — named in the summary in the present tense, the newest giving it its elapsed time; otherwise lies flat |
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
  they came back for. Work lost with the process is pinned the same way,
  although it settles `interrupted`: it was pinned as `background` up to that
  moment, and the process ending lands just as long after the reader moved on.
  The table's *unless it was interrupted* is for a call the *turn* cut short,
  which settled before it could be marked and must not come back out of its
  group.
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

### The summary row

The summary is the tool row's box (`RowButton` in `ToolRow.tsx`) with a
different text column, so the two cannot differ in height. Settled, its glyph
is a muted `Check`, or `Ban` when something was interrupted — never green,
never red; red is the pinned rows'. No accent title: that is what tells it
from a tool row.

**It speaks for exactly the folded members — never for a pinned one.** A pinned
row is in sight and speaks for itself, so counting it again would say one thing
twice; and the rows the summary stands for are then exactly the ones [the
rail](#an-opened-group) marks once it is opened. Of the folded members, a
`success` call is named in a past-tense segment, a `running` one in a
present-tense segment, an `interrupted` one is only counted, in a trailing `N
interrupted`, and folded thinking is `Thought for 1m 20s`. A failed call is
pinned, so is in none of them — a failed `Edit` changed nothing. `summarize` in
`lib/toolGroups.ts` builds it; `GroupSummary` holds the segments structured,
not worded.

**A segment is a verb and what it touched:** `<Verb> <name>, <name>`, or
its count when the names would not say what most of it did.

- One segment per verb and tense: the present ones first, then the past ones,
  each in a fixed order by consequence — edit, create, start, run, stop, read,
  search, fetch, todo, other (`TOOL_VERBS`) — then the thinking, then `N interrupted`, so the end a
  narrow screen gives up is the least important.
- Names are in the order they first appeared. A live group only ever appends
  at the end, so the line never reshuffles under the reader, and the names come
  in the order of the rows under it.
- At most three names, and they are only drawn when they account for at
  least half of the segment's count (its calls, or its files for the file
  verbs; a name's `×N` counts N). Whenever they do not account for all of it,
  the count is written out, so the reader never adds anything up and one
  sample name never stands in for fifteen calls:

  | The names shown cover | Drawn as | Example |
  |---|---|---|
  | every call | the names alone | `Ran head ×3, sed` · `Read a.ts, b.ts` |
  | at least half | the count, a muted `: `, the names | `Ran 15 commands: pnpm test ×9, git diff` |
  | less than half | the count alone | `Ran 15 commands` |

- When not all names fit, the ones kept are those with the most calls (ties to
  the first seen), still drawn in first-appearance order — so a live group
  never reorders what it has drawn, though a name may swap in or out as the
  counts change.
- The count is worded as the line always was: `Edited 2 files`, `Ran 1
  command`, `Read 3 files`, `Searched once` / `Searched N times`, `Fetched N
  pages`, `Used N tools`, and `Created N tasks` / `Started N stories` (`work
  items` when the kinds are mixed), `Stopped N tasks`. `Stopped` and `Updated
  todos` never name anything.

What a call is named by is read by `toolVerb` in `lib/toolSummary.ts`, beside
its verb — the same table of knowledge as the row's title, and a Codex `Bash`
through the same `singleCommandAction`, so the summary says what the rows under
it say:

| Verb | Counted by | Named by | Example |
|---|---|---|---|
| edit | distinct file — a Codex file change counts each of its files; a `NotebookEdit` counts its notebook | base name | `Edited ToolRow.tsx, toolGroups.ts` |
| create | call: `story_create`, `task_create` | its kind and the title it was given, quoted | `Created task "Design the row", story "Ship it"` |
| start | call: `story_start`, `task_start` | its kind and the title its [`workRef`](#pockodes-own-work-calls) carries, quoted — nothing while it runs | `Started task "Design the row"` |
| stop | call: `TaskStop`, `KillShell` | nothing — a task id names nothing a reader knows | `Stopped 1 task` |
| read | distinct file | base name | `Read 3 files: toolSummary.ts, ToolRow.tsx` |
| search | call | `Grep`, `WebSearch`, a Codex search: what it looked for, quoted; `Glob`: its pattern; a Codex file listing: the directory's base name and `/`. Never where it looked — the row has the scope | `Searched "Retry-After", **/*.test.ts` |
| run | call | the command's [head](#a-commands-head) | `Ran pnpm test, go test ./relay/...` |
| fetch | call | the URL's host — a Codex page open included | `Fetched github.com` |
| other | call | the row's own title: an MCP tool without its server (a Pockode work tool's readable title), otherwise the tool's name | `Used Get work, List stories`, `Used TaskOutput` |
| todo | — | nothing | `Updated todos` |

- **A repeated call is a repeated event; a re-read file is not.** Files are
  counted once however often they were touched, so a file name never repeats.
  A call-counted name that does is drawn once, with a muted `×N`: `Ran pnpm
  test ×2`.
- **Two files with one base name in one segment** — those two, and only those
  — are named by the shortest ending of their paths that tells them apart:
  `web/index.ts`, `server/index.ts`. The ending is joined in the separator the
  path itself uses.
- **A call with nothing to name it by** — a stop, a start still running, a call
  missing its command, pattern or URL — is counted and named by nobody, so it
  is only ever in the count.
- **Reading a task's output is not running a command.** `BashOutput` used to be
  counted under `run` with `KillShell`, so a log read twice and a shell killed
  read `Ran 3 commands` beside the one command that ran. A fetch is now
  `other`, named by its tool like `TaskOutput`; a kill is `stop`.
- **Creating and starting work rank above running a command.** They are what a
  story's reader scrolls back for — which tasks the agent spun off — and like
  an edit they leave something behind that outlives the turn. Every other work
  tool is `other`, under the title its row has; a read of the work (`Get work`,
  `List tasks`) is not a file read and is not counted under `read`.

#### A command's head

What a reader recognises a command by (`commandHead`): the first command in
the text that does the work. The shell is read as a shell — quotes, `$(…)`,
comments and here-doc bodies stay where they belong — and what an agent wraps
around the work is passed over: `cd`, `export`, `VAR=value` words, `echo`
banners and `sleep`s; `for … do`, `if … then`, `while`, subshells and `{ }`
groups; `sudo`, `env`, `timeout` and the `bash -lc '…'` Codex runs everything
in. Of that command it keeps at most three words — the first by its base
name, so `./scripts/run.sh` is `run.sh` — stopping before the first that is a
flag, a quoted or expanded argument, a redirection or a bare `.`. So `cd web
&& pnpm run test -- --watch` is `pnpm run test`, `for q in …; do echo "$q"; gh
search issues "$q"; done` is `gh search issues` and `find . -name …` is
`find`. Where it cannot tell — the command is a variable (`$FF -i …`), the
work is only inside a `$(…)`, a `case` — it names nothing rather than a keyword,
and the call is counted unnamed; setup alone (`cd web`, `sleep 30`) is named by
itself. Nothing marks the cut: the row is one tap away and has the whole
command.

#### When the line runs out

`truncate` cannot give names up before counts, and a name cut in the middle of
a list leaves the line claiming less than was done. So the row draws the
**richest form that fits**, from a ladder `summaryForms` builds, richest first:
every segment with its names; then the names given up one at a time from the
end of the line toward the start, each form worded by [the rule
above](#the-summary-row) — a segment that loses a name gains its count
(`Ran 3 commands: a, b`), and one whose names fall below half goes straight to
its count — down to the line of counts alone. If even that does not fit,
`truncate` cuts its end with an ellipsis. The most consequential segments keep
their names longest, and the present ones, leading, longest of all. The forms
do not get strictly narrower (`Ran ls, pwd` is shorter than `Ran 2 commands:
ls`), so the row takes the first that fits rather than searching by width.

`FittedLine` in `ToolGroupSummary.tsx` fits it to the width the text column
actually has — never to a character count, which could only disagree with the
screen. Every form is measured once per change of words, from copies drawn for
that one layout pass and removed before paint, since copies left in would be
found, selected and copied as the row's own text. They are read when one
`ResizeObserver` shared by every line reports them, inside the frame's own
layout, and every line it reports is fitted in one synchronous commit before
that frame paints — never in an effect, whose read would force the whole
transcript's layout in the middle of each streamed record that changes a group.
A line whose words and width are as they were does no work at all, and a
resize only compares numbers. Both sides are read with `getBoundingClientRect` — a
rounded `clientWidth` picks a form a fraction too wide, and its last name is
cut to `…` — and a web font arriving (`document.fonts` `loadingdone`) measures
again, since Geist swaps in after the fallback was measured. Until a width is known —
the first paint, jsdom — the richest form is drawn and `truncate` covers it; a
column out of sight, a list inside a collapsed Process, measures nothing and
keeps the last pick, and a reveal fits it afresh. A phone and a desktop climb the same
ladder, the phone just stops lower: on a 360px phone even `Edited 2 files ·
Ran 1 command · Read 3 files · Searched once` is wider than the column, and the
counts are cut. `ToolGroupSummary.browser.test.tsx` holds the fit at a phone's
width and a desktop's, and that neither an unchanged line nor the commit
bringing new words reads the layout.

Verb words and count wording are proportional, in `text-th-text-secondary`;
names are `font-mono`, the same colour — machine text, like a row's detail;
`, `, `: `, `×N` and ` · ` are `text-th-text-muted`. No accent, no red, no
green.

#### While it runs

The same vocabulary and the same ladder, in the present tense for what is
live:

```
⟳  Running pnpm build · Edited ToolRow.tsx · Read toolSummary.ts, ToolRow.tsx   12s
```

Present segments lead — `Editing a.ts` / `Editing 2 files`, `Running pnpm
test` / `Running 2 commands`, `Reading a.ts`, `Searching "foo"` /
`Searching` / `Searching N times`, `Fetching github.com` / `Fetching N
pages`, `Updating todos`, `Using work_get` / `Using N tools` — because live
work is what the reader is watching, and the front is the end the ladder gives
up last. When a call settles its name moves from its present segment to the
end of its verb's past one. The newest running folded call's elapsed time
(`ToolMeta`) stays at the right end, `shrink-0`, and the text fits in what is
left. One line in every form, so the row does not change height when it
settles. The spinning form's text is `aria-hidden` while it moves, and the
running glyph says `Tool calls running`.

It does not spin while a card in the group waits on the user: then the machine
is waiting for them. The tick says only that every folded call is over — the
card is pinned below, in sight — so a waiting card neither takes it away once
that is true nor brings it early: while folded calls still run behind the card,
the glyph is empty, neither busy nor done, and the present segments, still
leading, are what say it is still at work. That line changes only when a call
settles, so it is read out as it is. A group always has a settled call, so
some segment is always there — `N interrupted`, if nothing else.

A group no longer speaks a subagent's live form — its count over its
newest steps ([its second line](#the-second-line-steps-and-what-it-is-doing),
[the step window](#the-step-window)) — and the difference is on purpose: a subagent's row is one call whose steps are its
body, while a group is several calls, each of which the reader needs named.

### An opened group

**Rendering.** Every part is rendered once, in transcript order; the group adds
a summary entry before its first part and hides its folded parts with the
`hidden` attribute. Nothing is copied or remounted — a pending card is in the
DOM once, so a jump to it lands, and a row folded and unfolded comes back as it
was. A hidden part is not a scroll anchor candidate: an element that is not
displayed measures as sitting at the top. For the same reason a part the reader
was anchored on that folds away hands the anchor to the group's summary, held
where the part's top was but never above the view's top or under a bar pinned
there — where a fold from the row's own bar would have landed them ([folding
from the bar](#folding-from-the-bar),
[agent-chat.md](agent-chat.md#where-the-view-sits)).

**Nothing opens a group but the user, and nothing folds what the user opened.**
A row's open body is held by the list (`rowExpansionContext.ts`), which keeps a
row the user opened in sight when its group forms or closes, until they close
it themselves — the run they were watching does not vanish because the next
call arrived. Only the user's own choice counts: a pending card opens itself,
and folding it once it is answered and its call has settled is the point.

**A rail tells the rows the summary stood for from the pinned ones.** Opened,
a group is its rows in transcript order, the pinned among the folded — and
nothing else said which of them the summary's line had counted. So every
folded member's slot carries a 2px rail down its left edge (`RowSlot` in
`ToolList.tsx`), and a pinned row carries none:

```
┌───────────────────────────────────────────────┐
│ ⌄  ✓  Edited ToolRow.tsx · Read a.ts, b.ts    │  ← the summary, open
├───────────────────────────────────────────────┤
│▌›  ✓  Read   web/src/a.ts                     │  ← folded: on the rail
│▌›  ✓  Edit   web/src/ToolRow.tsx              │
├───────────────────────────────────────────────┤
│ ›  ✗  Bash   go test ./relay/…                │  ← pinned: no rail
├───────────────────────────────────────────────┤
│▌›  ✓  Read   web/src/b.ts                     │  ← folded again
└───────────────────────────────────────────────┘
```

- **Membership decides it, nothing else**: `entry.group` in `rowEntries`. A
  row the user opened while its group is closed still belongs to the summary
  above it and keeps its rail, and so does a thinking that folds; a part in no
  group never has one. The rows on the rail are the set the summary counted —
  the rail is its footnote.
- **It runs through the hairlines** (`-top-px`), so consecutive members read as
  one bracket and a pinned row visibly breaks it. Nothing is regrouped or
  moved, and the row's layout does not change: the rail is absolute, inside
  the row's own left padding.
- **It is neutral**: `bg-th-text-muted/40`, the summary glyph's colour at
  reduced strength. Not `th-border`, which is the hairline's and would read as
  one more; and not a colour, since failure stays the only saturated one.
  Pinned rows look exactly as they always have.
- **It is drawn over the row**: after it in the DOM, `z-3`, because an open
  row's [sticky bar](#the-sticky-title-line) is `z-index: 2` with a background
  and would cover it while pinned at the top. It is `aria-hidden` and
  `pointer-events-none`; the summary's `aria-expanded` already says the group
  is open.

### What a list and a group are keyed by

Rows are keyed by their part's `id`, which nothing around them can shift
([frontend-state.md](code/frontend-state.md#part-identity)). A list and a group
need a name too — it is what keeps a list's rows mounted, and what the open
groups are remembered by — and they take it from their **oldest** member
(`oldestPart`), not their first: rows arrive at both ends, a live call after
the last and an older page in front of the first, and the oldest is the one
neither displaces. A card that takes a row's place takes its id too, so the
card does not rename the list either. Only a member *leaving* renames it — a
`question_post` row replaced by its card when it was the oldest, an
`html_render` or `html_edit` call drawn on its own once it succeeds — and that
remounts the list.

Whether the user opened a row is remembered apart from its key: under its call
(`tool_call:<tool_use_id>`) for a tool row, under its part for anything else. A
card shares its row's key but not its choice, so a pending card opens itself
even where the user had closed the row; and the row rebuilt once a permission
card is answered — a new part for the same call — opens as the user left the
row the card replaced.

## The turn's changes

The tool rows say what a turn *did*; nothing said what it *left behind*. To
review a turn's edits the reader had to open every `Edit` row, folded into a
summary or not, and keep count of which file they were on. So a settled turn
that changed files closes with **the changes card**: those files, one row
each, under a header that carries [the work
figures](#the-work-figures) — `Worked 2m 13s · 14 tool calls · 3 files
changed` — the turn's size, said once:

```
┌────────────────────────────────────────────────────────────┐
│ ›  ✓  Edited 2 files · Read 3 files                        │  ← the work
└────────────────────────────────────────────────────────────┘
The sender now backs off on 503 too.                              ← the answer
┌────────────────────────────────────────────────────────────┐
│ ▤  Worked 2m 13s · 6 tool calls · 2 files changed  +11  −2 │  ← the header:
├────────────────────────────────────────────────────────────┤    the work figures,
│ ›  deliver.ts  src/webhooks/sender                 +7  −2  │    not a button
├────────────────────────────────────────────────────────────┤
│ ›  backoff.ts  src/webhooks/sender            new  +4      │
└────────────────────────────────────────────────────────────┘
[⧉] [⑂]
```

A turn that made calls and changed no file has no card; its figures go on the
turn-end row, at its right end ([the work figures](#the-work-figures)):

```
┌────────────────────────────────────────────────────────────┐
│ ›  ✓  Read 4 files · Searched 2 patterns                   │
└────────────────────────────────────────────────────────────┘
The retry lives in sender.go, line 88.
[⧉] [⑂]                                     Worked 48s · 6 tool calls
```

`turnChanges` (`lib/turnChanges.ts`) derives the files, a pure function of one
assistant message's parts as they are now, like `rowEntries`;
`Chat/TurnChangesCard.tsx` draws the card, `Chat/WorkFigures.tsx` the figures'
words for both places, and `MessageItem` places them (`SettledTurnEnd`, which
computes `turnChanges` once — it diffs whole files for a Codex add or delete —
and gives the figures to the card or to the row, never both).
What counts as a file change is asked of `proposedChange`
(`lib/proposedChange.ts`) — the one reader the tool body and the permission
card already use — so a tool it learns to read reaches the card with no list
of names here.

**It is the list's grammar, told apart by its header alone.** The frame,
hairlines, `-mt-px` and `ring-inset` are [the list's](#the-list); every file
row is the tool row's box (`RowButton`, no glyph — everything listed
succeeded), so height, hover and the touch floor cannot differ. The header —
the work figures — is the one row that is not a button, with `FileDiff` in the
chevron's column so its text lines up with the file names — the same trick by
which a group's summary is told from a tool row: by what it lacks, not by a new
colour or fill.

**Where.** Last in the turn, after everything the turn said and every ending
line, in this order: the parts (the answer, a warning or question record), the
error or `Interrupted` line, the [discarded
messages](discarded-messages-ui.md#3-at-the-end-of-the-stopped-turn),
`Process ended` — then the card, `mt-2` — then the turn-end row. An agent that
outlives the turn adds no line between them: its chip stands at the right end
of the turn-end row
([turn-progress-ui.md §4.3](turn-progress-ui.md#43-the-agents)). An interrupted turn so
reads warning → `Interrupted` → card → Copy/Fork: why it stopped, then what it
left behind, then what to do with it.

The card is what a reader *acts on* once they have read the answer — open a
diff, open the file, go to the call — so it sits with the other things to act
on, just above Copy and Fork, rather than between the work and the answer, where
it would be passed on the way down and scrolled back to. And a turn ends in
fewer rows that way, which on a phone is most of what decides how much of a
turn a screen holds: no turn gains a row for its size ([the work
figures](#the-work-figures) say where they go instead).

The card has a wrapper of its own outside `PartBlocks`, a scroll anchor
candidate like a part's: with rows open it can be screens tall.

**When.** Exactly when the actions are (`!pending`), so it comes in the render
the tail line goes in. It is never drawn on the reply the turn is writing: the
tail line and the group summaries own the running turn, and neither its
figures nor its files are final until it ends. A reply [a read
point](code/agent-integration.md#the-read-point) closes is over at that moment
(the reducer settles it to `complete`), so its card is drawn then, at the end
of *that* reply, above the message the read point delivered, while the turn
goes on in the reply under it; a call of its that is still running is counted
among its calls and, until it succeeds, not among its files. Settling appends
the card at the bottom of its reply: a reader at the tail stays at the tail,
as through any growth there, and a reader anchored anywhere — above a reply a
read point closed, say, where the card goes in over the delivered message —
keeps their anchor ([agent-chat.md](agent-chat.md#where-the-view-sits)). A turn that made **no
tool call** draws nothing — no card, no figures: a question answered in words
has no work to measure, and a thinking before the answer already says
`Thought for 12s`. A cut-short turn draws it like any other — that is the turn
whose leftovers most need reading. The one way it grows after settling is a
subagent the turn left in the background finishing edits: they are this
turn's, so rows join the card and its figures grow in place. A first such edit
on a turn that had changed no file draws the card in its place above the
turn-end row, and the figures move from that row into its header.

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

**Line counts are read off the inputs**, with no protocol of their own. A diff is
counted off the patch the body draws (`diffStat`, by its hunk headers), so the
card, the file's *Change* header and the row's
[`+N −M`](#what-the-call-measured) are one number:

| Change | `+` | `−` |
|---|---|---|
| `Edit` | its patch, built from `old_string` / `new_string` each closed with a newline so a fragment's last line compares as a line — appending to `a` is `+1`, not a rewrite of `a` — and carriage returns set aside, so a CRLF file reads the same (`fragmentPatch`, `lib/proposedChange.ts`) | same |
| `Edit` with an empty `old_string` | the new text's lines: it creates the file, so its text is diffed as it is, unclosed | `0` |
| `MultiEdit` | each edit as an `Edit`, summed | same |
| `Write` creating the file | the content's lines, a trailing newline opening none | `0` |
| `Write` over a file | the content's lines | unknown — the old content is not in the call |
| Codex | each file's hunks, so the count is the diff the row opens on; no hunks (an empty file, a pure rename) is `0`, an unknown change type is unknown | same |
| `NotebookEdit`, `replace` | the new source's lines | unknown — the cell it replaced is not in the call |
| `NotebookEdit`, `insert` | the new source's lines | `0` |
| `NotebookEdit`, `delete` | `0` | unknown, as above |

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
  `Bash` change files the card cannot list. Hence `files changed` counts
  changes it saw, not the state of the tree.
- **A notebook is counted in cell lines.** A `NotebookEdit`'s counts are lines
  of the cell's source, not of the `.ipynb` JSON a `git diff` would count, and a
  cell's old source is never known: the CLI reports it in `tool_use_result`
  (`old_source`, claude 2.1.330), but `proposedChange` reads the input alone so
  that the permission card, the row and this card say one thing — the rule a
  `Write` over a file already lives by. A notebook is never `new` or `deleted`:
  the tool edits a notebook that exists, and deleting a cell is not deleting the
  file.

What they do promise is to stay put: everything comes from the persisted tool
calls and results, so a reloaded turn draws the card it ended with.

**Accessibility.** The card is a `role="group"` named by its header — the work
figures' sentence, *"Worked 2 minutes 13 seconds, 6 tool calls, 2 files
changed"* ([below](#the-work-figures)) — not a region: one landmark per turn would
drown the page's own. The visible counts are `aria-hidden` beside an `sr-only` *"11 lines added, 2
removed"*. A file row hides its whole visible line and carries one `sr-only`
sentence, so its name reads as one: *"backoff.ts in src/webhooks/sender, new
file, 4 lines added"*, or *"config.ts in src, rewritten, 30 lines written"*
when nothing removed is known. It has `aria-expanded` and `aria-controls`
naming its body. Colour never carries anything alone: the counts are signed,
the chip is a word.

### The work figures

One run of words that says how big the turn's work was, standing at the
turn's end: the changes card's header when the turn changed files, and the
right end of the turn-end row when it did not. Never both, and never a row of
its own. On the row an agents chip that outlives the turn takes their place
while it lasts ([turn-progress-ui.md
§2.1](turn-progress-ui.md#21-where-it-is)).

**What they say.** Up to three entries, in this order — from how long, to how
much, to what was left behind — separated by `·` as a group summary's are:

| Entry | Shown | What it counts |
|---|---|---|
| `Worked 2m 13s` | when the reply's span was measured and is at least 1s | the reply's span, from the moment it opened to the moment it ended ([below](#where-the-duration-comes-from)) |
| `14 tool calls` | whenever the count is whole — the figures exist only for a reply with a call | the distinct `tool_use_id`s of the message's top-level `tool_call` and `permission_request` parts, whatever their status and however they are drawn. A failed, denied or interrupted call was still made — including one cut short while its card still stood in its row's place, which leaves only the card. A subagent is one call: its own steps are counted on its row's [second line](#the-second-line-steps-and-what-it-is-doing), so a step left flat because its parent is not loaded (it carries `parentToolUseId`) is not counted either — though it is work all the same, so a reply whose loaded half has only such steps still has figures, and is [cut](#where-the-duration-comes-from) like the top of the loaded history. A [fetch](#a-fetch-reads-on-the-row-it-came-from) filed on the row it reads is not a part of this message and is not counted; one whose row is not loaded falls through to a row of its own and counts like any row — so an older page joining can lower the count by the fetches it gives a home |
| `3 files changed` | on the card, when the turn changed a file | `turnChanges`' files — every file the card lists, folded behind `Show N more files` or not |

The `+N −M` totals stay at the right end of the card's header. An entry with
nothing to say is left out — never `0 files changed`, never a `—` for a time.
Without a duration the figures start at their count, `14 tool calls · 3 files
changed`: `Worked` exists to carry the number, and the counts read alone the
way a group summary's entries do. The nouns follow the count (`1 tool call`,
`1 file changed`).

**Their words.** `text-xs`; the duration is `tabular-nums`. The time is
`formatElapsed`, the turn clock's format: `48s`, `2m 13s`, `1h 12m`, so the
clock it settles from and the figure it settles into read alike
([turn-progress-ui.md](turn-progress-ui.md#the-rules), *times have one
format*).

**Two places.**

- **The card's header**, when the turn changed files: the header row —
  `min-h-9`, `FileDiff` in the chevron's column, not a button — with the
  figures as its title, the entries in `text-th-text-secondary` and the `·` in
  `text-th-text-muted`.
- **The turn-end row**, when it did not: after the `Message actions` group,
  `ml-auto`, so their right edge is the text column's (no negative margin on
  that side, unlike the icons'), vertically centred in the row's `min-h-9` /
  coarse `min-h-11`. All `text-th-text-muted`, without the icons' `opacity-60`:
  they are text, not a control, and do not brighten on hover. They come in with
  the row, by the same `animate-message-menu-in`. Outside the group, because
  they are not an action; to assistive technology a line of text, the visible
  words `aria-hidden` beside an `sr-only` sentence — the one a card's header is
  named by, *"Worked 48 seconds, 6 tool calls"*. Not drawn when the turn
  changed files (the card has them), while an agents chip holds the row's
  right end (above), when the count may have been cut (`calls` undefined: alone it would
  claim a size it does not know), or when there is no row at all — no text to
  copy and a session that cannot fork, which for a turn that ended on a call is
  rare.

Otherwise every turn that made calls has its size at its bottom edge, in one
of two places a glance down finds: the card's header, or the turn-end row. The time is
the one figure the rows above do not already give — group summaries say what
was done, not how long it took — and on a phone the turn-end row is two 44px
buttons and about 280px of nothing, where `Worked 12m 40s · 124 calls` takes
about 170.

**In a narrow column.** Where the box they sit in is narrower than `30rem`
(`--container-work-line`) the nouns shorten — `14 calls`, `3 files` — because
there the full header and its totals do not fit (`Worked 2m 13s · 14 tool
calls · 3 files changed  +11 −2` is wider than a 375px phone's column at
`text-xs`). It is a container query, not a viewport tier: the reading column is
narrower than the window beside a sidebar, and narrower still under an
extension's avatar. The container is the card's header, or the whole turn-end
row — not the figures' own box, which is sized by its content and so cannot be
a size container. Shortening keeps every entry; cutting the end, as a group
summary does, would cut the file count of a card about files. A files entry
standing alone — the cut-history case — always reads in full, `2 files
changed`: shortening is there to fit three entries, and `2 files` alone reads
as a fragment. The accessible sentence is the full one at every width. Past
that the words truncate at their end, and the totals never move.

**They are not a button and fold nothing.** The rows above stay exactly as
they are: groups fold by [their own rules](#groups) and nothing else, and no
part of the turn is put away behind the figures. Folding a whole turn behind
its summary is what makes long chats in comparable products a turn-by-turn
re-opening, with the diffs and pages the reader came for hidden in each — the
figures exist to say a turn's size, not to make it shorter to look at.

#### Where the duration comes from

**A number is shown only when it was measured**
([turn-progress-ui.md](turn-progress-ui.md#the-rules)), so the span is the
difference of two moments the server stamped as they happened, stored on the
records that open and end a reply — the same `observed_at` a tool row's
duration is read from
([tool-call-model.md](tool-call-model.md#observed-times-and-reported-durations)).
The client never measures it and never estimates it from when records reached
it.

| Moment | Record | Its `observed_at` |
|---|---|---|
| a reply that opened its turn begins | the `message` record that opened the turn — a send, a scheduled prompt, a page's action, a command | the moment the send reached Pockode, minted once and used twice: stamped on the record, and handed to the process as the prompt's moment, so `TurnState.OpenedAt` is that same instant whenever the message opens the turn — the tail line's `Working 2m 12s` and this `Worked 2m 13s` count from one start, retries after a replaced process included. Every `message` record carries it; the client reads it as a start only for a message that opened a reply — the reducer's *nothing running, so the message opens a turn* branch |
| a reply opened by [a read point](code/agent-integration.md#the-read-point) begins | its `message_ingested` | when Pockode wrote it: codex's echo, or Claude's delivery — as exact as the read point itself |
| a reply split off by a read point ends | the next `message_ingested` | the same moment, so the two replies' spans meet and add up to the turn's |
| the reply that ended the turn ends | the turn's `done`, `interrupted`, `process_ended` or `error` | when Pockode saw it |

Which records are stamped where is in
[agent-integration.md](code/agent-integration.md#eventrecord-unified-event-format) (the server
side) and [frontend-state.md](code/frontend-state.md#times-on-a-reply) (how the
reducer carries the two moments onto the assistant message — history, the way
a run's `startedAt` and `endedAt` are, not live state). One piece of it is
the design's own: the tab that sent the message never receives its record —
the server leaves the sender out of the broadcast — so the same moment comes
back on the send's answer (`rpc.MessageResult`'s `observed_at`), or the device
the user typed on would draw no `Worked` until a reload. The figure is derived
beside `turnChanges`, a pure function of the message: `turnWork`
(`lib/turnWork.ts`), which also counts the calls and says whether the reply
made any.

**Not measured, so not shown** — the figures are drawn without their duration:

- **Every reply recorded before these stamps.** Older `message`,
  `message_ingested` and `error` records carry no moment, so those turns draw
  `14 tool calls · …`. A reload does not lose the figure on a newer turn: both
  moments are stored.
- **A reply that opened without a message** — output the CLI resumed by
  itself, or an answer to a permission card that outlived its turn
  (`openedByCard`) — has no start. The reducer knows it: no `message` record
  and no read point came between the previous ending and the reply.
- **The top of the loaded history.** A page boundary can cut a reply, so the
  oldest loaded bubble may be the back half of one, with no opening record
  ([`prependHistoryPage`](agent-chat.md#history-paging)). Its count would be of
  half the calls, so the card's header shows only what the card already does —
  `N files changed`, of the loaded half — and the turn-end row, which would have
  nothing else to say, shows nothing; both gain the other entries when the
  older page joins it.
- **A `process_ended` a restarted server wrote** for a run nobody saw end, which
  carries no moment.
- **Under 1s.** A turn with a call in it rarely is; `Worked 0s` would be noise.

**What it includes** is everything between the two moments — thinking, calls,
writing the answer, and any wait inside the turn: a permission card the user
took ten minutes over, a background task the turn waited on. That is the span
the tail line's clock counts across a block
([turn-progress-ui.md §2.2](turn-progress-ui.md#22-when-it-shows)), so the two
agree. Taking the waits out would need when each wait began, and a
`permission_request` carries no moment ([not
done](#what-the-work-figures-leave-out)).

**At a read point the two clocks measure different things.** The tail line
counts the *turn* and goes on unchanged into the reply a read point opens
([turn-progress-ui.md §2.1](turn-progress-ui.md#21-where-it-is)); each reply's
work figures count *that reply's* span. So the second reply of a five-minute turn
split at the third minute settles into `Worked 2m 0s`, under a tail line that
said `Working 5m 0s`. That is deliberate: the tail is the pulse of what Stop would stop,
and the work figures are the size of the work above them, which for the second reply
is only what came after the read point. The replies' figures add up to the
turn's.

### From a file to the calls that changed it

```
│ ⌄  deliver.ts  src/webhooks/sender                   +7  −2  │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ src/webhooks/sender/deliver.ts                     Open  │ │
│ │ 1 · Edit        +5 −2      Go to call  [wrap] ⧉ ⤢        │ │
│ │ …diff…                                                   │ │
│ │ 2 · Edit        +2         Go to call  [wrap] ⧉          │ │
│ │ …diff…                                                   │ │
│ └──────────────────────────────────────────────────────────┘ │
```

**Each change in an open file row carries `Go to call`** in its section's
header — first in `Section`'s `actions`, ahead of the wrap switch
`proposedChangeHeader` puts there, so before the wrap switch, copy and the ⤢
a cut block adds:
a text button in `text-th-accent` with a `touch-target` hit area, like
`PathLine`'s *Open*. One per change, because each change is one call: a file
edited three times has three, each to its own call; changes one call made —
a Codex call that changed several files, in each of their rows, or one listing
a path twice — all go to the same row. It is not on
the file row: a row stands for every change to its file, so it has no one call
to go to, and its tap already opens it. A word, not an arrow: beside a diff an
arrow reads as scroll or fold, and with [nothing behind
hover](#the-rules) there is no tooltip to say otherwise.

**It is the transcript's jump** — the one `MessageList` owns for a permission
card ([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)),
taught to take a tool row by its `tool_use_id` rather than re-implemented: the
transcript's own container scrolls so the row's top lands just under every
bar pinned above it — the open subagent row the reveal just opened pins its own
bar at the top, and a row landed at the container's top would be under it. The
offset is the row's computed `scroll-margin-top`, which `index.css` already
sets under a `.row-bar` for exactly this, and which the jump reads for every
target (`useTranscriptScroll`'s `jumpTo`). The row takes the jump highlight, and
focus moves to the row's button. Tool rows gain a `data-tool-use-id` to be
found by, as a card is by `data-permission-request-id`. The highlight is the
same inset ring in `th-accent`, not the card's `th-warning`: a permission card
is waiting on the reader, a row they went to is not, and warning on a
successful call would read as a problem. The fading transition the stylesheet
declares on permission cards alone is declared on tool rows too, or the ring
would snap out. It
moves the view instantly, as every move the list makes does
([agent-chat.md](agent-chat.md#where-the-view-sits)), and leaves the reader
anchored on the row.

**What hides the row is opened first**, outermost first: the group it is folded
into, and for a subagent's step the subagent's row, its Process, and the group
inside that — at every depth, a subagent inside a subagent included. Each of
those is local state today (`RowList`'s open groups, `TaskItem`'s row and
Process), and a body never opened is not mounted at all (`CollapsibleBody`), so
there is no row to find until they open. So the jump is two-phase: the press
raises a *reveal* request for the `tool_use_id` through `ToolJumpContext`, which
`MessageList` provides beside the view context (not in it: `TranscriptView` is
the shape `ui`'s clamp takes, and a request would redraw every block that reads
it); every `RowList` and `TaskItem` on the path to it — each asks
`findToolRunPath` whether the call is under what it holds — opens what it
holds during that render (`useRevealRequest`), setting the same state the
user's tap sets, so a body this mounts takes the same request in the same
commit; and once that commit has landed the jump finds the row and moves. Opened this way they stay open until the user closes them, under the
list's rule that nothing folds what the user opened — the press was the
user's. **The row itself is not
opened.** Its body is the diff the reader just came from; what they went for is
what is around it — the read before it, the test after it.

**It never leaves the turn.** Only the turn's own calls are listed, and its
calls are in the same message as its card, so the row is loaded whenever the
card is ([history paging](agent-chat.md#history-paging) cannot have dropped
it), and it is always above.

**Coming back is scrolling down.** The file row stays open — only the user
closes it — and the card is under the work the reader jumped into, past the
answer at the turn's end; the scroll-to-bottom button is there when the turn is
the last. There is no *Back to changes*: a return point is a second scroll position
to keep true while the transcript grows and pages land above it, for a distance
that is rarely long.

**Every pointer alike.** The button is the same on touch and mouse, and nothing
about it is behind hover. On a phone the header has room for it: the section's
label gives way first, and the actions never move.

**Accessibility.** The button's name says which call, and starts with its
visible words so a voice command by them finds it (WCAG 2.5.3): *"Go to call
that made this change"* for a file changed once, *"Go to call 2 · Edit"* when
its changes are numbered. The jump moves focus to the row, whose own name is read; there is
no live announcement on top of it.

### What the work figures leave out

On purpose:

- **Folding the turn behind its figures**, or making them a button at all
  ([above](#the-work-figures)).
- **A divider between the work and the answer.** The figures sit at the turn's
  end, in the card's header or the turn-end row; a row of their own between the
  calls and the answer would be one more row per turn on a phone, for a
  boundary the answer's own text already makes.
- **Figures on a reply with no tool call**, or on the reply the turn is still
  writing — the tail line owns the running turn ([turn-progress-ui.md
  §5](turn-progress-ui.md#5-what-it-does-not-say)).
- **Taking waits out of `Worked`.** It would need a moment on
  `permission_request`, and a figure that is the turn's span is the one that
  agrees with the clock the reader watched.
- **A sum of the calls' durations.** Calls run in parallel and subagents
  overlap their parent; a sum would be a number of no span anyone lived through.
- **Counting a subagent's steps, or failed calls apart.** The rows say which
  failed, in red; the figures are the turn's size, not its health.
- **A way back from the row to the card**, a *Go to call* in the full-screen
  viewer, and a link from a tool row to its file in the card. Each is a second
  route to a place a scroll reaches.

## The row

```
┌─────────────────────────────────────────────────────────────┐
│ ›  ⟳  Bash   npm run build --workspace=@pockode/sh…  1m 04s │
│       vite v7.1.14 building for production…                 │
│ ›  ✓  Edit   …/Chat/ToolCallItem.tsx          +12 −3   1.2s │
│ ›  ✕  Bash   pnpm test --filter web           exit 1    14s │
└─────────────────────────────────────────────────────────────┘
  ^  ^  ^      ^                                ^           ^
  │  │  │      └ detail (truncates)             │           │
  │  │  │                                       └ figure: counts or exit
  │  │  │                                                   └ time   (figure + time: meta)
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
        <span className="shrink-0 text-th-accent">{title}</span>   {/* a subagent's: `agent`, below */}
        {chip && <Chip>{chip}</Chip>}        {/* MCP server, pockode */}
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

The chip is the same shape an MCP server or `background` wears, and lives in
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
own. In the row's place it also takes the row's part id, so the row's place
keeps its key ([what a list is keyed by](#what-a-list-and-a-group-are-keyed-by)).
Before this, the card was appended beside the row, so the same call was in the
list twice.
Adding a spinner to that first row is what turned the duplication from untidy
into false — it would say the machine is busy while the machine is waiting for
the user. The precedent was already in the reducer, one case away:
`ask_user_question` — the CLI's own question, now read from old transcripts
only — finds the `tool_call` part with its `toolUseId` and takes its place,
because "all three describe one tool use". `permission_request` carries
`toolUseId` for exactly the same join. Generalising it removed the duplicate rows.

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
keeps the tint. Once answered it is an ordinary row: no tint, a body on
`bg-th-bg-secondary` like a tool row's, and a glyph as muted as a settled
row's — `Check` for an allow, `X` for a deny, whoever answered. An answer is
not an event. A session can hold dozens of approved cards, and a green tick on
each would do what it did on the success rows: draw the eye away from the
calls that failed. A deny is a decision, not a failure, and what the engine
reports about the refused call afterwards is a settled run of its own (below).
A red `X` on the card would say "refused" a second time, in the colour that
means "failed". Shape tells allow from deny, and the verdict line says who and
why. A request the permission reviewer is
answering is the exception while pending: it waits on nobody, so it keeps the
frame (neutral, `outline-th-border`) without the tint, folds, and no button is
the accent. A verdict line under the row says who answered in the user's place.
Both are [unattended-mode-ui.md §3](unattended-mode-ui.md#3-the-permission-card).

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
| `Read` / `Write` / `Edit` / `MultiEdit` / `LS` | the name | the path relative to the work directory, split so the file name survives | **left** |
| `Grep` | `Grep` | `"pattern"` + ` in <path>` when scoped — the path relative to the work directory when inside it, and no ` in …` at all when it *is* the work directory | right |
| `Glob` | `Glob` | the pattern | right |
| `WebFetch` / `WebSearch` | the name | host + path / the query | right |
| `TodoWrite` | `TodoWrite` | `n done / m` | — |
| `Plan` (a Codex `plan` record, [turn-progress-ui.md §4.6](turn-progress-ui.md#46-the-plan-record)) | `Plan` | `n done / m` | — |
| `Task` / `Agent` (the CLI renamed it; history holds both) | the agent: `subagent_type`, a Codex spawn's agent name, else `Subagent` — led by an agent mark, capped at 45% | `description`, else the prompt's first line ([below](#line-1-the-agent-then-what-it-was-asked)) | right |
| `TaskOutput` | `TaskOutput` | the `task_id`, in mono | right |
| `BashOutput` (history only) | `BashOutput` | the `bash_id`, in mono | right |
| `TaskStop` / `KillShell` | the name | the `task_id` (`shell_id` on the old name), in mono | right |
| `NotebookEdit` | `NotebookEdit`, then an `insert` or `delete` chip when `edit_mode` is one | the `notebook_path`, split as a file tool's is | **left** |
| `GenerateImage` (Codex) | `GenerateImage` | the input's prompt, first line — none on codex-cli 0.171.0, whose start names no prompt; the row is named by the image under it instead, and the prompt is in the body ([tool-call-model.md](tool-call-model.md#codex-items-beyond-commands-patches-and-mcp)) | right |
| `Sleep` (Codex) | `Sleep` | — (the duration is the meta) | — |
| `AgentControl` (Codex) | the action: `Wait`, `Send input`, `Message`, `Follow up`, `Resume`, `Interrupt`, `Close`, `List agents` — led by the agent mark | the agents, each by its path's last segment, `, `-joined; one whose spawn named no path is only counted (`file_reader +1`, or `2 agents`) | right |
| a Pockode work tool | [its own table](#pockodes-own-work-calls) | | |
| `server:tool` (Codex MCP) or `mcp__server__tool` (Claude MCP) | the tool half | the server half as a chip, then the first scalar argument, else compact JSON | right |
| `html_render` (Pockode's own MCP tool), while it is a row | `html_render` | `pockode` as a chip, then the `title` — never the first argument, which is as often the whole page | right |
| `html_edit`, while it is a row | `html_edit` | `pockode` as a chip, then `<title> · from <base>`, or `from <base>` without a title | right |
| `html_get` | `html_get` | `pockode` as a chip, then the `id` | right |
| anything else | the name | first non-empty scalar in `input` | right |

Eight decisions inside that table:

- **`TaskOutput` is in the table although many of them never draw a row.** A
  fetch of a task's output is filed under the call it reads and takes no row at
  all whenever that call is loaded ([below](#a-fetch-reads-on-the-row-it-came-from));
  the row is what is left otherwise, which on a transcript long enough to page
  is common rather than exceptional. The fallback happens to name the same field
  today — `task_id` is the first string in the input — but by the order
  `Object.values` returns rather than by any rule, so one more string in the
  input would silently rename the row. Mono because a task id is a machine key,
  not prose.
- **The remaining kinds get a row each, and only the ones that need it get a
  row of their own design** ([below](#the-remaining-tool-kinds)). `TaskStop`
  and `BashOutput` are named by their key for the reason `TaskOutput` is; a
  `NotebookEdit` reads like the file tool it is, while its body is its own.
  The mode is a chip because `insert` and `delete` change what the row means
  and `replace`, the default, does not.
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
- **A file tool is known by its name, not by a `path` field.** Only the tools in
  the path row above are read by `file_path`, then `path` (`fileToolPath`,
  `lib/toolSummary.ts`). `toolSummary` and the body's `invocationView` both go
  through it, so the title and the body cannot disagree about which calls are
  file calls. The field used to decide it. Then an MCP tool that takes a
  `path`, such as `mcp__fs__read_file`, was drawn as a file. Its whole machine
  name sat in the never-truncating title, and its body was a path line that
  left out every other argument, which broke
  [everything the row truncates is in the body](#the-rules). Such a call is now
  an MCP row, and an unknown tool with a `file_path` is an "anything else" row.
  The body of either lists every argument, the path among them. `NotebookEdit`
  is not in the set: its input is the cell it writes, and a path line would
  hide it.
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

   **Rung 1b**: a **fetch of this run in flight** —
   `Waiting for output… 12s`, and what it settles into
   ([a fetch in flight](#a-fetch-in-flight)). Prose. Above the fetched line
   because it is the newer word: a reading is being taken now. Below the
   activity because the activity is the task's own account of the present,
   and on a row that has one the reader already sees something move.
2. the **last non-empty line** of this call's machine output, from either of two
   sources: the newest **fetch** of it that came back with something
   ([below](#a-fetch-reads-on-the-row-it-came-from)) — read out of the envelope
   the fetch carries it in, see there — and failing that `run.output` — Codex's
   `commandExecution/outputDelta`. Literal output either way, so mono.
3. for a settled `fromBackground` run, the first line of the outcome. Prose.
   Claude's own notification sentence, `Background command "<description>"
   <outcome>`, is cut to its outcome and capitalised — `Completed (exit code
   0)`; any other phrasing is shown as it came, and the body's *Outcome* keeps
   the whole sentence. A run the process took down before any outcome came
   (`lostWithProcess`) has none to show, so it reads **"Stopped when the CLI
   process ended"** — prose, not live — until the `background_lost` text
   arrives and takes the rung like any other outcome.
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
([agent-chat.md](agent-chat.md#where-the-view-sits)), without a write that
could cut a flick short — but everything above the change moves on the screen
whatever is done about the reader. A row that keeps one height asks for none of that.

For a foreground run that cost lands nowhere: the turn is blocked on it, so
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
height there. The cost is the row that has neither: it grows from no line to one
when its outcome arrives — or when the process ends live under it and rung 3's
*Stopped when the CLI process ended* takes the slot. A row that was showing live
activity keeps its height either way.

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
fetched of the work, then how it ended. It is not made a clock: only the
records that bound a call carry an observed time
([tool-call-model.md](tool-call-model.md#observed-times-and-reported-durations)),
a `ToolFetch` keeps none, and every record from before the stamps has none, so a
heading claiming a time would be inventing one. It is also the true order in
all but the contrived case of a fetch made after the notification arrived.

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

**When the work died with the process.** A background task dies with the CLI
process, and the row settles the moment the process ends — `interrupted`, chip
kept, `lostWithProcess` set, and rung 3's *Stopped when the CLI process ended* as
its second line ([code/frontend-state.md](code/frontend-state.md#tool-runs)). The
outcome Pockode writes for it, delivered at the next session start, carries
`background_lost` ([tool-call-model.md](tool-call-model.md#a-third-subtype-with-a-different-author)),
and is the explanation arriving rather than the row becoming true: its text
takes the second line and the *Outcome · after the turn* block, and the glyph
stays the interrupt's (`error` only where the client has no `process_ended` for
it). What must not happen is for it to land in the *Returned to the agent* block,
or in a plain `Result` block: the agent never read it, and no CLI ever said it.
Nor does the row say *Returned after the turn was interrupted*, which an
interrupted run with a result otherwise says: nothing returned. A subagent lost
this way with nothing reported says *The CLI process ended before the subagent
reported anything*. The record's own text names its author, so a reader of the
transcript is told where the claim came from and not only that the work ended.

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

#### A fetch in flight

`TaskOutput` blocks for 30 seconds by default, and a
fetch filed under its origin draws no row, so for those seconds nothing in the
transcript said what the agent was doing: the tail line read `Working`, the
origin row — often screens above — was unchanged, and the message the fetch
came in had nothing to draw. This used to be accepted, on the grounds that the
row's status is the task's and painting another call's progress on it is an
inference. The inference was never the problem; the missing statement was. The
fetch is a call of its own with a state of its own (`ToolFetch.state`,
[tool-call-model.md](tool-call-model.md#a-call-about-an-earlier-call)), and it
can be shown **as the fetch** without touching what the row says about the
task:

```
│ ⟳  Bash  pnpm dev                     [background]   4m 12s │
│        Waiting for output… 12s                               │  ← the fetch's own line
…
⟳ Waiting for output… 1m 4s · Go to call                         ← the tail line
```

**On the row it reads, a line of its own.** While a fetch of the run is
`running`, the second line reads `Waiting for output…` — `Reading output…` for a
fetch whose input does not wait (`block: false`) — then `·` and the fetch's
own counter, from its `seenAt`, at the tool counter's format and only from 3s.
Prose, muted, `aria-hidden` as every moving line is. It is a rung of [the second
line](#the-second-line-problem-1), between the activity and the fetched line.
What it does not do is the rule above, unchanged: the glyph, the chip, the tint
and the meta's time stay the task's — no second spinner, nothing red, nothing
settled.

**When it returns, the rung hands over in place**, so the row keeps its height:
to the fetched line (rung 2) when the fetch brought output; to the line that was
there before when it brought nothing or failed and an earlier fetch had shown a
line; and, on a row that had no line before, to a settled `No output yet` (came
back empty), `Couldn't read output` (the fetch failed — muted, not red, for the
reason a failed fetch is not red anywhere) or `Output not read` (interrupted).
Those three are prose and stay in the row's name, like the background outcome.
The last of them is what makes the rule hold that a second line [appears at most
once](#the-second-line-problem-1): a line a fetch opened is not taken away by
the fetch ending. The word is read off the newest fetch, the one whose line the
row was showing, and an answer whose envelope carries no output counts as empty
— on the row, where the task's latest word is meant; the body still draws the
envelope as it came. All of this is `toolSecondLine` (`lib/toolRun.ts`); the
counter is the row's own `ElapsedCounter`, from `ToolSecondLine.since`.

**In the body, the fetch's block is drawn while it runs**: its heading
`Fetched output · waiting…` (or `Fetch 3 · waiting…` from two), its content the
muted line *Waiting for the task's output.* Once it returns it is drawn as the
table above says. An `interrupted` fetch has no block, as before — "never came
back" is still nothing to draw — unless its result arrived after all, which is
drawn like any returned one.

**At the tail, the tail line says it**, because the reader is there and the row
usually is not. While the main agent's newest call is a filed fetch still
`running`, [the tail line](turn-progress-ui.md#23-what-it-says) reads `Waiting
for output…` with the turn clock, and after it a `Go to call` that is the
transcript's [jump](#from-a-file-to-the-calls-that-changed-it) to the row the
fetch is filed under. It names no call and no command — the line's rule — and
says only what the turn is doing, which is waiting. A fetch with a row of its
own needs none of this: it is a running row at the tail, with its spinner and
its counter, like any other call.

A message whose only part was the filed fetch still has nothing to draw once the
turn closes, and is still dropped then, the same as any turn that never got a
first token.

The fetch's own invocation — `block`, `timeout` — is drawn nowhere. It is how the
reading was taken, not part of what the task produced, and the `task_id` is
already this row's identity. The fetched text is not truncated either: the 50-line
cap on live output exists because that block is redrawn as the output moves, and
a fetch is one record that the CLI has already cut to its own limit.

## Elapsed and duration (meta)

Right-aligned, `shrink-0`, `text-th-text-muted`, after the detail — on a tool
row, a subagent row (the `1m 12s` in [the subagent body](#the-subagent-body))
and a running group's summary alike, because all three draw `ToolMeta`. It
holds two things, in this order: **what the call measured** — an edit's line
counts or a command's exit code, [below](#what-the-call-measured) — and then
**its time**, a finished run's duration or a live run's elapsed counter. They
are `gap-2` apart, with no `·` between them, as in `proposedChangeHeader`. The
time comes last so that the times of a stack of rows stay in one column.
Neither one is ever truncated; the detail gives way. On a 375px row that still
leaves the file name: the widest figure, `+1234 −567`, is about ten
characters, and the detail's own rules (left truncation, the 70% cap on the
name) handle the rest. No breakpoint is added for it.

### Where a figure comes from

**A number is shown only when it was measured**, and there are two
measurements, tried in this order:

1. **What the engine reported.** Codex's `durationMs` on a command or an MCP
   call, and Claude's for a subagent, `WebFetch` and `WebSearch`, and for
   backgrounded work's outcome
   ([agent-integration.md](code/agent-integration.md#eventrecord-unified-event-format)). It wins
   whenever it exists: it is the engine timing its own work, and it leaves out
   whatever happened around the call.
2. **What Pockode observed.** The server stamps the moment it saw each record
   come off the CLI (`observed_at`); the run's duration is `endedAt −
   startedAt`
   ([tool-call-model.md](tool-call-model.md#observed-times-and-reported-durations)
   defines both). Both ends
   are the server's clock, so the figure is the same live, on reload and a
   year later, and the phone's clock never enters it.

There is no third. A run with neither gets no figure — every record written
before the timestamps existed, and every codex call that reported none and
predates them. Nothing is ever estimated from when the *client* received a
record.

**Which moments count** is the model's definition of `startedAt` and `endedAt`
([tool-call-model.md](tool-call-model.md#observed-times-and-reported-durations)):
from the call, or from the permission answer that let it run, to the result that
settles it — for a [backgrounded](#when-a-background-run-finishes) call the
outcome, never the placeholder, which only says the call went to the background.

The permission rule is what keeps the number about the tool: Claude sends the
call before it asks, so a `ls` the user took two minutes to approve would
otherwise read `2m 3s`. The wait is the user's time, already on the card. An
answer from the permission reviewer counts the same as the user's. A call that
waited on a card whose answer carries no observed time has no observed start,
and so no observed figure: one that counts the wait would be wrong by exactly
the part the reader cannot see.

**The two are not told apart on screen.** Both measure the same span, from
the call to its result; the observed one also takes in the CLI's own handling on
either side of it — reading the call, writing the result line — which is not a
difference a reader would act on. A mark beside one source would ask them to
weigh it anyway, and on a phone a tooltip explaining it could not be opened. The distinction is kept in
the model — the engine's figure and the observed times are separate fields,
and the precedence above is the reducer's, not the row's — so a later feature
that needs to know can, and nobody reading the record mistakes Pockode's
reading for the CLI's report.

### Finished run

- Shown on any settled run that has an end to measure to — `success` and
  `error` alike: a call that failed still took that long.
- **An `interrupted` run normally has none.** Its end is not a result but the
  turn's or the process's: the `interrupted`, `done` and `process_ended`
  records, and a `background_lost`, say when Pockode *gave up* on the call, not
  when it ended, so they are never a run's end. A number there would read as how
  long it took to do something it never did. The exception is a result that
  outlived the interrupt: the run stays `interrupted`, but the call did finish,
  and its duration — reported or observed — is shown as on any other row. That
  is what a codex row already does with its `durationMs`.
- Hidden under 1s; a `Read` that took 40ms does not need a number. Most Claude
  rows will therefore still have none — the change shows on the calls that took
  long enough to wonder about.
- Format: `formatDuration` — `1.2s`, `47s`, `4m 12s`, `1h 12m`.

### Live run

A counter of how long the run has been going, on `running` and `background`
alike (a backgrounded call has not finished; its counter keeps going until its
outcome arrives and the duration takes its place).

- **It counts from the same start as the finished figure**, so the counter and
  the duration that replaces it agree — and a call rebuilt under its answered
  permission card now gets a clock from the answer, where it had none.
- **It does not depend on the phone's clock agreeing with the server's**, the
  same rule as the turn clock
  ([turn-progress-ui.md §2.3](turn-progress-ui.md#23-what-it-says)). A start the client saw
  arrive live is counted from when it arrived (`seenAt`), which is that moment
  on the client's own clock. A start known only from history is a server time;
  it is counted from the server's clock reading sent with that history, and the
  client counts on from when it received the reading. Without a reading, a
  replayed running row has no counter, as today — subtracting a server time from
  the phone's clock would show minutes of drift as minutes of work.
- So a reload, a reconnect and a second device all show the clock the first
  screen would have shown. A running subagent row replayed after a reload is
  the case this was missing most: it is the row most likely to be running long
  enough to reload over.
- It appears once the run has been going 3s — by its start, not by when this
  screen drew it, so a row replayed four minutes into a run shows `4m 0s` at
  once rather than nothing for three seconds.
- It ticks every second at every length, and on the same tick as every other
  elapsed clock on screen — the turn clock and the other live counters
  (`useElapsedMs`, one interval for all of them). A clock that prints seconds
  and ticks once a minute sits on `3m 0s` beside a tail line reading `3m 17s`;
  clocks with intervals of their own change their seconds out of step with each
  other. Format `formatElapsed` — whole seconds below a minute (`12s`), then
  `formatDuration`'s two units — and `tabular-nums`, like the turn clock.
- It is its own component, so the tick re-renders the counter and not the row.
  At most a handful of runs are live at once.
- Whether a run is live is still its status, never its clock. A run left
  `running` by a turn that ended is settled to `interrupted` by the reducer
  (and a dangling turn by [lifecycle-ui.md
  §2.4](lifecycle-ui.md#24-recovering-a-dangling-turn-after-a-restart)), so a
  year-old transcript still draws no stopwatches. A background task that
  really is still going after a day reads `26h 4m`: that is true, and the row
  is the place it should be noticed.

### Subagent rows and the rows inside them

A subagent row's figure is its call's, by the rules above: from the `Task` /
`Agent` call to its result, or to its outcome when it ran in the background — how
long the subagent worked, not how long the main agent waited for a placeholder.
A duration the CLI reports for the subagent wins, as everywhere. Its second line
(the report and tokens, or the latest child) never carries it: the figure
stays on line 1 ([why](#line-2-once-settled-the-count-the-report-the-tokens)).
A running step in its [step window](#the-step-window) carries its own counter, derived as that
child's row derives it; a settled step there carries none.

The rows in its Process follow the same rules with no exception: their records
are observed as the subagent's lines arrive. Where a subagent's frames reach the
stream only in one burst at the end, a child's call and result are observed
together, and its duration falls under the 1s floor and is not drawn — which is
the right outcome for a figure that would otherwise be a fraction of the truth.

A settled group's summary shows no total. Only a running group draws a figure,
its current call's counter, as before. How long the turn worked is [the work
figures](#the-work-figures)', which measures the reply's span rather than summing
calls.

### Edge cases

| Case | Figure |
|---|---|
| engine reported a duration | that, on a finished run |
| finished, both ends observed, ≥ 1s | the observed duration |
| finished in under 1s, either source | none |
| either end not observed (records from before the timestamps) | none — drawn exactly as today |
| waited on a permission card | from the answer, not from the call |
| waited on a permission card whose answer has no observed time | none, unless the engine reported one |
| interrupted, or its background work was lost with the process | none |
| interrupted, but its result arrived afterwards | that result's duration |
| live, start seen arriving on this screen | counter from `seenAt` |
| live, start known only from history, server clock reading present | counter from the observed start, on the server's clock |
| live, start known only from history, no reading | none |
| backgrounded, outcome not in yet | counter, still going |
| backgrounded, outcome in | duration from the call to the outcome |

### What the call measured

At most one figure, before the time, in `font-mono tabular-nums` and muted. A
`Bash` call has no counts and an edit has no exit code, so the two never meet
(`ToolOutcomeFigure`, `ToolRow.tsx`).

```
›  ✓  Edit   …/Chat/ToolCallItem.tsx        +12 −3   1.2s
›  ✓  Write  …/lib/newThing.ts              +48
›  ✕  Bash   pnpm test --filter web          exit 1   14s
```

**An edit's line counts**, `+N −M`, on `Edit`, `MultiEdit`, `Write` and a
Codex file change:

- **The same number as the body's *Change* header.** It is `callLines`
  (`lib/turnChanges.ts`), the turn's changes card's own count of one call
  ([how it is read](#the-turns-changes)), and for a diff that is the patch the
  body draws. The row sits directly above that header and is read against it.
  There used to be two counts. The tally diffed the fragments closed with a
  newline. The body diffed them unclosed, so appending a line to `a` was drawn
  as `-a +a +b` (+2 −1) with a false `\ No newline at end of file`, while the
  tally counted +1. Now the patch itself is built from the closed fragments,
  and both counts read that patch.
- **A `Write` is `+N` and nothing else.** That is the turn's changes card's
  rule. A new file is content, not a diff. When it overwrote a file, nothing
  says what was removed, so no `−` is drawn. The row carries no `new` or
  `rewritten` chip. The chip slot is for facts about the call itself, like an
  MCP server or `background`. Whether the file was new is already said by the
  body's *Content* and by the turn's changes card.
- **Only on `success`.** A failed change changed nothing, which is the turn's
  tally's rule too. Its body still has the muted counts beside `not applied`.
  An `interrupted` one may or may not have changed anything, and a running one
  has not yet. A pending permission card's row has no counts either: the
  change has not run, and the card's *Proposed change* header has them.
- A zero side is left out (`+3`, `−7`), and when both sides are zero nothing is
  drawn: `LineCountsLabel` again, with `colored={false}`. An `sr-only` "lines"
  goes in front of the counts, so a screen reader reads "lines +12 −3".
- **Muted, never green and red.** The turn's changes card colours its counts
  only because it is "not in a stack of tool rows where red could read as a
  failed call". A row is in exactly that stack. A red `−3` on every `Edit` row
  would cost the failed rows their red. The coloured counts stay in the body's
  header, one tap away.

**A command's exit code**, `exit N`, whenever one other than `0` was measured,
whatever the status. Negative codes and signal codes are drawn as they came
(`exit -1`, `exit 137`). `0` and "unknown" draw nothing. Codex reports the code
as a figure. Claude writes it as the failed `Bash` result's first line, and the
adapter parses that
([agent-integration.md](code/agent-integration.md#eventrecord-unified-event-format)).
An engine that reports a code also fails the call for it, so in practice the
code appears only on red rows. Rows that succeeded never show one, even though
no rule here checks the status.

- **On the row, not in the body.** This used to be the other way round, and the
  argument was that the glyph had already said the call failed. But the glyph
  says only *that* it failed. The code says *how*: `exit 137` (killed) and
  `exit 1` are different failures. A reader should not have to open the row to
  tell them apart. The body no longer ends with an `Exit code N` paragraph. Once
  the row is open, it is the sticky bar and its meta stays in view, so the
  paragraph only repeated it. Claude's own `Exit code N` line stays verbatim at
  the top of the *Output*.
- **`exit 1`, not `Exit code 1`.** The row is short of room, and the longer form
  would repeat word for word the first line of a Claude output.
- **Muted, not red.** A failed row is already red in three places: the tint, the
  `X` and the detail. The [second line](#the-second-line-problem-1) already
  turned down a fourth, and the same reason holds here. The second line says
  why the call failed, and the code says how, so the two do not repeat each
  other.

## The body (problems 2 and 3)

One `CollapsibleBody` → one padded block, with **no height and no scroller of
its own**. It used to be a `max-h-[60vh]` box scrolling on its own, and on a phone that
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

### One vertical scroll surface

The reason reaches past tool rows, so the rule does too: **the transcript is the
only thing in it that scrolls vertically.** Every tall block in it is clamped
the same way — a thought's text, a system, raw, command-output or work-event
message, a question record — where each used to be a `max-h-[60vh]` box
scrolling on its own. Besides the drag under the thumb, a box like that had two
places of its own to keep — its scroll position and the reader's place inside it
— that the transcript's [anchor](agent-chat.md#where-the-view-sits) could not
see, and that a pinned section header had to be taught to stick to. With none
left, the anchor reaches every block and holds it; overlays, the input bar and
the viewer are not the transcript and keep their own scroll. A new block that
runs long is a clamp, not a box.

### Budgets

A flat clamp had no notion of a body's total: a long command over long output
was two full clamps, more than a phone's whole transcript, while on a landscape
phone one clamp alone was taller than the transcript. So a section's height is
set by its **role** (`budget` on `Section`), in lines of the body's `text-xs`,
which are `1rem`:

| Role | Budget | Sections |
|---|---|---|
| main | `clamp(8 lines, 45% of the transcript, cap)` — cap 20 lines on a coarse primary pointer, 30 otherwise | Output, Content, Change, Matches, Results, Page, Result, *Outcome · after the turn*, *Output so far*, the `ExitPlanMode` plan, a permission card's *Proposed change*, a file's diff in [the turn's changes](#the-turns-changes), a subagent's report, a thought's text and its *Full reasoning*, a command's *Sent to the agent*, the body of a system, raw, command-output or work-event message, a question record's body |
| supporting | 8 lines | Command, File / Files (several paths, or one folded under a result), Parameters, Request, a search's arguments, *Returned to the agent*, *Fetched output*, Error, a permission card's *Raw input*, a subagent's prompt |
| none | never cut | the `TodoWrite` checklist, and a Codex `Plan` row's (a single file's path line on its own is not a section at all) |

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
output, *Output so far*, a thought still being thought) fades at the top with the button between the header and
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
- **A question record.** Its viewer source is the question, but the card draws
  its options and answer under it too; a slice of the question would take
  their place. It is clamped and offered full screen like any main block
  (`sliceable={false}` on `HeaderlessMainBlock`).

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
- A headed block keeps its header ⤢ as well. A headerless one
  (`HeaderlessMainBlock`: the plan, a subagent's report, a thought's text, a
  message body, a question record) has this one button, in place of both
  *Show all* and its *Full screen*.

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
| *Show less* with the button out of sight (under the pinned title or the [pinned section header](#the-pinned-section-header), or off screen when closed from that header) | the section's header — or, for a block with none (a subagent's prompt, any `HeaderlessMainBlock`), the block's own top: where it is when it is in sight — a pinned header is just under the row's title — and otherwise brought to just under the pinned row title (`coveredAbove`, the same height a fold lands under) |

Keyboard focus opening a block takes the same landing; the browser then
brings the focused control into view if the landing left it out, as it would
for any focus. Holding is asked of the
anchor rather than written to `scrollTop` here, so the next thing that moves the
transcript keeps the place rather than undoing it, and a reader following the
tail goes on following it when the place held is the end. What cannot be held is
not: a place above the transcript's top or past its end is the nearest one it
can reach.

**Live output follows its tail** (`follow`, on *Output so far* and on the
live thought's text and *Full reasoning* in the turn's tail), whenever it
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
  - A thought's body — a settled thought's and the live one in the turn's
    tail alike (`THOUGHT_BODY`): a thinking row has no bar over its body, so
    an opened *Full reasoning* pins at the transcript's top — or, inside an
    open subagent row's *Process*, under that row's bar. Every row bar sticks
    at the top, so whatever follows one inherits `--row-bar-above`, one bar's
    height, however deep it is, and the thought's body sets
    `--section-bar-top` to it (falling back to 0). A bare row's box clips its
    corners with `overflow-clip`, not `overflow-hidden`, for the reason the
    card below gives.
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
   - `TodoWrite`, and a Codex `Plan` row: the checklist (`TodoChecklist`,
     labelled `Todos` on both) — a status icon per item, the done ones struck
     through, and a `Plan` row's explanation first, as a muted paragraph. The
     turn's panel opens on the same checklist
     ([turn-progress-ui.md §4.2](turn-progress-ui.md#42-the-plan)). An
     input that is not a list of todos falls through to the fields below.
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
   changes are `ProposedChange`, shared with the permission card — with
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
   - `WebSearch`: a list of the results the search found, then the search
     tool's own summary. Claude sends one string (measured on 376 local
     results): `Web search results for query: "…"`, then a
     `Links: [{"title","url"}, …]` line, then a Markdown summary, then a
     `REMINDER: You MUST include the sources…` line. Some results have a second
     `Links:` line that repeats part of the first. A link has a title and a URL
     and no snippet. The summary is what tells the reader about the results.
     `parseWebSearchResult` (`lib/webSearchResult.ts`) reads it, so the
     component does not parse anything. The header line has to match or
     nothing is parsed. It is not drawn, since the row's detail is the query
     already. Each `Links:` line is read as JSON, and the links are
     deduplicated by URL in the order they first appeared. A `Links:` line that
     does not parse is not dropped: it stays in the summary as text. The
     reminder is the CLI's instruction to the model, a wrapper like
     `<tool_use_error>`, and only the drawing leaves it out. What remains,
     trimmed, is the summary.
     - Each result is one full-width `<a>` (`target="_blank"`,
       `rel="noopener noreferrer"`, at the `min-h-9` /
       `pointer-coarse:min-h-11` of a file row's *Open*). It shows the title in
       primary text, wrapping and never cut, then the host in muted text on
       one truncated line, then an ↗. The host is the hostname without a
       leading `www.`, enough to say where a result is from. The full URL is
       the link itself, and it is written out in full screen. There is no
       `openDeferredTab`, since the address is known at the click.
     - Only `http:` and `https:` become links. Any other URL, or one that does
       not parse, is drawn the same way but not as a link: no ↗, and the raw
       string in place of the host. A result with no title uses its URL.
     - The summary goes `mt-3` under the list, through `MarkdownContent`,
       with no heading of its own. A list and prose already look different.
       With no links only the summary is drawn, and with neither a muted
       `No results.` is drawn.
     - The section clamps at the `main` budget, list first, so the list is
       what shows. `resultCount` is undefined, as for `WebFetch`, because
       "N more lines" cannot describe the mix. Copy copies the raw result.
       Full screen is Markdown: one ``- [title](<url>) `host` `` per link
       (plain text for one that is not a link), then the summary.
     - A result that does not match, one that came as content blocks, and a
       failed call all fall back to `UnknownResultDisplay`, which is how they
       were drawn before. Codex's web search does not reach a `WebSearch` row
       yet ([tool-call-model.md](tool-call-model.md#out-of-scope)).
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
4. For a call whose result outlived the turn it was cut off in, one line saying
   so. A non-zero exit code is on the row
   ([what the call measured](#what-the-call-measured)), not here.

The attachment strip stays between the row and the body, and what goes in it is
what the result **is**: when a tool answers with a screenshot, the screenshot is
the answer, and an answer folded behind a chevron has not been shown. A block
marked `not_fetched` is not that — it is a *pointer* at a file nobody read — so
it is drawn as a reference line in the body instead
([above](#when-a-background-run-finishes)).

A file in the strip that is not drawn as an image, a video or audio, here and
in a user's message, is `AttachmentChip` (an image or a video is a thumbnail,
whose tooltip carries the same detail; audio is a player shaped like the chip),
which sets its own compact type — name `text-sm`, detail `text-xs` — rather than
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

A thumbnail is not expanded in place: tapping it opens the image in the
[media viewer](media-viewer.md#chat-attachment-thumbnails), full screen, where
it zooms and pans — or the video, where it plays.

Which entry a block gets is `attachmentKind` (`utils/attachment.ts`): what the
agent says it is. A block with something behind it is an image thumbnail
(`AttachmentThumb`, which also takes a block with no type at all, and hands
one that turns out to be a video or audio on), a video thumbnail (`VideoThumb`)
or an audio entry (`AudioEntry`); anything else with something behind it is a
chip with a file glyph. Both players read the description first, once on
screen, through `PlayableAttachment`, which also words a description that
cannot be read or is nothing it can play. A description of the other playable
kind wins over the block: `PlayableEntry` hands it to that kind's entry. A
block keeps the type it was written with, and the server once typed a voice
note in an MP4 or WebM container as video; read back now it is audio, and
should play as audio rather than say it cannot be previewed. A block with
nothing behind it is a chip whose icon says what is missing — `ImageOff`,
`VideoOff`, `VolumeX`, the glyphs a player's failure card uses — since a reader
looking for something to see or hear will not find it, and a generic file glyph
would not say that.

A video thumbnail is a **fixed square** (`size-24 sm:size-32`, the image
thumbnail's heights) from placeholder to first frame, its picture
`object-cover`: a block carries no dimensions for a video, so no shape is known
before the bytes are, and a square crops a phone's 9:16 and a desktop's 16:9
alike to a recognisable centre. It is drawn with a paused `<video>` and no
`controls`, streamed from a raw capability through `useMediaPlayback` — the
same one the viewer then plays from — with `preload="metadata"` and the
`#t=0.001` fragment, so only the header and the first frame are read and iOS
paints that frame. Until it has a source it is a skeleton, as an image's
placeholder is. From then until the frame paints — and for good on an iOS that
loads nothing before a press, or for a video with no picture this browser can
show — it is a black square with a play mark and a film glyph, already
tappable; once painted, the length takes the glyph's corner. Nothing under it
is themed, so neither is what is drawn over it: the square and the marks use
`th-media` / `th-on-media`, one value in every theme. A failure swaps it for a
chip titled as `MediaFailureCard` is: Retry for a load, Save for bytes this
browser cannot play (no viewer opens from a failed entry, so its Save is out of
reach), nothing for a file that is gone. That changes the entry's size, once,
on an entry that is finished — as a failed image thumbnail turning into a chip
always has.

Audio plays **where it is**: a voice note is listened to beside the message it
came with, and there is no audio stage. The entry is the chip's width and the
height of a chip with an action, so it sits level in a row of chips, and
turning into a failure chip with Retry or Save moves nothing. A failure chip
with no action — a file that is gone, or not audio after all — is 8px shorter
on a touch screen, the same one-off change as a failed video's.
The entry is a play button, the name, and a line that reads length · size
until the first play, then a scrubber and the time for as long as the entry is
mounted, so a paused note still says where it got to. A recording that states
no length (a MediaRecorder `.webm`) has nothing to scrub against and shows the
elapsed time alone. Its `<audio>` has no `controls` — native ones do not fit a
chip and look different in every browser — and streams through
`useMediaPlayback` like the video thumbnail, `preload="metadata"`, nothing read
until the entry is on screen. The button stays disabled until the element has
its source, and `play()` is called in the press itself: iOS refuses one made
outside the gesture, and a press that first waited for the capability would
land outside it. The scrubber is the one control here under 44px on a touch
screen (24px), deliberately: it is dragged along its length, not tapped, and a
44px row would make the entry taller than its neighbours. The entry that is
sounding has an accent border; starting one pauses any other player
([one sound at a time](file.md#playing-audio-and-video)). Failure is the video
thumbnail's chip, worded for audio.

**Nothing opens a tool call's body but the user.** Trial and error is how an
agent works: a turn routinely contains several failed calls, and four bodies
unfolding themselves bury the answer the user is reading. What replaced the
auto-expand is rung 4 of the second line — a failed row now says how it failed
without being opened.

That includes a subagent's. `TaskItem` used to be the one exception — it
opened a failed subagent's body once (`autoExpandedRef`), on the grounds that a
subagent failing is rare rather than routine and that its report is the only
account of what went wrong. Neither ground holds up as a reason for the body to
move itself, and the exception is withdrawn for every failed subagent, foreground
and backgrounded alike:

- **Where it fails, the user is either there or not.** A backgrounded run fails
  wherever in the transcript it was launched, long after the user stopped
  watching it — a 30-minute task unfolding itself shoves the transcript around
  under someone reading something else: the reader's place is held through it,
  but what is around it moves ([above](#the-second-line-problem-1)). A
  foreground run fails at the tail, where the user may be reading — and there
  the next thing in the transcript is the main agent's own reaction: it read the
  report and says what failed, or retries. The report is not the only account
  in either case; it is the most detailed one, and detail is what a tap is for.
- **The exception fired where nobody was watching.** It keyed on the status,
  not on the moment of failing, so it fired on mount: a reloaded session, or a
  page of history scrolled into, opened every failed subagent in it at once —
  exactly the "four bodies unfolding themselves" this rule exists to prevent,
  on a screen the user had not yet read. Keying it on "failed while watched"
  instead would make the same row draw differently live and on reload, which is
  the inconsistency [the second line](#the-second-line-problem-1) refuses
  everywhere else.
- **The row can carry what opening was for.** What a failed tool row got in
  place of opening — a line saying how it failed — a failed subagent gets too:
  `N tool uses · <first line of what it returned>`, the shape a backgrounded
  failure already had ([status by status](#status-by-status)). Line 1 is red,
  line 2 says why, the body is a tap away. The red row is how a failure is
  noticed, and the agents overview (designed separately) lists every subagent's
  outcome for a reader who was elsewhere.

So `TaskItem` has no auto-expand, and with it goes the only reason it withheld
the shared second line on a failed run (`failed && !run.fromBackground`): a body
that does not open is not something the line would copy. A failed subagent
reads through its own line rather than the shared rung 4, because its result is
a report or the CLI's verdict — prose, not machine output — and the shared rung
would cut its tail in mono; the first line is where a verdict states itself. This
closes the open decision recorded here before: **a `background` run must not
open itself** is now kept by the code, because no subagent run opens itself.

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
effect, so the button never flashes in late. The main blocks with no
header (`HeaderlessMainBlock`) — the `ExitPlanMode` plan, a subagent's report,
a thought's text, a message's body, a question record — keep a *⤢ Full screen*
text button in their clamp's row, beside *Show all*: growing a header for one
icon would cost 24px on every plan. [Huge content](#huge-content) adds its own *Open full …* button on the
cut side.

#### Who owns the viewer

A sheet inside the block would die with it, and blocks are replaced while they
are read: *Output so far* unmounts the moment the result arrives, a permission
card the moment it is answered. So there is one viewer per transcript,
`FullScreenHost` (`Chat/FullScreenHost.tsx`) — and each level of [a subagent's
transcript](subagent-transcript-ui.md#relation-to-fullscreenhost) is a
transcript, with a host of its own — rendered inside the transcript's
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
| `<run>:page` | [a page the agent drew](#a-page-the-agent-drew-html_render) |
| `report:<run>` · `thought:<hash>` · `sent:<message>` | a subagent's report; a thought's text and its *Full reasoning*, each keyed by a hash of its opening (200 characters, or its first six lines if they end sooner) so it carries over from the turn's tail into its row; a command's *Sent to the agent* |
| `system:<part>` · `raw:<part>` · `command-output:<part>` · `event:<message>` | a system, raw or command-output message's body; a work event's message |
| `question:<request>` | a question record — the viewer shows the question, not its options |

A key left with no publisher closes the viewer — but only if it is still
unpublished a frame later, since publishers legitimately unmount and remount
across commits. The source is content, not the transcript's rendering, because
the viewer draws it differently: unclamped, with its own wrap, and from the
latest text.

An image is not one of these sources. Attachments and the images in Files and
Git open in the [media viewer](media-viewer.md), a `Sheet` of its own; why it is
not this host is
[there](media-viewer.md#why-a-sheet-and-not-fullscreenhost-or-a-lightbox-library).

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
| Markdown (`WebFetch`, a `WebSearch`'s links then its summary, the plan, a report, reasoning, a `.md` file) | `MarkdownContent`, whole — a `.md` file through `FileContentDisplay`, so its relative images resolve against its own directory; plain wrapped text past `HIGHLIGHT_LIMIT` | none: it reflows | the top |
| a page (`html_render`) | `HtmlFrame`, edge to edge with no padding, scrolling itself; its source, under the toolbar's `</>`, as code | the code's, while its source is shown | the top, in the mode the card was in |

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
  A page only as its source: rendered, it is a document of another origin that
  neither this find nor the browser's reaches, so there is no 🔍 and
  Ctrl/Cmd+F is left to the browser rather than opening a bar that finds nothing.
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
  swipe, the browser's Back — or the key going away. Back closes it as it
  closes every layer ([project-ui.md §5.2](project-ui.md#52-back-closes-the-topmost-layer)):
  the viewer is a `Sheet`, which holds a same-href entry while it is up, and
  every other close takes that entry back. A file row's *Open* closes the
  viewer and navigates; the navigation is held until the entry is gone, so
  Back from the file lands on the chat with nothing open.
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

**The prompt is drawn as Markdown, muted.** It is the main agent's prose to the
subagent — headings, lists, code spans and fences as often as not — and it used
to be a muted `<pre>`, so a structured brief read as one wall of mono text with
its markers showing. It is `MarkdownContent` in the **note** variant the
Process's text uses ([below](#telling-the-subagents-words-from-the-main-agents)):
`text-xs`, `text-th-text-secondary`, tight margins — rendered, but still read
as a quotation of what was asked rather than as anyone's answer. Same place,
same closed disclosure, same clamp; only the rendering changes.

```
┌────────────────────────────────────────────────────────────┐
│ ›  ✓  ⧉ Explore  Find retry handling                1m 12s │
│       12 tool uses · The sender retries on…   45.6K tokens │
├────────────────────────────────────────────────────────────┤
│  The sender retries on 429 and 503, honouring …            │  report
│  …                                                         │
├────────────────────────────────────────────────────────────┤
│ ›  Process · 12 tool uses                                  │  closed
├────────────────────────────────────────────────────────────┤
│ ›  Prompt                                                  │  closed
├────────────────────────────────────────────────────────────┤
│  agent a555947eded58a158                                   │  facts
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
Process moves it without a scroll (the anchor holds still what the reader is
reading, not where the row starts), directly in each callback rather than a
frame later, and only while the row is open, so a
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
- **Nothing of the scroll anchor.** The candidates are the row wrappers and the
  sections of an open body ([the list](#the-list)), never the bar or a section
  header that sticks: a pinned box is drawn away from where it sits in the flow,
  and being pinned moves nothing in layout, so nothing the anchor measures moves
  with it.

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

### The row: which agent, and what it measured

A subagent can be most of a turn's work and most of its cost, and the CLIs say
which agent it was, how much it did and what it spent. The row used to say none
of it: its title was the literal `Task` on every subagent, the agent sat in a
chip, and a settled row ended in a bare count. The row now names the agent and,
once it settles, carries the first line of its report and the measured
figures.

```
 ›  ✓  ⧉ Explore   Find retry handling                     2m 2s
       12 tool uses · The sender retries on 429 and…   45.6K tokens
```

#### Line 1: the agent, then what it was asked

**The title is the agent; the detail is the task.** The title slot — accent,
`shrink-0`, the slot every row names *the kind of call* in — names the kind of
subagent, and the detail is the description, as before.

| Call | Title | Detail |
|---|---|---|
| Claude, `subagent_type` given | the type, verbatim (`Explore`, `general-purpose`, `code-reviewer`) — for a plugin's `plugin:agent`, the part after the last `:` | `description`; else the first line of `prompt` |
| Claude, no `subagent_type` | `Subagent` | as above |
| Codex, `subAgentActivity` (agent path) | the path's last segment (`read_a`) | none — the spawn names no task |
| Codex, `spawnAgent` | `Subagent` — its input is only `{prompt}`; a name, if a spawn ever carries one in its input, becomes the title by the same rule | the prompt's first line |

- **`Subagent`, not `Task` or `general-purpose`, when no type is known.** `Task`
  was the CLI's tool name, not anything the reader asked for, and it no longer
  matches the CLI either (it says `Agent`). `general-purpose` is what Claude runs
  when the type is omitted, but writing it would be the renderer guessing at the
  CLI's default — and Codex has no such default at all. `Subagent` is true of
  every row this renderer draws.
- **The chip goes.** It used to carry the type, which is now the title; one name
  twice on a 320px line is width the description needed. A `background` chip
  stays where it was.
- **A plugin's prefix leaves the row.** `pr-review-toolkit:code-reviewer` is
  `code-reviewer` on the row and the full name in the body's facts (below):
  the prefix says where the agent came from, which the reader rarely needs, and
  in the title slot it would spend the description's width on it.
- **The title is capped, because it is no longer a word Pockode chose.** A tool
  name is short by convention; an agent name is whatever its author typed. The
  title span is `flex min-w-0 max-w-[45%]` on a subagent row — the mark
  `shrink-0`, the name `truncate` — so a long name is cut and the description
  keeps at least half the line. A name cut there is not repeated in the facts
  line: telling that it was cut would mean measuring the DOM.
- **Old records need nothing.** The title is derived from the call's input like
  every row's (`toolSummary`) — `subagent_type` when the agent gave one, the
  Codex agent path — never from the result record, so a transcript from before
  this section reads the new way on reload, with no new field, and a call still
  running has its title from its first frame. A Claude call that omitted the
  type is `Subagent`, by the rule above.

**An agent mark, so it does not read as a tool.** With the agent's name in the
title slot, `Explore` sits exactly where `Bash` and `Grep` do and could be taken
for a tool called Explore. The title is therefore led by lucide's `Bot` (`⧉` in these diagrams) at
`size-3`, in the title's own accent, `shrink-0`, `gap-1` to the name — drawn
inside the title span, not in the leading column: the leading column is the
chevron and the **status** glyph, and a subagent's status must stay in the same
place as every other row's. It costs 16px, and it is the one icon a title ever
carries, so it is the subagent category's mark and nothing else's. A nested
subagent in a Process wears it too, which is what tells it apart from its
siblings among forty tool rows.

The mark is `aria-hidden`; the name is preceded by a visually hidden
`Subagent ` (`sr-only`), so a screen reader hears *"Subagent Explore, Find retry
handling"* — the same distinction the eye gets from the mark. A row titled
`Subagent` skips the hidden word rather than saying it twice. The running
glyph is named `Subagent running` on every subagent row, not `<agent> running`:
the status is the subagent's, whichever agent it is, and `Task` is retired.

Every surface that words the call from the summary follows for free: the sticky
title line, a full-screen viewer's title (`Explore · Find retry handling`), the
Process's `aria-label` (`Explore subagent's process`, now from the title rather
than the chip, so a Codex spawn gets `read_a subagent's process`; a row titled
`Subagent` keeps `Subagent's process`), and the latest-child wording of an outer
subagent whose latest child is this one (`Explore  Read the backoff policy`).

#### What is measured, and where each figure comes from

Three figures, each from one place, with one fallback where one exists. Shown
only when measured — the rule [the meta slot](#where-a-figure-comes-from)
already follows.

| Figure | First | Else | Never |
|---|---|---|---|
| **tool uses** | the run's children: every child `tool_use_id`, filed or [unfiled](#what-is-not-filed) (`countSteps`, unchanged) | the CLI's count — live from the activity's `subagent_progress.tool_uses`, settled from the result record's `subagent.tool_uses` | a mix of the two on one run |
| **tokens** | the result record's `subagent.total_tokens`: the subagent's context when it finished ([below](#tokens)) | — | a sum of the children's own usages, or a live figure |
| **duration** | the meta slot's rules, unchanged: Claude's `duration_ms`, else observed `endedAt − startedAt` | — | — |

**Live and final are the same number because they are the same count.** A
live count that ends on a different final one is what happens when the two
come from two counters — one ticking on the client while the run goes, another
the CLI writes when it ends — that count different things even once in a while.
So there is one counter per run, chosen by the run's data, not by its status:

- **A run with any child call counts its children, live and settled alike.**
  The live line counts them; the settled line counts the same children; the
  Process heading counts the same ones again, and the rows under it are the
  ones counted, so a reader who opens the Process and counts gets the row's
  number. The CLI's `subagent.tool_uses` is not shown on such a run.
- **A run with no child call counts the CLI's**: `subagent_progress.tool_uses`
  while live, the result record's `subagent.tool_uses` once settled — one
  source again, so they agree with each other. This is the subagent whose work
  never reached the stream (a subagent's own subagent that ran inside its call,
  measured on claude 2.1.286) and any CLI that streams no frames. Without that
  figure the row draws what it draws today with no steps.
- **What one tool use is**: one call the subagent made, whatever it became — a
  row, a permission card standing in for one, a denied call, a question card.
  A subagent's own subagent is one tool use, however much it did. Text is not
  one.

Why the children and not the CLI wherever both exist, although on an ordinary
run they agree — over 192 single-run subagents in local Claude Code transcripts
(claude 2.1.x) the hand-back's `tool_uses` equalled the distinct `tool_use` ids
in the subagent's own transcript every time:

- **The children are the one count a reader can check**, and the one every
  engine has. Codex reports no count for a spawn at all, and no record written
  before the server kept the CLI's has one; a rule that read the CLI's
  wherever it existed would count Claude and Codex rows, and old and new rows,
  by two different counters.
- **They tick per call.** `task_progress` arrives on the CLI's schedule, not on
  each call; a count read from it would stand still while the Process under it
  grew.
- **A resumed subagent is where the two part.** The CLI counts per call: a
  `SendMessage` that resumes a subagent reports only that call's tool uses, on
  its own result. Its streamed work is filed under the call that first spawned
  the subagent ([code/frontend-state.md](code/frontend-state.md#a-subagents-children),
  [Process](#process)), so that row's Process grows and its count grows with it,
  while that call's own `tool_uses` was written when it first ended. Every
  mismatch in the measured runs was this case. The row keeps counting what is
  under it.

#### Tokens

**What the CLI reports for the subagent, as it reports it — which is its
context at the end, not its spend.** Claude's figure (the result's
`tool_use_result.totalTokens`; older CLIs also wrote it into the hand-back text) is the input, cache and output
tokens of the subagent's **last request** alone: over 135 runs (claude 2.1.x) it
matched that request's sum in every one that was not resumed, and the run's
cumulative usage is five to twenty times more. It is what Claude Code's own
`45.6k tokens` means. Codex's figure is read to mean the same thing: the child
thread's **last** usage (`tokenUsage.last`), not its running `total`, so the
same word on two engines' rows is the same quantity.

So the label stays `tokens`, the CLI's own word, and the row does not call it a
cost: it says how much the subagent had in hand when it answered — a fair
measure of how big a job it was — and the session's spend is the session
panel's. A real per-subagent spend would need every one of its requests'
usage, which neither CLI hands over for a subagent; if one starts to, it is a
second figure with a name of its own, never a silent change to this one.

They are a fact at the end, so they live **in the result record** (its
`subagent`, beside `duration_ms` —
[agent-integration.md](code/agent-integration.md#eventrecord-unified-event-format)),
and a run gets them when it settles, never while live: a ticking token count on
a phone row is noise, and the live line has no width for it.

**Number formatting**, all through helpers that already exist:

- tool uses: the integer, `1 tool use` singular, `12 tool uses` —
  `toolUsesLabel` (`lib/toolRun.ts`), which the row and the Process heading
  share; `stepsLabel` beside it is the folded group's, which still says steps.
- tokens: `formatTokens` (`web/src/utils/tokens.ts`) — `842`, `4.2K`, `45.6K`,
  `128K`, `1.2M` — then ` tokens`. The capital `K` is the session panel's, so
  the app writes a token figure one way everywhere; Claude Code's own lowercase
  `k` is not copied.
- duration: `formatDuration`, in the meta slot, unchanged.
- Zero tokens are not drawn (an engine that reports `0` has measured nothing
  useful); zero tool uses are not drawn either — a subagent that answered
  without calling anything leads with its report.

#### Line 2 once settled: the count, the report, the tokens

A settled success's second line is `count · report`, and its tokens at the
right end — the duration stays on line 1:

```
 ›  ✓  ⧉ general-purpose  background  Review: the team's de…      2m 2s
       15 tool uses · Review: the team's decis…   45.6K tokens   ← desktop
       15 tool uses · Review: the team's decisions and…          ← phone
```

- **The report is the first line of what the body draws as the report**
  (`subagentLastWords`): `report` for a foreground run, `outcome` for a
  backgrounded one, through the same `firstLine` as a failure's tail
  ([below](#status-by-status)), muted like every settled tail — line 1 carries
  the status. Settling is the moment the conclusion becomes news, so it is
  there in the frame the run settles, even while siblings still run.
- **The duration stays in the meta slot.** Every row's time is right-aligned
  on line 1, live as a counter and settled as a duration; a subagent's
  `2m 2s` moving to the second line on settling would be a figure jumping
  across the row at the moment it stops, and two time positions in one list.
  The tokens sit under it, so the figures read as one column.
- **What gives way, in order:** the tokens drop out whole, then the report is
  cut with `…`; the count never yields. The line is one `flex-wrap` row exactly
  one line high (`h-[1lh] overflow-hidden`): `count · report` is its first item,
  with a `16rem` basis, and the tokens a `shrink-0` second that wraps onto the
  hidden line whenever both do not fit — on a 360–390px phone, which leaves the
  report the width after the count. Never `45.`. With no report the first item
  takes no basis, so `12 tool uses   45.6K tokens` still fits a phone. The
  basis is on the item and not on the report: a minimum on the report would
  make the report what wraps away on a deeply nested narrow row.
  `TaskItem.browser.test.tsx` holds this at 360, 390 and 900px.
- **What shows with what is known:**

| Known | Line 2 |
|---|---|
| tool uses, a report, tokens | `12 tool uses · <report>`, `45.6K tokens` at the right end when it fits |
| tool uses, an empty report | `12 tool uses`, `45.6K tokens` at the right end |
| no tool uses (answered without a call) | `<report>`, tokens at the right; an empty report is `45.6K tokens` alone |
| no tokens (every record before the server kept them; a Codex child that never reported usage) | the same, without them |
| nothing at all | the shared rungs, as a row with no steps draws today |

#### Status by status

| Run | Line 2 |
|---|---|
| live (`running` / `background`) | `N tool uses`, over its [step window](#the-step-window) from the first step — the count, and the steps under it say what it is doing; no tokens |
| `success` | `N tool uses · <report>` and the tokens ([above](#line-2-once-settled-the-count-the-report-the-tokens)) |
| `error` | `N tool uses · <first line of what it returned>`, in the muted second-line colour — the row's red is line 1's; why it failed is the news, and the body does not open to say it ([the body](#the-body-problems-2-and-3)). No tokens: on a failed row why outranks what it spent |
| `interrupted` | `N tool uses` while its frozen [window](#the-step-window) is drawn, then `N tool uses · <latest child>`, frozen where it was cut — no tokens even when a late result brought some: where it was is the news. Codex and Claude alike: a Codex subagent the user's Stop cut short is `interrupted`, not `error` (below) |
| settled from the background, `completed` | as `success` — the outcome is its report ([the subagent body](#the-subagent-body)), so it reads as a foreground success does |
| settled from the background, `failed` / `stopped` | `N tool uses · <first line of the outcome>` — the verdict is the news, as on a foreground failure |

The background split is a change, and the reason for it: on claude 2.1.286 the
CLI backgrounds a main-agent subagent of its own accord, so if a backgrounded
success read as a failure does, the most common subagent would never show what
it cost. Its outcome *is* its report, so it previews and costs as a foreground
success does.

**A failed run's first line is the first non-empty line of its result**, read
as a text child is ([below](#the-second-line-steps-and-what-it-is-doing)): block
and inline Markdown markers dropped, one `truncate` span, not mono — a
subagent's result is its report or the CLI's verdict, prose either way. For a
foreground failure the result is the call's own (a report that came back framed
is read out of its frame first, as the body does); for a backgrounded one, the
outcome. A failure that returned nothing keeps its count and tokens, as
before: there is no verdict to show, and the red line 1 still says it failed.

**Interrupted reads the same on both CLIs.** Claude settles a subagent the turn
cut short as `interrupted` — the muted `Ban`, never red, because the user
stopping it is not the subagent failing. Codex used to report the same case as
`error` (`settleSubagent` folded an interrupted subagent thread into
`IsError`), so the same act read as a failure on one CLI and as an interruption
on the other. A Codex subagent the user's Stop cut short now settles
`interrupted` too, and reads as the row above. What `interrupted` means is
*the user stopped it*, on both CLIs: a Codex subagent the model stopped itself,
inside a turn that went on, reads as failed, as a Claude background task the
model stops does — and one whose thread failed stays `error`. How the server
tells the two apart is
[code/agent-integration.md](code/agent-integration.md#subagent-threads)'s.

**A resumed subagent is running again.** A subagent the agent gives more work
after it finished — Claude's `SendMessage` to it, Codex's `sendInput` or
`followupTask` — works on under the row it was spawned with. While it does,
the row is a running row: the spinner, the live line (its count is every tool
use under it, the first run's and this one's), and an elapsed counter from the
moment it resumed — never the red of an earlier failure, nor the `Ban` of an
earlier Stop. Its body keeps the report it last returned, the only report there
is until the resumed run ends. When it ends the row settles again, as the run
that ended:

- **Codex** reports the resumed run on the spawn's own call, so the row takes
  its outcome — the new report, its duration and its tokens — and reads by
  the table above.
- **Claude** reports it on the `SendMessage` call, which has a row of its own
  and gets the outcome there. The subagent's row goes back to what it said
  before it resumed, report and tokens alike; its new work stays in its
  Process.

A message to a subagent that is still running changes nothing: it never
stopped. How the client learns either kind of resume is
[code/frontend-state.md](code/frontend-state.md#a-subagents-children)'s.

**Running** keeps the live line, with its count now counted as above
and labelled `tool uses`, and the elapsed counter on line 1; its calls are the
[step window](#the-step-window)'s. When the run has
no child yet but the CLI reported progress, the latest-child half reads
`subagent_progress.last_tool_name` (Claude's `task_progress`) as a bare title (`Grep`) — better than
`Running <description>`, which is the row's detail said again — and `run.activity`
only when there is neither.

#### What is not on the row

| Fact | Where | Why |
|---|---|---|
| `subagent.agent_id` — Claude's `agentId` | the body's **facts** line | a machine key for resuming the subagent, which the reader only needs to quote back to the agent; mono, selectable |
| full agent type | the facts line, only when it differs from the title: a `plugin:` prefix the row dropped, or a type only the result named (`subagent.agent_type` on a call whose input had none, titled `Subagent`) | otherwise it is the row's title again; a Codex `agent_path` is already the title |
| tokens | the facts line as well as the row, once settled and not cut short — `settledTokens`, the row's own figure | the first thing a narrow row drops ([above](#line-2-once-settled-the-count-the-report-the-tokens)), so a phone still has it one tap away |
| model | the facts line, if a record ever carries the subagent's — none does today | rarely differs from the session's; worth a glance, not a line |
| `spawn_depth` | nowhere | the rail already draws it, and a number would say it twice |
| per-kind token breakdown, cost | nowhere | the session panel's concern; a subagent's share of it is the turn-level summary's |

The **facts line** is the body's last block, after Prompt: one muted `p-2`
line, `border-t`, facts joined by ` · `, wrapping (`break-all` on the id) —
`pr-review-toolkit:code-reviewer · agent a555947eded58a158 · 45.6K tokens`.
It is drawn only with at least one fact. Not a disclosure: it is one line, and a
disclosure for one line is a tap to reveal less than its own label.

### The second line: steps and what it is doing

```
 ⟳  ⧉ Explore  Find retry handling                         47s
    6 tool uses · Checking the 503 path next.
    ✓ Glob   server/relay/**/*.go
    ✓ Read   sender.go
    ⟳ Grep   "Retry-After" in server/                       12s
```

[Above](#line-2-once-settled-the-count-the-report-the-tokens) replaces the
settled rows of the table below, and `N steps` is drawn as `N tool uses`
throughout; what follows is the live line. While a row draws its [step window](#the-step-window) — every
live row that has a step — the calls are the window's, and the line's tail
names none (below).

The collapsed row is how a user tells a subagent that is getting somewhere from
one that is stuck, without opening anything. Two facts do that: *how far* it has
come — the step count — and *what it is doing now*, which is its **latest
child**. So a subagent's second line replaces the shared rungs with its own; the
first row that matches wins:

| Run | Second line |
|---|---|
| `error`, or settled from the background `failed` / `stopped`, that returned something | `N tool uses · <first line of what it returned>` — of the outcome, for a backgrounded run; with no tool uses, the first line alone |
| no tool uses, no tokens and no report | the shared rungs, unchanged — `run.activity` while live (after `last_tool_name`, [above](#status-by-status)), the background rungs, else no line |
| live (`running` / `background`), with a step window | `N tool uses`, then `· <text>` only when the newest child is a text newer than the newest step |
| `interrupted`, with a frozen step window | the same |
| live, without a window (no step yet but a text or the CLI's count, or the Process open inline) | `N tool uses · <latest child>` |
| `interrupted`, without a window (folded, or the Process open inline) | `N tool uses · <latest child>` — frozen where it was cut |
| `success` / background `completed` | `N tool uses · <report>` and the tokens ([above](#line-2-once-settled-the-count-the-report-the-tokens)) |

`1 tool use`, singular. The rules inside that table:

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
- **While a window is drawn, the tail never names a call.** The window's
  bottom line is the newest step; naming it again on line 2, one line above,
  would be one fact twice. What is left for line 2 is words: the newest text,
  and only when it arrived after the newest step — a text older than that is
  about a step that has since moved on. A row whose window is not drawn reads
  the latest child as before, call or text: one before its first step, one with
  its Process open inline (the user's own tap took the window away, and the
  line names its latest child again), and an `interrupted` row once its frozen window
  folds — the tail takes `· <latest child>` in the same frame as the fold, so
  *where it was cut* appears at the one moment the row re-flows anyway.
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
  `truncate` span, not mono. `6 tool uses · ` never yields width; on a 320px phone the
  latest child is cut to a few characters and the count is still there, because
  the count is the half that answers *is it moving*.
- **It is never red, even when the latest child failed.** `Detail` is passed no
  error here. A failed call inside a subagent is the subagent's trial and error,
  exactly as one in the main transcript is
  ([the body](#the-body-problems-2-and-3)); the row's colour is the subagent's own
  outcome, and the failed call is red on its own row in the Process.
- **A settled run drops the latest child for its report, or for its
  verdict.** On `success` the report is the account of what happened, and the
  last thing the subagent touched is noise next to it; its first line, beside
  the count, is what a collapsed row keeps. A failed run — in its
  call or in the background — puts the first line of what it returned there
  instead: no subagent body opens itself
  ([the body](#the-body-problems-2-and-3)), so the row is where *why* has to be.
  `interrupted` keeps the child because there it *is* the news: where it was
  when it was cut. One that settled from the background and completed reads as
  a foreground success ([why](#status-by-status)). Keeping a line in every case is also
  part of what holds the row's height when it settles, and that matters more for a
  subagent than for any other foreground call: the main agent routinely spawns
  several at once, so a subagent row that finishes first is **not** at the
  tail — its siblings are still running under it. The rest of the height is
  its step window's, which stays, frozen, until it is unseen or the turn ends
  ([the step window](#settling-and-folding)).
- **`error` reads its own line, not the shared rung 4.** Rung 4 is the tail of
  machine output in mono; a subagent's result is prose that states its verdict
  first, so the first line is the one that says why
  ([status by status](#status-by-status)).
- **`aria-hidden` while live, exposed once settled**, as every second line
  ([above](#the-second-line-problem-1)). Both halves move while live: the count
  and the tail. The step window is `aria-hidden` throughout
  ([below](#the-step-window)).

A row with **no tool uses, no tokens and no report** draws what it drew
before this section existed. That covers two real cases with one rule: a subagent that
answered without calling anything, and with nothing to say, on a record with no
tokens, and every
transcript recorded before children were attributed — their subagent records
sit flat beside the call ([below](#what-is-not-filed)). Writing `0 tool uses` on
those would be false for the second kind. The price is that a step-less subagent which showed its activity
line while live loses it when it settles — the one re-flow left, on a subagent
that never called a tool, which is rare.
A failure that returned something is the exception, and reads its own line
even here: the shared failure rung is the tail of the raw result in mono, and
for a framed report that tail is the frame's usage line, not why.

### The step window

```
 ⟳  ⧉ Explore   Find retry handling                        47s
    6 tool uses
    ✓ Read   sender.go
    ✗ Bash   go test ./relay/…                                    ✗ muted, not red
    ⟳ Grep   "Retry-After" in server/                       12s
```

One line says *what* a subagent is doing, not *for how long*, and not what it
did just before — and those are what tell a subagent that is stuck from one
that is working. A step that has been running for a minute is the sign of a
hang; the same command failing three times in a row (`✗ ✗ ✗`) is the sign of a
loop; how fast the lines turn over is the pace. So while a subagent row is live
it draws its **newest steps** under its second line, one per line, each with its
own status: the **step window**. It is the one thing besides the second line
that adds lines to a row ([the rules](#the-rules)), and everything below is
about keeping that from costing what the rule protects — a list that can be
skimmed, and rows that do not move under the reader.

#### How many lines

| Subagent rows in the list (any status) | compact (< `sm`) | `sm` and wider |
|---|---|---|
| 1 | 2 | 3 |
| 2 | 1 | 2 |
| 3 or more | 0 | 1 |

**The list sizes the window, not the row.** The main agent routinely spawns
several subagents at once, and three lines on each would put four parallel
siblings at about 370px — the whole transcript area of a 360×640 phone with
the composer up. The count is of subagent rows in the same list
([the list](#the-list)), whatever their status, and it is a one-way fact: a
row added to a list never leaves it, so a window only ever shrinks because a
sibling arrived — and parallel spawns arrive together, before any of their
steps do, while the windows are still empty. A frozen window
([below](#settling-and-folding)) keeps the size it settled at: a sibling
spawned after it shrinks the live windows, not the one the reader may be
looking at. A row drawn outside a list counts
as a list of one. Inside a [Process](#process) or a
[transcript layer](subagent-transcript-ui.md), a nested subagent row follows
the same rules, its list being the list it is in at that level.

**A phone gets fewer.** On a phone the progress chrome and the windows compete
for a transcript area of about 400px, so the compact tier draws one line fewer
at every count. Zero means the row has no window: three or more parallel
siblings on a phone are plain two-line rows, line 2 reading
`N tool uses · <latest child>` ([the second
line](#the-second-line-steps-and-what-it-is-doing)), that never grow or fold.
The tier is the viewport's **width**, read through `useMediaQuery` against
`BREAKPOINTS.sm` (`stepWindowLines(runs, compact)` in `lib/subagentRun.ts`) —
the one count in this document a width tier decides. Not the height: the app
sets `interactive-widget=resizes-content`, so the keyboard opening changes the
height, and sizing by it would resize every window with every focus. Width
changes only on rotation, which reflows everything anyway.

**Reserved at the first step, bottom-aligned.** The window is not drawn before
the first step, so a row with none reads exactly as it did ([the second
line](#the-second-line-steps-and-what-it-is-doing)). At its first step it draws
**all k line boxes**: the newest step on the bottom line, the unfilled lines
above it blank, each new step entering at the bottom and rolling upward.
Rolling changes text, not layout, so a live row moves the rows under it once
(0 → k), not k times. A resume regrows a folded window the same way: once, at
the resume, on a row that has just said it is running again.

#### What each line shows

One flex line, `items-baseline gap-1.5`, `text-xs`, starting under the row's
name — the second line's left edge:

1. **Status glyph**, `size-3`, in the shapes `ToolStatusGlyph` uses, **all in
   `text-th-text-muted`** — never red, by the rule the second line already
   follows ([never red](#the-second-line-steps-and-what-it-is-doing)): red on a
   subagent row is the subagent's own outcome, and the shape alone says a step
   failed. The glyph is the status the step's own row or card shows in the
   Process:

   | The step in the Process | Glyph |
   |---|---|
   | a running / background row; an allowed card whose row has not come back | spinner — a still dot under reduced motion, as `RunningGlyph` |
   | a pending permission card; an unanswered question | `CircleHelp` |
   | a settled row | its own shape: `Check`, `X` or `Ban` |
   | a denied card | `X` |
   | an answered question | `Check` |
   | an expired card; a declined or cancelled question | `Ban` — the step got no answer and was cut short, which is not a failure |

2. **Title**, `shrink-0 text-th-text-secondary`, with its chip if any, then its
   detail through `Detail` — the call worded as its own row words it, and as
   the second line words a latest child (`StepCallLabel` is both). A nested
   subagent step reads as its own row's title, agent mark and name, and its
   description; its own steps are not shown. A question reads `Question`, then
   its header, or the question itself when it has none — the card's own
   `Question · <header>`.
3. **Elapsed**, right-aligned, `tabular-nums`, muted, as `ToolMeta` derives it
   for the step's own row — **only next to a spinner on a step drawn as a
   row**. A settled step carries none: three durations on three lines are
   noise, and they would cost the detail its width on a phone. A waiting step
   carries none either: it is waiting on the user, not working.

**Which steps, in what order.** The last k steps by arrival, counted by
`stepId` across the run's children and then its
[unfiled](#what-is-not-filed) children (the unfiled ones are the newer). A card
and the row that comes back for it are one step, drawn by its newest form. A
text is never a step, so it never takes a window line; the newest text, when it
is newer than every step, is line 2's tail instead
([above](#the-second-line-steps-and-what-it-is-doing)). Oldest at the top,
newest at the bottom: a new step enters where the eye already is, as a
terminal's tail does, and the oldest drops off the top. No animation.

**There is no `+N more` line.** Claude Code and Copilot end a preview like
this with one, but line 2's `N tool uses` sits directly above the window and is
the total; over oldest-first lines it reads plainly as *the last k of N*. A
`+N−k more` would cost a line on every row for a second number counting one
fact, and it would be the line that changes meaning on settle — where `N tool
uses` becomes `N tool uses · <report>` in place, the same count in the same
spot.

**What yields on a narrow line.** The glyph, the title (chip included) and the
elapsed figure are `shrink-0` and are never cut; the detail truncates, through
`Detail`, which drops a path's directories before its file name — the rule
`6 tool uses ·` already follows on line 2. Measured at depth 0 with a running
step showing `1m 4s`, a 320px transcript column leaves about 174px for the
detail, a 360px one about 214px; a level of rail comes off that, and the
browser test (`SubagentStepWindow.browser.test.tsx`) holds the rule at both
widths in Chromium and WebKit.

#### Settling and folding

Line 2 settles by [status by status](#status-by-status), unchanged. The window
stays, **frozen** at its last steps — drawn with the statuses the reducer left
them, nothing inferred, and no elapsed figure even beside a step the reducer
still calls running, since a counter ticking on a settled row would be a lie
about the row — until the first of:

1. **Its turn is no longer open.** The turn settles, Stop is pressed, or the
   row belongs to no open turn: it is not in one of the open turn's replies —
   the open bubble and, while the reply just taken was opened by a read point,
   the one before it (`openTurnReplyIds` in `lib/turnOverview.ts`, the walk
   the plan already uses) — and its run has not been live while this turn was
   open. The second half is a resume: a subagent resumed this turn runs again
   on its spawn's row, in an earlier reply, and settling there is settling in
   this turn. The turn settling is a reflow anyway: the changes card lands
   then, at the turn's end.
2. **The row is unseen**: its element lies wholly outside the transcript
   scroller's rect.
3. **The reader opens its Process inline**, which shows the same steps whole.

So the only fold that can happen in view is the one at the turn's end, and
the scroll needs nothing new for the others. A reader following the tail is
held at the bottom, and a row folding above the view only lowers the maximum
scroll. A reader scrolled up is held by the anchor — the last candidate that
starts at or above the view's top
([agent-chat.md](agent-chat.md#where-the-view-sits), `scrollAnchor.ts`) — so a
fold wholly above the view is under its correction, and one wholly below it
moves nothing visible. A lone subagent that finishes at the tail therefore
stays frozen in front of the reader until the turn ends.
`StepWindowFold.browser.test.tsx` holds this, and the reserved growth above,
on a 360×640 phone.

**Once folded, it stays folded.** The fold is latched by run id in a set
`MessageList` owns (`StepWindowFoldContext`, `stepWindowContext.ts`), not in
the row: a group collapsed and reopened, or a bubble drawn again, remounts the
row, and a latch inside it would regrow the window in front of the reader.
Scrolling back to a folded row does not regrow it either. The set is cleared
once no turn is open, since a settled turn draws every window folded by rule 1;
a run that goes live again (a resume) drops its entry, so its new window can
fold later in turn. The same owner keeps the runs seen live while the turn is
open (`liveThisTurn`, each row reporting itself through `markLive`), for rule
1's second half, and clears them with the turn.

Whether a bubble is in the open turn reaches the rows through a per-bubble
context (`InOpenTurnContext`), not the turn-tail context, which changes on
every thinking delta. "Unseen" is measured before paint as the row settles or
mounts (a reload into an open turn, a remount), so a row laid out of view is
never painted frozen, and after that by an `IntersectionObserver` on the
scroller with no margin — so a row under the pinned bars still counts as seen
and folds a little later, the safe direction (`useStepWindowFold`).

- **Stop** ends the turn, so every frozen window folds at once, and an
  interrupted row's line 2 takes its frozen latest child in that frame
  ([above](#the-second-line-steps-and-what-it-is-doing)) — as it does at
  whichever of the three moments its window folds.
- **Failure** keeps its red line 1 and its why-line; its window folds by the
  same rule.
- **Resume** — `SendMessage`, `sendInput` or `followupTask`
  ([status by status](#status-by-status)) — makes the row live again, and it
  grows its own window back: growth on a row that now says it is running, which
  the reader should see. Nobody else's regrows. When the resume settles, its
  window is frozen like any other in the turn, wherever its row is.
- **Reload** draws no frozen window the live view would already have folded:
  a settled turn draws them all folded, and in the open turn a row that mounts
  out of view folds before paint. A row in view may show its frozen window
  where the live view had folded it while unseen, which is harmless.
- **A background run that settles after its turn** is in no open turn, so it
  folds as it settles; its notification is the boundary. One still live when
  the next turn opens counts as live in that turn, and is kept frozen when it
  settles there.

#### Where it is drawn

**Wherever the second line goes.** On a closed row, inside the row's button
under line 2: the whole button stays one tap target, and the window is not a
control — nor a way into the subagent's transcript, which stays the ⤢ in the
Process heading ([subagent-transcript-ui.md](subagent-transcript-ui.md#the-way-in)).
On an open row, under the bar directly beneath the second line, outside the
bar's sticky area and the button, as the second line is
([the sticky title line](#the-sticky-title-line)). **While the Process is open
inline it is not drawn**: the Process shows the same steps whole, and that fold
is the user's own tap.

A pending card is still drawn between the row and its body
([when a step asks the user](#when-a-step-asks-the-user)); the step behind it is
in the window with `CircleHelp`, the card right under it.

While a transcript layer covers the chat, the windows behind it change as they
would, and the chat's anchor holds them on return, as for any growth.

**`aria-hidden`, live and frozen alike.** It is a moving or duplicate view of
steps the Process lists accessibly; the row's accessible name and its second
line are unchanged by it, and its glyphs' labels are not read.

#### Rejected alternatives

- **Three lines on every live row, whatever its siblings.** Four parallel
  siblings are about 370px: a phone's whole transcript, unskimmable, the rows
  under them pushed off screen.
- **Fold each row as it settles.** The drop the second line's *keep a line in
  every case* exists to prevent: the first sibling to finish is usually not at
  the tail, so 48px vanish above rows still running, and the reader's rows
  jump.
- **A window only while the row is in view.** The row would grow the moment it
  scrolled into sight, re-flowing the list on every scroll near it, for an
  IntersectionObserver per row.
- **A window only on the newest, or most recently active, subagent.** The
  extra height would move between siblings as their steps interleave: a
  re-flow on every step, worse than any fixed size.
- **One line, with the current step's glyph and elapsed time**
  (`6 tool uses · ⟳ Grep … 12s`). Height never changes, and it answers *stuck
  on a long step*; it cannot show a loop or a pace. The honest runner-up:
  cheapest, and worse at the question.
- **A trailing `+N more tool uses` line.** A second count of one fact, a line
  from the first ([above](#what-each-line-shows)).
- **A preview on tap.** A tap to answer a question that has to be answerable at
  a glance — and that tap exists already: the body, the Process, then ⤢.
- **Sizing by the viewport's height.** The keyboard changes it, and would
  resize every window each time it opened.
- **Reserving the window at spawn.** Parallel spawns stream in one by one, so
  each arrival would resize the others' reserved windows: a flicker before any
  step.
- **Folding when the list's last sibling settles** (the rule this replaced: a
  settled row kept its window while a sibling that had started before it ended
  was live). A lone subagent, or the last of a list, folded in front of a
  reader at the tail the moment it settled, and a Claude `SendMessage` resume,
  which reports the original spawn's `endedAt`, folded early.

### Process

```
├────────────────────────────────────────────────────────────┤
│ ⌄  Process · 6 tool uses                               ⤢   │
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
`Process · N tool uses` with the same `N` as the row — the same counter, or `Process` alone when every
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
not an interruption, not the subagent finishing — and no more than the
`TaskItem` body around it, which does not open itself either
([the body](#the-body-problems-2-and-3)). A reader who opened a failed
subagent's body came for the report; opening the Process too would put a
subagent's forty rows into the transcript at the moment they are reading it. If
the report is empty, its sentence sits above the closed Process — with only the
outcome blocks, when there are any, between them — which is where the reader
goes next. Its open state is local and survives the run settling, like the
Prompt's.

**Children in arrival order, each drawn by the renderer it would have in the
main transcript.** A call is a `ToolCallItem`, a subagent call a `TaskItem`, a
permission or question record its own card — the same components and rules as
at the top level, because a `Grep` is a `Grep` whoever ran it — a nested
`TaskItem` included, which reads its failure on its own line and opens only
when tapped, like the outer one. The
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

**A long or deep Process can be read as a transcript of its own.** The ⤢ at the
right end of the Process heading opens the subagent's work in a layer over the
chat's transcript, with a breadcrumb back (`Chat › Explore › code-reviewer`),
the subagent's live tail followed, and a ⤢ on every nested subagent's Process
there to descend into it. It is offered on every Process and replaces nothing:
tapping the heading still opens the Process inline. Everything about it is
[subagent-transcript-ui.md](subagent-transcript-ui.md).

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
  title; `Subagent's process` on a row titled `Subagent`). The cues above are all visual, and a screen-reader user
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
  (`Explore  Read the backoff policy`), not as the inner subagent's latest
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
row in the transcript the user can always see.

```
│ ⟳  ⧉ Explore  Find retry handling                         47s │
│    6 tool uses                                                │
│    ✓ Grep   "Retry-After" in server/                          │
│    ✓ Read   sender.go                                         │
│    ? Bash   rm -rf build/                                     │  the step behind the card
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
card names its own call, and the step behind it is in the row's
[step window](#the-step-window) with `CircleHelp`, directly above the card —
unless newer steps — a later sibling call, a nested subagent — have pushed it
out; the card names its call either way. The second line names no call while
the window is drawn. Once answered, a card leaves the slot: whatever it
and its call become afterwards are drawn in the Process, in arrival order, as
they would be in a message — the one height change here, and it happens under
the user's own tap.

**A card from deeper down says who asked.** The slot gathers cards from every
depth, so the row above it names only the outermost subagent, and each card
names only its call: `Bash  rm -rf build/` under `Explore` reads as Explore
asking even when it was the `code-reviewer` Explore spawned. Approving a command
is a judgement about who wants to run it, so a card asked by anyone other than
the row it sits under carries an **asker line** above its row line, inside its
frame:

```
│ ⟳  ⧉ Explore  Find retry handling                         47s │
│    6 tool uses                                                │
│    ✓ Read   sender.go                                         │
│    ⟳ ⧉ code-reviewer  Review the diff                     12s │
│    ? Bash   go test ./relay/…                                 │
│ ┌ ?  Bash   go test ./relay/…                               ┐ │  Explore's own: no asker line
│ │    [Deny]  [Always Allow]  [Allow]                        │ │
│ ├───────────────────────────────────────────────────────────┤ │
│ │ ⧉ code-reviewer  Review the diff                          │ │  asker line
│ │ ?  Bash   rm -rf build/                                   │ │
│ │    [Deny]  [Always Allow]  [Allow]                        │ │
│ └───────────────────────────────────────────────────────────┘ │
```

- **Who asked is the subagent whose children the card is filed in.** No record
  has to name it, and none does: neither CLI's permission request names a parent
  (Claude's `can_use_tool`, Codex's approval request with its `itemId`), but the
  card takes the place of its call, and the call names its parent
  (`parent_tool_use_id` on Claude's frames, the spawn's call id on a Codex
  subagent thread's items — [code/frontend-state.md](code/frontend-state.md#a-subagents-children)).
  So the card already sits in the asker's `children`, and the walk that gathers
  cards for the slot (`collectPartsWithin`) has only to hand back, with each card,
  the subagent calls it passed through on the way down. Both CLIs, any depth,
  one rule; nothing new on the wire or in the record.
- **The asker is named as its own row names it.** Title and detail come from
  that call's `toolSummary` and are drawn through the same `Bot` mark, title
  span and `Detail` the subagent row uses — so the line matches, letter for
  letter, the row it points at once the user opens the Process. The title is
  what tells agents of different kinds apart, and the detail is what tells two
  of the same kind apart: two parallel `Explore`s are two descriptions. A Codex
  `subAgentActivity` spawn has no detail and needs little — its title is the
  agent's own path segment, which the model names per agent.
- **Only the asker, not the path to it.** A subagent's subagent's card names
  the innermost agent alone, not `code-reviewer › Explore`: the decision is
  about who runs the command, and the chain between it and the row above is one
  tap away in the Process, where the asker's row sits under its own parent. A
  breadcrumb would spend a 320px line on names the user is not deciding about,
  and at depth it would have to be cut anyway.
- **None on the outermost subagent's own cards, nor on the main agent's.** A
  card with no asker line was asked by the row it is under — a subagent's slot
  or, outside every slot, the main agent — which is how every card has always
  read. Labelling those too would put the row's own name directly under the
  row, on the commonest card there is, to cover a case it is not.
- **Its shape.** One line, `text-xs`, the card's own padding, above the row
  line and inside the warning frame — part of the card, since it is a fact
  about the request — with the title in `text-th-text-secondary`, not the
  accent: an accent title above the card's own `Bash` would make two rows of
  one card. Title capped as on the row (`max-w-[45%]`, `truncate`), detail
  truncating after it; the line never wraps, so a card is exactly one line
  taller for it, and only while it waits.
- **A screen reader hears it first.** The line is the card's first content in
  DOM order, so it is read before the call: the mark `aria-hidden`, a visually
  hidden `Asked by ` before the name — *"Asked by code-reviewer, Review the
  diff"* — then the card as it always reads. Being inside the outer item's DOM
  says which subagent row a card is under; it never said which subagent asked.
- **It goes when the card leaves the slot.** Answered, the card is drawn in the
  asker's own Process, where the rail already says whose it is, and it reads as
  any answered card does. A card still flat because its call has not been
  written yet (claude 2.1.286 asks first —
  [code/frontend-state.md](code/frontend-state.md#a-subagents-children)) is
  outside every subagent and has no asker line — for that moment it reads as
  the main agent's, the one case where the line cannot say who asked, because
  nothing on screen knows yet. When its call arrives and takes the card into the
  slot, the card arrives there with its line.

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
| `running` | spinner, `N tool uses` over its [step window](#the-step-window) | grows; its live children spin |
| `background` | spinner + chip, same line while children arrive | as running, for as long as children arrive |
| `success` | muted check, `N tool uses · <report>` and the tokens | settled |
| `error` | red, `N tool uses · <first line of what it returned>`; the body stays closed | closed; a failed call, if any, is red on its own row |
| `interrupted` | `Ban`, `N tool uses · <latest child>` once its window folds — on Codex as on Claude ([status by status](#status-by-status)) | settled |
| resumed after any of the three above | as `running`, until the resumed run ends ([status by status](#status-by-status)) | grows again; the new children spin |

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

## The remaining tool kinds

Every tool call says what it did without being opened,
or the reader misjudges what the agent is doing. Three Claude tools used to fall
to the generic row, and Codex used to drop five kinds of item without a row at all
([tool-call-model.md](tool-call-model.md#codex-items-beyond-commands-patches-and-mcp)).
Each now gets at least a row that says honestly what happened; the ones that
change files or fetch content get what their siblings get. Their titles and
details are in [the table](#title-and-detail), their summary verbs in
[the summary row](#the-summary-row); this is the rest.

| Tool | Second line | Body | Turn's changes |
|---|---|---|---|
| `NotebookEdit` | the usual rungs | `PathLine`, then the cell, then the result | yes |
| `TaskStop` / `KillShell` | the usual rungs | what was stopped, with `Go to call` | no |
| `BashOutput` | the usual rungs | the invocation, then the result as it came | no |
| Codex `WebSearch` / `WebFetch` | the usual rungs | the invocation, then the links a search reported, or a line saying nothing came back to show | no |
| `GenerateImage` | the usual rungs; a limit reached is rung 4 | the prompt, with the image as the row's attachment | no |
| `Sleep` | none | one line, *Asked to wait 30s* | no |
| `AgentControl` | the usual rungs | the prompt when there is one, then each agent's state | no |
| a dynamic tool | as an MCP call | as an MCP call | no |

**`NotebookEdit` is a file change, drawn the way an `Edit` is.**
`proposedChange` learns a `notebook` kind, read from the input alone like every
other kind, so the permission card that asks, the row that ran and the turn's
card that lists it say one thing. The body is `PathLine` (with *Open* into the
Files tab), then one `Section` for the cell, then the result:

| `edit_mode` | Section header | Content |
|---|---|---|
| `replace` (or absent) | `Cell <cell_id>`, and the `cell_type` when given | the new source, mono, clamped, with copy and ⤢ |
| `insert` | `New <cell_type> cell after <cell_id>`, or `at the top` with no `cell_id` | the new source, as above |
| `delete` | `Deleted cell <cell_id>` | the muted line *The deleted cell's content is not in this call.* |

It is the new source and not a diff, for the reason a `Write` over a file is not
one: the cell it replaced is not in the call. The header's `+N −M` and the
meta's are the counts [the turn's card](#the-turns-changes) reads. An input in
a shape this does not know — an older CLI's `cell_number`, any field beyond the
five, a mode beyond the three, or a source missing outside a delete — gets the
generic argument list, never a half-read cell. Drawn from the input, the cell
is there while the call runs, its counts uncoloured until the call succeeds
(and `not applied` once it fails); an empty source reads *Empty cell*. Among the
turn's changes the notebook's block is headed `Cell`, where an edit's is
`Change` and a `Write`'s `Content`.

**A stop points at what it stopped.** `TaskStop` keeps a row of its own — it is
something the agent did — and its body says what stopped. Claude answers in an
envelope as a fetch does (`message`, `task_id`, `task_type`, `command`,
claude 2.1.330), and the body reads it: the `message` as prose, then the
`command` in mono; any other shape as it came. When the record names an
`origin_tool_use_id` and that row is loaded, the result section's header carries
`Go to call` — the transcript's [jump](#from-a-file-to-the-calls-that-changed-it),
named *"Go to the call that started this task"* — and the jump leaves the row
it lands on as it is. The origin row says it was stopped through its own
outcome, as it always did; the stop does not reach into it. A failed stop (*No
background command with ID … is running*) is an ordinary failed row, rung 4.
"Loaded" is read over the whole transcript as it is now, so a stop whose origin
arrives on an older page gains the jump then
([code/frontend-state.md](code/frontend-state.md#a-fetch-filed-under-the-call-it-reads)).

**`BashOutput` is history and is drawn as history.** No current CLI offers it,
and its records never carried an origin, so it is the row a `TaskOutput` gets
when nothing could file it: named by its key, its result drawn as it came. It
is not filed under the shell it read by matching its `bash_id` against the
placeholder's sentence: that would be inferring a join from prose.

**A Codex web call shows what Codex reported, and says plainly when that is
nothing.** The row is Claude's — query or page, host and path. A search's
result arrives in Claude's shape, so the links it reported are drawn as a
Claude search's are, under *Results*. Codex reports no page text, and a search
may report no links; where a Claude call would have its result, the body then
has the muted line *Codex does not report what the search found.* (*…what the
page said.* for a page), in a section under the same label. An empty section
would read as a search that found nothing. Several queries are all listed in
the invocation, the first being the detail; a find-in-page names its pattern
there too.

**A generated image is shown as what it is: an image the agent made.** The
image is the row's attachment — the strip `imageView`'s result already draws,
with the same open-in-viewer — and the body is the prompt Codex used
(`revisedPrompt`), whole, in a clamped section headed *Prompt*. The prompt
arrives with the result (codex-cli 0.171.0's start names none), so while the
call runs the body says *Codex names the prompt it used once the image is
made.*, and once it has returned, the prompt is drawn once, as the result,
with no invocation above it — or, where the result named none, the body says
*Codex did not name the prompt it used.* rather than drawing an empty section. A failure reads its reason on the second line and
under *Result*: *Image generation limit reached*, then *· resets 14:05* when
the time is known — written by the server in its own time zone, the user's on
the machine Pockode runs on, and as *Nov 28 12:00* on another day. It is not
among the turn's changes: the file is under Codex's own directory, not the
work directory.

**`Sleep` is one line.** The row is enough — `Sleep`, then its time in the
meta, counting while it waits like any call, observed rather than reported. The
body says *Asked to wait 30s* from the input's figure (*250ms* below a second,
`formatDuration`'s words above) — not *Waited*, which a sleep cut short by Stop
did not — because a row that opens on nothing is a row that looks broken.

**`AgentControl` is a call about subagents, not a subagent.** It wears the agent
mark, since it is about agents, but it has no Process and no steps: it is one
call, settling once. A `wait` can run for minutes, so its spinner and counter
are the pulse a reader needs. The body has the prompt, when it sent one, in a
clamped Markdown section headed *Prompt*, then each receiver's last known
state under *Agents*, one line each as the server wrote it
(`/root/file_reader: completed`). Without a prompt the invocation lists the
call's arguments. In a group summary it is named by its title, `Used Wait`.

## Pockode's own work calls

An agent driving a story calls Pockode's work tools —
creates a task, starts it, marks a step done — and those calls were generic MCP
rows: `task_create`, a `pockode` chip, and whatever argument happened to come
first, often a story id. Nothing said which task was created, and nothing led to
it. Now each reads as what it did and leads to the work it did it to.

```
│ ✓  Create task  [pockode]  Design the row                    │
│ ✓  Start task   [pockode]  Design the row                    │
⌄ opened:
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Task  Design the row                                Open │ │
│ │ Result                                                   │ │
│ │   Started work 01a2… (session: 01a2…)                    │ │
│ └──────────────────────────────────────────────────────────┘ │
```

| Tool | Title | Detail |
|---|---|---|
| `story_create` / `task_create` | `Create story` / `Create task` | the `title` it was given |
| `story_start` / `task_start` | `Start story` / `Start task` | the work's title |
| `work_reopen` | `Reopen` | the work's title |
| `work_update` | `Update` | the work's title |
| `work_delete` | `Delete` | the work's title |
| `story_wait` | `Wait for tasks` | the story's title |
| `story_unwatch` | `Unwatch` | the story's title |
| `step_done` | `Step done` | the work's title |
| `work_comment_add` | `Comment` | the work's title |
| `work_comment_update` | `Edit comment` | the new text's first line |
| `work_get` / `work_comment_list` | `Get work` / `List comments` | the work's title |
| `task_list` | `List tasks` | the story's title |
| `story_list` | `List stories` | — |
| `agent_role_list` / `agent_role_get` / `agent_role_reset_defaults` | `List roles` / `Get role` / `Reset roles` | the `work_type` / the role id, mono / — |

`html_*` and `permission_verdict` keep [their own rows](#title-and-detail), and
the question tools their cards ([answering-ui.md](answering-ui.md)). The table
lives in one place (`lib/pockodeWorkTools.ts`), which `toolSummary`, `toolVerb`
and the body all read, so the row, the summary and the body cannot name a call
differently. The `pockode` chip stays, as on every Pockode MCP row: it is what
tells the user these are calls into Pockode, not into the project.

**"The work's title" is the one the call's [`workRef`](tool-call-model.md#a-call-on-pockodes-own-work)
carries** — what the work was called when the call was made — and, before the
result has brought one or on a record without one, the id from the input, in
mono. A creation needs neither: its title is its input. The title is never read
from the work store for the row. A row is a record of a call, and a record that
retitles itself when the work is renamed is the record lying about what it was;
the current title is one tap away.

The body's line says the kind its `workRef` carries, else the one the tool's
name fixes (`story_start`, `task_list`, …), else *Work* — a `step_done` from
before `work_ref` cannot say which. A creation from then has no id but in its
result prose, which the client does not parse, so its line has no *Open*; any
other old record opens by its input's id. Of the input, a call whose line
already says everything it asked (`step_done`, `work_get`, …) shows nothing
more, and a creation without a `body` likewise; the listings of every story or
role keep their arguments as any MCP call does. A work event line's `Subtask`
row is the same `WorkRefLine` (`components/Chat/WorkRefLine.tsx`); the body
reaches the overlay through `OpenWorkDetailContext`, provided beside the other
transcript contexts in `MessageList`.

**The body opens on the work, and the work is one tap further.** Its first line
is `WorkRefLine`: the kind (`Task`, `Story`, `Job`) muted, the title, and *Open*
— a text button in `text-th-accent` with a `touch-target` hit area, the word
`PathLine` uses for the same act — which opens the work's detail overlay by id
(`onOpenWorkDetail`, the overlay a work event's *Details* opens). That overlay
subscribes to the work by id, so it opens whether or not any page of the work
list holds it, in any worktree. Then the arguments worth reading — a creation's
`body` and a comment's text as clamped Markdown, an update's changed fields, a
start's `worktree` and `watch` — and then the result as it came.

*Open* is offered when the call succeeded and did not delete the work. A
`work_delete` has the line without it, and so does a failed call: its id may
name nothing, and an overlay that opens on *not found* is a dead end the row
put there. Its accessible name starts with its visible word: *"Open task Design
the row"*.

**No live status, on the row or in its body.** Not a status chip, not
`Step n/m`, not a spinner for a story that is running: the glyph is the call's,
and the call is over long before anyone reads it. Whether the work is still going is a
question chat stopped answering on purpose
([code/work-system.md](code/work-system.md#rendering-in-the-transcript)), and
the overlay one tap away answers it from the work store, live. A status drawn
here would have to be read from the store by id on every render to stay true,
which is the aggregate card the work event line replaced — and a row in a
transcript is the worst place to keep it current: a hundred `Start task` rows
would each be subscribing to a work.

**The later work event line leads to the same work.** When a task this session
started finishes, its parent hears it as a work event line, `Pockode · Subtask
done · Design the row`. That line now opens the subtask too
([code/work-system.md](code/work-system.md#rendering-in-the-transcript)), so the
row that started the work and the line that reported its end meet at one page.
Neither jumps to the other inside the transcript: what the reader wants from
either is the work, not the moment, and the call is usually pages above or not
loaded at all.

## A page the agent drew (`html_render`)

`html_render` is Pockode's own MCP tool: the agent passes a `title` and an
`html` document (or fragment) to show the user something richer than Markdown.
It arrives as an ordinary tool call — `mcp__pockode__html_render` from Claude,
`pockode:html_render` from Codex — with no event of its own. Both names of each
of the three page tools (`html_render`, `html_edit`, `html_get`), and which
state is a card, are `lib/htmlRender.ts`, and nowhere else.

**Every page has an id, and is never changed.** The server stores each page a
session draws as a snapshot and names it `p1`, `p2`, … in drawing order; the
call's `tool_result` record carries that id as `html_page`, and `html_page.get`
reads the stored page back ([how](code/work-system.md#rendering-tool)). A
change to a page is a new page: `html_edit` derives one from an earlier page,
which stays as it was. A page is the whole snapshot, never a base plus edits
replayed on display — a change to how edits apply would otherwise quietly
redraw an old page as something it never was. Ids can skip a number in a
forked chat, which never reuses one its source had drawn when it was forked.
A record with no `html_page` is a page from before pages were stored, and its
card is drawn from its call's input, as it always was.

**Two tools draw a card, the third only a row.** `html_edit` derives a new page
from an earlier one, and its input holds only the edits (`base`, `title?`,
`edits`), so its card reads the page from the server by the id on its result —
`html_page.get`, or `session_view.html_page` in a
[viewed transcript](cross-worktree-session-ui.md) — through `useHtmlPage`,
never refetched while cached and never subscribed to, since a page never
changes. An `html_render` card still draws from its input, which is the stored
page byte for byte. The base's card is left as it was: both pages stand in the
chat, each in its own card. An `html_edit` that succeeded without an id has no
way to its page and stays a row. `html_get` only reads a page back for the
agent and is always a row, its detail the id it read.

- **The id is in the header**, muted mono after the title — `p3`, or `p4 · from
  p2` for a derived page — because it is how the reader asks for a change
  ("make p3's bars blue"), and the agent understands nothing else as precisely.
  A card from before ids has none.
- **An edit's page loads as an attachment's thumbnail does**: not before the
  card is near the viewport, and the grey placeholder until it arrives, titled
  with the input's `title`, else *Loading page…*; `</>` and ⤢ wait for the
  page, since there is nothing yet to show or open.
- **A page that does not load says so**: *Couldn't load page p3: <the server's
  reason>* with *Retry*, in place of the page, as an `alert` — never a
  placeholder that would read as still loading. So an InvalidParams answer —
  `page not found`, `session not found` — is final and shown at once; a lost
  connection or an internal error is retried by itself first.

**It is a row until it succeeds, and then a card.** `running`, `background`,
`error` and `interrupted` are drawn exactly as any other call's, detail = the
title ([title and detail](#title-and-detail)): a page that never arrived is no
part of the reply. On `success` the call stops being a row part (`isRowPart`,
`lib/partTree.ts`), so it is a block of its own, like text: it ends the list
before it, starts a new one after it, folds into no group and counts in none.
It leaves the list at the moment it settles, which is the same moment a group
forms ([why](#why-a-group-forms-only-on-settled-calls)), so it is never first
folded and then pulled out. A subagent's Process goes through the same
`PartBlocks` and draws the same card.

```
┌──────────────────────────────────────────────┐  the list's frame, alone
│ ▢  Q3 Latency Report                 </>  ⤢  │  header, no fill
├──────────────────────────────────────────────┤
│ ⊘ Not loaded · cdn.jsdelivr.net       [Load] │  only when a host was refused
├──────────────────────────────────────────────┤
│                                              │
│    the page, white, as written, no padding   │  as tall as the page, ≤ 70%
│                                              │
├──────────────────────────────────────────────┤
│ ⤢ Full screen                                │  only when the cap cuts it
└──────────────────────────────────────────────┘
```

- **Frame**: the list's own `rounded-lg border border-th-border overflow-clip`.
  The header keeps the row's height floor and puts an `AppWindow` where the
  glyph column would be; the title is one `truncate`d line, `Untitled page`
  when empty, and whole in the viewer's title. No chevron: the card does not
  fold, it is the reply.
- **Hosts not loaded.** The strip of hosts the page was refused sits between
  the header and the page ([why](#the-sandbox-and-the-policy)). It is part of
  what `</>` hides, and the full-screen view shows its own.
- **`</>`** (`aria-pressed`, *Show source*) swaps the page for its source: the
  `CodeBlock` every other code uses, clamped at the main budget
  ([budgets](#budgets)), so the transcript keeps the drag. The frame is only
  hidden under it, never unmounted, so the page keeps its state and its scripts
  do not run again.
- **⤢** is always there, and last: unlike a section's, it does not wait for a
  cut, since a card is never the best place to read a page and nothing can tell
  whether it was read to the end. The viewer ([per kind](#per-kind-of-content))
  opens in the mode the card is in, titled by the page alone — the reader is
  reading a page, not a tool call.
- **Height** follows the page, up to 70% of the transcript's height
  (`TRANSCRIPT_HEIGHT_VAR`, as the budgets are, so a phone on its side does not
  overflow), and past it the page scrolls inside itself. A body refuses a
  scroller of its own ([the body](#the-body-problems-2-and-3)), but a frame
  cannot be cut and then opened in place as a body is: opening it would put a
  page of any height into the transcript. Its scrollbar
  is invisible on a phone, so once cut the card says so itself with *⤢ Full
  screen* under it. A frame has no height of its own to measure — it is another
  origin — so the card appends **one small script** to the page that posts the
  document element's height on every resize — its scroll height instead once
  that passes the frame, since a page pinned to its frame (`html, body {
  height: 100% }`, common in generated pages) keeps its content in the
  overflow; only messages whose `source` is
  that page's own window — inside [its wrapper](#the-sandbox-and-the-policy) —
  are taken, 0 is ignored (a hidden or momentarily
  blank page), and the floor is 48px. The cap is CSS (`min(<reported>px,
  calc(… * 0.7))`), so it moves with the transcript, and a page that is
  `min-height: 100vh` — or pinned to 100% with the body's default margin, which
  overflows the frame by that margin — settles at the cap instead of growing
  with its frame.
- **Width is the chat pane's, not the reading column's.** Prose reads best at
  the column's 768px ([agent-chat.md](agent-chat.md)), but a page is a
  dashboard, a table, a timeline as often as prose, and squeezed to the column
  on a desktop it wastes most of the screen. So a reply's card takes the
  transcript's width inside its gutters, up to 1280px — past that a desktop is
  mostly margin — centred on the transcript like the column it leaves
  (`WIDE_BLOCK_STYLE`, `Chat/transcriptWidth.ts`; the width is
  `TRANSCRIPT_SPAN_VAR`, which `MessageList` publishes beside the height). It is
  never narrower than the column, so on a phone, where the pane is narrower than
  768px, nothing changes. Everything in the card goes with it — the source, the
  placeholder, the strip, the error. Two kinds of card stay in the column: one
  inside a subagent's Process, which stays in the box it was drawn in, and
  every card under an extension that puts an avatar beside the column or a
  bubble around it, since a card centred on the pane would cover the one or
  break out of the other.
- **A page wider than its card scrolls sideways, inside itself.** The card and
  the transcript never get wider: the page's own document scrolls, in the card
  as in the full-screen view, which needed nothing new. A vertical swipe is not
  caught by it: the browser locks a gesture to the axis it started on, and a
  page with no vertical room to scroll hands it on to the transcript, so no
  `touch-action` or script is involved. Where a scrollbar takes room (desktop
  Linux and Windows), the reported height adds it back, or a wide page would
  also scroll down by the scrollbar's height.
- **The agent is told a range, never the width.** One page is opened on a phone
  and a desktop, today and next month, so no width the card had once is the
  page's width. Both `html_render`'s description and the
  [HTML-first guidance](code/agent-integration.md#html-first-sessions) say the
  same thing — about 320–1280px, a fluid layout usually suits, and what is wide
  by nature (big tables, timelines, diffs) may be drawn wide, since it scrolls —
  and `TestHTMLRender_WidthMatchesTheHTMLFirstGuidance` keeps the two ranges
  equal. It is a recommendation: nothing measures or refuses a page by its
  width.
- **Mounted near the viewport, never unmounted.** Opening a long session must
  not run every old page at once, so a frame mounts only when its card comes
  within 200px of the viewport (`useInView`); before that it is a
  `bg-th-bg-secondary` placeholder — grey, because a white block that has not
  loaded glares in the dark theme. The placeholder takes the page's last
  measured height, kept by call across remounts (160px the first time), so a
  reopened session does not jump as frames arrive. Once mounted the frame
  stays: unmounting would throw away what the user did in the page.
- **White, unless the page follows the theme.** A page that does not use the
  `--pk-*` variables is a sheet of paper: the frame is `bg-white` under
  `color-scheme: light` — without it a dark parent paints the canvas dark under
  a page that assumed white — and in the dark theme it reads as paper on the
  transcript, deliberately, the only colour here that is not a `th-` token. A
  page that uses them is drawn in the theme instead
  ([theme](#theme-a-page-that-asks-for-it)).

### The sandbox and the policy

The page is drawn **as the agent wrote it**: no filtering, and no base
stylesheet unless the page asks for one by using the theme's variables
([theme](#theme-a-page-that-asks-for-it)) — only the base and the absolute
paths that let it reach [project files](#project-files), and the bridge that
lets it [send](#sending-to-the-agent).
It is the agent's own output, written for the user, and every rule added on top
of how it looks would be a page that renders wrong for a reason nobody can see.
Two things are protected instead, and neither is the page: Pockode around it,
by a sandbox; and the reader's data, by a policy that lets the page reach no
host the reader has not allowed for it — the rule every surface follows
([markdown-images-ui.md](markdown-images-ui.md#external-requests-wait-for-the-reader)),
and for a page, with its strip, wrapper and security boundary, in
[page-external-hosts-ui.md](page-external-hosts-ui.md). Both are in
`HtmlFrame.tsx`, the one frame component the card and the viewer share, which
takes the policy from `lib/pageHosts.ts`. The frame the app holds is a wrapper whose one child is the page:

```
<iframe srcdoc="<policy><wrapper's listener>
                <iframe srcdoc='<policy><base><reporter>[<bridge>][<base stylesheet>]…the page…<height script>'
                        sandbox='…'>"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox[ allow-forms]">
```

The bracketed parts are only in a page that asks for them: the bridge in one
that [sends](#sending-to-the-agent) or follows the
[theme](#theme-a-page-that-asks-for-it), `allow-forms` on both frames of one
that sends, the base stylesheet in one that follows the theme. A page that
asks for nothing is drawn as it was before either existed.

The floor is `HTML_FRAME_SANDBOX`, on both frames:

- **Never `allow-same-origin`.** A `srcdoc` frame inherits its parent's origin;
  with this token it would keep it, and read Pockode's stored credentials and
  open its WebSocket. That socket drives the agent — which runs commands on the
  user's machine — so a page in a message would be a way to run anything there.
  This is the class of hole Open WebUI's CVEs were. Without it the frame is an
  opaque origin, which is also why its height has to be posted rather than
  measured.
- **Never `allow-modals`.** Pages stay in the session, and every one mounts
  again when the session is reopened; a page with an `alert` or `confirm` would
  throw it up from an old message each time.
- **`allow-popups` and `allow-popups-to-escape-sandbox`** so a link the user
  presses opens in a new tab as a normal page, not a crippled one.
- **`allow-forms`, only on a page that sends** (`AGENT_PAGE_SANDBOX`), so a
  form can send; the three guards that keep a submission from going anywhere
  are in [forms in a page](#forms-in-a-page). Every other page keeps the floor.

`HtmlFrame.test.tsx` holds both forbidden tokens out, on both frames.

The sandbox does not hold back a page's requests; the policy does. It is a
`<meta>` at byte 0 of both documents, so it is in force before anything the
agent wrote, and the wrapper's `frame-src 'none'` keeps the page from leaving
its frame for a host by navigating itself
([how](page-external-hosts-ui.md#the-wrapper)).

### Project files

A page reaches the project it was drawn in, as an `.html` file opened in Files
does ([file.md](file.md#html-pages)). The screenshots, recordings, sounds and
data an agent has just produced are already files, so its page names them by
path instead of carrying their bytes, which the transcript would keep for good
([the 256KB cap](code/work-system.md#rendering-tool)).

- **Through the worktree's root.** Before drawing, the frame asks for the
  [raw capability](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)
  for the root of the worktree that `.html` file previews load through
  (`PROJECT_TARGET` in `HtmlFrame.tsx`). It puts a `<base href>` to it right
  after the policy, unless the page sets a `<base href>` of its own, which is
  the one it was written against. So a relative URL — an image, a video, a
  sound, a stylesheet, a script, a CSS `url()`, a `fetch("data.json")` —
  resolves against the root of the worktree, the base a Markdown image in chat
  resolves against too. The policy names the capability and nothing else of
  the server ([the policy](page-external-hosts-ui.md#the-policy)), and what the
  root scope withholds — `.git`, `.env`, `.envrc` and their `.*` variants,
  other worktrees, Pockode's data — does not load; any other dot path does,
  as any file would.
- **Absolute paths under the work directory** are made relative before the
  page is drawn (`projectRelativeHtml`, `lib/htmlRender.ts`), since an agent
  names the file it saved by its full path as often as not: bare, as a
  `file://` URL, and on Windows with either separator and in any case. Only a
  path right after `src=`, `href=`, `poster=`, `data=`, `srcset=` (its first
  candidate), `xlink:href=` or `url(` is rewritten, wherever that text stands;
  a path anywhere else — in the page's prose, or as a script's own string — is
  left as written, since the page cannot be parsed the way the browser will.
  So `fetch("data.json")` reaches the project and
  `fetch("/home/…/repo/data.json")` does not. A rewritten path resolves against
  the page's own `<base href>` when it sets one, so there it does not reach the
  project. Any other absolute path — outside the work directory, or in another
  worktree — stays out of reach.
- **Which worktree.** The one the user is in, also while viewing another
  worktree's session read-only
  ([known gaps](cross-worktree-session-ui.md#known-gaps)). A page drawn
  while a worktree switch is still landing may get the capability of the
  worktree being left — unlike a download, the frame does not check whom its
  capability serves; a Reload once the switch has landed draws it from the new
  one.
- **The frame waits for it.** While connected, the frame is drawn only once the
  capability has arrived — one request, cached under the same key as an `.html`
  preview with no hosts allowed — so a page is never drawn first without its
  files. Offline it does not wait: the page is drawn with no base and no reach
  into the project, its project requests are refused, and the strip lists the
  app's own host, which cannot be allowed. A request for the capability that fails draws the page the same way,
  under a `PageNotice` below the strip that says so:
  `Project files won't load on this page: <error>`.
- **Each document asks again.** Every document drawn — a Load or a Reload in
  the strip, the full-screen view, the card mounted again in a reopened session
  — takes the cached capability only while it has at least five minutes left
  (`fresh`, `useRawMediaSource`) and a new one otherwise, so a page drawn hours
  later is not drawn under one that has expired. A page already on screen is
  never redrawn for a capability — not on a renewal, not on a worktree switch —
  so once its own has expired
  ([its lifetime](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself))
  its later project requests fail with nothing said until the page is drawn
  again; a page drawn offline stays without the project until then too.

**Known limits.** An unclosed `<script>` or `<!--` in the page swallows the
appended script, and the card stays at its placeholder height (⤢ still reads
it). While focus is inside the page, keys go to the page's document, so Escape
never reaches the viewer — ✕ closes it. A link in the page does not navigate
the frame, except into the page itself (`#section`): it opens in a new tab, on
the reader's tap or from the strip
([links](page-external-hosts-ui.md#links-inside-the-page)). A frame scrolled out of view is
throttled by the browser and reports nothing until it comes back. A page whose
script widens it later without changing its height is not measured again, so
where a scrollbar takes room it may cover the last line; a phone's overlay
scrollbar does not. The height reporting, the scrollbar's room in it and the
sideways scroll are watched in Chromium and WebKit
(`HtmlRenderCard.browser.test.tsx`; WebKit draws the page's styled scrollbar,
headless Chromium hides it), not on an iOS device.

### Sending to the agent

A page can send something to the agent — the canvas branch's contract
(`feature/canvas-mode`, `docs/canvas-ui.md` §6.1 and §8 there), adapted to many
cards in one transcript instead of one canvas. **Most of what the reader does
in a page never reaches the agent**: switching a tab, filtering, expanding,
editing a value are the page's own scripts. A send is for what needs the agent
— *approve this*, *try the second option*, *redo it with these values* — and
each one is a user message that starts or joins a turn.

**Every card that sends can send whenever, an old one too.** The message
names the page it came from, so a press on `p2` while `p5` is the latest is not
ambiguous: the agent is told it is `p2`, and can `html_get` it.

**A page sends when its HTML says it does**: it contains `data-pk-send` or
`pockode.send` (`sendsToAgent`, `lib/pageBridge.ts`), read from the page as
stored, as the theme's test is ([below](#theme-a-page-that-asks-for-it)). Only
such a page gets the bridge's send and `allow-forms`; any other keeps the
floor, so a page that never meant to send — every page stored before this —
keeps its forms exactly as they behaved: in Chromium dropped before their
`submit`; in WebKit `submit` fires, then the sandbox blocks the submission,
with `form-action` behind it. A page that reaches the function
some other way (`window["pock" + "ode"]`) is not one the test sees; the tool
descriptions say to write it plainly. A card with no page id — from before ids
— has no page to name and is drawn as a page that does not send, whatever its
HTML says: the floor and no `pockode`; it gets the bridge only for the theme,
when it [asks for that](#theme-a-page-that-asks-for-it).

#### In the page

Three attributes and one function — `docs/canvas-ui.md` §6.1, taken as it is,
table, precedence and all:

| Markup | Sends | When | Data |
|---|---|---|---|
| `<button data-pk-send="approve">` — any element but a `form`, `input`, `select` or `textarea`; a `div` or `li` is made a button | `approve` | click on it or inside it (`closest`), but not on a field or `label` inside it | in a form, its named fields; plus `{ [name]: value }` when the element has a `name` |
| `<form data-pk-send="create">` | `create` | submit — a submit button, or Enter in a text field | the form's named fields, and the submitter's `name`/`value` |
| `<input data-pk-send="search" name="q">` | `search` | Enter | `{ q: <value> }`, `{ value: <value> }` without a `name` |
| `pockode.send(action, data)` | `action` | when called | `data`, any JSON value; `{}` when omitted |

What is copied unchanged, with the canvas's reasons:

- the nearest `data-pk-send` wins, so one press never sends twice; Enter in an
  `<input data-pk-send>` sends the input's action only;
- **Enter while an input method is composing** (`isComposing`, or `keyCode`
  229) sends nothing — it confirms a Chinese or Japanese word;
- an element that sends but is not a button gets `role="button"` and
  `tabindex="0"` (only where the agent set none), Enter on keydown and Space on
  release, and gives them back when it stops sending;
- form data is `FormData` — a repeated name an array, files left out,
  unchecked boxes absent; a disabled element sends nothing; a held Enter sends
  once;
- an `<input data-pk-send>` is cleared once the send is accepted, and keeps its
  text when it is refused or when the reader typed on meanwhile;
- `pockode.send` returns a `Promise`: resolved once the server accepted the
  message, rejected with an `Error` whose `code` is one of the reasons below
  and whose `message` is a sentence the page may show. `data` goes through
  `JSON.stringify` / `JSON.parse` in the bridge, so what is sent is what the
  agent reads; what JSON cannot hold rejects with `invalid`, unsent.

What differs from the canvas:

| | Canvas | Chat card |
|---|---|---|
| Where it came from | `revision`, the app's record of what the frame shows | `page`, the card's id (`p3`) — the app's, never the page's: a page cannot claim to be another |
| Size | `canvas_size` on every message | none: the agent is told a range ([width](#a-page-the-agent-drew-html_render)) |
| Before the reader has used the page | sent; a send on load runs on every device | refused, `inactive` ([below](#a-send-before-the-page-was-used)) |
| Read-only frame | the history view | a session viewed from another worktree |
| `data-pk-blocked` on the page's root | reflects whether sending is possible | not offered: every refusal is answered on the send itself |
| Patches, focus reports | yes | none — a card is never redrawn in place |

#### The bridge

`pageBridgeScript` (`lib/pageBridge.ts`, from the canvas branch's
`canvasBridge.ts`) runs in the page after the reporter and before the agent's
markup, in every card and full-screen view of a page that sends or follows the
theme. In every such page it reports when the page is ready and applies the
theme the app posts (in a page that follows it). In a page that sends it also
defines `window.pockode.send` and nothing else; takes `click`, `submit` and
Enter in the capture phase on the document, so markup added later needs no
wiring; makes buttons of sending non-buttons; and, last in the bubble phase,
cancels a submit nobody handled ([forms](#forms-in-a-page)). It posts
to the app (`parent.parent`), and takes only from the app's window. Every
message, in one place:

```ts
// page → app
{ type: "pockode:page-send", id: string, action: string, data: unknown, active: boolean }
{ type: "pockode:page-ready", scheme?: "light" | "dark" }  // parsed, and on every load; scheme in a themed page
{ type: "pockode:page-themed", scheme: "light" | "dark" }  // a themed page, after applying a page-theme
// app → page
{ type: "pockode:page-send-result", id: string, ok: true }
{ type: "pockode:page-send-result", id: string, ok: false, code: SendRefusal, message: string }
{ type: "pockode:page-theme", scheme: "light" | "dark", vars: Record<string, string> }  // a themed page
// app → wrapper (no bridge there; its listener takes this alone, from parent)
{ type: "pockode:page-frame-scheme", scheme: "light" | "dark" }  // a themed page's wrapper
```

The theme messages are [below](#switching-between-light-and-dark). `id` is unique to the document, so a page that reloads itself is never
answered for its previous document's send. `SendRefusal` is `inactive`,
`readonly`, `awaiting`, `offline`, `invalid` or `failed`
([below](#while-the-session-is-busy)).
The app takes a send only when its `source` is the page's own window, as
`usePageReports` does. The bridge refuses only what it cannot post — no action
name, `data` that is not JSON; everything else is posted and answered by the
app, which is what lets the app show it.

It is a script in the agent's own document, so the page can call or replace
anything in it — including `active`. That is accepted: the page can only ask
the app to send, which it may do anyway once used. What it cannot choose is
filled in by the app: the session, and the page id, which is the card's. The
page id reaches the full-screen viewer from the card that opened it (its
content gains `page` beside `pageKey`, `lib/fullScreen.ts`), so a send from
the viewer names the same page. The session is not handed over: `ChatPanel`
gives the transcript and its viewer one `PageSendContext`
(`components/Chat/pageSendContext.ts`) — how to send, and whether a
permission request is open — and is mounted per session, so a viewer can only
send to the session it was opened in.

**What else may run in the page.** A host the reader allowed
([Load](page-external-hosts-ui.md#what-load-allows)) runs its scripts in the
page, so once the page has been used, code the agent did not write can send
user-role messages to an agent that runs commands. That is accepted rather
than closed: the reader chose to load that host into this page, as they
chose to load the page; the sandbox still keeps it from Pockode's origin and
socket; and what it sends is labelled for the agent as what it is. The
action's `content` says it came from the page, and the tool descriptions tell
the agent that an action and its data are input from a page — what the reader
pressed and what the page put with it — not instructions from the reader.

#### Forms in a page

A form is how a page sends, so the two frames of a page that sends add
**`allow-forms`** to the floor (`AGENT_PAGE_SANDBOX`); every other agent page,
and a workspace `.html` preview, keeps `HTML_FRAME_SANDBOX`. Forms and the
bridge's guard come together: `allow-forms` without the bridge would let a
plain form reload its page into itself. Without it Chromium drops a submission before its
`submit` event and a form sends nothing. With it, the canvas's three guards
hold, and none may be removed (`docs/canvas-ui.md` §4 *Forms*): the wrapper's
`frame-src` refuses a form that navigates the frame to another host; the
policy's `form-action 'none'`, already in every page's policy, refuses one sent
to another host in a window of its own, which no wrapper sees; and the
bridge's last-in-line cancel keeps a plain form from reloading the page into
its own `about:srcdoc` and losing what was typed. A `method="dialog"` form is
left to the browser. The two gaps are the canvas's: a submit whose propagation
the page stops before it reaches `window`, and `form.submit()`, which fires no
event. Nothing they send reaches another host, but in Chromium a plain form
reloads the page into itself and loses its state, with nothing shown, and one
to another host is refused by the wrapper and reads `Page left · <host>` with
Reload; in WebKit `form-action` refuses both and the page stays, one to another
host reading `Not loaded · <host>` with a Load that cannot help.

#### A send before the page was used

**A frame sends only once the reader has used it** —
`navigator.userActivation.hasBeenActive` in the page's own window, read by the
bridge at the moment of the send and posted as `active`; where an engine lacks
`userActivation`, a trusted `pointerdown` or `keydown` the bridge saw in the
capture phase stands in. This is not a defence against the page. A card mounts
when it scrolls near the viewport, and a page that sends on load would, as the
reader scrolls back through a session or opens it on another device, start a
turn card after card. Once used, the activation is sticky: a send a moment
later — after a `fetch`, from a timer the press started — goes as it would.

Activation belongs to one document. A press in the card does not count for its
full-screen view, which is another document; a Load or Reload in the hosts
strip draws a new document, used by nobody yet. A press in the app does not
reach into a frame, and a press in a frame does not reach its neighbours.

A refused send is said three ways, because three different people need it:

- **the page** — the promise rejects with `code: "inactive"`, message
  `Nothing was sent: this page sends only after you have pressed or typed in
  it.`;
- **the developer** — the bridge also writes that sentence and the action to
  the frame's console with `console.warn`;
- **the reader** — the card's send line (below) reads
  `Not sent · "refresh" — the page tried to send before you used it`, muted,
  not an alert: nobody pressed anything, so nothing is announced, but a page
  that misbehaves on load is not hidden either.

#### While the session is busy

- **A turn running**: the send is an ordinary mid-turn message and folds into
  the running turn at its read point
  ([agent-event.md](agent-event.md#the-read-point-message_ingested)), exactly
  as typing would. It is not queued, held or refused: pressing *Try option B*
  while the agent is still writing option A is a thing the reader means.
- **A turn blocked on a permission request**: refused, `awaiting`, `Answer
  the permission request first.` Both CLIs read nothing while one is open, so
  the server refuses any message then (`chat.ErrTurnAwaitingAnswer`, which is
  `TurnState.AwaitingUserAnswer()`, a permission blocker and nothing else); the
  app checks first — `PageSendContext.awaitingPermission`, the same test
  `ChatPanel` hands the input to the permission prompt by (`promptOwnsInput`:
  the turn is `blocked` and one of its `blockers` is a `permission`) — so the
  refusal is immediate. An open `question_post` question does not
  block — a typed message may answer it, and a send is a message — nor does a
  turn parked on background work.
- **Not connected**: refused, `offline`, `Not connected — try again when the
  connection is back.`
- **A session viewed from another worktree**: refused, `readonly`, `This
  session is read-only here.` — its cards draw, but nothing can be sent to it.
  Read-only is where the transcript is read from (`useSessionView()`,
  `lib/sessionView.ts`, as `useHtmlPage` already asks), not a fact about the session
  ([cross-worktree-session-ui.md](cross-worktree-session-ui.md)), so a send
  from such a card is refused on receipt and `chat.html_action` is never
  called from it.

The app refuses in that order on the client — `inactive`, `readonly`,
`awaiting`, `offline` — then calls `chat.html_action`
(`useChatMessages().sendHtmlAction`, which echoes the bubble at once and takes
it back when the server refuses). Between `readonly` and `awaiting`, a frame
drawn with no `PageSendContext` around it has nowhere to send and answers
`failed`, `This page can't send from here.`; in the app every transcript has
one. The server's own
permission refusal carries `data.reason: "awaiting_permission"`, so the race
the server check exists for — a permission request that arrived after the
client looked — still reads `awaiting` with the sentence above; any other
`InvalidParams` answer is `invalid` with the server's words, any other failure
`failed` with the error's message. Every send is answered, so no promise is left pending.

#### The card's send line

What became of the card's last send is one line **under the page**, above
*⤢ Full screen* when that is shown, in the app's document — the place the
press was made, which on an old card may be far from the bottom of the
transcript where the bubble lands:

```
├──────────────────────────────────────────────┤
│   …the page…                                 │
├──────────────────────────────────────────────┤
│ ✓ Sent "approve"                             │  muted
│ ⚠ Not sent · "approve" — Answer the permiss… │  error colour, role="alert"
└──────────────────────────────────────────────┘
```

- One line, the latest outcome only, `truncate`d; the whole sentence is its
  `title` and its accessible text. It replaces the previous outcome. It is
  kept by call in memory, as the card's measured height is, and is shared by
  the card and its full-screen view: the latest send from either document of
  the page. It goes when the app reloads — the reader's memory of this
  sitting, not part of the page.
- From the press to the answer it reads `Sending "approve"…`, muted, so a slow
  round trip is not a press that did nothing; the page's own element is not
  disabled meanwhile — the page decides that, from its promise.
- It goes with the page under `</>`: hidden with the page and *⤢ Full
  screen*, and back as it was when the page is.
- `Sending…` and `Sent` are muted and polite (an `<output>`, role `status`); a
  refusal after a press is in the error colour and `role="alert"`; `inactive`
  is muted and silent, as above, in neither region. Both regions are mounted,
  empty, from the frame's first render on, and a line is put into one or the
  other: a live region that appears already holding its text, or whose role
  changes under it, is announced unreliably (`PageSendLine.tsx`; the memory is
  `lib/pageSends.ts`).
- The full-screen view shows the same line under its page. A send from it
  lands under the viewer; the viewer stays open, and the card shows the same
  line when it is closed.
- **The transcript does not jump to the bubble.** Following the bottom it
  follows, as for any message; scrolled up on an old card it stays there, and
  the line is the confirmation. Moving the reader away from a page they are
  working in, on every press, would be the worse failure.

#### Under a layer

A press meant to put away a panel with no backdrop must not also press a
button in a card under it and send. While a layer of the app's own is drawn
over the transcript, each frame lies under a `FrameShield` — the canvas
branch's (`docs/canvas-ui.md` §4 *Under a layer*) — so the press lands in the
app's document and the page never sees it. `FrameShield`
(`components/ui/FrameShield.tsx`) reads `useIsDrawnOver` from
`@pockode/shared` — whether a layer is drawn over the surface the frame is on,
which `useIsPageCovered` alone does not say for a frame inside a sheet; the
rule is in [answering-ui.md](answering-ui.md#who-owns-the-dismissing-click).
**Only the
frames of pages that send take it**: under a layer a shielded page cannot be
pressed or scrolled, which for a page that cannot send would be a change with
nothing to prevent. The strip
and the send line are the app's already and are not shielded. The full-screen
view is a layer over the cards, which are shielded under it, but not over its
own page: that one is shielded only by a layer opened over the viewer.

#### The action message

What reaches the agent is a **user message with a structured page action**:
the `message` record, origin user, with one field added, as `command` is:

```jsonc
{
  "type": "message",
  "content": "Page action \"approve\" from p3:\n{\"id\":\"42\"}",
  "html_action": { "page": "p3", "action": "approve", "data": { "id": "42" } }
}
```

- `content` is what the agent reads (`htmlpage.ActionText`): the action
  quoted, the page, then `data` as compact JSON on the next line — `{}` when
  the page sent none; a `null`, a string, a number or an array the page sent
  is kept as it is. The card's id is the one the agent already knows from the
  tool result. Quoting the action, refusing control characters in it and
  compacting the data keep a page from writing a second line that would read
  as anything but its data.
- It is an event: it says what was pressed on which page, and nothing on it
  changes later. A forked chat keeps the source's ids, so it still names the
  right page there.
- **It never becomes a draft**, for the canvas's reason (`docs/canvas-ui.md`
  §6.2): a fork anchored on it drops it and leaves the input empty, a
  discarded one is drawn discarded with no restore, and a turn it opened that
  failed on sign-in offers no *Send again*. The reader presses the page again
  instead.

```
chat.html_action {
  session_id: string,
  page: string,            // the card's id, "p3"
  action: string,          // 1–128 characters, no control characters
  data?: unknown,          // any JSON; omitted = {}; at most 64KB compacted
} -> MessageResult         // chat.message's, plus html_action echoed back
```

Refusals are `InvalidParams`, checked in this order, and leave nothing
behind:

1. `session not found`;
2. `page must be a page id such as p1, not "<page>"` — digits only after the
   `p`, and no leading zero (`htmlpage.ParseID`), so `p+3` or `p03` cannot
   reach `p3` while the record says otherwise;
3. `action must be 1–128 characters with no control characters`;
4. `data is <n> bytes, over the 64KB limit`;
5. `page p9 does not exist in this session` — any page the session has, not
   only the latest;
6. `chat.ErrTurnAwaitingAnswer`'s message, unchanged, with `data.reason:
   "awaiting_permission"` (`rpc.ChatErrorData`) so the client can tell it
   apart without reading the words ([above](#while-the-session-is-busy)).
   `replyErrorForChat` adds the reason for every chat send refused this way,
   `chat.message`'s too.

It takes the typed
message's path — refused before anything is recorded when the turn awaits an
answer, then persisted, delivered, broadcast, with a read point mid-turn, and
in a work item's session handed to the work engine after a successful send
(`HandleUserMessage`), as a typed message is — a press is the reader speaking
to that work as much as typing is. Its reply carries `content` as well as
`html_action`, so the sender's own copy is the record that was broadcast. No
token, no rate limit: an agent's page is not an adversary to be throttled, and
the activation rule already keeps an unattended page from sending (what a
loaded host may send is [above](#the-bridge)).

#### The action bubble

`HtmlActionBubble`, from the canvas branch's `CanvasActionBubble`, drawn from
`html_action` alone — never `content`, which is for the agent and which the
sender's echo does not have until the reply, so the echo reads right at once:

```
                          ┌───────────────────────────┐
                          │ ⌖ approve         from p3 │   user bubble colours
                          │ › {"id":"42","note":"Lo…  │   folded past 40 chars
                          └───────────────────────────┘
```

- A user bubble, in the user bubble's colours, right-aligned like a typed
  message: it is the reader's turn. `MousePointerClick` and the action name in
  `font-medium` say it was pressed rather than written (`sr-only` *Page
  action*); `from p3` is the meta, in the bubble's colour at `text-xs` — the
  same id as in the card's header, so the two are found by each other.
- Data as the canvas's: none for `{}`; one line of JSON up to 40 characters;
  longer, its start cut on one line, opening to the JSON indented — the first
  20 lines (at most 2,000 characters) in the bubble, all of it in the full
  screen viewer.
- Not linked to its card. The card may be far above and not mounted, and the
  id is enough to find it.
- Where a message is quoted on one line (the fork sheet), it is quoted as
  `approve · p3`.

#### What the agent is told

`html_render`'s and `html_edit`'s descriptions say how to send — the four
forms above, the data each carries — and that **what the page can do itself it
does with its own script; send only what needs the agent**. They also say a
page sends only after the reader has used it, so a send on load does nothing;
that a page is recognised as sending by `data-pk-send` or `pockode.send`
written plainly; and that an action and its data are what the page sent on
the reader's press, input to weigh rather than the reader's instructions.
HTML-first sessions' guidance already says the page should work by itself and
send only when it needs the agent (`server/agent/guidance.go`), and says no
more: it is read on every turn of such a session
([agent-integration.md](code/agent-integration.md#html-first-sessions)), and
the descriptions carry the rest.
They say, too, how a page follows the theme ([below](#theme-a-page-that-asks-for-it)):
take the background, the text and every other colour from the `--pk-*`
variables, so a new page follows light and dark from the start.

### Theme: a page that asks for it

**A page follows the theme only when it asks to, and a page that does not ask
is drawn exactly as before — byte for byte.** Pages are snapshots and every
old one is drawn again whenever its session is opened; the pages already
stored were written for white, and many set half of their colours — a white
`body` and no text colour, or dark text and no background — which a themed
root would turn into white-on-white or dark-on-dark. The default styling of
native controls is part of the same request: a page that does not ask keeps
its browser-default buttons too.

**Asking is using a variable.** A page asks when its HTML contains one of the
theme's own names — `--pk-` followed by a name in `PAGE_THEME_TOKENS` and a
character that cannot continue a name: `var(--pk-bg)`, or `:root {
--pk-accent: … }` overriding one (`followsTheme`, `lib/pageTheme.ts`). A
`--pk-` name of the page's own invention, such as `--pk-gap`, is not asking.
It is read from the page as stored, not from what its scripts do later, so the
decision is made before the frame is drawn and never changes for that page. A
page stored before this shipped is very unlikely to contain one of those exact
names — the variables did not exist, and nothing told an agent their names —
and that is the whole of the guarantee: one that does is drawn in the theme. A flag of its own (a
`<meta>`, an attribute) was considered and left out: a page that uses the
variables and forgets the flag would be drawn with them undefined, and a page
with the flag and no variables gains nothing from it. The price is the rare
page that only *mentions* `--pk-` in its prose; it follows the theme, which it
can still override.

For an `html_edit` page the test reads the derived page whole, as it is drawn,
so an edit that introduces the variables opts the new page in and leaves its
base as it was.

#### What a page that asks gets

The canvas's styling, as it is (`docs/canvas-ui.md` §3.3 and §8.4), so the two
are one contract to the agent:

- **The variables** — `--pk-bg`, `--pk-bg-secondary`, `--pk-bg-tertiary`,
  `--pk-text`, `--pk-text-secondary`, `--pk-text-muted`, `--pk-border`,
  `--pk-accent`, `--pk-accent-text`, `--pk-accent-hover`, `--pk-success`,
  `--pk-error`, `--pk-warning`, `--pk-code-bg`, `--pk-code-text` — each the
  computed value of the `--th-*` token the canvas maps it to, in the palette
  and scheme shown now. The names are a promise to every page ever drawn, so
  the list lives once (`PAGE_THEME_TOKENS`) and a test holds the tool
  descriptions to it.
- **The base stylesheet**, after the reporter and the bridge and before the
  agent's markup, in `@layer pockode-base` and entirely inside `:where()`, so
  any rule of the agent's wins: `:root` gets the variables, `color-scheme`,
  `background: var(--pk-bg); color: var(--pk-text)` and the accent as
  `accent-color`, for the controls left native (checkboxes, radios, ranges);
  buttons and fields get
  the theme's fill, border, radius, focus ring and the 44px floor under a
  coarse pointer; a `[data-pk-send]` button and a sending form's submit take the
  accent; hover only under a fine pointer; disabled dimmed. Nothing else of the
  document: no font, no margin, no layout.
- **A frame in the theme.** The frame element is `bg-th-bg-primary` under the
  theme's `color-scheme`, the wrapper transparent, so where the page does not
  paint, the transcript's ground shows — never white. The card's border keeps
  it a card.

A page that does not ask gets none of these — no variables, no base
stylesheet — and the white frame. Whether it sends is a separate question
([sending](#sending-to-the-agent)): a white page may send, and a themed page
need not. Nor does following the theme need a page id: a card from before
ids, which never sends, follows the theme if its HTML asks.

**The full-screen view follows the same rule**: a page that asks is drawn
there on `bg-th-bg-primary` under the theme's scheme, one that does not on the
white it has now.

**The theme is not part of what the document is.** The base stylesheet is
written into the `srcdoc` with the theme current when the document is drawn,
but the theme is no part of the frame's `Source`: a theme change never makes a
new document, which would reload the page and lose its state. Every change
after the drawing goes by message (below).

#### Switching between light and dark

- **A page that asks follows live.** On every theme change, palette included
  — and when a custom theme is registered after the app started
  (`subscribeThemeRegistry`), which changes the palette and nothing in the
  theme store — the app posts `{ type: "pockode:page-theme", scheme, vars }` to the bridge,
  which rewrites the base stylesheet's `<style>` element — never an inline
  style on `:root`, which would outrank the agent's own `:root { --pk-…: … }`.
  The page is not redrawn and keeps its state, its scroll and what was typed
  in it. The bridge answers each with `pockode:page-themed`. On **every**
  `pockode:page-ready` the app posts `pockode:page-theme` to the page and
  `pockode:page-frame-scheme` to the wrapper again, unconditionally, as the
  canvas does: what it posted before may have reached no listener, and a
  palette change keeps the scheme, so comparing schemes would miss it.
- **The frame never disagrees with its document** — the canvas's rule (§4
  there): where a frame element and its document disagree on `color-scheme`,
  Chromium and WebKit paint an opaque canvas of the document's scheme in the
  frame. So the wrapper's `color-scheme` follows the theme shown now
  (`{ type: "pockode:page-frame-scheme", scheme }`, posted with every theme
  change). The wrapper has no bridge: its listener, beside `LEFT_LISTENER`,
  takes that one message, from `parent` only, and sets its own
  `color-scheme`. And **a new document the app draws of a page that asks is
  hidden until it is ready and in the scheme shown** (`visibility: hidden`
  until a `pockode:page-ready` or `pockode:page-themed` in the current scheme,
  or 2 seconds): WebKit may paint a fresh `srcdoc` document white before its
  style applies, which in the dark theme is a white flash on every card that
  scrolls into view. Meanwhile what shows is the `bg-th-bg-primary` of the box
  around the frame — a hidden frame paints no background of its own — at the
  card's kept height. A page that reloads itself is not hidden again: its
  frame has been shown, and its new document is put in the theme by the
  ready it says. The focus a Load hands the frame
  ([on Load](page-external-hosts-ui.md#what-happens-on-load)) waits until it
  is shown, since a hidden frame takes none, and is not handed at all if the
  reader has put it somewhere else meanwhile.
- **A page that does not ask does not change.** It stays white under `light`
  in both themes, and nothing is posted to it.
- `</>` shows the page as stored, never the injected parts, in either case.

#### In an HTML-first session

The same rule: the session's style changes what the agent is told, not how a
page is drawn ([html-first-session-ui.md](html-first-session-ui.md)). Its
pages follow the theme because `html_render`'s and `html_edit`'s descriptions
tell every agent to use the variables, in both session styles — not because the
session is HTML first; one that does not use them is paper there too.

## Width and pointer

Almost nothing here is width-dependent, and that is the design rather than an
omission.

| Tier | What changes |
|---|---|
| compact (<640) | the baseline described above, and a diff's line numbers in one narrow column |
| `sm:` (640–1023) | `p-2` → `sm:p-2.5`, the [full screen](#full-screen) viewer's `p-3` / `px-3` → `sm:p-4` / `sm:px-4`, and a subagent's [step window](#how-many-lines) one line taller |
| `lg:` (≥1024) | nothing — the transcript column does not change shape |

A page's card is the one thing wider than the column, and it follows the pane's
own width rather than a tier ([width](#a-page-the-agent-drew-html_render)).

The step window's extra line is the one count a tier decides — a phone's
transcript is too short for the desktop's ([how many lines](#how-many-lines)).
What each of its lines shows does not change: at every width its glyph, title
and elapsed figure keep their width and its detail truncates
([what yields](#what-each-line-shows)).

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
- A subagent's [step window](#the-step-window) is `aria-hidden`, live and
  frozen: the Process lists the same steps accessibly.
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
   after 3s. Reload the page mid-run: spinner + chip, no activity line, the
   counter at the reading it had before the reload (not restarted from 0s, and
   not off by the phone's clock), and nothing claiming it succeeded.
4. The same call after `task_notification`: glyph settles, chip stays, the
   second line becomes the outcome **without the row changing height**, and the
   body shows both the placeholder and the outcome under their own labels. The
   counter becomes the call's duration, from the call to the outcome — not the
   second or so the placeholder took. The same on reload.
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
   one, `durationMs` on the right, a non-zero `exitCode` as `exit N` before it.
   A claude `Bash` running `sleep 3` shows about `3.0s` on the right once
   settled, and the same after a reload; a subagent row shows how long it ran;
   a transcript written before `observed_at` existed shows no figure on any
   claude row.
7. An approved `Bash`: **one** row, not two — the card takes the pending row's
   place and the engine's next report gives it back, and while the card is
   pending nothing around it is spinning. Check both orders: Claude announces the
   call first, Codex may ask first. Wait a minute before approving a
   `sleep 5`: its counter and its settled duration read about `5s`, not `1m 5s`.
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
15. A subagent at work, collapsed: titled by its agent behind the `Bot` mark
    (`Explore`, a Codex `read_a`, or `Subagent` when none is known), no type
    chip, the description as the detail and still there beside a 40-character
    agent name. Line 2: `N tool uses`, the count going up with each tool
    call, and `· <text>` only while its newest words are newer than its newest
    step, as prose. Under it, nothing before the first step; then its newest
    three steps, oldest on top, each worded as its own row would word it, with
    a muted glyph — nothing in the window red, even a failed step — and a
    counter only on the running one. None of its text
    or rows anywhere in the main transcript, as long as the spawning call is
    loaded ([what is not filed](#what-is-not-filed)).
16. Two subagents spawned together: each row counts only its own tool uses,
    and each window has two lines; three or more siblings have one each.
    Let the upper one finish first: its line becomes `N tool uses · <report>`
    and its tokens
    **without the row changing height** — its window stays, frozen, with no
    counter — with the same `N` it showed live the moment before, while the
    lower one keeps moving. When the lower one settles, both windows fold in
    one frame. Resume one of them: only its own window comes back, and a
    subagent appended to the list later regrows nobody's. Reload at each
    point: the same windows as the live view. Open a running row: the window
    goes under the bar with the second line; open its Process too: the window
    is gone, and line 2 names its latest child again.
17. Open the finished one: report, then `Process · N tool uses` **closed** —
    the same `N`, and that many calls inside when opened — then `Prompt`
    closed, then the facts line (`agentId` and whatever else is known). Open Process: the subagent's text in small secondary type on
    a rail, its tool rows exactly as main-transcript rows, nothing scrolling
    inside the Process itself, and the report **not** repeated at its end.
    Reload: the same row, the same count.
18. A subagent step that needs permission, with the Task row collapsed: the card
    is visible directly under the Task row, not hidden in the closed Process —
    and for a subagent's subagent, under the top-level Task row — with its step
    in the window above it, behind a muted `CircleHelp`. Approve it: the
    card leaves that slot and the step runs inside the Process. A card asked by
    the subagent's subagent carries one line above its row naming that inner
    agent as its row does (`⧉ code-reviewer  Review the diff`); the outer
    subagent's own card beside it has none.
19. Interrupt a subagent mid-run, on Claude and on Codex: `Ban`, muted, never
    red, the window folded and the line frozen on its latest child in the same
    frame, and no spinner left anywhere inside its Process.
    A subagent that fails, foreground or backgrounded, live or on reload: red
    line 1, `N tool uses · <first line of what it returned>`, and the body
    **closed** until tapped.
20. A transcript recorded before this change: subagent rows and their work read
    exactly as they did, with no `0 tool uses` anywhere — titled by their
    `subagent_type` now, which their input always carried, and with no tokens
    where the record kept none.
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
    place and not repeated, each row opening on its own; the folded rows on the
    rail, unbroken across their hairlines, and the two red rows breaking it.
    Neither failure is named or counted in the summary.
23. While the group runs: `Running <command> · <past segments>  <elapsed>` on
    one line, and the same line in the past tense when it settles, the
    command's name moving to the end of `Ran`, **without the row changing
    height**. A failed `Edit` is not in `Edited …`. On the summary, a file
    touched twice is named once; a command run twice is `<command> ×2`; two
    `index.ts` in different directories are told apart by their directories;
    four commands run once each read `Ran 4 commands: <a>, <b>, <c>`, never
    `+1`. Narrow the window: names go one at a time from the end of the line,
    never cut mid-name, the first segment's last, and a segment left naming
    less than half its calls is its count alone; widen it and they come back.
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
    `Running <command> · <past segments>`, and the spinner returns if it is
    still running once the card is answered.
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
33. A turn that reads, edits two files, creates one and then answers: when it
    settles the tail line goes and the card appears under the answer, directly
    above Copy and Fork, headed `Worked 1m 4s · 7 tool calls · 3 files
    changed`, the created file `new` with no `−`; following the tail, the view
    stays on the tail. While it ran there was no card. Interrupt or fail one
    like it: the card is under the `Interrupted` or error line and above Copy
    and Fork, listing only what succeeded; a turn whose calls changed nothing
    has no card and no row between its work and its answer, and `Worked … · N
    tool calls` at the right end of its Copy/Fork row, adding no height; a turn
    with no call has neither. Every row above stays as it was: no group folds
    or opens.
    Reload: the same figures, with the same duration; a turn from before the
    stamps reads `7 tool calls · 3 files changed`. On a 375px phone the header
    reads `Worked 1m 4s · 7 calls · 3 files` and keeps its totals; the
    turn-end row's figures read `… · 6 calls`. A subagent left in the
    background that edits a file after a no-file turn settled draws the card
    there, and the figures leave the row for its header.
34. Open a card row of a file edited twice, once by a subagent: each change has
    `Go to call`. The main agent's lands on its row, folded in a group until
    then — the group opens, the row is highlighted and focused, its body still
    closed. The subagent's opens the subagent row, its Process and the group
    in it, and the row lands just under the subagent's pinned bar, not
    behind it; all stay open afterwards. Scrolling down finds the file row
    still open. On the device that sent the turn's message, the figures have
    their `Worked` at once, not only after a reload.
35. On a 375px phone, two `index.ts` in deep directories: one line each, told
    apart by their last directory, chip and counts whole; in the body,
    `PathLine` relative, and the full path once it is tapped. The same file
    edited three times is one row with the summed counts, opening on
    `1 · Edit` to `3 · Edit`; edited once, `Change`. A `Write` over a file: `rewritten`, `+N` only, and the line saying so above its diff.
36. Nine changed files: five rows and `Show 4 more files`; press it and focus
    lands on the sixth row. Seven: all listed. Reload: the same card.
37. On a 375px phone, open a card row onto a diff of about 60 lines and drag
    up and down over it: the transcript moves, never the diff alone. The diff
    is cut and faded with *Show N more lines* under it, `+N −M`, the wrap
    switch and ⤢ in its header; a `Write`'s block copies its content.
38. An `Edit` the tool refused (an `old_string` not in the file): the row's
    second line is the reason in prose, with no `</tool_use_error>` on it.
    Open it: an *Error* section in red above *Change*, the *Change* header
    reading `not applied` with muted counts, and nothing in the body or the
    copy carrying the tag.
39. A `Grep` with an absolute `path` inside the work directory: the row reads
    `"pattern" in src/lib`; with `path` the work directory itself, just
    `"pattern"`.
40. With reduced motion on: every running row, and a running group summary,
    shows a still accent dot where the spinner was.
41. On a 375px phone, open a failed `Bash` with a long output and scroll into
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
42. On a 375×667 phone, open a `Bash` with a 20-line command and a 60-line
    output (the walkthrough's `fullRun`; thousands would be
    [huge](#huge-content)): the command is cut at 8 lines with *Show all* under it,
    the output at about 45% of the transcript with *Show N earlier lines* above
    it, and both fit on one screen. A block 5 lines over its budget shows whole
    with no button. Turn the phone landscape: a cut output is at most about
    half the transcript (rotated after opening: opened in landscape, 60 lines
    are already [huge](#huge-content)). A `TodoWrite`'s checklist is never cut.
43. In that `Bash`, with the output's last line mid-screen, press *Show N
    earlier lines*: the last line stays exactly where it was and the log grows
    upward. *Show less* leaves its button where it was pressed; closed with its
    button out of sight, the section's header lands just under the pinned title.
    *Show all* on the command keeps the command's top. The walkthrough's
    `keep-place` scene logs each edge before and after.
44. Open that output with *Show N earlier lines* and scroll into it: the
    *Output* header pins directly under the row's title with a hairline, the
    copy button, ⤢ and a collapse control; there are never more than those two
    bars. Scroll to the output's end: the header is carried off under the row's
    title, not over it. Press the collapse control mid-output: the output is cut
    again and its header lands just under the row's title, focus on *Show N
    earlier lines*. A section that fits, or one cut and not opened, never pins.
45. On a 375×667 phone, a 30-line *Output* has ⤢ in its header and no *Open full* button; a 5-line
    one has no ⤢; a 30-line *Command* never has one. The plan and a subagent's
    report, cut, have *⤢ Full screen* beside *Show all*.
46. On a 375×667 phone and on a desktop, a `Bash` that printed 10,000 lines:
    never opens in place — its last lines faded under *⤢ Open full output ·
    10,000 lines*, no *Show* button, never pinned. The viewer opens at its last
    line with its command under the title; tap the command for all of it. Scroll
    to the top: line 1. Turn wrap off: the block scrolls sideways as one.
47. In that viewer, find `FAIL`: the count, a highlight on each match and a
    stronger one on the current, Enter / Shift+Enter and the ↓ / ↑ buttons wrapping at the
    ends and jumping to lines that were not drawn, the match a third of the way
    down. With a Chinese or Japanese IME, committing a word with Enter jumps
    nowhere and Escape mid-composition closes nothing. Escape closes find, focus
    on 🔍; Ctrl/Cmd+F reopens it with the query back, selected; then Escape
    closes find again, and the next one the viewer.
48. A `Glob` of 3,000 files: 100 rows in place with *Show N more files*, and
    ⤢ opens all 3,000; *Open* on one closes the viewer and opens the file.
49. Open a running command's *Output so far* full screen and let it finish: the
    viewer stays, now holding the whole output, and the reader's line stays put;
    past 200 lines it first says *Earlier output arrives with the result*.
50. Close the viewer with Back (Android back, iOS edge swipe, browser Back): it
    closes, the page stays, and the transcript is where it was — also after
    toggling diff wrap in a viewer, which every transcript diff follows. ✕ and
    Escape leave no extra history entry behind: Back afterwards does what it did
    before the viewer opened.
51. An `html_render` call, from Claude and from Codex: a `pockode` row titled by
    the page while it runs (or if it fails), then on success a card that splits
    the list around it — never inside a group. In the dark theme a page that
    uses no `--pk-*` variable is white, with browser-default buttons, exactly
    as before; its placeholder is not white.
52. A page taller than the screen: the card stops at 70% of the transcript with
    *⤢ Full screen* under it; a short page has no footer and no inner scroll.
    Toggle `</>` and back: the page has kept its state. A page that tries
    `alert()` shows nothing; one that reads `localStorage` or `parent.document`
    throws. A `target="_blank"` link opens a new tab.
53. A session with many pages, reopened: only the frames near the screen
    mount, and scrolling to the others does not make the transcript jump.
54. A page full screen: edge to edge, no 🔍, Ctrl/Cmd+F the browser's own;
    `</>` turns it into code with wrap and find.
55. A page that loads a chart library from a CDN: the chart is missing and the
    strip names the CDN; Load redraws it with the chart, and the full-screen
    view opened afterwards needs no Load. Allowed full screen first, the card
    underneath offers *Reload* rather than reloading itself
    ([page-external-hosts-ui.md](page-external-hosts-ui.md)).
56. A page that shows a screenshot, a recording and a sound from the project,
    named once by a relative path and once by its absolute path: all load with
    no strip, as does an image under a dot directory
    (`docs/.vitepress/dist/logo.png`); a `.env`, `.env.local`, `.envrc` or
    `.git/config` it fetches does not. A `#section` link scrolls the page.
    Offline, the page draws without them and the strip names the app's host.
57. Ask for a page, then for a change to it, from Claude and from Codex: the
    first card says `p1`, the second `p2 · from p1`, and both stand, the first
    unchanged. Reopen the session: both draw, the second loaded from the
    server. Fork the chat between them and ask again: the fork's next page is
    not `p2`. Ask the agent to change `p9`: it is told which pages exist, and
    nothing new is drawn.
58. A page with a `data-pk-send` button, a sending form and a sending input, in
    Chromium and WebKit: each sends once — by click, by Enter, and not by an
    Enter that confirms an IME word — and the bubble reads the action, `from
    p3` and the data. A plain form does not reload the page. Press a button on
    an older card while a newer one is the latest: the bubble names the older
    id, the transcript does not jump, and the old card's line reads `Sent`.
59. A page that calls `pockode.send` on load: nothing is sent, on reopening the
    session or on a second device; its card says *Not sent … before you used
    it*, its console says why, and its promise rejects with `inactive`. A send
    a second after a press goes. With a permission request open, a press is
    refused with *Answer the permission request first.*; with only a question
    open, or while the agent is merely running, it joins the turn.
60. Switch light ↔ dark with a page that uses `--pk-*` on screen: it follows
    without reloading — text typed in it stays — and never flashes white, not
    on the switch and not when a card scrolls into view in the dark theme. A
    page with no `--pk-*` beside it stays white, and so does one that only
    defines a name of its own (`--pk-gap`). An old page with a plain form and
    no `data-pk-send` behaves as before: its form goes nowhere.
61. A page in a wide desktop pane: its card is 1280px, centred, wider than the
    text above it; in a 900px pane it fills the pane inside the gutters; on a
    phone it is the column's width. A 3000px-wide table in it scrolls sideways
    in the card and full screen, the transcript never does, and a vertical
    swipe over it scrolls the transcript. Under an extension with an avatar,
    and inside a subagent's Process, the card stays in its column.
61. A successful `Edit` that appends one line: `+1` before its time on the row,
    muted, and the same `+1` in its *Change* header, with no `-a +a` pair
    and no "No newline at end of file" in the diff. A `MultiEdit` shows its
    edits summed. A `Write` shows `+N` with no `−`. A failed `Edit` and an
    interrupted one have no counts on the row, and an edit that changed
    nothing shows no `+0`. On a 375px row with a long path, the counts and
    the time are whole and the file name still shows.
62. A failed claude `Bash` (`exit 1`) and one killed (`exit 137`), closed: a
    muted `exit 1` / `exit 137` before the time, the times of the stack
    still in one column. Open one: the bar still shows the code, the output
    still starts with Claude's `Exit code N`, and no paragraph at the end of
    the body repeats it. A refused `Bash` (`<tool_use_error>`) and a denied
    one show no code. Neither does a successful one.
63. An MCP tool that takes a `path` (e.g. `mcp__fs__read_file`): titled
    `read_file` with an `fs` chip, not by its machine name. Its body lists
    every argument, the path among them, rather than a lone path line.
64. A `WebSearch`: *Results* is a list of titles with their hosts, each
    opening its page in a new tab, then the summary as Markdown, with no
    `REMINDER: …` line anywhere. A result found twice is listed once.
    Copy gives the raw result; full screen gives the links, then the summary.
    A failed one reads as it did before.
65. Approve one call, deny another, and let the permission reviewer allow
    and deny one each: all four settled cards have a muted `✓` or `✕`, the
    same grey as a settled row's tick. No green and no red, apart from a
    failed answer send's error line.

For [a fetch in flight](#a-fetch-in-flight), [the remaining tool
kinds](#the-remaining-tool-kinds) and [Pockode's own work
calls](#pockodes-own-work-calls):

66. On a CLI that still has `TaskOutput`, background a `sleep 40; echo done`
    and have the agent fetch it while blocking: the `Bash` row keeps its
    spinner and chip and gains `Waiting for output… 12s` under the command,
    counting; the tail line reads `Waiting for output… · Go to call`, and the
    button lands on that row. When the fetch returns the line becomes `done`
    with no change of height. Stop the turn during a second fetch: the line
    goes back to `done`, and after a reload no line anywhere says waiting.
67. A `NotebookEdit` replacing a cell: `NotebookEdit` and the notebook's name
    on the row, `+N` in the meta, *Cell <id>* and the new source in the body,
    and the notebook among the turn's changes with the same `+N`. An insert
    wears an `insert` chip; a delete says its content is not in the call.
68. A `TaskStop` of a backgrounded command: a row of its own, the command it
    stopped in its body, `Go to call` landing on the command's row — whose own
    outcome says it was stopped. In a group the summary reads `Stopped 1 task`,
    never `Ran`.
69. A Codex web search and a Codex page open: rows titled `WebSearch` and
    `WebFetch`, counted under `Searched` / `Fetched`, the search's body
    listing the links Codex reported and the page's saying Codex does not
    report what came back. A Codex image generation: its image in the
    row's attachment strip, not among the turn's changes. A Codex `wait` on a
    subagent: an `AgentControl` row titled `Wait`, spinning while it waits.
70. A story agent that creates and starts a task: `Create task · <title>` and
    `Start task · <title>`, the summary `Created task "<title>" · Started task
    "<title>"`; *Open* in either body opens the task's page, in any worktree.
    Rename the task: both rows still say the old title. Let the task finish:
    the parent's `Subtask done` line opens the same task. No row ever shows the
    task's status.

## Out of scope

- **The turn's changes, live or reconciled.** No card or work figures while
  the turn runs, no net diff, no counts checked against git, no `Bash` side
  effects, no folding of the turn behind its figures, and nothing in
  `web-cluster` ([the turn's changes](#the-turns-changes), [what the work
  figures leave out](#what-the-work-figures-leave-out)).
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
  introduced, and none is needed. The one fixed colour, the white of a page
  that does not use the theme's variables, is not the theme's to change
  ([above](#theme-a-page-that-asks-for-it)).
- **More from a page than a send.** No `data-pk-blocked` on a card's root, no
  link from an action bubble back to its card, no per-page or per-session rate
  limit, no anti-forgery token: each is a second way to say what the send's
  own answer already says, or a defence against an agent's page, which is not
  an adversary ([sending](#sending-to-the-agent)).
- **Filing `BashOutput` or a stop under its origin.** `BashOutput` is history
  with no origin to file by, and a stop is an act that keeps its row
  ([the remaining tool kinds](#the-remaining-tool-kinds)).
- **Filing claude 2.1.330's reads of a background task.** That CLI no longer
  offers `TaskOutput`; how it reads a task's output instead is unmeasured
  ([tool-call-model.md](tool-call-model.md#a-call-about-an-earlier-call)), and
  whether such a read leaves its own row is a decision of its own.
- **A notebook cell's old source.** The CLI reports it after the call
  (`old_source`), and a diff could be drawn from it on the row; the permission
  card could not have it, and the three readers of a change saying one thing
  was chosen over it, as for `Write`.
- **A work's live status on its call's row**, and a jump between a work call's
  row and the work event line that later reports on the same work — both lead
  to the work instead ([Pockode's own work calls](#pockodes-own-work-calls)).
- **From an `AgentControl` call to its agents' rows.** The agents are named;
  going to each spawn row would need the adapter to carry the spawn call ids,
  for a call that is rarely more than a wait.
- **A fetch's content blocks reaching the attachment strip.** The strip is
  partitioned from `run.contents`, so a file block that arrived inside a fetch
  stays in the body. `TaskOutput` answering with an image does not happen in
  practice, and wiring a fetch into the attachment system is its own decision.
  What matters is that the body never calls such a fetch empty
  ([above](#a-fetch-reads-on-the-row-it-came-from)).
