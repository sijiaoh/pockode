# Cross-Worktree Session UI

How a user reads a conversation that belongs to a worktree they are not standing
in — including one that no longer exists — in `web/src/components/Session/` and
`web/src/components/Chat/`: what the URL says, how the sidebar offers those
sessions, and what the chat screen becomes when it cannot be written to.

The feature exists because **session data outlives the worktree it was made in**:
deleting a worktree leaves its conversations, attachments and all, exactly where
they were ([why that is the right trade](code/work-system.md#what-a-deletion-leaves-behind)).
What is left has to be reachable from wherever the user happens to be, and
unreachable data is the same as deleted data. That is what this screen is.

Related: [agent-chat.md](agent-chat.md#sessions-outlive-their-worktree) for the
wire methods those reads use, [code/work-system.md](code/work-system.md#worktree-deletion-protection)
for what a worktree deletion is allowed to do at all,
[list-paging-ui.md](list-paging-ui.md#36-when-the-sidebar-is-showing-another-worktrees-sessions)
for the paging promises the merged list has to keep,
[session-fork-ui.md](session-fork-ui.md) for the other banner a transcript can
carry, and [sidebar-ui.md](sidebar-ui.md) for the weight ladder, narrow-width
rule and colour semantics every row here obeys.

## Read-only is structural, not a rule the screen keeps

A viewed session is read-only because of where its data comes from, not because
anything decided to disable the controls. It is read through `session_view.*`,
which has no method that can say anything to a session and no subscription to
follow — so there is nothing to disable and nothing to re-enable. The screen only
has to *say* so.

Two consequences run through everything below:

- **Nothing on this screen updates.** What was read was true when it was read.
  The transcript is therefore settled as an idle turn whatever the session was
  doing, and the reads never refetch in the background.
- **A worktree that still exists is not a place to talk from either.** The user
  is expected to switch to it, which is what `Open there` is for. Reading another
  live worktree's conversation and reading a deleted one's are the same screen
  with two wordings.

## The URL: `from`

One search parameter, on the two session routes only:

| URL | What it means |
|---|---|
| `/w/A/s/abc` | An ordinary session: the data belongs to worktree `A`, the one in the path |
| `/w/A/s/abc?from=feature-x` | The user stands in `A`; the transcript is read out of `feature-x`, read-only |
| `/w/A/s/abc?from=` | The same, reading the **main** worktree — the empty string is a value, not an absence |
| `/w/A/s/abc?from=A` | Naming the worktree already in the path is an ordinary session, not a read-only one |

**The worktree in the path is still where the user is standing**, and `from` never
moves it: Files, Git and Project are about that worktree and are untouched. The
reasoning behind each row — which routes may carry the parameter, why `""` differs
from absent, why the last row is a no-op rather than an error — is stated with the
parameter itself, in `SESSION_VIEW_PARAM` (`web/src/lib/sessionView.ts`), and
nowhere else. Build these URLs with `buildNavigation` and read them with
`useRouteState`; nothing composes the search string by hand.

Overlay routes deliberately do not carry it (see [Known gaps](#known-gaps)).

## The sidebar: one worktree at a time

### The filter panel

`Filter sessions` holds one flat level of grouping — the panel's own title is its
heading, so the existing checkbox has no group header of its own:

```
Show task sessions
──────────────────────────────
WORKTREES
  ○ This worktree
  ○ All worktrees
  ○ <GitBranch> feature-x     12
DELETED
  ○ <Archive>   old-fix        3
```

- **A single choice, not a set.** The intent is "go and look at another
  worktree's conversations"; a combination of two worktrees answers no question
  anyone asks, while forcing every row to say which one it came from.
  `All worktrees` covers the one cross-worktree need there is — *I don't remember
  where it was*.
- **`WORKTREES` and `DELETED` are one radio group.** They separate the two states
  visually; splitting the group along them would split one choice into two.
- **The worktree the user is standing in is not listed.** It is `This worktree`,
  and listing it twice would make one list reachable two ways.
- **With no other worktree holding sessions, the whole group is absent.** A
  choice between one place and all of it is not a choice — on a machine with one
  worktree this panel is exactly what it was before. Which worktrees have sessions
  is asked only while the panel is open or the sidebar is already showing another
  worktree's list, never merely to draw the sidebar. The one exception is a
  filter that has already left `This worktree`: the group is the only way back
  from one, and the last other worktree can lose its last session while its list
  is the one on screen.
- **The count on each row is not decoration.** It is the only warning a user gets
  that deleting the last session takes that worktree out of the filter for good.
- Options are ordered main first, then by name — the server answers in the order
  it walks the disk, which is no order to look something up in.
- Choosing a worktree closes the panel; the checkbox above it does not. A choice
  among several is over once made, and on a phone the panel sits over the very
  list it just changed. A toggle is flipped, looked at, and often flipped back.

While the filter is anything but `This worktree`, the trigger button carries a
`BadgeDot` and renames itself (`Filter sessions, showing worktree feature-x` /
`…, showing all worktrees`). Nothing else on screen says the list is somebody
else's once the panel is closed, and the filter is not persisted, so there is no
other way to find out.

### `GitBranch` and `Archive`

Two glyphs carry "still there" against "deleted", in the filter rows, on the list
rows, on the context line, on both strips of the read-only screen, and on a
work's `WorktreeBadge`. A 240px row has no space for the word `(deleted)`, and
`Archive` says exactly the right thing — *kept, but no longer running*. Screen
readers get the word: `, deleted worktree`.

**Neither state is ever `th-error`.** A deleted worktree is unusual, not a
failure, and [sidebar-ui.md](sidebar-ui.md#visual-weight) forbids red for the
former. A deleted worktree's `WorktreeBadge` also stops being a link — there is
nowhere to go — and drops to a muted static marker.

### Where the difference is announced: once, above the list

Under any filter but `This worktree`, one context line sits between the header row
and the list:

| Filter | Line |
|---|---|
| a worktree that exists | `Sessions in "feature-x". Opening one switches to that worktree.` |
| a worktree that is gone | `"feature-x" was deleted. Its sessions can only be read.` |
| `All worktrees` | `Sessions from every worktree. Opening one may switch worktree.` |

The difference belongs to the list, not to any session in it: on a row it would
repeat dozens of times and compete with the title for a 240px line. Under
`All worktrees` the per-row glyph carries the distinction instead.

**It must not look like a group header.** Sentence case, no uppercase, no letter
spacing, and it alone has a bottom border. At the same size a label and a
statement can only be told apart by shape, and unheeded this line reads as a
third group header.

### The rows

- Under `This worktree` **no row is marked**. Every row carrying the same name is
  noise.
- Otherwise the marker goes in the row's **subtitle**, not its left slot: the
  left slot is fork's, and a forked session from another worktree would otherwise
  need two. The subtitle reads `<glyph> feature-x · 14:22`, the name truncating
  and the time holding its width — the name is what gives way in a 240px column.
- A row of the worktree the user is standing in is unmarked even under
  `All worktrees`, and opens and deletes exactly as it always has.
- **The open session's row is highlighted whichever list it came from.** A viewed
  session has no row in this worktree's list, so it is not what the shell otherwise
  calls the current session; the filter has moved to the list that does have a row
  for it, and that row is the one to mark. Session ids are unique across worktrees,
  so there is nothing to disambiguate. Without this the one-shot filter move above
  would buy a list with nothing selected in it.
- **The filter never touches `New Chat`.** It always creates in the **current**
  worktree and is never disabled on account of the list belonging to another one
  (only a worktree switch in flight disables it). The context line is what keeps
  that from being read wrongly.
- Empty states name what was asked: `No sessions in "feature-x".`, `No sessions.`
  under `All worktrees`, and the original `No conversations yet` for this
  worktree.

### The filter's lifetime

- **Not persisted**, unlike `Show task sessions`. Going to look at another
  worktree's conversations is an act, not a preference; remembering it would open
  the sidebar on a stranger's list days later with no sign of why.
- **Reset when the worktree changes.** Switching means the user has arrived where
  they were going.
- **Moved once, at the moment of navigation**, when a session is opened that the
  filter has no row for — the ordinary way into a deleted worktree's session is a
  work's chat link, and without this the sidebar would show a list in which
  nothing is selected. It works in both directions: opening an ordinary session
  while the filter points elsewhere brings it back to `This worktree`. It happens
  **once**; from then on the filter is the user's, even pointed somewhere the open
  session has no row in.
- A worktree whose last session is deleted drops off the server's list, and a
  filter naming it falls back to `This worktree`. `All worktrees` falls back on
  the same event, once no worktree but this one has sessions left: the panel
  stops offering worktree rows at that moment, so a selection left standing
  there would be one the user could no longer undo — on a snapshot of the very
  list they already have live. Only on the server's own answer — a *failed* read
  has also "been asked" and knows nothing, and the empty list it leaves behind
  would take the user's selection away over a moment of bad network.

### `All worktrees` is merged on the client

There is no request for "every worktree's sessions": `session_view.list` names one
worktree, so one round asks every source that still has a page and
`mergeSessionRounds` (`web/src/lib/sessionMerge.ts`) puts the results in one
order. One source or several is the same machinery.

Two paging promises have to be re-earned by hand, because the server cannot make
them across sources:

- **A safety line.** Each source is read newest-first, so everything a source has
  not handed over yet sorts below the last row it has. A merged row is only shown
  once it sits at or above the last row of *every* source that still has more —
  below that line another source's next page could still land in between, and
  inserting a row above what the reader has already scrolled past is the one thing
  paging may not do ([list-paging-ui.md §2.4](list-paging-ui.md#24-the-list-holds-still-while-it-is-being-read)).
  The line only moves down, so the visible list only grows downwards.
- **Dedupe by id**, newest copy winning, exactly as
  [§3.3](list-paging-ui.md#33-the-constraint-paging-puts-on-the-server) requires
  of every list here. A session touched between two requests moves within its
  source and can be handed over twice; so can a refresh that re-reads a round.

The cost is that a deep scroll over many sources fetches some rows it cannot yet
show. A filter naming one worktree runs the same machinery with one source and
never truncates.

### Refreshing, and why it is never automatic

These lists are one-shot reads, so they are re-read only when the user does
something that asks for it: opening the sidebar, pulling to refresh, changing the
filter, deleting a row. Installing a round replaces the list and restarts paging,
so a background refetch would silently cost a reader every earlier page they had
pulled in and the position they were at.

A refresh **invalidates rather than resets**: the rows stay on screen and every
round the reader had pulled in is asked again. There is no store holding these
rows, so dropping them would flash a skeleton every single time the sidebar
opened. Dedupe is what makes re-reading a landed round safe.

A read that fails has to say so. An empty list would claim *nothing was ever said
here*, which is the one thing a failure must not be allowed to say, so the panel
shows the reason and a `Retry`. Under `All worktrees` a failure to even learn
which worktrees exist is fatal in the same way; a filter naming one worktree reads
that worktree regardless.

## The read-only screen

The same `ChatPanel`, with three strips changed and several controls gone.

**Which of its two wordings a user actually meets.** Nothing in the app routes
here for a worktree that still exists: a sidebar row and a work's chat link both
switch to it instead, and the only way to *read* a live worktree's session from
outside is a hand-written URL — or a source worktree that comes back under its old
name while its session is on screen, which is exactly the case `Open there` is
there for. The deleted wording is the one the app reaches on its own.

### Top: whose conversation this is

`SessionOriginBar` — `<GitBranch> Session from "feature-x"`, or
`<Archive> Session from "feature-x" (deleted)`.

It does not scroll with the transcript: *this is not the worktree you are in* has
to be true at every scroll position. That is what separates it from
`ForkOriginBanner`, which states a fact about where the transcript *begins* and is
right to scroll away with it. It carries no control at all — it answers "whose
session is this", and what can be done about it belongs at the other end of the
screen, next to where an answer would have been typed.

### Bottom: what stands where the composer stood

`ReadOnlyBar` replaces `InputBar` — it does not disable it. A disabled box invites
the user to wait for it to come back, and nothing is coming back: the execution
environment is elsewhere, or gone. It is as tall as the composer's single-line
state, so moving between a live session and a viewed one does not make the page
jump.

| Source worktree | Copy | Control |
|---|---|---|
| exists | `Read-only — this session belongs to "feature-x".` | `Open there` |
| deleted | `Read-only — the worktree "feature-x" no longer exists.` | none |

`Open there` is a **secondary** control, not an accent one: accent means "the one
thing to do here", and the one thing to do here is read. Switching worktree is a
change of context and must not shout louder than Send once did from the same row.
Its accessible name is the whole sentence (`Open this session in worktree
feature-x`) while the label stays short, as `WorktreeBadge` does. It lands on the
session's ordinary URL in its own worktree with `from` dropped, so the screen
that arrives is a live, writable one.

### The action bar between them

- **`Engine` and `Mode` are removed, not disabled.** Disabled reads as "not just
  now", and what is missing is the execution environment itself.
- **`Stop` is not rendered** — there is no open turn to end, and none can start.
- **`Session info` stays.** What the session spent and which work it belongs to
  are still readable, and it is the way back to that work.
- The row keeps its border and padding with one button in it, so the two screens
  do not differ in height at the bottom.

### In the transcript

Reading is untouched: images and attachments, tool-call expansion, a code block's
copy button. **Scrolling back pages exactly as it does in a live session** — the
newest page arrives where a subscription's snapshot would have, and earlier ones
come from the same cursor under a different method name, so the transcript, its
sentinel and its scroll anchoring are the same code
([agent-chat.md](agent-chat.md#history-paging)). What goes is anything that would
speak:

- **Fork is gone from every row** in both source states. A fork starts a session,
  which only the worktree that owns it can do — so forking means `Open there`
  first, and for a deleted worktree it means nothing at all. Fork is the whole of
  the message menu, so the `…` slot is not rendered at all rather than opening on
  nothing — a read-only session is a third way for the session-level condition to
  come out `no`, beside a host that cannot navigate and an agent that cannot fork
  ([session-fork-ui.md](session-fork-ui.md#which-rows-reserve-a-slot)).
- **`AttentionStrip` and the answer panel are not rendered.** An unanswered
  question cannot be answered from here — and the panel putting itself up on
  the foot of the conversation
  ([answering-ui.md §4](answering-ui.md#4-when-the-panel-is-up)) is gated on the
  same read-only check, so nothing arrives over a transcript that is here to be
  read.
- **The openers inside the transcript go with them.** A question card's
  `Answer this`, a permission card's `Allow`/`Deny`, and the empty state's
  hints are all withheld by giving the list no handler for them — each card
  already draws itself without a control when it has none. A pending card that
  offers nothing is the truth here, not the dead end it would be in a live
  session. The question card is the one that needs saying: its status comes
  from the records rather than from the turn, so unlike the permission card it
  is not settled by the idle turn a viewed transcript is read under, and
  `Answer this` would otherwise name a question in an answer panel that is not
  rendered.
- **An empty transcript says `Nothing was said in this conversation.`** rather
  than the live screen's `Start a conversation...` — an invitation under a bar
  that has just explained there is no composer.

### When the read fails

A refused read is said out loud rather than left as an empty transcript, which a
reader would take to mean the conversation *was* empty. A session the source
worktree no longer has reads `This session is not in "feature-x" any more.`;
anything else shows the server's own reason. One question on screen — *can this
conversation be read* — gets one answer, so the metadata and the transcript are
read together and a transcript that failed alone cannot hide behind a title that
arrived.

### Two boundaries

- **`from` naming the worktree in the path is not a read-only screen.** Without
  that rule, `Open there` would flash one on its way out.
- **The strips read live state, not a snapshot.** A source worktree deleted — or
  recreated under the same name — while its session is on screen moves the copy
  and the presence of `Open there` with it. Until the worktree list has landed the
  screen waits, because before then "deleted" cannot be told from "not asked yet".

## Deleting

**No delete control is added to the read-only screen.** Session deletion has never
lived on the chat screen — it lives on the sidebar row, which is one tap away —
so nothing was taken off this screen and nothing has to be put back
([responsive-ui.md](responsive-ui.md#what-may-be-hidden-three-levels) grades a
control by what is lost *on the screen it is on*). What had to be true is that the
existing path keeps working: a row's delete button is neither hidden nor disabled
because its worktree is gone, and the confirmation is the same one every other
session gets — `This action cannot be undone.` has
already said everything.

Which call is made follows the row, not the connection: a row of this worktree
goes through the ordinary session delete, a row of another (or of a deleted)
worktree is deleted by name. Nothing is pushed afterwards, so both `session_view`
reads are asked again — one delete can move both, the row leaving the list and the
worktree leaving the filter when it was the last one.

Deleting the session the read-only screen is showing leaves that screen: this
worktree's list is not the list the row came from, so there is no neighbour to
fall back to. The user lands in the current worktree and the filter follows the
session they arrive on, which is `This worktree` — even when the source worktree
still has other sessions. That is the one-shot navigation rule winning over the
narrower one, and it is the consistent outcome: the alternative shows one
worktree's conversation beside another worktree's list.

## Known gaps

- **Overlay routes do not carry `from`.** Opening Project, Files or Git from a
  read-only session and closing the overlay returns to the current worktree's home
  rather than to that session; browser Back still returns. Teaching every overlay
  route the parameter would give the convention a second place to live, for a
  route the user reaches only by leaving the screen.
- **File links open the current worktree's file.** A path in a viewed transcript
  may name a file whose content differs, or which does not exist. Files belong to
  the worktree the user is standing in, by design.
- **A current-worktree row under `All worktrees` is a snapshot** like every other
  row in that list, so a session running right now may show a stale state there.
  `All worktrees` is a way of finding something, not a view to sit in; one
  mechanism per list is worth more than mixing a subscription into a merge.
- **A failed delete is silent.** That is not new here — the ordinary session
  delete has the same gap, and the new path was deliberately shaped like it rather
  than growing an error surface of its own.

## Considered and not done

- **Multi-selecting worktrees** — see the filter panel: the combinations answer
  nothing and cost every row a label.
- **A server-side cross-worktree list.** It would remove the merge and the safety
  line and change nothing on screen: `useSessionViewList` would fetch differently
  and `mergeSessionRounds`, a pure function, would be deleted whole. It is the
  only alternative if the client-side merge ever stops being worth its fetches.
