# A subagent's transcript

A subagent's work is drawn under the call that spawned it, behind its
**Process** ([tool-call-ui.md](tool-call-ui.md#process)). For a short subagent
that is the right place: a few rows, read in the flow of the turn. For a long or
deep one it is not:

- **It is unbounded.** An opened Process grows to its full height, by design
  ([why](tool-call-ui.md#process)), and a forty-step subagent is screens of rows
  in the middle of the main conversation.
- **It has no "jump to latest".** A live Process grows at its bottom and does
  not follow, which is right inline and wrong for someone who wants to *watch*
  the subagent.
- **It indents.** Each level costs a rail's 18px, three levels are about 54px,
  and on a 360px phone the second level's rows are already short of a detail.

So a subagent can also be opened as **a transcript of its own**: a layer over
the chat's transcript that shows that subagent's work as a conversation, with a
breadcrumb back to where the reader came from, that follows its live tail and
can descend into a nested subagent the same way. Comparable tools do the same —
Claude Code's `/tasks` → Enter, the Codex app's subagent threads — and on a
phone no inline nesting reads well; a view of its own is the honest answer.

The inline Process stays exactly as it is. This is a second way to read the same
children, offered beside it, never instead of it.

## Words

- **The layer** — the whole thing this document describes.
- **A level** — one subagent shown in the layer. The layer holds a stack of
  levels, outermost first; the top of the stack is the one on screen.
- **The shown subagent** — the subagent of the level on screen. Its children
  are the level's top-level parts, the way the main agent's parts are the chat
  transcript's.

## The way in

```
├──────────────────────────────────────────────────────────┤
│ ›  Process · 42 tool uses                             ⤢  │
├──────────────────────────────────────────────────────────┤
```

**A ⤢ at the right end of the Process heading** — lucide's `Maximize2`, the
24px box the sections' full-screen button uses
([full screen](tool-call-ui.md#full-screen)) with its `touch-target` hit area,
`text-th-text-muted` turning `text-th-text-primary` on hover. The heading
becomes a flex row: the disclosure button keeps the rest of the width, and the
⤢ is a second button beside it, not inside it.

- **Named for what it opens**: `aria-label="Open Explore subagent's
  transcript"` (from the row's title, as the Process's `aria-label` is;
  `Open subagent's transcript` on a row titled `Subagent`), and a `title` with
  the same words for a fine pointer.
- **Offered on every Process**, whatever its length or state. The budget rule
  that decides a block's ⤢ ([full screen](tool-call-ui.md#full-screen)) needs a
  length known now, and a live subagent's is not: a ⤢ that appeared at step nine
  would be a control flashing in under a reader's thumb. A short Process also
  gains from the layer once it holds a nested subagent, which is where the
  indent bites. One place, always there, is what a reader learns.
- **Tapping the heading still opens the Process inline.** Nothing switches by
  itself: not a long Process, not a deep one. The reader who wants the inline
  view keeps it; the ⤢ is one more tap for the one who wants the other.
- **Inside a nested `TaskItem`** — in an inline Process or inside the layer — its
  Process heading has the same ⤢, and it opens that subagent. From the chat,
  that opens the layer with the whole path ([depth](#back-at-each-depth)); from
  inside the layer, it descends one level.
- **A row with no Process has no ⤢**: a subagent whose work never reached the
  stream (one that ran inside its call, a CLI that streams nothing) has nothing
  to show as a transcript, and its row stays what it is. So does one whose only
  child so far is a pending card: the card is drawn in the row's slot, not in a
  Process, and the ⤢ arrives with the Process once the subagent goes on.
- **Only where a transcript can be opened**: the ⤢ is drawn where something
  provides the opener (`SubagentTranscriptContext`) — the chat's list and each
  level. A `TaskItem` drawn anywhere else has the Process heading alone.

**Two ways in from outside the row**, which open the same layer through the
same opener (`SubagentTranscriptContext`): an entry in the turn's agents list
([turn-progress-ui.md §4.3](turn-progress-ui.md#43-the-agents)), and a
subagent task in the attention strip's background list
([turn-progress-ui.md §4.5](turn-progress-ui.md#45-naming-what-a-background-wait-waits-on)).
Each opens it only where the ⤢ is offered — a subagent with a Process
(`hasProcess`) — and goes to the row otherwise.

**Not on the row itself.** A subagent row's first line is full at 320px: the
status, the agent's name capped at 45%, the description and the elapsed time.
A 24px icon there would come out of the description, on every subagent row, to
save one tap for the reader who opens a transcript — the body is one tap, the
⤢ in its Process heading the next. The row is also a single button
([the row](tool-call-ui.md#the-row)), and a second control inside it would be
the nested-button problem the Process heading does not have. A running row's
[step window](tool-call-ui.md#the-step-window) is not a way in either: it is
part of that one button, not a control of its own.

## Where the layer sits

**Over the chat's transcript, not over the app.** The layer takes the area the
message list takes — between the session header and the strip and input bar
under the list — `absolute inset-0` against the same wrapper `ChatPanel` puts
around the list for the answer panel, and **under** the answer panel (whose
`z-10` it stays below): the panel is raised over whatever the transcript area
shows, and while the layer is up that is the layer. The session header, the attention strip, the
answer panel and the input bar stay where they are and stay live. Being inside
the transcript's own box, the layer is put out of reach with the list while the
answer panel is on screen (`transcriptInert`), as the list is: the panel is
modal over that rectangle, whatever it shows.

That is the difference between this and the full-screen viewer, and it is
deliberate:

- **Stop has to stay in reach.** The reader most likely to open a subagent's
  transcript is watching a long one, and the one most likely to want to stop it
  is that same reader. A layer over the whole app would put Stop one Back away.
- **Requests elsewhere stay visible.** While the reader is three levels down,
  the main agent or a sibling subagent can ask for permission or post a
  question. The attention strip already says so, under the list, with its jump
  ([answering-ui.md](answering-ui.md)); a layer that covered it would need a
  second copy of that strip. Leaving the strip and the input bar uncovered is
  what makes the layer need none.
- **Talking to the main agent stays possible.** A message typed under the layer
  goes to the main agent, as it always does; the layer stays up. The subagent
  itself cannot be talked to from here, and the layer has no input of its own.

The layer is still a layer in every sense §5.2 means
([project-ui.md](project-ui.md#52-back-closes-the-topmost-layer)): the user
opened it, it stands between them and the transcript, it holds a history entry
and Back closes it. Only the part of the screen it covers differs.

The message list under it is `inert`, so Tab, find-in-page and a screen reader
do not reach the rows it covers, and its scroll position, open rows and open
Processes are untouched — closing the layer shows the transcript exactly as it
was left.

Registering as a layer has two effects on the chat beyond Back, both intended:

- **The chat's Escape-to-interrupt stands down** while the layer is up, as it
  does under any layer (`useIsPageCovered`): Escape goes up a level instead
  ([below](#back-at-each-depth)), and Stop stays the button.
- **A handoff's prefill waits** — the input bar takes a prefill handed in from
  outside only once nothing covers the page — so one made while the layer is up
  lands in the draft when the layer closes. It is rare here (a handoff is made
  from another page, which closes the layer on its way) and is the rule every
  layer already follows.

**Each level gives its layer in `CoverLayerContext`**, as `Sheet` gives its own:
a page's frame drawn in a level asks whether anything is drawn *over it*
(`useIsDrawnOver`, through `FrameShield`), and without the context it would
read the level itself as covering it and shield itself — an `html_render` page
in a subagent's transcript that cannot be pressed. `@pockode/shared` exports
`CoverLayerContext` beside `useCoverPage`, which returns the layer for exactly
this.

## The header

```
360px coarse
┌──────────────────────────────────────────┐
│ ←  Chat › Explore › code-reviewer        │  44px: back and the breadcrumb
│    ⟳  Review the diff in relay/     47s  │  the row, without its title
│       6 tool uses · Bash  go test ./…    │  the row's second line
├──────────────────────────────────────────┤  hairline
│ … the level's own scroller …             │
```

Three lines, `bg-th-bg-primary`, `border-b`, its content on the same reading
track as the list under it (`mx-auto max-w-3xl px-3 sm:px-4`), so the header
lines up with the rows at every width while its hairline runs edge to edge.

**Line 1: ← and the breadcrumb.**

- **←** is a 44px button at the left edge (`ArrowLeft`, the icon pages' ← uses),
  `aria-label="Back to <parent crumb>"` — `Back to Explore`, `Back to chat`. It
  goes up one level, exactly as Back does ([below](#back-at-each-depth)).
- **The breadcrumb** is the path from the chat to the shown subagent, one crumb
  per level: `Chat`, then each subagent's row title (`Explore`,
  `code-reviewer`, `Subagent`, a Codex `read_a`) — the word the reader saw on
  the row they opened, so the crumb they come back to is recognisable. Each
  earlier crumb is truncated at `max-w-[40%]` and the last at `max-w-[60%]` (it is
  the one always in view, so it gets the room), separated by a muted `›`
  (`ChevronRight`, `size-3`, `aria-hidden`).
- **The last crumb is the shown subagent**: `text-th-text-primary font-medium`,
  not a button, `aria-current="page"`, with the `Bot` mark before it (`size-3`,
  the row's own mark, `aria-hidden`) — the one place in the header that says
  *this is a subagent*, as the mark does on its row.
- **Every earlier crumb is a button** in `text-th-text-secondary` (underlined on
  hover with a fine pointer, with a `touch-target` hit area) that goes up to
  that level: `Explore` pops every level above Explore's, `Chat` closes the
  layer.
- **When the path is wider than the line** — three levels of long names on a
  phone — the breadcrumb is a horizontal scroller with no scrollbar, pinned to
  its end when its level is drawn and whenever the line's width changes (each
  level has a header of its own, and a level's path never changes), with a 16px
  fade at its left edge while anything is cut there. Its line is `h-11`, so a
  crumb's hit area sits inside the scroller instead of being clipped by it. The shown subagent is always in view; the way up is
  always ←. A collapsed `…` crumb was the alternative and was rejected: it
  would need a menu, which is a layer of its own over this one, to reach a level
  the reader can reach with ← anyway. Real depths are one or two levels
  (Claude's `spawn_depth` seldom goes past two), so the scroller is the rare
  case.
- It is a `<nav aria-label="Subagent path">` holding an `<ol>`.

**Line 2: the row, without its title.** The shown subagent's status glyph, its
chips (`background`, `after Stop`), its detail (the description; nothing for a
Codex `subAgentActivity` spawn) and its meta — the elapsed counter while live,
the duration once settled — taken from the row's own header (`subagentHeader`,
which the row and the agents list draw from too) for the same `rowRun` the row
uses (a resumed subagent is running here too). The title is the
last crumb, so it is not said twice. Red as the row's line 1 is red when the
run failed; the muted `Ban` when interrupted.

**Line 3: the row's second line**, as the row draws it (`subagentLine`,
`SubagentLineContent`): `6 tool uses · <latest child>` while live, the
count, report and tokens once settled, the first line of what it returned on
a failure. The row's [step window](tool-call-ui.md#the-step-window) is not drawn here — the level
under the header is those steps whole, as an open Process is — so, as on a row
whose Process is open, the line names its latest child. It is the glance
that answers *is it moving* for a reader who has scrolled up into the middle of
the work, and it costs one 16px line. `aria-hidden` while live, exposed once
settled, as on the row. Drawn only when the row draws one.

The header is not sticky inside the scroller: it sits above it, outside it, so
the scroller is the level's one vertical scroll surface
([one vertical scroll surface](tool-call-ui.md#one-vertical-scroll-surface)) and
an open row's bar pins to the scroller's top, under the header, exactly as it
pins to the transcript's top ([the sticky title line](tool-call-ui.md#the-sticky-title-line)).

On desktop the header is the same three lines; nothing is added for the width.

## What a level shows

A level is the shown subagent's conversation, top to bottom:

```
│ Prompt                                              │  muted label
│ ┌─────────────────────────────────────────────────┐ │
│ │ Review the diff in server/relay/ for …          │ │  note variant, clamped
│ │ Show more                                       │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ I'll start with the sender.                         │  the subagent's text
│ ┌─────────────────────────────────────────────────┐ │
│ │ ›  ✓  Read   server/relay/sender.go             │ │  its calls, a list
│ │ ›  ✓  Grep   "Retry-After" in server/           │ │
│ │ ›  ✗  Bash   go test ./relay/…                  │ │
│ └─────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────┐ │
│ │ ›  ⟳  ⧉ code-reviewer  Review the diff     12s  │ │  a nested subagent: a row,
│ │       3 tool uses · Read  backoff.go            │ │  with its own Process and ⤢
│ └─────────────────────────────────────────────────┘ │
│ …                                                   │
│ Report                                              │  once settled
│ The sender retries on 429 and 503, honouring …      │
│ agent a555947eded58a158                             │  facts
```

1. **The prompt**, if the call carries one: what the main agent (or the parent
   subagent) asked. A muted `Prompt` label, then the prompt in a
   `bg-th-bg-secondary` rounded box, drawn as the body draws it — `MarkdownContent`
   in the **note** variant inside `ClampedContent` — so a long brief is cut at
   the budget with its *Show more*. It opens the conversation the way a user's
   message opens a turn, but it is not drawn as a message bubble: a bubble is
   what the user said, and the user did not say this. A Codex
   `subAgentActivity` spawn names no prompt and its level starts at its first
   child.
2. **The children, in arrival order, as top-level parts** — drawn by the same
   `PartBlocks` and `ContentPartItem` as the chat transcript, so they group
   ([groups](tool-call-ui.md#groups)), open and pin exactly as there. Two things
   change because this level is the subagent's own conversation:
   - **Its text is drawn as a message, not a note.** The note variant and the
     rail exist to tell a subagent's words from the main agent's in the same
     column ([telling the subagent's words from the main
     agent's](tool-call-ui.md#telling-the-subagents-words-from-the-main-agents)).
     Here there is no main agent's text to confuse it with, and the header
     names whose conversation this is, so its text is `MarkdownContent` at full
     weight — what reading it on a phone needs.
   - **Depth starts again at 0.** The shown subagent's children have no rail;
     a nested subagent's inline Process inside the level has the first rail,
     and so on, with the same three indented levels as the chat. Descending is
     how a fourth level gets the width of the first.
3. **How it ended**, once there is something to say: the body's conclusion —
   the interrupted note, the report under a `Report` label (Markdown at full
   weight, with its ⤢ *Full screen*), or the empty-report sentence, then the
   outcome sections (a backgrounded subagent's *Outcome · after the turn*, a
   later fetch's output), then the facts line. The Process and the Prompt are
   the two parts of the body the level already draws as itself, so they are not
   repeated. This is the same component as the `TaskItem` body's conclusion,
   lifted out of `TaskItem` and drawn by both, so the two cannot drift. While
   the subagent is running there is no report, and the level ends at its newest
   child: the empty-report sentence *"still working"* would only repeat the
   header's spinner.

**The report is not drawn twice** — the rule the Process already follows
(`withoutEchoedReport`): a last child that is the report's text is left out of
the children, and the report is drawn once, at the end, under its label.

### Unfiled children

A subagent's children can have loaded before its call: the page holding the
call came later than the page holding its work, and that work sits flat in the
chat where it first loaded ([what is not filed](tool-call-ui.md#what-is-not-filed)).
The inline Process can only count those and say they are further down; the
layer can do better, because it is drawn from the whole loaded transcript and
not from one row's subtree.

**The level draws them in place, after the filed ones.** The filed children are
the older work, from the call's own page; the flat ones are the newer — while
any are flat, later work goes flat after them — so filed then unfiled is
arrival order, and the level is the subagent's work whole. No divider and no
note between the two: the split is where a page boundary fell, which is a fact
about loading and not about the subagent. The inline Process keeps its *N more
further down* line, and the chat keeps the flat parts where they are — the
layer is a view and moves nothing in the transcript under it.

A run's row only needs a count, a step count and the latest child
(`unfiledChildren`); the layer needs the parts themselves. Both are read from
one sibling walk, `unfiledParts(messages)` in `lib/subagentRun.ts`, which hands
back the flat parts keyed by the run's `tool_use_id`, in arrival order.

A subagent whose **call** is not loaded has no row and no Process, so it has no
way in; its flat children read as they do today.

### Errors

Nothing about failure is drawn differently in the layer, because the rules
already hold at every depth:

- **A failed call** is red on its own row, as in the chat — the subagent's trial
  and error, not its outcome.
- **A failed subagent** is red in the header's line 2, as its row's line 1 is,
  with the first line of what it returned on line 3; its full report or the
  CLI's verdict is the level's last block, where the reader who reads to the
  end arrives.
- **An interrupted subagent** has the `Ban` and its line 3 frozen where it was
  cut; its level ends at its last child, then *Returned after the turn was
  interrupted.* if a late report came — or, when that report is not an error,
  *Finished after the turn was stopped.*, under a header whose glyph is the
  `Check` its row draws ([tool-call-ui.md](tool-call-ui.md#status)).
- **A nested subagent that failed** is a red row in the level, and reads its
  failure on its own second line, as it does inline.

### A step that asks the user

The layer applies the chat's rule to its own top level
([when a step asks the user](tool-call-ui.md#when-a-step-asks-the-user)): in the
chat, the main agent's pending cards are drawn in place and every subagent's
are lifted into the slot under the outermost subagent row. In a level, the
shown subagent is the "main agent":

- **The shown subagent's own pending card is drawn in place**, as a top-level
  part — which is the level's tail, since the subagent is blocked on it, and
  so in view of a reader who is following. It has no asker line: it was asked
  by the conversation it is in, as a main-agent card in the chat has none.
- **A nested subagent's pending card is drawn in that subagent's row slot** in
  the level, between its row and its body, with the asker line when the asker
  is deeper than that row — exactly the chat's rule, applied with the level's
  rows as the outermost ones.
- **Answering it here answers it.** It is the same card for the same request;
  the chat's copy in its slot settles at the same moment.
- **The scroll button keeps clear of it** (`keepClearProps`), as in the chat.
- **A request that is not the shown subagent's** — the main agent's, a sibling
  subagent's, the parent subagent's — is not in the level. The attention strip
  under the layer says it is waiting, as it always does. Its *Jump to request*
  closes the layer (every level), as it closes the answer panel on its way, and
  then jumps in the chat. A request that *is* drawn in the top level is jumped
  to there instead, without closing anything — the level's scroller offers the
  same `jumpToRequest` the message list does, landing through the same code
  (`Chat/transcriptJump.ts`). A card in a level under the top one is not on
  screen, so it counts as outside the layer.

A **question card** is a record and holds no buttons; it is drawn wherever its
call is, in the level as in the Process, and answering happens in the answer
panel, which the layer does not cover.

## Following the live tail

The level's scroller follows the transcript's scroll rules, and is built on the
same machinery rather than a second copy of it (`useTranscriptScroll`'s
anchoring and its scroll button, generalised from the chat's messages to a
level's parts — [keeping the reader's place](tool-call-ui.md#keeping-the-readers-place)):

- **Where it opens.** A **live** subagent opens at its end, following. A
  **settled** one opens at its top, on the prompt: the reader who opens a
  finished subagent's transcript has already seen its report on the row's body,
  and has come for how it got there.
- **Following.** While the view is at the end, new children — a row, a line of
  text, a card — keep it at the end, and a child that grows (a live row's
  output, a nested row's second line) does not pull it away. This is the chat's
  own tail-following, unchanged.
- **Scrolling away** stops it. The ↓ scroll button appears, centred at the
  bottom of the level as the chat's is, with the accent dot once a new child
  has arrived below the view, and its name says so (`Scroll to bottom, new
  steps`) — one component with the chat's (`Chat/ScrollToBottomButton.tsx`).
  Pressing it goes to the end and follows again; so does scrolling back
  to the end by hand. Rows growing above the reader do not move them: the view
  is anchored, as the chat is.
- **When it settles.** If the reader is following, the conclusion block arrives
  at the end and the view goes to the **report's top** — under the header —
  rather than to the end of a report that may be screens long, and stops
  following: there is nothing more to follow, and a report is read from its
  start. If the report fits below what is in view, nothing moves. A reader who
  had scrolled away is not moved; the dot says something arrived. The header's
  spinner becomes the settled glyph and its line 3 becomes the count, report
  and tokens, in place.
- **When it resumes** — a `SendMessage` to it, a Codex follow-up — the level is
  live again, as the row is: the header spins, new children arrive at the end
  under the old conclusion block's place, and following resumes by the same
  rule. The conclusion block keeps the last report until the resumed run ends,
  as the body does.

How it is built: the level hands `useTranscriptScroll` its own signature of
the end — how many children, the last one by identity, the report, the
outcome, whether it is live — and opens with `startAt: "top"` when settled. A
short level reads from its top rather than sitting on the bottom as a short
chat does: its rows are never shorter than the view. Settling goes to the
report's top with `readFrom`, which keeps aiming there while the report is
still being drawn: the report measures itself a commit before it draws, so a
jump made in the commit the run settles in would be measured against an end
that is about to move.

The levels under the top one are not on screen and follow nothing; coming back
up to one shows it where it was left ([below](#back-at-each-depth)), with its
dot if it grew. One that was following and is still at its end follows on.

## Back at each depth

The layer is a stack of levels, and **each level is one layer** in §5.2's
sense: it holds a history entry of its own while it is up, through
`useCoverPage(true, { onBack })` — one registration per level, not one for the
layer. So each step down is one step of Back, as a dialog over a sheet is
([stacked layers](project-ui.md#stacked-layers)).

| Action | Does |
|---|---|
| Back (Android's back, iOS's edge swipe, the browser's Back, a mouse's back button), ←, Escape | up one level; from the first level, closes the layer |
| A crumb | up to that level: every level above it closes, and their entries are taken back together (one traversal, not one per level); `Chat` closes the layer |
| A ⤢ in a nested subagent's Process inside the level | down one level |
| A file row's *Open*, anything that navigates | the layer closes first, every level, and the navigation waits for their entries to be gone — the held navigation every layer gets ([project-ui.md §5.2](project-ui.md#52-back-closes-the-topmost-layer)) — so Back from the file lands on the chat with nothing open |
| A route overlay taking the chat, a session switch | the layer closes: they are navigations, and a navigation unwinds every layer's entry before it goes, calling each one's Back — each level's, top first |
| The shown subagent's run no longer in the loaded transcript (a rewind, a reload of the session) | its level closes, and every level above it; a level is the run's, read from the transcript each render, never a copy of it |

- **Opening a nested subagent straight from the chat opens the whole path.** Its
  ⤢ in an inline Process (Explore's Process, open in the chat, showing a
  `code-reviewer` row) opens the layer with Explore's level and then
  code-reviewer's on top — two levels, two entries — so the breadcrumb is a
  true path and ← is always *up*, whichever way the reader came in. The cost is
  one Back more than the reader made taps, for the reader who jumped in deep;
  the breadcrumb on screen says exactly where the extra Back goes.
- **A level below the top stays mounted, hidden** (`invisible` and `inert`), so
  coming back up to it finds its scroll position, its open rows, its *Show
  more* and its find query as they were left. Invisible rather than `hidden`:
  a scroller taken out of layout can lose its scroll position, and one kept in
  layout cannot. Depths are small and the cost is one subtree per level.
- **The levels are siblings, outermost first — never one inside another.** Each
  level's registration pushes its entry a tick after its effect runs, and a
  child's effect runs before its parent's: levels nested in the React tree and
  mounted in one commit (the whole path, opened from the chat) would push the
  inner level's entry *under* the outer one's, and the first Back would take the
  outer level's entry and close both. Drawn as siblings from the stack, their
  effects run in stack order and so do their pushes. Closing several at once
  (a crumb) is then one traversal: each closed level asks the layer history to
  settle, and the first settle goes back over every entry left with no live
  layer, so the rest find nothing to do.
- **Escape** goes up a level from wherever focus is — the level, the header,
  the composer below — the way `InputBar`'s menu takes it: a `document`
  listener on the top level, claimed with `preventDefault`, skipped when the key
  is already claimed ([who owns Escape](answering-ui.md#who-owns-escape)). A
  full-screen viewer, a sheet or a dialog opened over the layer claims it
  first, so the first Escape closes that and the next goes up a level. **While
  the answer panel is up the key is the panel's**: it is drawn over the layer
  and claims Escape on the window, and the layer stands down for as long as it
  is shown, as the chat's interrupt does — one press, one thing put away.
- **Focus.** Opening and descending focus the new level's scroller (a
  `<section tabIndex=0>` named for the level), so the keyboard scrolls at once.
  Going up returns focus to the ⤢ that went down, without scrolling — or to the
  level's scroller, for a level opened as part of a path, which no ⤢ of its
  own went down from; closing the
  layer returns it to whatever opened it: the ⤢ in the chat — the list was inert
  meanwhile, so it is still there — an agents-list entry, or a strip task. An
  opener that has gone meanwhile (its message redrawn, the agents list closed
  as the turn settled, the strip's row replaced) hands focus to the ⤢ now
  standing for the same run, as the viewer finds its opener's successor
  (`openerOrSuccessor`, by the `data-subagent-opener` every opener carries), or
  — where that ⤢ is in a row body that is closed or was never opened — to the
  run's row.
  A jump to a request that closes the layer takes focus where it lands instead.

## Relation to `FullScreenHost`

The layer is **not** the full-screen viewer and is not drawn by it:

- **The viewer is a `Sheet`, and sheets do not nest** (`useIsInSheet`). Inside
  the layer every block keeps its own ⤢ — a `Bash` row's output, a nested
  report, a diff — and the media viewer and the dialogs still open. If the
  layer were a sheet, every one of those would be a sheet in a sheet. As a layer
  of its own, a sheet opens over it like a sheet over a drawer, which §5.2's
  stack already allows.
- **The viewer shows one block's content; the layer shows a conversation**, with
  rows that open, groups that fold and cards that are answered. Its content is
  the transcript's own renderer, not a `FullScreenSource`.

**Each level is a transcript, so each level has its own `FullScreenHost`.**
"One viewer per transcript" is the viewer's rule
([who owns the viewer](tool-call-ui.md#who-owns-the-viewer)), and a level is a
transcript. It also has to be: a block's key is derived from its run
(`report:<run>`, `<run>:result`), and the same run is drawn in the chat under
the layer, in the level that shows it as a nested row, and in the level above
that one. Sharing one registry would let a level's block withdraw — or replace —
the source the chat's open block still publishes. One host per level keeps
every key in the transcript that drew it. A viewer opened from a level closes
with that level: the host is unmounted with it.

Of the contexts the chat's list provides, a level provides its own transcript
view (`holdAt`, with the level's scroller behind it) and, once for the whole
layer, the unfiled children and the subagent resumes, read from the same whole
transcript as the chat's. The rest it leaves at their defaults: the turn's tail
reads idle, since a level is no turn and has no tail of its own, and there is no
tool jump (*Go to call*), whose one user — a turn's changes card — belongs to a
turn and is not drawn in a level.

The layer itself is rendered inside the chat's `CoveredSurface` and inside its
`PageSendContext`, beside the message list, and is not portalled. So a page
drawn in it sends as a page in the chat does, and if the surface is ever
covered with the layer up, the layer is hidden and inert with it rather than
floating over whatever covered it — the problem `CoveredSurface` exists for is a
portal's, and this has none. It is not *closed* by being covered: every way the
chat gets covered today is a navigation, which has already closed it
([back at each depth](#back-at-each-depth)).

## Width

**Phone first (360px).** The layer is the transcript area's full width, the
level's track the chat's own `px-3`, so a level's rows are as wide as the chat's
top-level rows — the point of the layer for a nested subagent, whose rows were
36–54px narrower inline. The header's three lines are about 88px; with the
session header and the input bar, a 360×640 phone keeps over 400px for the
level, about as much as the chat itself has. With the keyboard up (the reader
typing to the main agent) the level shrinks with the chat, as the layer is
inside it.

**Desktop.** The same layer over the same area: the session sidebar column stays
beside it, the level's track is the chat's `max-w-3xl`, centred, and the
header's lines sit on that track. Hover underlines the crumbs; Escape and the
mouse's back button go up a level. Nothing is added for the width: no split
view with the chat beside the subagent. A second column was considered and left
out — the chat at a third of a desktop is the cramped Process again, and the
breadcrumb is already one click from it.

## Accessibility

- The layer is a `<section>` — a `region` landmark — named `<title> subagent's
  transcript` (`Explore subagent's transcript`; `Subagent's transcript` for a
  row titled `Subagent`), and the message list under it is `inert`. Not a
  `dialog`: the input bar and the strip below it are live and reachable, so it
  is not modal.
- The breadcrumb is a `nav` with an `ol`, the last crumb `aria-current="page"`.
- The ⤢ and ← name where they go (`Open Explore subagent's transcript`,
  `Back to Explore`).
- A level's scroller is a `<section>` named `<title> subagent's work`, the
  focus target on open.
- Nothing new is announced while live: the rows announce as they do in the chat,
  and the header's line 3 is hidden from the accessibility tree while it moves,
  as the row's is.

## Out of scope

- **Talking to a subagent** from its transcript. The input bar is the main
  agent's; a subagent is reached through the main agent.
- **A layer from a reload or a link.** Layers are not in the URL
  ([project-ui.md §5.2](project-ui.md#reload-deep-links-forward)); a subagent's
  transcript is reopened by its ⤢.
- **Virtualising a level.** A level draws every child, as the chat draws every
  loaded message; groups fold most of a long subagent back into lines.
- **Opening the layer by itself** — when a subagent starts, when it passes some
  length. Nothing in the subagent's rows opens by itself
  ([process](tool-call-ui.md#process)), and a layer raised over the reader is
  the loudest way to break that.
