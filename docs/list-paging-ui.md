# List Paging UI

How the two lists that grow without limit — the session sidebar and the project
list — stop being fetched whole, and what that does to the live updates already
pushed onto them.

This file is the design; it names no protocol field and no data structure. What
it does name are the promises the interaction makes, because those are what a
paging implementation is free to break silently.

Read alongside [sidebar-ui.md](sidebar-ui.md) (the panel the session list lives
in), [project-ui.md](project-ui.md) (the screen the work list is) and
[agent-chat.md](agent-chat.md#history-paging), which is the one list in the app
that already pages and is the pattern the session list follows.

## 1. The two lists are not the same list

| | Session sidebar | Project list |
|---|---|---|
| What it is for | Getting back into a conversation | Seeing what needs a person |
| Order today | `updated_at`, newest first (`server/session/store.go` — `FileStore.List`) | The order the store holds, which is creation order; the archive alone is sorted, by `updated_at` |
| Sort key | **Moves constantly.** Every turn touches it | Stable. A row's position never changes while it is on screen (project-ui.md §2.3) |
| What the user does with it | Scans the top, occasionally digs | Reads the groups, acts on a row |
| What grows without limit | Sessions, forever | Closed work, forever |
| Chosen interaction | **Infinite scroll** | **Paging, in the archive only** |

The two choices come out of the two rows in that table that differ most: the
session list is scanned in one direction from a known end and its order is
already recency, which is exactly what a scroll is; the project list is read as a
whole with counts and groups over it, which is exactly what a scroll is not.

**Where this departs from the ask.** "Sessions scroll, work pages" was the
starting suggestion and it survives, with one correction: *the work list does not
page — its archive does*. Paging the rest of that screen would page the one
list in the app whose job is to say that something needs a person, and §2.1 is
why that cannot be a page. The half of the work list that actually grows without
limit is the archive, so that is the half that pages; the other half gets a cap
on each of its two unbounded groups (§4.1) and keeps every promise it makes
today.

## 2. What a page may never break

Four promises the current screens make. Each was made without paging in mind,
and each fails quietly if a page is allowed to be the whole truth.

### 2.1 A count is over everything, never over a page

The *Needs you* heading carries a count, and the Project tab carries an
attention dot derived from the same predicate over the whole work list
(`web/src/components/Project/ProjectTab.tsx`). A count computed over a loaded
page is not a smaller count — it is a wrong one, and the dot is worse: it is an
*absence* of a signal, so a user is told there is nothing to do by a list that
simply has not been read that far. **Nothing that says "how many" or "is there
any" may be derived from a page.**

This is the constraint that decides §4: the part of the work list those signals
are read from is not paged at all.

The sidebar has one of these too, and it was missed when this was first written:
the Sessions tab's unread dot was `sessions.some(unread)`. An unread session is
one an agent finished with while nobody was looking, which is precisely the
session a reader has not scrolled to — so it is the worst possible thing to
derive from a page. It is answered by the server now, over the whole list and
narrowed by the same filter the subscription holds, and it rides on the snapshot
and on every notification after it.

### 2.2 A story arrives with the tasks it speaks for

A story's row states `{n} active` and `{closed}/{total} tasks` over its children
(project-ui.md §3), and those children include tasks that get no row of their
own — a closed task under an open story is counted here and listed nowhere. A
task row, in turn, names its parent story, and can only get that name from the
parent itself.

**A page is therefore not a set of rows; it is a set of rows plus everything
those rows make claims about.** Whatever unit a page is cut along, a story and
its tasks are on the same side of the cut, in both directions.

The same rule reaches one screen this document did not anticipate. A story's
*detail page* read its children out of the work list, which was sound while that
list was every work item. Once it is `Current` and holds nothing closed, a
closed story reloaded on — a daily act, on a URL people share — shows no tasks
while its own row claims `{closed}/{total}` over them. So the detail answers for
its own subtree instead of borrowing the list's
([code/work-system.md](code/work-system.md#the-list-holds-rows-the-detail-page-holds-the-item)).
A story bounds its children and §7 already refuses to page them, so this asks
for nothing unbounded.

### 2.3 An absence is not evidence

One rule for naming a session the list has no row for already exists
(`web/src/lib/sessionStore.ts`), because the session list is narrowed by a
filter, so a session missing from it is not a session that is gone. Paging adds
a second reason for a row to be missing — it is further down than the user has
read — and every surface that reads a title or a state out of the list has to
survive it. **A row that is not
loaded reads exactly like a row that is filtered out: unknown, never deleted.**

Concretely, that rule had to stop deciding on the filter alone. It answered "a
deleted session" whenever nothing was being filtered, which is sound while the
list is everything and wrong the moment it is a page — and the two callers print
its answer to the user in words (`SessionItem`'s fork line,
`ForkOriginBanner`). Once the list can be partial there is only one honest answer
left for a row that is not there, whatever the filter is doing — which leaves no
state for it to decide on, so it is a constant (`UNLISTED_SESSION_NAME`) rather
than a selector.

### 2.4 The list holds still while it is being read

project-ui.md §2.3 already promises this for work rows: "rows keep the order the
list arrives in, so a work that starts or blocks while the list is being read
stays where the user's eye left it". The session list has never made that promise
and has never needed to, because the user reads its first screen and the rows
that jump to the top are jumping into view, not out of it.

With infinite scroll it needs the promise, and §3.2 gives it the same one.

## 3. The session sidebar — infinite scroll

### 3.1 Loading

The list loads its first page with the sidebar, exactly as today. A sentinel row
sits at the end of the list and asks for the next page when it comes within about
one screen of the viewport, so the rows are there by the time the user's thumb
gets to them. One page per arming: the request that lands re-arms the sentinel,
a request that fails disarms it.

This is `MessageList`'s pattern inverted, and inverting it deletes its hardest
part. Chat pages *upward*, so every landing page pushes the reader's content down
and has to be measured and re-pinned around. The session list pages *downward*:
rows are appended below the fold, nothing on screen moves, and there is no anchor
to restore. **No page that lands here needs a scroll measurement.** The one thing
that can still move the reader is a row arriving at the *top* while they are far
down it, and §3.2 says who absorbs that.

| State | What is on screen |
|---|---|
| First load | The existing `SessionListSkeleton`, unchanged |
| More to come, at rest | A fixed-height row at the end of the list. Fixed so that a spinner appearing in it never resizes the list |
| Loading a page | A spinner in that row, `srText` "Loading earlier conversations" |
| The page failed | The message, and the row's control relabelled **Retry**. Auto-loading stays off until it is pressed — an observer left armed over a sentinel that never moves retries in a tight loop behind the user's back |
| No more to come | "No earlier conversations", and **only if the user has actually paged at least once**. On a list that fitted in one page, saying where it ends states the obvious (the same rule as chat's "Beginning of conversation") |
| Empty list | The existing "No conversations yet" |

**The sentinel row is a button, and it is the same button in every state above.**
Visually it is the spinner row; to the keyboard and to a screen reader it is "Load
earlier conversations", reachable by Tab and activated by Enter, and after a
failure it is the Retry the table names — one control under two words, never two
controls. It clears the hit-area floor like any other.

It exists because infinite scroll with no manual control is the one part of this
pattern that is routinely inaccessible, and it costs one element to avoid. It is
also the only way on in the two states where the observer is not going to fire
again by itself: after a failure, and after a page that did not fill a tall
viewport.

Pull-to-refresh stays where it is, at the top. It and the sentinel are at
opposite ends of the same scroll container and cannot be reached in the same
gesture.

### 3.2 Live updates, once the list is longer than a page

The subscription keeps pushing. The rules:

| Event | Behaviour |
|---|---|
| A session **changes** — new turn, unread, title | The row updates in place. **It does not move.** |
| A session is **created** | Prepended, at the top of the list, where it genuinely belongs. The user is not scrolled to it |
| A session is **deleted** | The row goes immediately. It is the answer to an action, and an action's answer is never deferred |
| A session changes but is **not loaded** | Nothing. It will be in its right place the next time the order is computed |

A prepend is the one event that moves everything below it, and a reader 200 rows
down would see the list slide by one row. **The browser's own scroll anchoring
absorbs that, and the session list must therefore leave it on** — which means not
doing what the transcript does, where it is switched off (`overflow-anchor: none`)
precisely because chat pins its own anchor by hand. A list that does no measuring
of its own must not disable the thing that measures for it. This is the one place
in §3 where that matters, and it is worth a test of its own (§8).

**Recency reordering happens on a load, not on an event.** That is the whole
rule, and it is the same one project-ui.md §2.3 already states for work. Today
the list re-sorts on the server for every fetch and never re-sorts on the client
at all, so this is not a new behaviour — it is the existing behaviour, named, so
that paging cannot be built on the assumption that a row may be moved to the top
of a list somebody is 200 rows into.

The server already keeps a rule of this shape on the other side, and for the
same reason: `FileStore.AddUsage` deliberately leaves `UpdatedAt` alone, because
"moving the session to the top of the list every time a turn is metered would
reorder the list behind the user's back". §3.2 is that sentence applied to every
other kind of touch.

A frozen order is legible rather than arbitrary because every row already prints
its own `updated_at` (`SessionItem`'s subtitle). A row sitting above one that was
touched more recently is not a list in no order — it is two visible dates, and
the user can see which of them the list was sorted on.

The order is recomputed, and the list collapses back to one page, on exactly
these: opening the sidebar, pull-to-refresh, switching worktree, flipping the
task-session filter, and reconnecting. All five are things the user did, and all
five already reset this list today.

**The open session may be outside the loaded range, and nothing is invented to
fix that.** Reading a session does not touch its `updated_at` — neither
`SetUnread` nor `AddUsage` does — so opening an old conversation and not writing
in it leaves it exactly where it was, possibly pages down. No row is manufactured
at the top for it: the list is sorted, a row pinned out of that sort is a row
whose printed date contradicts its position, and the sidebar is how the user
*leaves* the session they are in, not how they confirm they are in it.

Nothing needs building for this. The shell already resolves the open session
without the list — `useSessionDetailSubscription`, with `AppShell`'s own note
that "the list alone can no longer say" — because the task-session filter
created this same absence first. Paging is its third cause and its first two
already have the answer. What is lost is the active highlight on a row that is
not on screen anyway.

### 3.3 The constraint paging puts on the server

The sort key is `updated_at` and it moves while the user scrolls. A page asked
for by position — "the next 30 after 60" — will skip rows and repeat rows as
sessions bump to the top behind the request.

> **Hard constraint.** Asking for more must mean *"the sessions that come after
> this one"*, naming the row the user can see at the bottom of what they have —
> never *"skip the first N"*. And the client dedupes by id regardless: the
> constraint removes the systematic error, not every race.

A skipped row here is not a cosmetic defect. It is a conversation the user cannot
find by scrolling, and they have no way to know it was skipped.

### 3.4 A resync must restore what the user had

A dropped event makes the server re-send the whole list. Today that replaces the
list wholesale and costs the reader nothing, because the whole list is what they
had. With paging, replacing it with a first page strands a reader who was five
pages down past the end of a list that just got shorter under them.

**A resync restores as much of the list as the user had loaded, not the first
page of it** — up to a cap of five pages, beyond which the list collapses to the
top, because a client that has to be handed 150 rows to recover is being handed
back the problem paging was introduced to remove. Resyncs are rare (they follow
a dropped event) and a deep-scrolled sidebar during one is rarer; the cap is
where those two rare things are allowed to be visible.

"Collapses to the top" is not a scroll the app performs. The list simply gets
shorter and the browser clamps the reader to its new end, which is where they
were headed anyway; what the app does is **disarm auto-loading whenever a resync
returns fewer rows than were held**, because a sentinel left armed at that new
end would ask for the next page at once and undo the cap. The button is still
there, so one press resumes. The distinction that has to be kept is between a
resync and a *snapshot*: a snapshot is a different list — another worktree, a
flipped filter — and a short one says nothing about where the reader was.

### 3.5 Why not virtualize instead

A windowed list would cap the DOM and cap nothing else — the rows still arrive,
still parse, still sit in the store, and the transport cost this work exists to
remove is paid in full. Virtualization is the answer to "too many rows on
screen"; paging is the answer to "too many rows fetched", which is the actual
report. They compose later if a 30-row page ever proves too heavy to render, and
nothing in §3 forbids it.

## 4. The project list — the archive pages, the rest does not

### 4.1 Current is loaded whole, and that is the design

The `Current` segment is not paged. Three reasons, any one of them sufficient:

- Its counts and the Project tab's attention dot are read off it (§2.1).
- Its rows are grouped and rolled up across the whole set (§2.2): a page
  boundary inside it is a wrong count on a story row.
- It is the screen's answer to "what needs me", and that question has a small
  answer. Work in flight is bounded by how much a person can be in the middle
  of.

"Whole" there means §2.2's whole: a closed task under an open story is part of
what `Current` needs, because its story's row counts it, even though it gets no
row in either segment and is not in the archive either. The rows are not the
payload.

What is not bounded is the work nobody is driving: `open` work piles up in
*Not running*, and `stopped` work piles up in *Stopped* — nudges run out, runs
abort, users press Stop — and nothing closes either by itself. So:

> **The cap is on those two groups, each on its own.** Above a generous number
> of rows (see §5), a capped group arrives short, and **the rows it is missing
> are taken off the bottom of it**. *Needs you* and *In progress* are never
> capped and never truncated: they are the two groups the screen exists for, and
> a "show more" under either of them is a list telling the user it has more work
> for them and declining to say what.

**Each capped group gets its own cap and its own hidden count**, because a
group's heading shows "rows received plus rows held back" (below): one number
spanning two headings would make at least one of them wrong. They share the same
*number*, though — there is no reason for the two to hold different amounts, and
two numbers would be two things to explain.

*Stopped* is capped even though every row in it wants a person. The cap limits
what a single subscription *ships*, not what is on the screen — fifty rows is
already several screens either way — and a group that accumulates and is never
capped is the unbounded group moved to the top of the list rather than removed.
The promise survives the cap because the heading counts the whole group and the
control fetches the rest; *Needs you* is exempt not because "groups that want you
may not be capped" but because it cannot accumulate — every row in it has a live
agent waiting.

Off the bottom, and not off the front, because both groups are shown
`updated_at` newest first (project-ui.md §2.3), so the bottom is the least
recently touched — and a work the user just touched must not be the one that
vanishes. The same rule cuts the archive's pages, so both cuts in this document
follow the order the reader is looking at. The control sits **above** the
group's rows, directly under its heading, and reads **"Show earlier work"**: it
points the way it leads.

**Both controls can be on screen at once, and either one lifts both caps.**
`work.list.earlier` re-sends the whole `Current` segment uncapped — it is a lid
coming off, not a page being turned (§5) — so pressing one makes both
disappear. That is the right shape for a lid and the reason the request takes no
group argument. One consequence has to be handled rather than inherited: the
request is a single action, so a *failure* is one failure. The error and the
Retry it becomes are rendered under the first group offering the control only;
the second keeps saying "Show earlier work", and pressing it asks for exactly
the same thing. Two copies would announce one failure twice to a screen reader
and leave two buttons reading `Retry` with nothing to tell them apart.

The cap is on what is *fetched*, not on what is rendered. A cap that only hides
rows already in the client leaves the weight this whole change exists to remove
exactly where it was.

The group's count stays the true total either way, and says so — `Not running 120`
over 50 rows and a control is honest; `Not running 50` is not. Which means the
count is a fact that comes *with* the list rather than the length of what
arrived (§2.1); it is the one number on this screen that a client cannot
count for itself.

**And the number is a soft cap, deliberately.** What gets dropped is whole
stories — a story cannot be dropped without its tasks, because it keeps every
one of them for the roll-up on its own row (§2.2), so dropping the tasks alone
saves nothing. But a story may hold a task that is itself a row of its own, and
dropping that story would take the row with it. Those stories are skipped
instead, so when there are not enough droppable ones left the group arrives a
little over the number.

"Only stories are droppable" bites hardest on *Stopped*, and the shape of it is
worth knowing: a stopped **task** is never dropped, so that group's hidden count
is only ever made of stopped stories, and a project with many stopped tasks under
few stopped stories is effectively uncapped there. That is not a defect — what
accumulates without limit is stopped stories, and the number of stopped tasks is
bounded by the stories holding them — but it means how hard the cap bites on
*Stopped* depends on the shape of the data.

That is the right way round. "*Needs you* and *In progress* are never capped and
never truncated" above is an **invariant**; the number is a **budget**; and of
the two, a budget is the one that can be overrun without anybody being lied to.
Nothing downstream may read the cap as an exact bound on how many rows arrive —
which is also why the count that comes with the group, and not the length of
what arrived, is the number the heading shows.

### 4.2 Closed pages

The archive is the one list in the app that grows forever and that nobody is
waiting on. It is also the one already sorted by a key that barely moves — closed
work stops changing — which is what makes discrete pages safe here and unsafe
anywhere else.

```
┌──────────────────────────────────────┐
│ ‹  Project                           │
├──────────────────────────────────────┤
│  Current   [ Closed ]                │
├──────────────────────────────────────┤
│  ◦ Rebuild the project page    3d    │
│  ◦ Wire the relay handshake    5d    │   20 rows
│  ...                                 │
├──────────────────────────────────────┤
│  ‹ Newer      Page 2       Older ›   │  pager, fixed
├──────────────────────────────────────┤
│           + New Story                │  bottom bar
└──────────────────────────────────────┘
```

A page of the archive is subject to §2.2 like any other slice: a closed story on
page 3 still prints `{closed}/{total} tasks`, and its tasks are neither in
`Current` nor on any other page. They come with the page, and they get no rows.

**The pager is a fixed row above the bottom bar, not a row at the end of the
list.** A pager at the end of a 20-row list is two flicks away from the thumb
that wants it, and it is furthest away exactly when the page is full — which is
always, except on the last one. Fixed, it is in the thumb zone, it is in the same
place on every page, and it obeys sidebar-ui.md's principle 1 by not being there
at all when there is only one page to show. Both buttons are 44px, both carry a
word rather than an arrow alone, and each is disabled at its end of the list
rather than removed, so the row does not reflow as the user walks it.

The cost is two stacked fixed rows on a phone, about 100px of chrome. It is
accepted here and would not be accepted in `Current`: the archive is scanned, not
acted on, so the rows it hides are the cheapest rows on the screen.

**Changing page returns the scroll to the top of the list**, because a page is a
new set of rows and reading it from the middle is not a thing anyone asked for.

**"Newer" and "Older", not "Previous" and "Next", and the indicator says `Page 2`
and not `Page 2 of 7`.** Both come from the same constraint as §3.3: the pager
walks from the row it can see, so it can always say where it is and can never say
how far there is to go without counting a list it has not read. Naming the
direction in the archive's own terms — time — is also the only labelling that
survives a user who has forgotten which way the list is sorted, and the relative
`updated_at` on each row (project-ui.md §3, slot 7) agrees with it on every row.

There is no jump-to-page control. It needs a total over the archive, and that is
a different kind of number from the *Not running* count §4.1 insists on: a count
of things to do is a signal to act, while a count of things finished is one
nobody acts on — which is why project-ui.md §2.1 already refused to put one on
the segment itself.

### 4.3 Live updates in the archive

| Event | Behaviour |
|---|---|
| A row on the page changes | Updates in place |
| A work is closed while the user is on page 3 | **Nothing moves.** It belongs at the top of page 1; the page the user asked for is the page they keep. The page is re-asked for along its own cursor, which is a window further down the same order, so the rows that come back are the rows that were there |
| A work on the page is reopened | The row stays, and stays accurate — it is a row about a work item, and the work item still exists. It is gone the next time the page is loaded |
| A row is deleted | It goes, and the page is one row short until the user moves. A page is a window, not a quota |

No "new items" banner, and no auto-refresh. Nobody is waiting on the archive, and
a chip announcing that something finished is a notification wearing a list
control's clothes — [lifecycle-ui.md](lifecycle-ui.md) owns where finishing is
announced.

**"The next time the page is loaded" has to be something that happens.** Twice
above, a row is wrong until then; if nothing ever reloads the page, "until then"
is "until the app is reloaded", and the archive is a list that a user watched
work disappear into and never come out of. That was the first real bug here: the
page's lifetime was the *subscription's*, so a work closing after the segment
had been opened once reached neither half of the screen — gone from `Current`
because it is closed, absent from the archive because the archive is only ever
fetched.

So a close is recorded as *the page on screen no longer says what the server
would*, and the segment being on screen is what turns that into a request. The
same record is made for the two moments that hand back the whole of `Current` —
reconnecting, and a resync after a dropped event — because neither of those
mentions closed work either, and a work that finished inside the gap they exist
to cover would otherwise fall through both halves of the screen. It is not made
over a page that *failed*: the reader is looking at an error and a Retry, and a
refresh would take both away to answer something they did not ask about. The
page asked for is the one the reader is on, never the first: a close lands at the
top of page 1 and cannot move a window further down. It is therefore free in
every case but the one that matters — a reader on page 1, who sees the work they
just finished, which is the whole of the report.

What must **not** be built out of this is an insert. A row landing in the archive
unasked is a page the server never cut: a client that puts a row at the top of
page 1 by itself has a page of 21 rows, a cursor that no longer names its own
end, and a sort it had to invent — which is the same argument §4.2 makes for the
pager and §2.1 makes for counts.

**The subscription itself is not scoped to this screen, and cannot be.** The
watcher behind `Current` is opened with the app and closed with it, because the
Project tab's attention dot is read off what it delivers (§2.1) — a watcher that
ran only while the list was open would leave the dot dark on a project that needs
a person, which is the exact failure §2.1 exists to forbid. What does get a
lifetime is the archive *page*, above: it is fetched when the segment is looked
at and re-fetched when it stops being true, and the paging state is released with
the subscription it was served against (§4.2's cursors are that subscription's,
not the app's).

The `Current` segment, being unpaged, keeps every live behaviour it has today
unchanged. That is the second reason to leave it alone: the one screen in the app
whose job is "tell me the instant something needs me" is also the one that must
not acquire a page the news can land behind.

## 5. Page sizes

| List | Size | Why this number |
|---|---|---|
| Session list, first page and every page after | **30** | A phone sidebar shows about 11 rows: `SessionListSkeleton` is built to match the row and draws it at 56px, over `SidebarListItem`'s 44px floor. 30 is two and a half screens: enough that the sentinel is never already on screen at rest — which would make the first page ask for the second one before the user has done anything — and small enough that the first paint is not waiting on rows nobody scrolls to. Held to one number rather than a larger first page: a first page big enough to matter is a first page big enough to be the problem |
| Session list, resync cap | **5 pages** | §3.4. The point where recovering the user's position costs more than putting them at the top of the list |
| *Stopped* cap, *Not running* cap | **50 rows each** | High enough that an ordinary project never sees the control, low enough to stop either group from being the whole screen. One number for both: there is no reason for them to hold different amounts. It is a cap, not a page: pressing it once loads the rest of *both* groups, and there is no second press |
| Closed archive page | **20** | The pager is fixed (§4.2), so page size is not constrained by reaching it — only by how long a page takes to scan. At 20 a page is about two screens: short enough to be read as one page, long enough that walking a real archive is not all thumb work |

Chat history's 50 (`session.DefaultHistoryPageSize`) is deliberately not matched.
A history record is a fragment of a message and fifty of them are a conversation;
a list row is a whole object with a whole tap target, and fifty of those are a
scroll with no end in sight.

## 6. web-cluster

Nothing to do. `web-cluster` lists **nodes** — project directories on one machine
(`web-cluster/src/components/NodeList.tsx`) — and has no session list and no work
list. Its list is bounded by how many directories a person registers, it is
polled rather than subscribed, and [cluster-ui.md](cluster-ui.md) records that a
filter over it was considered and rejected for the same reason paging would be:
the panel's whole job is one screen long.

If that list ever needs paging, §3 is the pattern to take, and the pointer gates
and hit-area floors it would need are already shared
([responsive-ui.md](responsive-ui.md#the-ladder-is-shared-with-web-cluster)).

## 7. Deliberately not done

- **Paging the tasks on a story's detail page.** A story's children are bounded
  by the story, and the roll-up in §2.2 needs all of them anyway.
- **Search over either list.** project-ui.md §7 already turned it down for the
  archive. Paging does not change that argument; it is the argument.
- **A jump-to-page control, or any total count of the archive** (§4.2).
- **Virtualization** (§3.5).
- **Paging `Current`** (§4.1).

## 8. What an implementation has to get right

The checks, in the order they would fail:

| # | Check |
|---|---|
| 1 | The Project tab's attention dot and the *Needs you* count are the same before and after paging exists, on a project whose archive is longer than one page (§2.1) |
| 2 | A story row's `{closed}/{total} tasks` is right when some of those tasks are closed and the archive has not been opened (§2.2) |
| 3 | Scrolling the session list to the end, while sessions are being touched by a running agent, loses no session and shows none twice (§3.3) |
| 4 | A session that updates while the user is scrolled past it does not move (§3.2) |
| 5 | A failed page shows Retry and does not retry by itself; Retry recovers and re-arms (§3.1) |
| 6 | The sentinel is reachable and operable by keyboard alone (§3.1) |
| 7 | A resync while scrolled deep does not strand the user past the end of the list (§3.4) |
| 8 | The archive pager does not render when there is one page, and each button is disabled rather than removed at its end (§4.2) |
| 9 | Changing archive page returns the scroll to the top (§4.2) |
| 9a | A work that closes while the app is open is in the archive the next time the Closed segment is looked at, with no reload (§4.3) |
| 10 | A session created while the reader is far down the list does not slide the rows under them — the scroll anchoring §3.2 relies on is on, and no `overflow-anchor: none` has been copied over from the transcript |
| 11 | Each capped group's count is that whole group's, not the number of rows fetched, and "Show earlier work" sits above the rows rather than below them (§4.1) |
| 11a | The rows a cap holds back are the least recently updated of that group — the bottom of what the reader sees — and the two capped groups cannot spend each other's budget (§4.1) |
| 11b | Two groups offering "Show earlier work" at once produce one error message and one Retry between them when the fetch fails (§4.1) |
| 12 | Opening an old session that is outside the loaded range still opens, still resolves its title, and does not manufacture a row (§3.2) |
| 13 | Nothing calls a session "deleted" on the strength of its absence from a list that can be partial (§2.3) |
| 14 | Every new control clears the hit-area floor ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)) |
