# Project UI

The information architecture of the project page — the list of work, the row,
the creation flow, and the way the two of them connect to a detail page. It was
written to be implemented from and it has been: every screen has one layout,
every group one membership rule, every control one place.

It does **not** restate the state vocabulary. `Activity`, its glyphs, tones and
labels, which lifecycle button exists for which `status`, and the attention dot
are [lifecycle-ui.md](lifecycle-ui.md) §§1–4, and this document only ever names
those leaves. It does not cover the agent-role screens, which are unchanged.

**What it replaces.** This has landed, and it is the page: what the list holds
and how it is grouped is here rather than in
[lifecycle-ui.md §6.1](lifecycle-ui.md#61-list-grouping), which now keeps only
the part that is about the state vocabulary, and the components that draw it are
[projects/frontend.md § UI Structure](projects/frontend.md#ui-structure), which
describes them rather than the architecture. Two rationales in lifecycle-ui.md
were overruled on the way, and each says so where it lands: tasks leaving their
parent to join a group (§2.2), and the story row's labelled Start chip (§3).
What the implementation found out, and which checks it left behind, is §8.

## The one thing this fixes

The page had one screen, and it was asked to do two unrelated jobs at once:
triage what is happening now, and hold the history of everything that ever
happened. Five collapsible status groups was what that compromise looked like,
and every complaint about the page followed from it:

- Finished work sat at the bottom of the same scroll as live work, so reading it
  cost a long scroll and then a tap, and then another tap per story to see the
  tasks inside it.
- A chevron on a story row meant three different things — a toggle, a decoration
  that could not be tapped, or nothing at all — depending on the story's status.
- A newly created story appeared in the *fourth* group down, far below the form
  that created it, still needing a description before it could be started.
- The one group that promised "there is something for you to do here" could not
  hold the thing to do: only stories were grouped, so a task waiting on the user
  was nested inside a story that was not waiting on anything, in a different
  group. The user was told there was something to do, and then had to hunt for
  it.

> **The list is a list of things to do. Everything else is a different screen,
> or it is inside a detail page.**

That single sentence decides all five questions below, and the rest of this
document is what it expands to.

## 1. Two screens, one axis of navigation

| Screen | Route | What it is |
|---|---|---|
| Project | `/works` | Every work that needs a person or is under way. One column. |
| Work detail | `/works/$workId` | One story or task, its children, its comments. |

Both routes carry the usual `/w/<worktree>` prefix outside main, as every route
in the app does; the list itself is global across worktrees either way.

**Pages, not tabs.** The app already routes both of these as full-screen
overlays in the main panel, and the list→detail step is the app's one navigation
axis: a row goes to a page, Back returns. A tab bar would add a second axis
across the top, spend the scarcest space on a phone permanently, and — the real
objection — it would have to name its tabs after states, which puts the same
work in different tabs at different times. A user cannot learn where something
*lives* under a tab bar whose tabs are moods.

The one genuine split is not between states but between **use cases**: triaging
live work and looking something up in the archive. That is a filter over one
list, not a second location, so it is a segmented control (§2.1) and not a tab —
and it is not in the URL (§5).

**Back from a work detail returns to the list**, and from a task to its parent
story's detail first — both already true and both kept. It is worth writing down
because it is what makes the *Current* / *Closed* choice a filter rather than a
location (§5): the trip into a detail and out again is the one thing that choice
has to survive, and Back is not where the segment is remembered.

## 2. The Project screen

```
┌──────────────────────────────────────┐
│ ‹  Project                           │  header
├──────────────────────────────────────┤
│  [ Current ]   Closed                │  segmented control, sticky
├──────────────────────────────────────┤
│ ⏸ Needs you                      2   │  group header, sticky, inert
│   ◦ Wire the relay handshake     💬⏹ │
│     Needs answer · main · Engineer   │
│   ◦ Rebuild the project page     💬⏹ │
│     Needs input · in: Cluster mode   │
│ ⏵ In progress                    3   │
│   ...                                │
│ ○ Not running                    4   │
│   ...                                │
├──────────────────────────────────────┤
│           + New Story                │  bottom bar
└──────────────────────────────────────┘
```

The glyphs in that sketch are stand-ins; the real ones are the lucide names in
the tables below, and every one of them already exists in `ActivityIcon`.

### 2.1 The segmented control

Two segments, `Current` and `Closed`, full width, directly under the header and
outside the scroll area so it never scrolls away.

`Current` is everything not `closed`. `Closed` is the archive: closed stories,
newest first, flat. **Closed work is not a group in the main list and not a
collapsed section — it is the other segment**, which is the answer to "it takes
a long scroll and a tap to see finished work". It now takes one tap on a control
that is always in the same place, whatever the list is doing.

The segment words are chosen against the state vocabulary rather than for
brevity. "Closed" is exactly the status word for what is in it. "Current" names
nothing in the vocabulary on purpose: "Open" and "Active" are both status
values, and a segment wearing either would claim a membership it does not have.

Neither segment carries a count badge. A count is a signal to act, the group
headers inside `Current` already carry the ones that are (§2.3), and a running
total of finished work is a number nobody acts on.

**The archive skips a heading level, deliberately.** `Current` reads `h1` →
group `h2` → row `h3`; `Closed` has no group, so it reads `h1` → row `h3`. The
two ways out are both worse: a hidden `h2` over the archive would be a second
announcement of the segment button the user just pressed, and re-levelling the
rows to `h2` in one segment would make the same row claim two depths depending
on a filter. A skipped level is a best-practice warning rather than a barrier —
the rows are still headings, still walkable, and still in one flat list, which
is what the archive is.

### 2.2 Which work gets a row

> **A row exists for every story, and for every task that needs a person.**
> Everything else about a task is rolled up into its story's row.

"Needs a person" is `needsUser(activity)` or `status == "stopped"` — the two
ways a task can be stuck with nobody coming for it. A task that is running,
idle, open or closed has nobody waiting on it, so it is its story's business and
is reached through the story.

This is the paragraph that overruled
[lifecycle-ui.md §6.1](lifecycle-ui.md#61-list-grouping)'s "a task never leaves
its parent to join a group of its own" — a sentence that is gone from there now.
The rule was sound about the list it was written for, where the story row could
expand to reveal the task. It is
not sound about a list with no expansion: the *Needs you* group's whole promise
is that it holds the things for the user to do, and under the old rule the thing
to do is a task, while the group only admits the story that is waiting on it.
The user is told there is something to do and then has to go and find it. A task
that needs a person is the one case where the parent is not where the user
should be looking, so it is the one case where the task gets its own row.

Nothing is listed twice: a story row never contains child rows, so a story in
*In progress* and its blocked task in *Needs you* are two rows about two
different things, each with its own action. A task row names its parent in its
meta line (§3) so it is never orphaned.

### 2.3 Three groups, and why three

Inside `Current`, in this order:

| Group | Contains | Header glyph | The question it answers |
|---|---|---|---|
| **Needs you** | `status == active` and `needsUser(activity)` — stories *and* tasks | `CirclePause` warning | What is blocked on me? |
| **In progress** | every other `active` story | `CircleDot` accent | What is being handled without me? |
| **Not running** | `status == open` or `status == stopped` stories, plus `stopped` tasks | `Circle` muted | What is nothing happening to? |

Two questions decide the group, and they are asked in this order: **is an engine
driving this work, and if it is, is it blocked on the user?** That is the whole
rule. It replaces four groups whose order needed a paragraph of justification
between `stopped` and `open`, because those two differ in how they got there and
not in what the user does about them — the row's own control is the same control
under both labels, Start and Restart (lifecycle-ui.md §3), and the row's own
glyph already tells a hollow `Circle` from a red `CircleStop`. Merging them
costs the user nothing they were reading off the header and saves them a group.

**`stopped` stays out of *Needs you*, deliberately.** It does need a human, but
it needs one whenever the human gets to it, and a stale stopped work parked at
the top of *Needs you* would teach the user that the group's count is not a
number of things to do. That is the same argument lifecycle-ui.md §4 makes for
keeping `stopped` out of the attention dot, applied to the place a count is
read.

Group headers are **inert**: a glyph, a label, a count, and no collapse toggle.
A heading element, not a button — which is also what lets a screen reader jump
between groups, something the buttons never offered.
The one thing collapsing was for was getting the archive out of the way, and the
archive is a segment now. The header sticks to the top of the scroll area while
its rows are being read, so a long group never leaves the user wondering what
they are scrolling through.

The count is the number of **rows** in the group. It is not a number of work
items in some tree — the tasks folded into a story row are counted in that row's
own meta line (§3), where they can be told apart from it.

A group with no rows is not rendered, header and all. No group re-sorts itself
on an activity change: rows keep the order the list arrives in (creation order),
so a work that starts or blocks while the list is being read stays where the
user's eye left it, and only a change of *group* moves it. The `Closed` segment
is the one place sorted by anything, `updated_at` newest first, because "when
did this finish" is the only question the archive is asked.

### 2.4 Empty, loading, failed

| State | What is on screen |
|---|---|
| Loading the list | Spinner in the scroll area. The segmented control and the bottom bar are already there and already usable. |
| The subscription failed | The error text, in the scroll area, unchanged. The bottom bar stays: creating work does not depend on the list having loaded. |
| `Current` empty | "Nothing on the go." and one line: "Start with a story — the button below." |
| `Closed` empty | "Nothing finished yet." Nothing else; there is no action to offer here. |
| A group empty | No header, no placeholder (§2.3). |

## 3. The row

Two lines, and a third that is not about the work at all: **line one is what you
can do, line two is what is true, and line three — when it is there — is what
happened when you last tried.**

```
line 1:  [glyph]  Title, truncated to one line        [💬]  [⏹]
line 2:  Needs answer · in: Story name · main · Engineer · 1 active · 2/5 tasks
line 3:  invalid work: work is already running
```

**Line 1** — the activity glyph (`ActivityIcon`, the row's own precise leaf), the
title, and up to two trailing controls:

| Control | When | Shape |
|---|---|---|
| Chat (`MessageSquare`, the icon the detail page's Open Chat already wears) | `session_id` exists | icon-only, 44 × 44 |
| The lifecycle control — Start / Restart / Stop / Reopen | per lifecycle-ui.md §3, by `status` | icon-only, 44 × 44 |

Tapping the row anywhere else opens the detail. The title is the tap target and
takes all the space the two controls leave.

The detail is the right landing even for a *Needs you* row, and not a detour on
the way to the chat: it is the one place the agent's own `wait_reason` is shown
verbatim (lifecycle-ui.md §6.2), which is what tells the user *what* is being
asked. The Chat control on line 1 is there for the user who already knows.

Each icon control names its work in its accessible label — `Open chat for
"<title>"`, `Start "<title>"` — because a screen reader walking a list of rows
meets a column of identical verbs otherwise. The lifecycle control's label comes
from `ACTION_LABEL`, so the word the button speaks is the word it would print.

**Both controls are icon-only on every row, in every group.** This overruled the
one sentence in lifecycle-ui.md §3 that gave a *story* row a labelled Start chip
— true of a row whose meta line had room for a word, and since rewritten there
to point at this rule. Line 2 is facts now, and a control that lives there in
one group and on line 1 in another is a control the user has to look for. The
glyph on the left of the row already says what the button on the right will do.
`WorkPrimaryAction`'s labelled branch was deleted rather than left unused when
its last caller went: an unreachable branch is still measured, and its chip was
the register's entry for a control no user could reach.

**Line 2** is a single line of muted text, no wrapping, built from a fixed slot
order. Each slot has one rule for when it appears, and the group never changes
it; when the line is too narrow, the rightmost slots truncate first, which is
why the order is what it is.

| # | Slot | When | Why here |
|---|---|---|---|
| 1 | Activity label, warning tone | `needsUser(activity)` | What kind of answer is wanted — pick an option, allow, or write a message — is the first thing the user needs and the only thing that decides where they are going next. |
| 2 | `in: <parent title>` | the row is a task | A task row only exists here because it left its story (§2.2); without this it is a title with no context. |
| 3 | `WorktreeBadge` | the work's worktree is fixed | The list is global across worktrees; the badge and its visibility rule are the old row's unchanged, including staying off rows whose worktree can still change. Its hit area is not: see the hit-area note below. |
| 4 | Role name | the work has a role | Who is doing it. |
| 5 | `{n} active` | the row is a story with active children | The only thing lost by not nesting tasks is "something under here is moving", and this is it — in the same words the detail page's children header uses. |
| 6 | `{closed}/{total} tasks` | the row is a story with children | Progress. |
| 7 | Relative `updated_at` | the `Closed` segment only | The archive is sorted by it, and a sort key the user cannot see is a list in no order at all. |

**A left accent bar marks the rows that need a person**, as before: warning for
any `needsUser` leaf, error for `stopped`, nothing otherwise. It survives the
redesign unchanged because it is the one thing that works at a glance, before
any word is read — and it is why slot 1 does not need a "Stopped" label to go
with it. The bar says someone is blocked; slot 1 says what kind of answer is
wanted, which only the `needsUser` leaves have.

**Line 3 — the command that failed.** Present only while the row's own lifecycle
command has failed and nothing has been done about it since: one line of
`text-th-error` with `role="alert"`, the server's message verbatim — word for
word what the detail page's action bar prints, because the same hook builds it
on both surfaces — wrapping rather than truncating.

It is a third line rather than an eighth slot on line 2, and two reasons decide
that, either of them alone. Line 2 is a fixed sequence of facts *about the
work*, while a command that failed is a fact about the user's last tap: it
belongs to this session, and it is not true for the next person to read the row,
which no other slot can say. And line 2 is built to shed information — it never
wraps and it clips from the right, which is how the slots truncate — so a
sentence put there arrives as its first two words. The line that fixes "the
failure has no words" cannot be the line whose job is to drop them. **Nothing
about line 2 is relaxed to make room: the error never goes there.**

It wraps because the list is the only place it is ever written. The row and the
detail page hold separate command state, and the list unmounts on the way into a
detail page, so opening the work does not carry the message there — unlike the
title, which truncates because the detail page has the whole of it. A long
message makes a tall row, and that is the accepted cost: it is rare, it clears
itself, and a clamp would lose the text with nowhere left to read it.

It goes when any one of three things happens: the user runs the command again
(which clears the failure before trying), the work's status changes under it so
the button is now a different verb, or the screen is left, which unmounts the
row. The second is the rule that already drops a pending Stop confirmation when
the work leaves `active` — a dialog and a message both belong to the action that
raised them — and a failure that leaves the action untouched survives it,
because a Stop that failed on a work still `active` is still about Stop.

There is no dismiss control: it would be one more thing on the row to aim at,
owing 44 × 44 and a `z-10` lift above the row's own overlay, and those three
rules already cover everything the user does next. Line 3 itself is text and not
a control, so it takes no lift: the row's overlay covers it, and tapping it
opens the work like the rest of the card.

The lifecycle control keeps its error tint, but the tint is a hint and never the
message — Stop is drawn in the error colour to begin with, because the action
itself is the destructive one, so a Stop that failed changes nothing about the
button. What ties the failure to the control that produced it is position: line
3 is under it, on its row. It no longer carries the message itself:
the `title` tooltip that used to hold it is unreachable on the pointer this
platform is built for, and an `aria-label` replaced by the error took the verb
off the button exactly when the user most needs to know which button it was — a
screen reader walking a column of identical verbs loses the row it was aiming
at. `role="alert"` says it once, to everyone, and the button goes on being
Start.

**The message is the button's description as well**, by an `aria-describedby`
from the control to line 3 — the accessible *name* is untouched. `role="alert"`
speaks the message once, and after that the line belongs to no element's name:
it sits outside both the heading and the button. Someone moving by button or by
heading would come back to a control saying only `Start "<title>"` and never
meet the failure again; with the description they get the verb *and* what
happened, at the control they returned to.

This is what makes "the button only says the verb" safe to keep. The name was
the contested channel because it was the only one that reached a screen reader
at that control at all — which is why overwriting it with the error looked
reasonable once. The failure now has a channel of its own on the same button, so
there is nothing left for the name to compete with.

The attribute is there only while the message is: an id pointing at nothing
resolves to the same silence as no description at all, so one left behind would
be a fix that reads as done and is not.

The detail page's action bar deliberately does not do the same. Its one
`role="alert"` paragraph carries `actionError ?? deleteError`, so pointing the
action button at it would announce a failed *Delete* as that button's
description, and a failure attributed to the wrong control is worse than one
with no description. A row can do this because a row offers one command.

There is no toast, here or anywhere: feedback appears where the action started
([git-ui.md](git-ui.md)), and a toast starts somewhere else and leaves on a
timer the user did not set. That rule's other half — an outcome stored in the
panel survives leaving the tab and coming back — is **not** claimed here: line 3
goes with the row, and the third clearing rule above is exactly that. What it
does instead is last as long as the screen it belongs to, which is longer than
any toast and is the whole window in which the user can still act on it.

**Nothing about this line differs by pointer**, and that is the point of it. The
arrangement it replaces had one channel only a fine pointer could reach, and a
failure message that needs a pointer test to explain itself is a failure message
that is still broken.

**No chevrons, anywhere.** No row expands, no group collapses, and the three
different meanings a chevron had on a story row are gone because the affordance
is gone. Children are listed in exactly one place, the story's detail page,
which already has that section.

**No child-rollup attention dot on a story row either.** It fired when the story
or any of its tasks satisfied `needsUser`, and both halves are now rows of their
own in the group above it: the dot would point at something already on screen.
The dot on the sidebar's ProjectTab is unaffected and its rule
(lifecycle-ui.md §4) does not change — it is read when the list is *not* on
screen, which is the whole reason it exists.

Hit areas follow [responsive-ui.md](responsive-ui.md#hit-areas-and-spacing) and
nothing here relaxes them: the two icon controls owe a 44 × 44 box on both axes
under a coarse pointer, and the title — which is the row's own target, covering
the card and growing with it when line 3 appears — states `min-h-[44px]` rather
than letting whatever lines happen to be there add up to one (§8 has the reason
that is not a belt-and-braces).

Slot 3 is the row's third interactive thing and the one that is **not** 44px.
The badge reaches its 44 with a transparent overlay that leaves its own box, and
line 2 clips — that is how the slots truncate from the right — so in a row the
badge is its 20px box and the line's padding, about 26px. Deliberate: 11px below it is inside the next row, whose
whole area is another work's target, and a band where aiming at one work
switches worktree is worse than a small badge. A miss here opens the work, which
is where its worktree is written anyway
([responsive-ui.md, blind spot 9](responsive-ui.md#the-automated-gates)).

### 3.1 One row, two screens

The story detail's Tasks section is now the *only* place a story's tasks are
listed, so its rows and the list's rows are the same component with the same
slots — not two row implementations that drift. Every slot rule above decides
itself from the work, with one exception, and the exception is decided by the
**screen** rather than by the group:

- Slot 2, `in: <parent title>`, is passed off on the Tasks section. Every row
  there is a task of the story on screen, and naming it on each row is noise.

That is the whole difference. A task row in *Needs you* and the same task's row
under its story carry the same glyph, the same two controls and the same facts,
which is what makes the two screens feel like one place.

## 4. Creating work lands you on its detail page

One rule for both types: **`work.create` is followed by navigation to the new
item's detail page.** Nothing is ever created into a list position the user then
has to go and find.

The trigger:

| Screen | Control | Creates |
|---|---|---|
| Project | `New Story` in the bottom bar | a story |
| Story detail | `Add Task` at the end of the Tasks section | a task under it |

The bottom bar is the existing `BottomActionBar`, with one primary button. It is
at the bottom because that is where a thumb is and because creating is the most
frequent action on this screen, and it is *fixed* because the top-of-list form
it replaces scrolled away exactly when a long list made it most useful.

The form is a `Sheet` (the shared component) holding the two fields the server
requires and no others — title, and the role selector carrying the old inline
form's default-role resolution unchanged. The description is not in the sheet:
it is the brief the agent reads, it is usually several paragraphs, and it has a
perfectly good editor on the page the user is about to land on. A second editor
here would be two places to write one field.

When no agent role exists the sheet cannot ask for one, so it holds the old
form's message instead of the fields — "No agent roles registered", and for a
story the line pointing at the Agent Roles screen. The create control stays
enabled and opens it: a disabled button with no explanation is the one version
of this that tells the user nothing.

An empty list of roles is three facts and only one of them is that message. The
role subscription is app-wide, it starts out loading, it returns to loading on
every reconnect, and it can fail — so the sheet says which of the three it is
rather than telling a user whose roles are still arriving that there are none.

The sequence, and what each step is for:

1. Tap the create control → the sheet opens. Focus lands on the sheet itself,
   not the title field: `Sheet` takes it deliberately so its title is announced
   first, and it does so after the form's own effects have run, so focusing the
   field would mean outliving that on a timer.
2. Submit → `work.create`.
3. **It fails** → the sheet stays open with the error under the fields, the
   text intact, nothing navigated. Unchanged from the inline form it replaced.
4. **It succeeds** → the sheet closes and the app navigates to
   `/works/<new id>`. `work.create` answers with the created `Work`
   (`web/src/lib/rpc/work.ts`), so the destination is in the result the form
   already awaits; nothing has to wait for the list notification to arrive.
5. The user writes the description and taps `Start`, which is already the
   primary button in that page's action bar for an `open` work.

Step 5 is the reason for the whole change. Creating a work is never the end of
the interaction — a work with a title and no brief is a work no agent can do —
and the detail page is where the rest of it happens. Landing there turns three
steps (create, find it in the fourth group down, open it) into none.

Back from that detail page reaches the list (§1), where the new row is in
*Not running*. Its position there stops mattering the moment nobody has to go
looking for it.

The wiring this needs is one callback: the create form takes an
`onCreated(workId)` and both call sites pass the shell's existing
`handleOpenWorkDetail`. The form does not navigate on its own — `AppShell` owns
every navigation in this app, and a component that routes itself is a second
place worktree-aware URLs get built.

The sheet has no "create another" affordance. Entering several tasks in a row is
a real workflow and this costs it a trip back, which is the deliberate trade: a
task usually needs a brief too, and one rule for creation is worth more than the
one workflow where landing on the detail is not what was wanted.

## 5. Where the segment is remembered

The chosen segment is **UI state in a store, not a route**, following the
precedent of `web/src/lib/gitPanelStore.ts` — a small `projectPanelStore` with
one field.

- **Not component state.** The screen unmounts on the way into a detail page, so
  a user browsing the archive would be returned to `Current` by the trip out and
  back.
- **Not the URL.** It is a filter on one screen rather than a place, and in the
  URL every segment tap becomes a history entry: Back would step through the
  user's filter changes instead of leaving the list, which is the single most
  irritating thing a mobile page can do. Nothing needs to deep-link to the
  archive.

Nothing persists it, so a reload starts on `Current` — the store is created
fresh with the module, and a user who reloads is starting over, which is where
starting over belongs. The `reset()` beside the setter is there so a test can
isolate itself, following `gitPanelStore`'s shape; no app code calls it.

## 6. Edge cases

| Case | Behaviour |
|---|---|
| A task needs the user and its parent story also does | Two rows in *Needs you*; the task's slot 2 names the story. |
| A story is `waiting_children` while a child needs the user | Story in *In progress* with its `Clock` leaf, child in *Needs you* above it. This is the arrangement §2.2 exists for. |
| A `stopped` task under an `active` story | Task row in *Not running*, story row in *In progress*. The task's own control is Restart. |
| A needs-you or stopped task whose parent is `open` or `closed` | It still gets its row; slot 2 names the parent whatever state the parent is in. The list does not ask a parent's permission to show a task that needs a person. |
| A work changes group while on screen | It moves. Nothing else reorders (§2.3). |
| A closed task under a story that is not closed | No row, in either segment. It is inside its story, which is where a finished task is looked for. |
| A work in another worktree | Badge in slot 3; the Chat control switches worktree, exactly as the old row's did. |
| A title too long for one line | Truncates. The detail page is one tap away and has the whole of it. |
| A work with no role | Slot 4 is omitted, not drawn as `—`. An empty slot is not a fact. |
| Two rows' commands both fail | Each row carries its own line 3. The failure lives in the row's own command state, and two rows are two works. |
| A command fails, then the work's status changes anyway — the engine stopped it, an agent closed it | Line 3 goes with the status change: by the row remounting if the work changed group, and by the command's own reset if it did not. The button is a different verb now, and the message was about the old one. |

## 7. Deliberately not done

- **Paging.** Not here: the archive pages and the `Current` segment does not,
  for reasons that belong with the other list's — [list-paging-ui.md](list-paging-ui.md).
- **Search or filter over the archive.** One tap reaches it and it is sorted
  newest-first; a project large enough to need search is not a project this page
  has, and a search box would cost the screen its simplest line.
- **A master-detail split on the expanded tier.** The list renders in the main
  panel beside the sidebar, and two columns inside that panel would put a list,
  a detail and a sidebar in the space of one chat. One column at every width.
- **Reordering, priorities, due dates.** Nothing in the data model carries them
  and nothing in the page's job needs them.
- **Grouping by worktree or role.** Both are slots on the row and neither is a
  question this list is asked; the group axis is state, and it has one.
- **Any change to the agent-role screens.**

## 8. What the implementation had to get right

The checks, in the order they would fail, and where each one is now:

| # | Check | Held by |
|---|---|---|
| 1 | A task with `needs_answer` is its own row in *Needs you*, and its story is not | `WorkListOverlay.test.tsx` |
| 2 | A `stopped` task is in *Not running* with a Restart control | `WorkListOverlay.test.tsx` — the group on a stopped task, the Restart control on a stopped story, the row being the same component either way — and `WorkPrimaryAction.test.tsx` for the label itself |
| 3 | No row renders a chevron or a collapse toggle, and no group heading is a button | `WorkListOverlay.test.tsx`, `WorkRow.test.tsx` |
| 4 | `work.create` resolving lands on the new work's detail; rejecting leaves the sheet open with the error and does not navigate | `CreateWorkSheet.test.tsx` for the sheet, `WorkListOverlay.test.tsx` and `WorkDetailOverlay.test.tsx` for each caller's wiring |
| 5 | Switching segment and then entering and leaving a detail returns to the chosen segment | `WorkListOverlay.test.tsx` |
| 6 | Back from a story detail reaches `/works`, and from a task detail its parent story | `WorkDetailOverlay.test.tsx` |
| 7 | Both row controls are 44 × 44 under a coarse pointer | `web/tests/touchTarget.test.ts`, which reads every icon-only control |
| 8 | The list and the story detail's Tasks section render the same row component, and only Tasks drops the parent slot | `WorkRow.test.tsx` (the slot), by construction elsewhere |
| 9 | Creating with no agent role opens the sheet on its message rather than doing nothing | `CreateWorkSheet.test.tsx`, which also separates that message from *loading* and *failed* |
| 10 | A failed row command prints its message on the row, and the control keeps its own action label rather than wearing the error | `WorkRow.test.tsx` for the message and the label together, `WorkPrimaryAction.test.tsx` for the button on its own |
| 11 | The message goes when the work's status changes under it without the row changing group | `WorkRow.test.tsx` |
| 12 | The message is the control's accessible description while it is there, and the attribute is *absent* — not pointing at nothing — while it is not | `WorkRow.test.tsx`, in the same case as check 10. It asserts the missing attribute rather than an empty description, because a dangling id and no attribute compute the same empty description: assert the description and a dangling id passes |

Check 6 was the one that reached the end of the rewrite untested. It had been
written down as the behaviour that was already right and could be lost while the
screen around it was rewritten, and it survived — `WorkDetailOverlay` still
passes `onBack={parent ? () => onOpenWorkDetail(parent.id) : onBack}` — but
until the review nothing asserted it, which is exactly how the next rewrite
would have dropped it. Both destinations are asserted now.

Both gates named in the design went red and were answered rather than silenced:

- **`web/tests/touchTarget.test.ts`** compares the control register in
  [responsive-ui.md](responsive-ui.md#outside-the-floor-today) against the code.
  All three of its `WorkListOverlay` entries stopped existing — the task title
  in a `min-h-[36px]` row (there are no nested task rows, and no 36px row), the
  labelled Start chip (§3), and the title centred in a `min-h-[44px]` row, which
  the design expected to survive and which did not: the screen draws no row of
  its own any more, and `WorkRow` states its 44 rather than centring in it. The
  register and the graded list that named them were regenerated from the scan.
- **`WorkListOverlay.test.tsx`** asserted the five groups, the closed group's
  default collapse and the nested task rows. Those are the behaviours that were
  removed, so the file was rewritten against the rules above rather than adapted.

One thing the implementation found that the design did not know: the scan behind
the register read `after:inset-0` as the control's own box, so the row-wide hit
overlay would have taken `WorkRow`'s title out of both the floor check and the
register at once. The scan now drops tokens behind a pseudo-element variant
before reading them ([responsive-ui.md blind spot
8](responsive-ui.md#the-automated-gates)), and the title states `min-h-[44px]`
as well as laying the overlay — the overlay is the `::after` box, so the `min-h`
is the number the floors are answered with.
