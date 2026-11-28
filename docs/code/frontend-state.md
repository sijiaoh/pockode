# Frontend State Management

Pockode uses Zustand for state management, an item store and a pure presentation pass for the chat transcript, and a registry pattern for runtime extensibility. This document explains why these patterns were chosen.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Extension Layer                                                │
│  ├─ themeRegistry ──────────────────────────────────────────┐   │
│  ├─ chatUIRegistry                                          │   │
│  ├─ headerUIRegistry           useSyncExternalStore         │   │
│  ├─ sidebarUIRegistry     (React subscription)              │   │
│  └─ settingsRegistry                                        │   │
├─────────────────────────────────────────────────────────────────┤
│  UI State Layer                                                 │
│  ├─ themeStore ◀─────── subscribeThemeRegistry              │   │
│  ├─ inputStore (localStorage)                               │   │
│  ├─ questionDraftStore (localStorage)                       │   │
│  ├─ filesSearchStore (localStorage)                         │   │
│  ├─ gitSyncStore                                            │   │
│  ├─ gitCheckoutStore                                        │   │
│  ├─ gitOperationStore                                       │   │
│  ├─ gitWriteStore                                           │   │
│  ├─ gitChangesViewStore (localStorage)                      │   │
│  ├─ portPreviewStore (localStorage)                         │   │
│  └─ worktreeStore + listeners                               │   │
├─────────────────────────────────────────────────────────────────┤
│  Domain Data Layer                                              │
│  ├─ sessionStore ◀───┬── wsStore notifications              │   │
│  ├─ workStore        │                                      │   │
│  ├─ agentRoleStore   │                                      │   │
│  ├─ scheduleStore    │                                      │   │
│  ├─ agentOptionsStore│ (one fetch per connection)           │   │
│  ├─ settingsStore    │                                      │   │
│  ├─ cliLoginStore    │ (status read, not pushed)            │   │
│  └─ authStore        │                                      │   │
├─────────────────────────────────────────────────────────────────┤
│  Transport Layer                                                │
│  └─ wsStore                                                     │
│     ├─ WebSocket lifecycle                                      │
│     ├─ JSON-RPC client                                          │
│     └─ Subscription callbacks                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Zustand Stores

### Store Inventory

| Store | Purpose | Key Pattern |
|-------|---------|-------------|
| wsStore | WebSocket, RPC, subscriptions | Single hub for all communication |
| sessionStore | Chat session list — one page of it, as the server narrowed it — and the filters over it (task sessions, reviewer sessions, worktree) | State/Actions interface split; an absence in it is not proof a session is gone ([why](subscription-system.md#what-the-client-gives-up-by-letting-the-server-filter)). The worktree filter is the one field here that can mean *the list on screen is not this store's* |
| sessionDetailStore | The open session's own metadata, and whether it exists at all | One session at a time, read through a selector that checks whose it is |
| workStore | The project list's `Current` segment, and the one archive page on screen | State/Actions interface split; the two halves are separate fields because only one of them is pushed to |
| agentRoleStore | AI roles | State/Actions interface split |
| scheduleStore | Every schedule, each with its latest run's row | State/Actions interface split; app-wide because the Project tab's dot reads it ([schedule-ui.md §1](../schedule-ui.md#1-the-project-tab)) |
| agentOptionsStore | Selectable models and effort levels per agent | Fetched once per connection, not subscribed |
| settingsStore | App settings, and why they are missing when they are | Holds the subscription's `refresh` too: the Retry is far below the hook that owns it |
| cliLoginStore | Each AI CLI's sign-in status and update check on the server machine, and its latest sign-in flow and update or install ([cli-update.md](cli-update.md#the-web-client)) | Status is read on demand, never pushed ([why](cli-auth.md#no-subscription)); a flow outlives the sheet showing it. In memory only: a flow's link and codes are secrets |
| authStore | The credential to connect with: the session token that survives a reload, or the password just typed | localStorage init; a leaf module written to by wsStore, never the other way round |
| inputStore | The draft, per session: its text, the files picked for it with their uploads, and a prefill's one-shot reveal request (beside it, not in the state: the mounted composer's caret reader, for a prefill put in at the caret) | persist middleware for the text only — neither a `File` nor its `blob:` preview survives a reload. The files are here, not in the bar, because the bar is unmounted mid-draft and an upload outlives it. A surface outside the chat writes it only through `usePrefillComposer` ([why](../agent-handoff-ui.md#1-prefill-handoff)) |
| questionDraftStore | What has been typed into each unanswered question, per session | persist middleware, plus a second map: what came out of storage waits there until the session's unanswered list vouches for it, so an answer to a withdrawn question can never reach the screen ([answering-ui.md §5](../answering-ui.md#5-drafts)) |
| filesSearchStore | File search options | localStorage init |
| gitSyncStore | The fetch/pull/push in flight in each worktree, whether the user or the Git workspace started it, and how the last one ended | Keyed by worktree; outlives the sheet that started the run |
| gitCheckoutStore | The branch switch and the branch delete in flight in each worktree, and how the last of each failed | Keyed by worktree; outlives the Branches list or branch detail that started it |
| gitOperationStore | The abort of an in-progress merge/rebase/cherry-pick/revert in each worktree, how it ended, and which operation's banner is collapsed ([git-conflict-ui.md](../git-conflict-ui.md#abort)) | Keyed by worktree; outlives the workspace the abort was pressed in |
| gitWriteStore | Each worktree's serial queue of stage/unstage/discard writes, the paths they have pending, and the Changes list's unacknowledged failure | Keyed by worktree; one write at a time, so two taps cannot race |
| gitChangesViewStore | The Changes list's flat/tree choice, and which tree folders are collapsed in each worktree ([git-changes-ui.md](../git-changes-ui.md#flat-and-tree)) | localStorage init for the view, which the review also reads for its order; collapse state in memory, keyed by worktree |
| portPreviewStore | The ports a preview was recently opened for ([port-preview.md](../port-preview.md#opening-a-preview-from-the-app)) | localStorage init; one key for every worktree, since ports belong to the machine |
| worktreeStore | Current worktree, whether the project is a git repository, and whether the server can run the setup hook | External listener pattern; `isGitRepo` is `null` until the server has answered |
| themeStore | Theme mode/name | Registry subscription |

### Why wsStore is Large

wsStore manages WebSocket connection, JSON-RPC channels, and subscription callbacks in one place. This is intentional:

1. **Connection lifecycle is atomic** — connect/disconnect must be coordinated with all subscriptions
2. **RPC channel is a resource** — cannot be duplicated across stores
3. **Notification routing needs global view** — must know all callbacks to dispatch

The alternative (each store managing its own connection) would lead to duplicate connections and lifecycle conflicts.

Reconnect policy lives here too — an unbounded backoff retry rather than a fixed
attempt count, because the connection may be a relay tunnel the server itself
takes the better part of a minute to notice is dead. See
[websocket-rpc.md](websocket-rpc.md#auto-reconnect).

### Store Patterns

**Pattern A: State/Actions Interface Split** — Most domain stores use this pattern for type safety:

```typescript
interface SessionState {
  sessions: SessionListItem[];
  isLoading: boolean;
  // Set during a worktree switch: sessions are retained but marked stale, so the
  // sidebar can go on rendering them without letting the user act on a list that
  // belongs to the worktree being left.
  isReloading: boolean;
}
interface SessionActions { setSessions(page: SessionPage, isResync?: boolean): void; }
export type SessionStore = SessionState & SessionActions;
```

**Pattern B: Listener Pattern** — worktreeStore uses external listeners for non-React contexts:

```typescript
// web/src/lib/worktreeStore.ts (abridged)
const changeListeners = new Set<WorktreeChangeListener>();

export const worktreeActions = {
  setCurrent: (name: string) => {
    // Synchronously notify listeners before React re-renders
    for (const listener of changeListeners) listener(prev, name);
  },
  onWorktreeChange: (listener) => {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  },
};
```

wsStore subscribes to these listeners to clean up worktree-scoped subscriptions before worktree switch completes — React's async rendering would be too late. App-level subscriptions (work list/detail, agent role list, settings, worktree list) are preserved across switches because the server keeps pushing to them.

`isGitRepo` has listeners of its own, for the moment the project becomes or stops being a git repository. It is live state the server owns, three-valued — `null` (not answered yet), `true`, `false` — and written only from the server's answers: the `worktree.list` result (`fetchWorktrees`), the `worktree.subscribe` reply, and each `worktree.changed` ([git.md](../git.md#projects-without-a-repository)). A failed `git.*` request never writes it: one failure proves nothing, and the server has already read the answer. `null` is not a stand-in for either answer; git-only UI treats it as "not yet" and stays hidden ([git-ui.md](../git-ui.md#projects-without-a-repository)). Those replies can arrive out of order, so a newer answer cancels the list request in flight before refetching, and `fetchWorktrees` does not write from a request that was cancelled — otherwise the older reply would put the older answer back. `onGitRepoChange` fires only when the value actually changes; its five listeners are the caches that depend on it — `queryClient.ts` invalidates the git queries when a repository appears and removes them when it goes (an invalidation then would refetch through readers that have not yet re-rendered as disabled, straight into `-32002`), wsStore drops the cached `command.list`, which leaves out commands that need git, `gitSyncStore` drops the last fetch/pull/push outcomes, and `gitCheckoutStore` and `gitWriteStore` drop their failures — all of which belong to the repository before the change.

**Pattern C: Registry Subscription** — themeStore subscribes to themeRegistry changes:

```typescript
// web/src/lib/themeStore.ts — themeActions.init
subscribeThemeRegistry(() => {
  const { theme: current, mode } = useThemeStore.getState();
  if (isValidTheme(current)) {
    // Apply when pending custom theme becomes available
    applyThemeToDOM(mode, current);
    return;
  }
  // Fallback if active theme was unregistered
  useThemeStore.setState({ theme: "abyss" });
});
```

### Neither List Store Holds a List Any More

Both list stores used to hold everything the server had. Now each holds as much
as the user has asked for, and the difference shows up in the fields that had to
be added around the rows — every one of them is there because something on
screen used to be derivable from the array and no longer is.

**`sessionStore` holds a prefix that grows.** `nextCursor` says where the next
page starts (`null` once the list has been read to its end), and `hasUnread`
carries the sidebar badge, which must come from the server: it is an "is there
any" over the whole list, and an unread session is by definition one an agent
finished with while nobody was looking — exactly the session a reader has not
scrolled to. `generation` is bumped whenever the list is replaced wholesale, and
a page that was in flight across a resync, a worktree switch or a filter change
is dropped on arrival rather than spliced into a list it does not belong to.

`setSessions` takes an `isResync` flag because two different events replace the
list and they mean opposite things by a short answer. A *snapshot* is a new list
— a first subscribe, a refresh, another worktree, a flipped filter — and a new
list that happens to be shorter says nothing about the reader. A *resync* is the
same list handed back at the reader's own depth, so a short one means the cap
cut it, and the sentinel's auto-loading is switched off: the browser clamps the
reader to the list's new end, where an armed sentinel would immediately ask for
the next page and undo the cap. The button stays. Deriving this from "shorter
than before" alone — the first attempt — silently disarmed paging every time
someone switched worktree or flipped the filter.

**`workStore` holds two lists that answer to opposite rules**, which is why they
are separate fields rather than one array with a predicate over it. `works` is
pushed to, and every change to any work item reaches it — including changes to
rows it does not hold, which are upserted rather than dropped, since a work that
starts needing a person must be able to light the attention dot from outside
what was fetched. `archive` is the mirror image: fetched, and pushed nothing but
a correction to a row already on the page the user is reading — plus
`archiveStale`, which is not a row at all but the page admitting a closed story
has appeared behind it, and is what makes the Closed segment ask again
([why](subscription-system.md#nobody-is-waiting-on-it-is-not-nobody-ever-looks-at-it)).

The archive pager walks with `archiveCursors: string[]`, a stack the *client*
keeps — entry 0 is always `""`, and "Older" pushes the cursor the server just
returned. Stepping back is then handing back a cursor already used, so the
server never learns to page backwards and the pager can honestly say `Page 2`
while being unable to say `Page 2 of 7`. Landing a page truncates the stack to
that page, or walking back and forward again would reuse a cursor from a deeper
walk and skip the page just left. `archiveAttempt` records the page last *asked*
for, which after a failed "Older" is not the page on screen — Retry has to
re-ask for the one that never arrived, not the one the user is reading.

The reasoning behind all of it — cursors, the two update strategies, what the
server only approximates — is
[subscription-system.md](subscription-system.md#paging-and-pushing-on-one-list).

### Why a Segment Is Not State

Which segment of the project list is on screen — `Current` or `Closed` — used
to be a store here (`projectPanelStore`) and is **not state at all any more**:
it is in the URL. There is no third option in between. Component state would
hand a user browsing the archive back to `Current` every time they opened a
work, which is why a store was reached for; but the store bought that at the
price of a segment no link could name and a Back button that skipped the whole
visit. Back stepping through the segments the user chose turned out to be the
behaviour users asked for by name, and it is the one a browser gives for free —
a segment is a place, where a filter on the page is a setting and is replaced
([project-ui.md §5.1](../project-ui.md#51-back-up-and-replace)).
The round trip into a work is paid for in the URL instead: the detail carries
the segment it was opened from, which a store never had to and a component never
could. See [project-ui.md](../project-ui.md#5-where-the-segment-lives).

The Git workspace's three segments are in the URL for the same reasons
([git-ui.md](../git-ui.md#routes-segments-and-back)) — all but the sidebar's at
`expanded`, which holds its segment and History query as component state
(`GitTabLists`), set from the URL each time the route arrives somewhere new:
there the URL names the page the main area has open, and turning the list must
not change it. A store for the Git
panel's UI, `gitPanelStore`, held whether its `History` group was expanded, and
went when History stopped being a collapsible group and became a segment.

### Why a Run in Flight Is a Store

`gitSyncStore`, `gitCheckoutStore` and `gitWriteStore` hold neither server
data nor a user preference: they hold **a request that is already on its way**,
and what it left behind. A run outlives the component that started it, and not
as an accident of layout — it outlives it *by definition*. Staging from an open
diff and navigating away unmounts that view while the request is in flight;
closing the sync sheet mid-push is a documented interaction rather than an edge
case ([git-ui.md](../git-ui.md#remote-sync)); and the Git workspace is a page,
so its segment control and Back both leave a list while something
started from it is still running
([git-ui.md](../git-ui.md#results-that-outlive-the-page)).
Component state would lose the outcome of something that is still happening —
a silent failure — and there is nothing to ask again, because the request has
already been made.

All three are keyed by worktree for the same reason: switching worktrees mid-run
is reachable, and a single record would show A's outcome under B, or let A's run
disable B's controls. And all three drop their failures — never what is still
running, whose settling is what lifts the guard — whenever the project starts or
stops being a repository (`worktreeActions.onGitRepoChange`): a failure is about
the repository it ran against, and one refused after `.git` went would otherwise
come back as a banner after a later `git init`.

What each holds:

- **`gitSyncStore`** — per worktree, the running operation, the outcome of the
  last one, and `auto`: whether that run was the fetch the Git workspace starts
  by itself on the way in rather than one the user asked for.
  `startAutoFetch` shares `start`'s guard, so an automatic fetch and a manual
  one can never run on top of each other, but leaves nothing on success and a
  failure marked `auto` — which the sync chip carries as a mark rather than
  the banner a manual failure gets, since nobody asked for that run
  ([git-ui.md](../git-ui.md#automatic-fetch)). The next run of either kind
  replaces it.
- **`gitCheckoutStore`** — per worktree, the branch a switch is running to and
  how the last switch failed. It has `gitSyncStore`'s shape and semantics —
  one switch per worktree, a new one clears the last failure, success leaves
  nothing — and it is a store of its own rather than a field of
  `gitWriteStore` on purpose. `gitWriteStore` queues the fast local writes —
  stage, unstage, discard — one after another; a branch switch moves HEAD and
  the working tree, is guarded rather than queued (a second switch while one
  runs is refused, not lined up), and is behind a control that cannot be
  double-tapped into a collision. Put in that queue it would make a tap on a
  file wait behind a checkout, and put beside it as one more field it would
  blur what the store is: a queue of quick writes. A branch delete keeps its
  own run and failure here, beside the switch's (`deleting`, `deleteError`),
  for the same reason: its confirm closes when the user leaves while the
  request runs, and one delete per worktree is guarded, not queued.
- **`gitWriteStore`** — per worktree, the queue, the paths with a write pending
  (whole-file writes by path, hunk writes by path and hunk ID — a path holds
  many hunks, and `isPathWriting` counts both as the file being busy:
  [git-changes-ui.md](../git-changes-ui.md#in-flight-and-after)),
  and `failures`: the Changes list's banner. `fail` replaces whatever failure
  the worktree was showing, `succeed(paths)` clears it only when the success
  covers one of the paths that failed — another file succeeding says nothing
  about the one that did not — and `dismissFailure` is the banner's `✕`. It is
  here rather than in the list for the reason the pending sets are: the write
  outlives the list, and a failure that settles while the user is on another
  segment has to be on screen when they come back.

Keying is not the whole answer for `gitWriteStore`, though, because a queued
write is not yet a request: the server applies a `git.*` write to whatever
worktree the connection is bound to, so one whose turn comes after a switch
would write into the tree the user has just left. It is dropped at the moment it
would have been sent (`WorktreeChangedError`), which is the only moment its
destination is known.

Why not react-query, which already tracks in-flight mutations? Because these
stores are not caching a result — they are **ordering the requests**.
`gitWriteStore` is a serial queue: one write per worktree at a time, because the
server will not run two of *these* writes in a worktree at once either — stage,
unstage and discard all touch its index, and it refuses a second one that has
waited too long ([git.md](../git.md#serialising-writes)). Tapping two files in a
row does not deserve an error. react-query deduplicates and caches; it does not
serialise, and nothing per-component could, since the whole point is that taps
in two different components have to get in line behind each other.

They are stores rather than the refs the next section argues for, because what
they hold is *drawn*: which rows show a spinner, and which button says `Pushing…`.

### Why Scroll State Is Neither a Store nor State

The transcript's scroll decisions — which of the two things the reader is doing,
the element an anchor is holding still, the seam a page landing is held by, and
whether the view is at rest or something is pressed on it — live in refs inside
`useTranscriptScroll` (`web/src/components/Chat/useTranscriptScroll.ts`,
[the model](../agent-chat.md#where-the-view-sits)), and that is the exact
opposite of the reasoning above.

They are not in a store because **they must not outlive the component**. The
list is keyed by the session id and remounts on every switch, and every one of
these values describes a view that no longer exists once it does; a store would
carry "the user had scrolled up" into a session they have not looked at yet.
Where the stores above hold a run that is still going, these hold facts about
a layout that no longer exists.

They are refs rather than `useState` because **nothing should re-render when
they change**, and more than that: they are read at moments a render cannot
reach. The state and the anchor are read inside a layout effect and a
`ResizeObserver` callback, and the state again by the timer that says the view
has come to rest, against the DOM as it is at that instant. A state
update would deliver the new value a render later — after the frame whose scroll
position was the whole question — and would reflow the very list being measured.

The height of the track the rows sit on is not even a ref: it is read back off
the track's own inline style, the one place it is written, so there is no second
copy to fall out of step with the layout.

What the scroll-to-bottom button draws is state, and it marks the boundary:
whether it is showing and whether it carries the new-content dot, because those
are drawn. Something is state when a render has to happen because of it; the rest of this is
bookkeeping the render must not see.

### Why a Page's Scroll Position Outlives the Page

**The contract: going back to a page puts the reader where they left it; any
other way of arriving starts at the top.** A browser does this for a page that
scrolls the window. Here the window never scrolls — the shell clips
([responsive-ui.md](../responsive-ui.md#who-owns-the-scroll-boundary)) — and
every page scrolls a container of its own. A page is unmounted when another
replaces it (`ChatPanel`'s overlay switch, `GitWorkspace`'s detail), and its
container goes with it. So unless something else remembers, nothing does.

This is the opposite of the transcript above, and the difference is the
page's lifetime. The transcript's scroll facts describe a view that stays
mounted under every overlay, so they die with it. A page's offset is wanted
exactly *after* the page is gone, so it has to live outside it, in
`lib/scrollMemory.ts`. It is still not a store and not state: nothing renders
from it, and it is read when a page mounts, or when the entry changes under
a page that stayed mounted.

**Keyed by history entry, not by URL.** A fresh push of a URL the reader has
seen before is a new visit, just as following a link is in a browser. Opening
the same commit again from History starts at its top. The one exception is a
layer's entry — a sheet, a dialog, a drawer holds one while it is up
([project-ui.md §5.2](../project-ui.md#52-back-closes-the-topmost-layer)) —
which is keyed as the page's own under it (`visitKeyOf`,
`web/src/lib/layerHistory.ts`): a sheet going up or down is no new visit, and
the page under it keeps its scroll. What counts as *back*:

- **The browser's Back, or any `history.go()` back.** It returns to an entry
  that is still in the history, so the entry's key finds what was saved. That
  includes every in-app `←`: it goes up (`useGoToParent`,
  [project-ui.md §5.1](../project-ui.md#51-back-up-and-replace)), which is a
  `go()` back to the parent's own entry whenever that entry is behind. Nothing
  that pushes is a return: a push of the page the reader came down from — the
  Stories button pressed from a work — is an entrance, and starts at the top.
  No `←` pushes, so there is no push to take for one.

**Why not TanStack Router's `scrollRestoration`.** It fails on all three
counts:

- It records every scroller in the app by CSS path, including the sidebar and
  the transcript, which manage their own place.
- It restores at `onRendered`, before content that is still loading has any
  height to scroll into.
- It keys by entry alone, so every sheet's entry would be a new visit and the
  page under it would scroll to the top as the sheet opened.

**The entry is the one on screen, not the router's location.** The router's
location moves to the next entry as soon as a navigation starts. The page
being left is still mounted at that point, and a scroll there would be saved
under the next page. `useScrollRestorationScope` therefore moves to a new entry
only once the rendered matches have been committed. `PageBody.test.tsx` holds
this with a loader that is kept open.

**A page that stays mounted is restored too.** Some views are one instance for
every page they show: `ChatPanel` renders `FileView` with no key, so a
document and the one it links to are the same mounted scroller, and coming
back to the first is no mount. So when the entry changes under a mounted
scroller, the scroller goes to the new entry's offset, or to the top when it
has none — a fresh visit, even though nothing remounted. A replace is the same
visit (a diff's side switched, a file renamed), so `scrollMemory.ts` moves the
replaced entry's offsets to the new one, and the page stays where it is —
unless the replace puts another page in its place: a parent standing in for
the child its `←` was pressed on, the next file for one just discarded. That
replace carries `FRESH_VISIT_STATE` and starts at the top, since every page's
scroller is named alike and the offsets left are the other page's.

**A fresh visit can start somewhere other than the top.** A file opened at a
line starts with that line in view ([file.md](../file.md#landing-on-the-line)).
The content cannot write `scrollTop` itself: picking another line of the open
file keeps the page mounted, and the scroller answers the entry change in its
own layout effect — an ancestor's, so it runs after the content's and would
put the fresh entry back at the top. So the content *asks*
(`useFreshVisitLanding`, provided by `PageBody`) and the restoration does the
writing: when it shows a fresh entry with a landing waiting for it, it lands
there instead of at the top, and saves the offset at once so nothing resets
it. Whether the entry is fresh is judged when it is shown, not when the
landing is asked for — by then a page whose content was still loading has
already saved its reset to the top as the entry's offset. A return is never
landed, and an entry is landed at most once, so a refresh of the content
cannot pull the reader back.

**Restoring waits for content, and gives way to the reader.** A page usually
remounts before its data is back, so the restore keeps writing the target every
frame until the scroller is tall enough, for up to `RESTORE_WINDOW_MS`. It
stops as soon as the reader reaches for the page — a wheel or touch on the
scroller, or a pointer press or key anywhere, since a pager, a next-conflict
button or a settings section moves the scroller from outside it. Its own
clamped writes are never saved, or a short page would overwrite the target.
This is the same "waits, and gives way" rule the Git list's row reveal follows
([git-ui.md](../git-ui.md#at-expanded-the-sidebars-list-and-the-detail)).

#### What a page has to do

**Write the page's scrolling body as `PageBody`** (`components/ui/PageBody.tsx`)
instead of a bare `min-h-0 flex-1 overflow-auto` div. That is the whole opt-in.
`ContentView` renders its non-`fill` body as one, so the file, diff and
commit pages built on it have it already. A page that needs its own handle on the scroller
passes `ref` to `PageBody`; the ref is filled alongside the restore's.

A scroller that cannot be `PageBody` — a different element, or a ref that has
to stay a `setState` — uses `useScrollRestoration(ownRef)` directly
(`hooks/useScrollRestoration.ts`). `BranchDetail`, `ConflictView` and
`SettingsPage` do this. Give the second argument only when one page has two
scrollers that should both be remembered.

Rendered outside `AppShell` — in a test that mocks the router, say — there is
no `ScrollRestorationContext`, and `PageBody` is a plain scroller. Nothing has
to be arranged for it. That holds only while the scrollers' module leaves the
router alone, so the shell's half, which reads it, is a module of its own
(`hooks/useScrollRestorationScope.ts`): a browser test's router mock exports
only what it lists, and one missing name fails every file that imports it.

#### What it deliberately does not cover

| Scroller | Why not |
|---|---|
| The chat transcript | It is covered, never unmounted, under overlays, and its own model decides where it sits on a session switch ([agent-chat.md](../agent-chat.md#where-the-view-sits)) |
| The Git lists below `expanded`, and every sidebar list | Kept mounted under the layer above them, so they never lose their place ([git-ui.md](../git-ui.md#routes-segments-and-back)) |
| A sidebar tab turned away from (`GitTab`, `FilesTab`) | A tab switch is not a navigation. A tab hidden with `display: none` loses its scroll box, and covering it instead is that surface's decision to make, not this mechanism's |
| An HTML page preview (`ContentView fill`) | The scroll is inside a sandboxed iframe this code cannot reach. A Markdown preview is a plain `ContentView` body, so it is covered |

**Known edges, accepted:**

- **A reload forgets everything.** The memory is in-process, and nothing goes
  to `sessionStorage` — unlike the history trail (below), which a `←` needs to
  survive a reload and offsets do not.
- **A child page opened directly has no parent behind it.** Its `←` lands on a
  fresh parent, at the top.

#### The history trail is not the scroll memory

Going up needs to know what is behind the page, which the browser never tells
a page. `lib/historyTrail.ts` is the one record of that: `{ key, href }` at
each `__TSR_index`, written on every push, replace and traversal. It is not a
store either — nothing renders from it; `useGoToParent` reads it at a press —
and it is kept in `sessionStorage`, which lives exactly as long as the tab's
history, so a reload still knows what is behind. What it stored is believed
only while the entry on screen is the one stored at its index; a typed URL
starts a document the router numbers from 0 again, and the trail then knows
that entry alone, which is always the safe answer (the parent replaces the
page). An entry from before a reload belongs to a document that is gone, so a
`go()` to it loads the app afresh; the rewrite owed on arrival is kept in
storage too and made by the next document's trail as it starts. Each entry
says which document wrote it, because such a `go()` may be slow to begin
unloading this one: when `←`'s wait for it runs out, the parent is put in place
here and that rewrite is still kept, since an entry the browser has dropped
can never be arrived at. That is why
`router.tsx` creates the browser history itself and starts the trail before
`createRouter({ history })`: the router reads the location as it is created.

Before the trail, `router.tsx` wraps that history in the layers'
(`layerHistoryFor`, `lib/layerHistory.ts`;
[project-ui.md §5.2](../project-ui.md#52-back-closes-the-topmost-layer)): a
push made while a sheet or a drawer holds an entry waits until the entries are
gone back over, a replace under one keeps the entry the layer's, and a reload
under one strips the marker from the entry the app starts on. The trail sees
a layer's entry as any other — it has the page's href, so `←`'s walk passes it
as a duplicate of the page — and the strip is a `replaceState` that keeps the
entry's key, because a router replace would give it a new one and the trail
would no longer know what is behind the page.

## Server Cache vs Store

Not every piece of server data belongs in a store. Data the client fetches
request/response — directory contents, git status, commit diffs, file search
results — lives in the react-query cache instead, so staleness, in-flight state
and deduplication come with it rather than being re-implemented per store.
Stores hold what the app itself owns (UI preferences) and what arrives as a
stream of subscription notifications. A watcher notification and a cached query
compose: `*.changed` says something moved, and the query refetches.

One fetch sits outside both: `agent.list`, which reports what each registered
agent declares about being forked. Its answer comes from the implementations
compiled into the server, so it cannot change while that server runs — there is
no staleness to manage and nothing to invalidate, and `lib/rpc/agent.ts` caches
the promise for the tab instead. That hand-rolled cache is the price, and it is
only worth paying for a value that is constant by construction; anything that can
change server-side belongs in react-query with the rest.

The catch is scope: those caches are keyed by query key, not by worktree, so
`queryClient.ts` invalidates every key in `WORKTREE_DEPENDENT_QUERY_KEYS` once a
switch completes. A worktree-scoped query missing from that list keeps serving
the previous worktree's data — paths that look fine until they 404 on open —
and it is the easy step to forget when adding a query.

The `session_view.*` reads are the deliberate exception, and the reason is in the
key rather than in the list: each one names the worktree it read from
(`["session-view-detail", worktree, sessionId]`, and the list's key carries its
set of sources), so a switch cannot make a cached entry mean the wrong worktree —
there is no such thing as "the previous worktree's" answer to a question that
names its worktree out loud. The source list (`session_view.worktrees`) is the
one key with no worktree in it, and needs none: it answers for the project, not
for whichever worktree the connection happens to be bound to. They also decline the staleness half of what
react-query offers — `staleTime: Infinity`, no background refetch — because
nothing pushes to them, and because installing a page replaces a list wholesale
and restarts its paging: a refetch behind the reader's back would cost them every
earlier page they had pulled in and buy the same rows back. They are re-read when the user
does something that asks for it, through `invalidateSessionViewQueries` —
invalidated, never reset, so the rows stay on screen while every round the reader
had pulled in is asked again ([cross-worktree-session-ui.md](../cross-worktree-session-ui.md#refreshing-and-why-it-is-never-automatic)).

A viewed session's metadata is read the same way and deliberately **not** written
into `sessionDetailStore`. That store holds *the bound worktree's open session*
and clears whenever its subscription resets; another worktree's session put there
would be erased by a reset that has nothing to do with it. For the same reason one
hook holds both of its reads (`useViewedSession`): the screen asks one question —
*can this conversation be read* — and a metadata read that succeeded while the
transcript failed would answer it as an empty conversation, which is the one thing
a failure must not be allowed to say.

`agentOptionsStore` is the one store filled by a plain request/response call. The
per-agent model and effort lists are constants compiled into the server, so
nothing react-query manages applies to them: they cannot go stale, no
notification invalidates them, a single hook asks for them, and being server-wide
they are untouched by a worktree switch. The one thing that can change the answer
is a reconnect to a server upgraded in the meantime, which `useAgentOptions`
covers by fetching on every `connected` rather than once per app load.

The fetch hangs off `AppShell` rather than off the panel that needs it because
three screens now read the same lists: the chat's engine selector, the agent role
page, and the global defaults in Settings. Each of them also needs the lists of
the agent it is *about to* switch to, not only the current one, so per-panel
fetching would buy nothing and cost a round trip per open.

Both lists sit in that one store behind a **single** `error`, and
`useAgentOptions` fetches them in one `Promise.allSettled`, even though the
server answers them as two methods (`session.models`, `session.efforts`). That is
not tidying. *This agent has no effort levels* and *the effort list never
arrived* reach the selector as the same absence, and the only thing that tells
them apart is whether an answer arrived at all — so that question must have one
answer, not one per list. It does: *nothing has answered yet* is exactly
`models === null && error === null`, a failed fetch counting as an answer. A list
that did arrive is still kept when the other one failed; losing it would punish
the working half for the broken one.

## The Transcript

The server sends the transcript as items — pages of them, then an update per
record that changed any — each complete as it stands
([agent-chat.md](../agent-chat.md#history-paging)). Everything about what an
item *is* is the server's: a call's status, its permission request and answer,
its result and background outcome, a question's fate, a turn's start and
ending, which messages a Stop threw away, what a subagent did under its call.
The client derives none of it again. What it decides is how to draw it, and
that is two pieces:

- **`ChatItems`** (`web/src/lib/chatItems.ts`) holds the items as the server
  last stated them, by id, with the turns, the live streams of calls in flight,
  this client's own sends until the transcript has them, and presses on
  permission cards the server has not recorded yet. It derives nothing.
- **`buildTranscript`** (`web/src/lib/transcript.ts`) turns that into the
  `Message[]` the chat renders — bubbles, rows, cards — and is the only author
  of every `Message`, `ContentPart` and `ToolRun`. A renderer reads what it is
  given and infers nothing of its own.

The wire shapes are hand-written in `web/src/types/chatItems.ts`, mirroring
`server/projection/page.go` and `update.go`, which the record type generator
does not cover; the record payloads they nest come from `wire.generated.ts`.

### Data Flow

```
chat.messages.subscribe / chat.messages.history / session_view.history → ChatPage
chat.update → ChatUpdate        chat.delta → ChatDelta        chat.resync
  → useChatMessages → ChatItems (installNewestPage / addOlderPage / applyUpdate / applyToolDelta)
    → buildTranscript(store, cache) → Message[] → MessageList
```

`ChatItems` is mutable and owned by one `useChatMessages`; every change goes
through its functions, which replace each changed node — and every run above
it — rather than editing one in place, and the hook then commits a rebuild. A
node's identity is therefore its version. That is what makes the rebuild
cheap: the transcript is cut into **stretches**, runs of top-level items of one
turn, and a stretch whose nodes, turn and neighbours are the same objects as
last time comes back as the same messages (`TranscriptCache`). A record
re-renders the bubble it touched and nothing else, which is what React.memo on
the rows relies on and what `transcriptMemo` keys on
([below](#transcript-wide-facts)).

Finding those stretches does not walk the transcript either. The store notes
the smallest top-level id whose row it changed since the transcript last
looked (`takeRowsChangedFrom`), and a build keeps the last build's stretches
that lie wholly before it — all but the one just before, which the changed
row may have joined — walking only from there. A record lands near the end,
so its rebuild costs the last turn or two, not the 21k rows of the
benchmark's long session: walked whole, that was 0.3 ms a record in Node and
2–3 ms in a profiled production build; now it is 0.03 ms and 0.4–0.6 ms.
A send of this client's own drawn as an echo changes rows without the store
marking one, so a stretch is kept only if it lies wholly before every echo row
of this build and the last; sends go at the end, so that still keeps all but
the newest few, and a send left failed and unrecorded does not make every
later build walk everything.

Reading a page or an update is a matter of filing:

- **The subscription's page replaces everything.** A re-subscribe — a
  reconnect, or `chat.resync` — starts the store over from the new snapshot;
  only this client's sends still waiting on a reply, and the part ids, carry
  over, so nothing that did not change remounts.
- **An older page goes in front.** An item already held keeps the newer
  account; a turn already held is replaced only by one that knows its ending.
- **An update upserts.** Its turns first, then its items in order, each
  replacing the held copy whole and keeping its children (an update never
  carries them). An item can move: a call recorded before its subagent call
  goes under it when that arrives, and the message that opened a turn goes
  into it. An update whose `through_seq` the page already reached is skipped,
  but its `streams_ended` is applied, since the stream snapshot does not know
  of it.
- **An item the client never loaded is not new.** An upsert for an id it does
  not hold, older than the oldest loaded item while older pages remain — a
  backgrounded call reporting from a page above — is dropped; that page will
  bring the item as it then stands.

### Message Variants

`Message` is exactly `UserMessage | AssistantMessage`. Two other things arrive
as user messages rather than as variants of their own, each tagged with a
`source`: Pockode's own annotations — the prompts the Work engine sends,
`source: "system"` — drawn as a collapsed line instead of a bubble (see
[work-system.md](work-system.md#rendering-in-the-transcript) for why the
transcript holds no aggregate of them), and an answer another agent gave through
`question_answer`, `source: "agent"`, drawn as a named block
([answering-ui.md](../answering-ui.md#an-answer-another-agent-gave)).

A typed message is the one with **no** `source` at all, which is what
`isTypedByUser` (`web/src/utils/messageSource.ts`) asks. Two behaviours are
about the person at the keyboard rather than about the message's role — following
the transcript to the tail on send, and the delivery receipt — and both go
through that predicate. The fork menu deliberately does not: a fork cuts around
anything that entered the conversation, whoever supplied it, which is the line
the server draws too (`chat.isUserMessageRecord`).

**`status` is not a common field.** Only assistant messages carry one, so
anything asking about it has to narrow on `role === "assistant"` first.

### Bubbles

A turn is its opening message and the reply under it. The reply's status is
the turn's: `streaming` while the newest turn is open, and once it has ended,
what ended it — `ended_by` says `done`, `interrupted`, `process_ended` or a
failure, with the turn's `error` item's text on the bubble. A turn not ended
that is not the newest is drawn finished; its process went away without a
record, and only the newest can still be running. A transcript read out of
another worktree (`useViewedSession`) is never continued, so an open turn there
is drawn finished too.

**A message sent into a running turn is drawn under the reply that was being
written**, not where its item sits among the turn's items: the reply above it
keeps growing until the agent *reads* the message, and splits there, at the
`read` item ([agent-integration.md](agent-integration.md#the-read-point)). One
turn has one ending, but not one bubble. A bubble opened at a read point carries
`openedAtReadPoint`, which is how `openTurnReplies` reads the turn's work
across both halves. Messages nobody read — a Stop discarded them —
go under the turn's last bubble, where the Stop's summary is drawn. Output
tagged with a turn after the next one started (a Codex straggler) is a stretch
of its own after that turn's, drawn as a finished bubble; only the turn's main
stretch carries its ending.

An empty bubble is kept only while it says something: an open turn's reply not
written yet (it carries the tail line), and a turn that ended badly or threw
messages away with nothing written. A finished turn that produced nothing draws
no box.

Which bubble the open turn is writing into is `openAssistantIndex` — the last
assistant still `sending` or `streaming` — and never position: a message sent
mid-turn sits below the reply still being written, and a send the server
refuses leaves its reason under the message. `MessageList` computes it once and
hands each row `isOpenTurn`, which is what carries the tail line
([turn-progress-ui.md](../turn-progress-ui.md#2-the-tail-line)).

What the line *says* does not come through the bubble's props: the turn's phase,
its clock and what the main agent is thinking right now reach it through
`TurnTailContext`, so that a thinking delta several times a second re-renders the
one line rather than every memoized bubble. The plan and the agents in it come
the same way, with the id of the one bubble that draws them
([turn-progress-ui.md §4.3](../turn-progress-ui.md#43-the-agents), *where
the plan and the agents are derived and drawn*). "Thinking now" is
`useChatMessages` state beside the transcript, never a part of it: the
subscription's `streams.thinking` and the `chat.delta`s that continue it,
folded per frame. It ends where the server says the stream ended
(`streams_ended.thinking`), or with the turn. If the user had the line open,
the row the thinking settles into opens too: the update that ends the stream
brings the thinking item, and the hook adds its part id to `openedThoughtIds` in
the same render as the row, which `RowList` reads through
`OpenedThoughtsContext` as that row's first choice.

Being a context is not enough on its own once the transcript is long. When a
plain context's value changes, React walks the whole tree under its provider
looking for readers, through every memoized bubble that bails out. On a
300-turn session that walk cost 20–40 ms for each record a subagent wrote,
because the agents in the tail change with every one of them. So the contexts
whose value changes while a turn streams — `TurnTailContext`
and `SubagentResumesContext` — are built with
`createSelectableContext` (`web/src/components/Chat/selectableContext.tsx`).
The context itself carries one object that never changes. The value reaches
readers through a subscription, and each reader selects its own slice:
`TurnEnd` takes the tail only on the bubble `overviewMessageId` names, and a
subagent row takes only its own call's entry. A change redraws the readers
whose slice changed and walks nothing. The providers still take a plain
`value`, so they are written and tested like any other context. A context whose
value changes only on a page load or a user's action (stop targets, discarded
messages, the step-window fold, the jump request) stays a plain one: it is
read in fewer places, and when it changes the page usually redraws anyway.

The browser has the same problem one layer down. Each message row in
`MessageList` is `contain: layout style`. Without a boundary per row, output
growing the newest row made Chromium's pre-paint visit every box in the
transcript after every streamed record: about 30 ms a record at 300 turns,
according to the streaming bench's trace, and none of it visible in the JS
profile. Paint containment would also cut paint, which costs about 5 ms a record
there, to under 1 ms. The rows do not have it, because it clips at the row's
edges and would cut off the outward focus rings of controls flush with a row's
sides. The cost of the layout containment is that a row
becomes the `offsetParent` of everything inside it, so a row's place in what
scrolls has to be measured with `getBoundingClientRect` against the scroller
(`VirtualLines` already does).

**A bubble's key survives a page.** A turn's first bubble is keyed by its turn,
not by its first item, so when an older page brings the front half of a turn
cut by the page boundary, the half goes into the bubble on screen and the bubble
stays the same node. That is load-bearing outside the transcript: the reader is
held still across a page by the first loaded row's bottom edge, which only
measures what went in above it if the row is the same node before and after
([agent-chat.md](../agent-chat.md#reading-a-page-on-the-client)).

**Where a fork can cut** is the `anchorSeq` a message carries: a user message's
item's `last_seq`; a reply's newest record — its items' `last_seq`, or the
turn's `end_seq` on its last bubble — kept below the first item drawn after
it. The cap matters because a call's `last_seq` moves on when its background
outcome arrives turns later, and because a message drawn under a reply is older
than the reply's later items: a fork from the reply must not cut past messages
the user can see below it. The client only compares seqs the server gave it and
never computes with them — where the cut falls is the server's answer
([session-fork-ui.md](../session-fork-ui.md#the-rule),
[agent-integration.md](agent-integration.md#history-storage)).

### This Client's Own Messages

The sender is left out of the update carrying its own message
([agent-chat.md](../agent-chat.md#live-updates)), so a send is drawn from an
**echo** (`Echo`) until the transcript holds its item. The echo goes where the
message was sent: after the top-level item that was last at that moment, in
the turn then open — so a message sent mid-turn is drawn under the reply being
written, like anybody's — or, sent to an idle agent, with a reply bubble of its
own (`sending`) at once. A refused send takes the echo back; one that failed
otherwise leaves it with the failure drawn directly under it.

The reply to `chat.message` carries the message's `item_id`, and the item is
written into the store from what was sent and what the reply adds. An update
can beat the reply — the turn the message opened takes its item in, or a Stop
discards it — and a message item first heard of from a record after its own is
this client's: the waiting echo with the same text takes it, or else one of the
kind that record implies (only a send to an idle agent opens a turn). That is a
guess the reply can overrule: the item the reply names wins, and an echo that
guessed it gives it back. A fresh page — a re-subscribe while a send is in
flight, or after one failed on a dropped connection — is matched the same way,
against the messages recorded since the transcript last stood, so the page's
copy and the echo are never both drawn. A send that failed here may still have
been recorded (a reply lost to a timeout or a dropped connection), and its own
record can then reach this client over a newer connection; a failed echo
therefore takes a newly heard-of message item with the same text, and its
failure is dropped. Several sends keep the order they were
made in. Either way the item it becomes takes the echo's row keys, its own and
its reply's, so the bubble the user watched appear is the one that stays.

### Part Identity

Every `ContentPart` carries an `id`, and so does every `Thought` inside a
thinking part; every list of either is keyed by it. Position cannot stand in: a
page joining from above puts parts in front of the ones on screen, and an index
key would hand each row's DOM and state — an open body, a clamp — to whichever
part slid into its place.

- **Minted by the store, the first time an item is seen** (`ChatItems.partIds`,
  `newPartId` in `lib/partTree.ts`), and kept for as long as the store lives,
  across a re-subscribe too. Not the item id itself: ids name items, while
  part ids also have to sort.
- **Ids sort in mint order.** A module counter in base 36, zero-padded to a
  fixed width, so comparing two as strings says which came first. `oldestPart`
  is the only reader of that order — see
  [tool-call-ui.md](../tool-call-ui.md#what-a-list-and-a-group-are-keyed-by)
  for why a list and a group are named after their oldest member. An item paged
  in later is minted later, so a list does not change its name when its older
  members arrive.
- **A part built from a run of items is named after its first**: consecutive
  texts, or consecutive thinking. **A card in a row's place takes the row's
  id** — a permission card is the call's own item; a posted question's card
  takes the `question_post` row's, a legacy question's first card the ask
  call's — so one place on screen keeps one identity as the call turns into a
  card and back.

### Discarded Messages

A Stop on a Claude turn can throw away messages the agent had not read yet
([agent-integration.md](agent-integration.md#stop-ends-the-background-work-too)).
What the transcript draws from it is in
[discarded-messages-ui.md](../discarded-messages-ui.md); this is how the state is
kept.

The server says it twice over, and the client keeps both as said: the message's
item is marked `discarded`, and the turn the Stop ended lists it (`discarded`
on its stretch and its update), which the turn's last bubble carries as
`discardedMessageIds`. "This message was discarded" is derived on every render
by `discardedMessages`, which joins those ids with the messages' `messageId`s
across the loaded transcript, rather than written onto the message: the turn
can be loaded a page before the message it names.

A posted question's card is read the same way. A discarded answer reopens its
question — the server's item goes back to `open` — but the card is the record
of what was said, so the item keeps the answer it lost (`discarded_answer`,
`discarded_in`) and the card is drawn with it, its message id as
`answerMessageId`; the card reads `Not read` when that id is in the derived set
([answering-ui.md](../answering-ui.md#6-the-record-card-in-the-stream)). A new
answer or a withdrawal replaces it.

### Tool Runs

Every tool call in a turn — a `Bash`, a `Read`, a subagent — is one
`{ type: "tool_call" }` part holding a `ToolRun`, drawn where its item stands —
or, for a subagent's own call, in its parent run's children
([below](#a-subagents-children)) — so a call reads at the point in the turn
that made it. Nothing groups them: a summary across several calls can only
restate what the individual rows already say, and it costs the one thing a
transcript is for, which is knowing when each thing happened.

A subagent call is not a second shape. It *is* a tool call — Claude even carries
its `tool_use_id` on the task lifecycle frames — and keeping a `TaskRun` beside
`ToolRun` meant two status machines for one thing. `TaskItem` stays, as the
renderer for that category, and its extra fields (`description`,
`subagent_type`, `prompt`, and a Codex spawn's `agent_path`) are derived from
`input` the way every other row's title is
([tool-call-model.md](../tool-call-model.md)).

The run's status is the item's, read onto the row's five
(`running` / `background` / `success` / `error` / `interrupted`); what makes
the item's status what it is — a backgrounded call staying open, a cut turn
interrupting its calls, a process ending taking its background work down, a
result after a Stop — is the server's projection
([agent-integration.md](agent-integration.md#the-history-projection),
[tool-call-model.md](../tool-call-model.md#toolrun)). Two of its facts are
kept beside the status rather than folded into it, because each says something
the status cannot: `finishedAfterStop` (an interrupted call whose late result
was not an error — drawn as the success it was,
[tool-call-ui.md](../tool-call-ui.md#status)) and `lostWithProcess`
(backgrounded work that died with its process, so a `result` on it is Pockode's
account of the loss —
[tool-call-ui.md](../tool-call-ui.md#when-a-background-run-finishes)). A
backgrounded call's placeholder stays beside its outcome (`placeholderResult`):
the placeholder is what the *agent* read, the outcome what *happened*.

**A call waiting on a person is drawn as the card in its row's place**: while
the user is deciding, the machine is waiting for *them*, and a row spinning
above the card would say the opposite
([tool-call-ui.md](../tool-call-ui.md#the-permission-card-takes-the-rows-place)).
So an item `awaiting_permission` is a `permission_request` part; so is one
`denied` before the engine reported the refusal, and one `expired`, which never
ran; and a request that named no call is only ever a card. Once the answer lets
it run, or the engine reports, the item is a row again, keeping the answer as
`ToolRun.permission`. A press on the card is drawn at once
(`pressAnswer`, the store's `pressed`) and gives way when the server's answer
arrives; a press the server refuses is undone the same way (`resetPrompt`).
Until the answer is recorded an allowed card is a press on its way
(`answerRecorded`).

**A posted question takes the place of the call that posted it.** Its item
names no call — the call reaches the server from the MCP endpoint, which does
not know the CLI's id for it — so it is joined by position: behind the cards
of its batch (one call's questions share an `asked_at`), or in the place of the
newest `question_post` row whose result came after the question
([answering-ui.md §6](../answering-ui.md#6-the-record-card-in-the-stream)). A
join that misses leaves the row and the card side by side. A legacy question
(the CLI's own ask tool) names its call and takes that row's place, one card
per question.

#### A fetch filed under the call it reads

Claude's `TaskOutput` is a call whose whole content is an earlier call's output.
Left as a row of its own it lands a screenful below the work it describes, with
an opaque `task_id` as the only thing tying the two together. So when the server
could say which call it reads — `origin_tool_use_id`, resolved in the adapter
because only it holds the map
([tool-call-model.md](../tool-call-model.md#a-call-about-an-earlier-call)) — and
that call is loaded, the fetch takes no row at all, and is drawn on that call's
run as an entry in `fetches`.

The fetch is still an item of its own, in its own turn; filing it is the
presentation's. Fetches always come after the call they read, so a client paging
newest-first holds every fetch of a call by the time the call's page arrives,
and a fetch drawn as a row because its call was not loaded is filed once the
call's page comes in.

A stop (`TaskStop`, `KillShell`) carries the same field and is never filed: it
is an act with consequences, and keeps its row (`isStopTool`, `lib/taskStop.ts`).
The field is kept on its run as `originToolUseId`, and its body's `Go to call`
is offered only while that row is loaded — `loadedStopTargets`, read over the
whole transcript and provided by `StopTargetsContext`, for the reason
`SubagentResumesContext` is a context: the work stopped is usually in an
earlier bubble than the stop.

An entry's `state` is the fetch item's — `running`, `returned`, or
`interrupted` when what ended a running call ended it first — and nothing about
the run itself changes: not its status (the fetch read the task, it did not end
it, and a failed fetch says nothing about the task) and not its `result`, which
is what this call handed the agent. An entry holds its text under the same two
names a run does — `result` and `contents` — and `toolRunText` reads either.

**The turn waiting on a fetch is the bubble's `awaitedFetch`.** A filed fetch
draws no row, so nothing in the parts says the main agent's newest call is
one; the tail line needs exactly that
([turn-progress-ui.md](../turn-progress-ui.md#23-what-it-says)). It is read off
the open bubble's items: set while the main agent's newest text, thinking or
call is a filed fetch still running.

What the renderers make of the list is
[tool-call-ui.md](../tool-call-ui.md#a-fetch-reads-on-the-row-it-came-from).

#### A plan filed on the call that wrote it

A plan ([turn-progress-ui.md §4.6](../turn-progress-ui.md#46-the-plan-record))
says where the agent's plan stood at one moment. One filed on a call (Claude's)
rides on that call's item and is set on its run as `plan`: the call's row is the
plan's history. A Codex plan has no call and is an item of its own, drawn as a
settled `Plan` row so lists, groups and the work figures need no special case;
one filed on a call the history does not hold (a fork cut it off) has no row to
ride on and is dropped. Either way `plan` carries its place in record order
(`order`) — the Codex item's seq, or the newest record of the call it rides on —
because the plan chip picks the newest plan by record order, not by call order.

#### A subagent's children

A subagent's own text, thinking and calls are nested in its call's item, at any
depth, however the records interleaved; the transcript draws them as that run's
`children` — a list of ordinary parts, the same shape a message's content is,
built by the same code. So a message's content is a tree, and `lib/partTree.ts`
holds the walks over it. What the renderers do with the tree is
[tool-call-ui.md](../tool-call-ui.md#a-subagents-own-work).

- **Nesting is the server's.** A call recorded before the subagent call it ran
  under moves under it when that arrives; work a subagent resumed later
  (Claude's `SendMessage`, a Codex child given more work) names the call that
  first spawned it and is nested there. A child changes no bubble's status and
  opens no bubble — it is the subagent's.
- **A child whose parent is not in the history sits flat**, at the top level,
  keeping `parentToolUseId` — a fork cut the call off. That stops it running
  together with the main agent's text.
- **A resumed subagent runs again.** Codex settles the spawn's own call again
  when the child's next turn ends, so its item simply goes back to `running`.
  Claude resumes a subagent under a call of its own, `SendMessage`, whose `to`
  is the id the subagent's call reported; nothing is written onto the
  subagent's run, and whether it is running again is read off that call
  (`liveResumes`, provided through `SubagentResumesContext`):
  while a `SendMessage` to it is `running` or `background`, the row draws itself
  running, on that call's clock and live progress (`resumedRun`). A copy of the
  call's status on the subagent's run would have to follow the call through
  every way a call settles; read off the call, the row settles whenever the
  call does.
- **Each text item is its own paragraph.** Consecutive texts from the same
  speaker join with a blank line, not end to end: both adapters send whole
  messages, never deltas.
- **Consecutive thinking from the same speaker is one part**, each item one
  entry in its `thoughts`, because the engine splitting one pause into two
  blocks is nothing a reader can use
  ([turn-progress-ui.md](../turn-progress-ui.md#11-what-it-is)). A thinking
  that would draw nothing — no text, not redacted, no duration — is left out.

#### Live state on a run

Four of a run's fields do not come from history and cannot: `activity` (the
latest one-line status), `output` (what a streaming engine has printed),
`outputDroppedLines` (what the cap on `output` has dropped, below) and
`subagentProgress` (a subagent's live counters). They come from the call's
stream: the subscription's `streams.tools` snapshot and the `chat.delta`s that
continue it, which are never persisted — a progress line is a *latest value*,
and a snapshot of one in the transcript becomes a lie the moment the next one
arrives ([agent-event.md](../agent-event.md#what-is-not-an-event)). The store
keeps them by `tool_use_id` and the run reads them while it is `running` or
`background`.

- **A run read from history has none of them, and is still correct**, because
  `status` carries "still going" on its own.
- **A stream ends where the server says** (`streams_ended`), dropping all four:
  the item has all of it, and a stale live count never stands in for the
  result's `subagent` report. Deltas held for the next frame are applied before
  the update that ends their stream, so the output never trails its result.
- **Deltas are coalesced per animation frame** in `useChatMessages`, merged per
  call (output appended, the rest latest values) rather than queued: they can
  arrive faster than the screen refreshes, and a hidden tab flushes nothing.
- **An empty activity leaves the last line standing**, and the output is
  capped at its last 200 lines. A line that blinks in and out re-flows every
  row below it, and a build that printed ten thousand lines is not ten thousand
  DOM nodes. What the cap drops is counted in `outputDroppedLines`, so a reader
  of the buffer — the full screen viewer — knows where its lines sit in what
  this client has received ([tool-call-ui.md](../tool-call-ui.md#full-screen)).

#### Times on a run

A run's times are not live state: `startedAt` and `endedAt` are the item's
`started_at` and `ended_at`, so a run read from history has them exactly as a
live one does
([tool-call-model.md](../tool-call-model.md#observed-times-and-reported-durations)
defines which records they come from, and why the turn's ending never counts).
The one time that *is* about this client is `seenAt`, the start on its own
clock, which is all a ticking counter can subtract from `Date.now()`. The store
sets it on the node as the item arrives:

- **From an update that changes `started_at`** of a call the store holds — an
  answer letting it run, a resume — it is the moment the update arrived. A call
  an update brings for the first time is read through the subscription's clock
  reading, as a page's is: it may have started long before (one adopted from a
  page never loaded), and the reading is close to its arrival otherwise.
- **From a page**, it is `started_at` carried over through the page's
  `server_time` and when the page arrived (`ServerClockReading`, built by
  `readServerClock`): `receivedAt − (serverTime − startedAt)`, an interval on the
  server's clock added to a moment on this one, so the two clocks never have to
  agree — the turn clock's rule
  ([turn-progress-ui.md §2.3](../turn-progress-ui.md#23-what-it-says)).
- **Otherwise** — no `started_at`, or a page without `server_time` — there is
  no `seenAt` and no counter. A missing counter is the honest failure;
  subtracting a server time from the phone's clock would show drift as work.

`receivedAt` is when the page *arrived*, not when it was put on screen, and the
difference is real for a viewed session: its `session_view.history` page sits in
react-query's cache, so `useViewedSession` hands over the query's
`dataUpdatedAt` as `pageReceivedAt` and `useChatMessages` installs the page
against that; otherwise a cached page's counters would come up short by the
cache's age.

The duration a row shows is `toolRunDurationMs` (`web/src/lib/toolRun.ts`), not
a field: the engine's `durationMs` and the observed `endedAt − startedAt` are
kept apart in the run, and the precedence lives in one function so the row, the
subagent row and any later summary read it the same way.

#### Times on a reply

A reply carries the two moments its span is read from, `openedAt` and
`endedAt` on the `AssistantMessage`, read off items for the same reason a run's
are: they are history, so a reload draws what the live view did
([tool-call-ui.md](../tool-call-ui.md#where-the-duration-comes-from) says which
records). A reply opens at its turn's opening message's `observed_at`, or at
the read point that opened it; it ends at the next read point, or at the turn's
`ended_at` on its last bubble. The sending tab's echo takes `openedAt` from the
send's reply. A reply that opened without a message — output the CLI resumed by
itself — has none, and nothing is guessed. `turnWork` (`lib/turnWork.ts`) reads
the work figures' span and call count off a settled reply. It counts nothing
on a reply whose start is not loaded: the server marks the newer half of a turn
a page boundary cut as a `continued` stretch, `ChatItems.continuedFrom` holds
the first item of the oldest loaded page's first stretch while it is, and
`buildTranscript` marks the reply that stretch opens `startNotLoaded` unless
something loaded — its turn's opening message, a read point — opened it. Nor
does it count a reply whose only calls are a subagent's steps left flat, whose
spawning call a fork cut off.

### Transcript-Wide Facts

Some facts are the whole transcript's and are read by several components:
the resumed subagents (`liveResumes`), the stop targets that are loaded
(`loadedStopTargets`), the top-level agents and the current plan
(`topLevelAgentRuns`, `currentPlan`), and a run found by its id
(`findLoadedRun`). Each streamed record hands over a new transcript array, and
the list, the status line, the attention strip and an open subagent transcript
all ask for these facts again in the same commit. On a 300-turn session that
meant several walks over about 24,000 calls for every record.

Reference stability makes this cheap (`web/src/lib/transcriptMemo.ts`).
`perTranscript` keys a fact on the transcript array, so it is derived once per
record however many readers ask. `perMessage` keys what one message contributes
on that message, so a walk over the calls re-reads only the message the record
changed, and the transcript-wide answer is put together from the other
messages' cached parts. Both depend on `buildTranscript` handing back the same
message objects for what did not change, and never changing one in place. Code
that edited one in place would get stale answers back and no error.

## Extension System

Extensions register capabilities at runtime via `ExtensionContext`:

```typescript
// web/src/lib/extensions.ts
export interface ExtensionContext {
  readonly settings: { register(config: SettingsSectionConfig): void };
  readonly chatUI: { configure(config: Partial<ChatUIConfig>): void };
  readonly headerUI: { configure(config: Partial<HeaderUIConfig>): void };
  readonly sidebarUI: { configure(config: Partial<SidebarUIConfig>): void };
  readonly theme: { register(name: string, info: ThemeInfo, css: string): void };
}
```

### Disposables Pattern

Each context tracks cleanup functions automatically:

```typescript
// web/src/lib/extensions.ts
function createContext(extensionId: string): InternalContext {
  const disposables: Array<() => void> = [];

  return {
    settings: {
      register(config) {
        const unregister = registerSettingsSection(namespaced);
        disposables.push(unregister);  // Auto-cleanup on unload
      },
    },
    dispose() {
      for (const fn of disposables) fn();
    },
  };
}
```

When `unloadExtension(id)` is called, all registered resources are cleaned up.

### Extension Loading

Extensions are auto-discovered via Vite's glob import:

```typescript
// web/src/lib/extensions.ts — loadAllExtensions
const modules = import.meta.glob<ExtensionModule>(
  "../extensions/*/index.ts",
  { eager: true },
);
```

## Registry Pattern

Registries provide runtime extensibility with React integration via `useSyncExternalStore`.

### Common Structure

All registries follow this pattern:

```typescript
let state = ...;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useXxxRegistry() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
```

### Theme Registry Example

```typescript
// web/src/lib/registries/themeRegistry.ts
export function registerTheme(name, info, css): () => void {
  // Immutable update for React change detection
  customThemes = new Map(customThemes);
  customThemes.set(name, info);
  injectThemeCSS(name, css);
  notifyThemeListeners();

  return () => {  // Unregister function
    customThemes = new Map(customThemes);
    customThemes.delete(name);
    removeThemeCSS(name);
    notifyThemeListeners();
  };
}
```

Built-in themes are typed (`ThemeName`), custom themes are runtime-registered.

### ChatUI Registry

Allows extensions to replace UI components:

```typescript
// web/src/lib/registries/chatUIRegistry.ts
export interface ChatUIConfig {
  UserAvatar?: ComponentType<AvatarProps>;
  AssistantAvatar?: ComponentType<AvatarProps>;
  InputBar?: ComponentType<InputBarProps>;
  ModeSelector?: ComponentType<ModeSelectorProps> | null;  // the session panel's Permissions; null drops it
  EngineSelector?: ComponentType<EngineSelectorProps> | null;  // its Engine (agent + model + effort)
  StopButton?: ComponentType<StopButtonProps> | null;  // the default InputBar's send slot
  // ...
}
```

Components check the registry and fall back to defaults:

```tsx
const config = useChatUIConfig();
const Avatar = config.UserAvatar || DefaultAvatar;
```

## Subscription Hook

`useSubscription` manages WebSocket subscription lifecycle:

```typescript
// web/src/hooks/useSubscription.ts
export function useSubscription<TNotification, TInitial>(
  subscribe: (callback) => Promise<{ id: string; initial?: TInitial }>,
  unsubscribe: (id: string) => Promise<void>,
  onNotification: (params: TNotification) => void,
  options: SubscriptionOptions<TInitial>,
)
```

Key features:

1. **Generation counter** — prevents race conditions when multiple subscribes overlap
2. **Worktree switch handling** — the server invalidates worktree-scoped subscriptions on switch, so the hook resubscribes. Rather than clearing data (`onReset`), a switch is a soft refresh: previous data stays on screen and is swapped out by `onSubscribed` when the new worktree's snapshot arrives (see [subscription-system.md](subscription-system.md#why-worktree-switch-is-a-soft-refresh-not-a-reset))
3. **Connection state** — resets on disconnect, but deliberately keeps data during `reconnecting` and resubscribes once the connection is back
4. **Nothing lost while opening** — the callback is registered under the client-generated id before the request goes out, and notifications arriving before the initial snapshot is applied are held and replayed after it (see [subscription-system.md](subscription-system.md#why-nothing-is-lost-while-a-subscription-is-being-opened))
5. **A snapshot handler that throws is reported apart from a failed subscribe** — by the time `onSubscribed` and the replay run, the subscription is open and stays open, so an exception there recovers the same way (`onError`, else `onReset`) but is reported in its own sentence instead of as `Subscription failed`, which would send the reader looking for a network fault that is not there (see [subscription-system.md](subscription-system.md#why-a-throwing-snapshot-handler-is-reported-separately))

## Key Files

| File | Purpose |
|------|---------|
| `web/src/lib/wsStore.ts` | WebSocket + RPC + subscription management |
| `web/src/lib/queryClient.ts` | react-query setup + worktree-dependent invalidation |
| `web/src/lib/chatItems.ts` | The client's copy of the transcript's items: pages, updates, live streams, this client's sends |
| `web/src/lib/transcript.ts` | Items → the `Message[]` the chat draws ([why](#the-transcript)) |
| `web/src/lib/partTree.ts` | Walks over a message's content, which nests a subagent's work under its call; mints part ids |
| `web/src/lib/extensions.ts` | Extension loading and context creation |
| `web/src/lib/registries/*.ts` | Runtime registries for themes, UI, settings |
| `web/src/lib/*Store.ts` | Domain data stores |
| `web/src/lib/gitSyncStore.ts` / `gitCheckoutStore.ts` | The Git workspace's fetch/pull/push and branch switch and delete per worktree, for runs that outlive the view that started them |
| `web/src/lib/gitOperationStore.ts` | The abort of an in-progress git operation per worktree, its failure kept while that operation lasts |
| `web/src/lib/gitWriteStore.ts` | The Git workspace's serial queue per worktree, for writes — and their failures — that outlive the view that started them |
| `web/src/lib/worktreeQuery.ts` | Worktree list query key + fetcher, kept together |
| `web/src/hooks/useSubscription.ts` | Subscription lifecycle hook |
| `web/src/lib/historyTrail.ts` / `web/src/hooks/useGoToParent.ts` | What is behind the page in the tab's history, and the in-app ← that reads it to go up ([why](#the-history-trail-is-not-the-scroll-memory)) |
| `web/src/lib/scrollMemory.ts` / `web/src/hooks/useScrollRestoration.ts` / `web/src/hooks/useScrollRestorationScope.ts` / `web/src/components/ui/PageBody.tsx` | A page's scroll position per history entry, put back when the reader returns ([why](#why-a-pages-scroll-position-outlives-the-page)) |
| `web/src/lib/valueState.ts` | Stored / still coming / not coming, named once for every control that waits on a snapshot ([why three states](subscription-system.md#why-the-controls-wait-for-the-session-to-describe-itself)) |

`worktreeQuery.ts` exists because two hooks (`useWorktree`, `useWorktreeDisplay`)
read the same react-query cache entry. Key and fetcher living in separate files
let each hook write its own fetcher, and the moment the response shape changed the
two disagreed about what that cache entry holds. Keeping them in one module makes
"same entry, same shape" a property of where the code is, not of everyone
remembering.
