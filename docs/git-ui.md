# Git Workspace UI

How the Git workspace (`web/src/components/Git/`, entry `GitWorkspace`) presents the four everyday operations — commit, discard, branch, remote sync — and how the sidebar's Git tab (`GitTab`) leads into it. Backend architecture is in [git.md](git.md); this document covers entry points, navigation, layout, interaction flow, feedback and confirmation policy. The layouts and copy below are what the workspace does — where the implementation departed from the original design, this file records the implementation.

The Changes segment — one list of files with a checkbox each — and the `diff` layer, a file-by-file review, are [git-changes-ui.md](git-changes-ui.md)'s; this file points to it rather than restating either.

The rules the workspace's rows share with the sidebar's Files panel — the visual weight ladder its `L1`–`L5` references point at, what `th-accent` is allowed to mean, and the narrow-width rule every fixed row below obeys — are in [sidebar-ui.md](sidebar-ui.md), which also owns the Git tab's shape.

## Goals and constraints

- **The workspace is a place; the sidebar is its doorplate.** Git used to be a panel inside the tabbed sidebar — then a 288px drawer on a phone, a 240–500px column on desktop — and every layout was drawn at 288px. It is now a page of the main content area, `/git`, with the sidebar's Git tab reduced to a read-only overview and three entries into it ([The sidebar's Git tab](#the-sidebars-git-tab)). Everything that writes appears once, in the workspace; nothing in the sidebar writes.
- **Still narrow where it matters.** Below `expanded` (1024) the workspace has a phone's width to itself; at and above it, its list column is user-resizable and never narrower than 280px ([Layout](#layout)). Every fixed row still obeys the narrow-width rule, which is about containers, not about the sidebar ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)).
- **One-handed and touch-first.** Full-width rows are `min-h-[44px]`; icon-only buttons inside a row are `min-h-[36px] min-w-[36px]` (L5), defined once in `ui/iconButtonClass.ts` so a row's checkbox and `⋯`, amend and dismiss cannot drift apart in weight. 36 is the visual rung; a coarse pointer grows the box to 44 ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)).
- **One list.** The Changes segment is one list, a row per path, with staging a checkbox on the row rather than a group it sits in ([git-changes-ui.md](git-changes-ui.md#the-changes-segment)). The segments themselves are a filter over the page, not a level of it.
- **Reuse the existing vocabulary.** `th-*` tokens, `ConfirmDialog` and `Sheet` from `@pockode/shared`, `BottomActionBar`, `SidebarListItem`, `PageHeader`, the segmented control the Stories screen already had (`ui/SegmentedControl.tsx`, extracted so both pages draw one), and lucide icons.
- **Nothing stashes implicitly.** Pockode runs in worktrees that share one stash stack with the main checkout and every other worktree, so a stash the user did not ask for can be popped by a different session. No operation here creates one — a switch that git refuses is reported, not worked around.

## Routes, segments and Back

The workspace is three segments, each a list, and the diff, branch and commit pages are layers under them:

| Screen | URL (under the usual `/w/<worktree>` prefix, with `session`) | Segment |
|---|---|---|
| Changes list | `/git` | `changes` — the absence of the parameter: never written as `segment=changes`, though accepted if typed |
| History list | `/git?segment=history` | `history` |
| Branches list | `/git?segment=branches` | `branches` |
| A file's review | the `diff` route (staged or unstaged — the side on screen) | `changes` |
| A branch | `/branch/<ref>`, plus `remote=1` for a remote-only branch ([git-branches-ui.md](git-branches-ui.md#the-branch)) | `branches` |
| A commit | the `commit` route — with the History query it was picked from, or `branch=<ref>` (and `remote=1`) when it was opened from a branch | `history`, or `branches` with `branch` |
| A file as a commit changed it | the `commit-diff` route, carrying the commit's query or `branch` | as the commit |
| A file as of a commit | the `commit-file` route, carrying the same | as the commit |

**A layer does not carry its segment.** A diff can only have come from Changes and a branch only from Branches, and a commit says where it came from by what it carries, so the layer decides its parent — `gitSegmentOf(overlay)` in `types/overlay.ts`, which is also what `isGitOverlay` is built on. What a commit layer carries is its origin (`CommitOrigin`): the History list it was picked from — range, search and file filter ([git-history-ui.md](git-history-ui.md#url)) — or the branch whose detail it was opened in, `{ ref, remote }` ([git-branches-ui.md](git-branches-ui.md#opening-a-commit)), never both; `branch` makes it the Branches segment's. This is unlike the Stories detail, which carries the segment it was opened from because either segment can open it ([project-ui.md §5](project-ui.md#5-where-the-segment-lives)). There is no second set of URLs for the wide layout either: the same URL is one layer on a phone and two columns on a desktop, so resizing never invalidates where the user is.

Navigation is `AppShell`'s, on the Stories screen's model:

| Action | Result | History |
|---|---|---|
| A segment in the segmented control | That segment's list, at the top. At `expanded`, a detail open in the right column is dropped — it belonged to the other segment | push, so Back walks the segments |
| The branch name in the top bar | The Branches list | push |
| A file, a commit or a branch in a list — or a commit in a branch's detail | Its layer | push, at every width, so Back stays right across a resize |
| A press that names the layer already on screen — the bare list of the segment it is on | nothing | no entry |
| The lit segment while a detail is open beside it | The bare list, detail dropped | push |
| The app header's `←` on a list, or at `expanded` on anything | Back to the chat the workspace was opened over (`session`), or the worktree's home | as every page over the chat |
| The app header's `←` on a narrow layer | The **parent**: diff → Changes (`Back to changes`), branch → Branches (`Back to branches`), commit → History (`Back to history`) or, opened from a branch, → that branch (`Back to branch`), commit-diff → commit, commit-file → commit-diff | navigates *to* the parent URL rather than `history.back()`, so a deep-linked diff still has a list to go back to. Pushed, except from the review: there it is `history.back()` when the review was pushed from the list — the one case where the list is known to be behind — and otherwise a replace ([git-changes-ui.md](git-changes-ui.md#what-the-two-bottom-buttons-say)) |
| A sidebar entry | That segment's list — never a detail it remembers | push |

`handleSelectGitSegment` serves the segment control, the branch name, the back of a narrow commit opened from History and of a narrow branch, a gone branch's `Back to branches`, and the sidebar's entries, so all of them land on a list the same way.

**Switching worktree inside the workspace stays inside it**, at the same segment's list: every worktree has one, where the path or hash of the detail on screen may not exist over there (`useWorktree.select` reads the current route). Each worktree's own failures stay with it ([Results that outlive the page](#results-that-outlive-the-page)), and the automatic fetch decides again for the new worktree ([Automatic fetch](#automatic-fetch)).

**There is no composer anywhere in the workspace.** The chat input is hidden on every layer — `git`, `diff`, `branch`, `commit`, `commit-diff`, `commit-file` are in `ChatPanel`'s `inputBarHiddenOverlays`, beside the Stories pages. The workspace's bottom edge belongs to Git's own primary actions — the commit bar, the review's `Discard file` / `Stage & next` bar, `New branch…` — and a composer under them would be a third stacked bar on a phone, all of them competing for the thumb. Viewing a diff or a commit — and a commit's file layers — used to keep the composer under it; those are the places this is a change. To talk to the agent the user goes back, which the app header's `←` always offers; and the way Git hands work to the agent is the [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), which brings the user back to the session's input with a prefilled message, rather than a second input here; which entries call it is [agent-handoff-ui.md](agent-handoff-ui.md)'s list.

## The top bar

One row, `min-h-[44px]`, directly under the app header, on **every** layer — the narrow diff and commit layers included. That is not decoration: a sync left running when its sheet was closed reports through the sync chip and nowhere else, and a layer without the bar would lose both that progress and the automatic fetch's failure mark. It is split into two independent targets so it stays a single line (`Git/BranchBar.tsx`):

| Region | Content | Tap |
|--------|---------|-----|
| Left (`flex-1`, truncate from the head) | `GitBranch` icon + branch name | Opens the **Branches** segment (`Branches, currently on <name>`) — not a sheet |
| Right (chip button, never truncated) | Sync state | Opens the **Sync sheet** |

Detached, the left region reads `detached @ 9692fc9` and still leads to Branches — except during a rebase, which names the branch being rebased instead ([git-conflict-ui.md](git-conflict-ui.md#the-top-bar-during-a-rebase)). The bar shows whatever branch data it has, even while a refetch is failing: react-query keeps the last value alongside the error, and swapping a known branch name for a message would take the bar down for exactly the reason it renders outside the lists' error branches. While loading it is a skeleton; only with nothing cached at all does it read `Branch unavailable`, with the query's error message in the title attribute, and then it is not pressable (the Branches segment says why it cannot read the list). The placeholder is `Git/HeadPlaceholder.tsx`, shared with the sidebar's overview.

### The sync chip

The chip names **the one step this branch most needs**. The first row that holds wins:

| # | Condition | Chip | Accessible name (after `Sync with remote, `) |
|---|-----------|------|------|
| 0 | No remote, or detached HEAD | **hidden** | — |
| 1 | No upstream, or `upstream_gone` (`needsPublish`) | `Publish` | branch not published |
| 2 | behind > 0 and ahead > 0 | `↓2 ↑1` | 2 to pull, 1 to push |
| 3 | behind > 0 | `↓ Pull 2` | 2 to pull |
| 4 | ahead > 0 | `↑ Push 1` | 1 to push |
| 5 | Counts zero, never fetched (`last_fetch == null`) | `⟳ Fetch` | never fetched |
| 6 | Counts zero, fetched | `⟳ Synced` | up to date |

The derivation is `describeSyncStatus` in `utils/gitSyncStatus.ts`, and it is the **only** one: the sidebar's overview reads the same `SyncStatus` and the same `describeSyncStep` sentences, so the chip and the overview cannot disagree about what the branch needs. `hasSyncStatus` is row 0.

- **Every state only opens the sheet.** `Pull 2` is the name of the next step, not a one-tap pull; the counts are as old as the last fetch, which only the sheet has room to say.
- **A single direction gets a verb, a divergence does not.** Two verbs do not fit, and the sheet says it as a sentence.
- **Row 5 exists because zero is not "up to date".** `↓0 ↑0` from a workspace that has never fetched is not knowledge, so it reads `Fetch`. With the automatic fetch on the way in, this state usually shows only for a moment.
- **`Upstream missing here`** — an upstream is configured but its remote-tracking ref is not in this repository, never fetched or pruned after the remote branch was deleted — is row 1. The counts are unknown rather than zero, so the chip must not read `Synced`; the sheet names the ref and offers fetch to update it or push to recreate it.

Two marks lead the state without taking part in the priority:

| Mark | Shown | Accessible name |
|---|---|---|
| A run in flight, manual or automatic | spinner first | becomes `fetching…` / `pulling…` / `pushing…` |
| The last **automatic** fetch failed | `TriangleAlert` in `text-th-warning` first | `, automatic fetch failed` appended |

The two are exclusive: a new run replaces the outcome the mark stands for. The spinner **leads rather than replaces**: the `Publish` state has no icon to take over, and the counts are still the truth until the operation refreshes them, so nothing already on the chip is swapped out or blanked. It stops when the run settles, and what replaces it is the refreshed count — the success signal arrives where the user is already looking, which is why success needs no message of its own ([Feedback and errors](#feedback-and-errors)).

The run the chip shows is the one thing on it that is **not** derived from the server's answer; it comes from `lib/gitSyncStore.ts`, and may have been started from a sheet the user has since closed, or by the workspace itself ([Remote sync](#remote-sync), [Automatic fetch](#automatic-fetch)). That extra input is accepted deliberately: the sync sheet is this chip expanded, so the chip is where the action was started from.

### Automatic fetch

Counts are only as fresh as the last fetch, and nothing else fetches on its own. So the workspace fetches by itself on the way in (`useAutoFetch` in `hooks/useGitSync.ts`, called from `GitWorkspace`):

- **When.** Once on arriving in the workspace — from any page that is not `/git`, at any layer, deep links included — and again for each worktree switched to while inside it. Moving between segments and layers is not arriving: `GitWorkspace` stays mounted across them, and across the `expanded` breakpoint.
- **Only if** (`shouldAutoFetch`) the chip is on screen — a remote, and not detached; no sync is running in that worktree; and `last_fetch` is empty or more than ten minutes old (`AUTO_FETCH_AFTER_MS`). Ten minutes is long enough that walking in and out of the workspace does not fetch every time, short enough that counts read on arrival are about today. `last_fetch` is the server's clock and the comparison uses the browser's; a skew moves the threshold by the same amount, which costs a fetch too many or too few and nothing more.
- **"The chip is on screen" is a hard condition, not a nicety.** An automatic fetch's failure is reported on the chip; with no chip there is nowhere to report it, and a fetch that could fail unseen is a silent failure. So it does not run.
- **It waits for data that belongs to the worktree it decides for.** During a worktree switch the branch cache still holds the previous worktree's answer and the connection is still bound to it. Nothing is decided between the switch starting and settling — including a switch already under way when the workspace mounts — nor while the branch query is fetching, nor after a refetch that failed, which leaves the previous answer in place. A switch that never settles leaves that visit unfetched: the safe way to be wrong, since the chip and the sheet still say how old the counts are.
- **Running** it is the same run as a manual fetch (`gitSyncActions.startAutoFetch`, the same guard as `start`): the chip spins, the sheet shows Fetch spinning with Pull and Push disabled, and a second sync cannot be started on top of it.
- **Success says nothing.** The spinner stops and the counts refresh; the sheet's `Last fetched` moves. There is no `Fetched.` waiting in the sheet — that would answer a question the user never asked.
- **Failure is not a banner.** Nobody started this run, so no place the user acted in is waiting for an answer. The chip gains the `⚠` mark, the sidebar's overview says `Automatic fetch failed`, and the sheet's in-sheet `role="alert"` result reads `Automatic fetch failed.` with git's output under it (`Automatic fetch failed. <reason>` and no output when the server refused it). Under it `Last fetched` is the honest answer to how old the counts are, and `Fetch` is the retry.
- **The mark stays until the next sync starts**, manual or automatic — "one outcome per source, a new run replaces the last". Opening the sheet does not clear it: there is no "seen" state, and having seen it does not make the counts fresh. If HEAD goes detached the chip — and with it the mark — is hidden; the outcome stays in the store and the mark is back with the chip, and with no counts on screen in between there is nothing for it to warn about.
- **Manual fetch, pull and push fail as before**: in the sheet while it is open, in the top bar's banner while it is closed ([Feedback and errors](#feedback-and-errors)). What tells the two apart is who started the run, which `SyncRun.auto` records.

### On the relationship with `WorktreeSwitcher`

The sidebar header shows a `FolderGit2` icon with the worktree name — every worktree marker does, so it is never the top bar's `GitBranch` — and the top bar and the sidebar's overview show a branch name. They are kept apart by what they name: the header switches *workspace* and is labelled by worktree name (`review`), the top bar names *the branch within this workspace* and always renders the real ref name. A branch already checked out in another worktree cannot be checked out here — git refuses — so its row says `in <worktree>` and its `Switch to this branch` is unavailable with `Checked out in <worktree>.` instead of letting the user find out through an error ([git-branches-ui.md](git-branches-ui.md#the-row)). Linked worktrees are named as the switcher names them; the main checkout reads `in main worktree`, because the switcher labels *it* by branch and "branch X is held by branch X" says nothing (see [git.md](git.md#branches)).

## Layout

### Below `expanded`: one layer per screen

**A list layer:**

```
┌──────────────────────────────────┐
│ ←  Git                           │  app header — ← back to the chat
├──────────────────────────────────┤
│ ⑂ feature/git-ui      ↓ Pull 2   │  top bar      — fixed, L2
├──────────────────────────────────┤
│ ⚠ Push failed · Details        ✕ │  top-bar banners — sync, switch (see Feedback)
├──────────────────────────────────┤
│ [ Changes ]  History   Branches  │  segmented control — fixed
├──────────────────────────────────┤
│ ⚠ Discard failed · Details     ✕ │  inline-action banner — Changes only
│ ▣ 3 files  +142 −37      [≣|⌸]   │  list header, sticky  ┐
│ ☑  GitTab.tsx          +12 −3  ⋯ │                       │
│    web/src/components/Git        │                       ├ scroll area
│ ▣  git.md              +88 −20 ⋯ │                       │
│    docs                          │                       ┘
├──────────────────────────────────┤
│ [Discard unchecked…] [Commit 2…] │  commit bar — Changes only, when committable
└──────────────────────────────────┘
```

Each segment's root is a flex column whose scroll area is a plain `min-h-0 flex-1 overflow-y-auto` box, with the fixed rows as its siblings rather than content inside it. The top bar, the banners above the list, the segmented control and the commit bar therefore stay reachable however far the list has scrolled, and they render outside the list's `isLoading` / `error` branch: a failing `git.status` must not take the branch name, or the other segments, down with it. The segmented control is the Stories screen's — full width, outside the scroll area, no counts ([project-ui.md §2.1](project-ui.md#21-the-segmented-control)); each segment opens at the top.

**A detail layer** (here the review; a branch and a commit have the same frame — app header, top bar, the page):

```
┌──────────────────────────────────┐
│ ←  git.md                        │  app header — the layer's own title; ← to its list
├──────────────────────────────────┤
│ ⑂ feature/git-ui      ↓ Pull 2   │  top bar, as on every layer
├──────────────────────────────────┤
│ ‹ 2 / 3 ›  docs          ↵ ␣     │  the review's toolbar
│ (DiffView, with its own banner)  │
├──────────────────────────────────┤
│ [Discard file]  [Stage & next ]  │  DiffView's own bottom bar
└──────────────────────────────────┘
```

A layer has **no segmented control** — the segments filter the lists, and a layer belongs to exactly one — and **no commit bar**: a layer's bottom edge is its own — the review's bar and a commit file's two (its diff, its version); a commit and a branch have none — and two stacked bottom bars are not acceptable. The list stays mounted under the layer rather than unmounted, so Back returns the reader to where they were in it. It is covered the way the transcript is under an overlay — `invisible absolute inset-0`, `inert`, inside a `CoveredSurface` so a sheet it raised closes — and not with the `hidden` attribute: `display: none` destroys the very scroll box it is kept for ([answering-ui.md](answering-ui.md)).

### At `expanded`: two columns

```
┌──────────────────────────────────────────────────────────────────┐
│ ←  Git                                                           │  app header — always "Git"
├──────────────────────────────────────────────────────────────────┤
│ ⑂ feature/git-ui                                     ↓ Pull 2    │  top bar, across both columns
├──────────────────────────────────────────────────────────────────┤
│ ⚠ Push failed · Details                                       ✕  │  top-bar banners, across both
├────────────────────────┬─────────────────────────────────────────┤
│ [Changes] History Bra… │ git.md                                  │  column heading (L2)
├────────────────────────┼─────────────────────────────────────────┤
│ ▣ 3 files +142 −37   ≣ │ ‹ 2 / 3 › docs                    ↵ ␣   │  the review's toolbar
│▌▣ git.md      +88 −20⋯ │   (the diff)                            │
│ ☐ notes.txt   +9     ⋯ │                                         │
├────────────────────────┼─────────────────────────────────────────┤
│ [Discard…] [Commit 2…] │ [ Discard file ]        [ Stage & next ]│  each column's own bottom bar
└────────────────────────┴─────────────────────────────────────────┘
```

- **Two columns follow the tier** (`useIsExpanded`), not the main area's measured width, as everywhere else in the app. At 1024 with the sidebar at its 320px default the main area is about 704px; a user who drags the sidebar to 500 has made that trade themselves ([responsive-ui.md](responsive-ui.md#the-width-ladder)).
- The left column holds everything the narrow list layer holds — segmented control, banner, list, commit bar — and **the user can resize it** by its right edge, with the sidebar's handle and drag logic (`ResizeHandle`, `useResizableWidth`; why it stays 8px is [responsive-ui.md](responsive-ui.md#the-column-resize-handle)). Its numbers are against the measured row holding both columns:

  | | Width | Why |
  |---|---|---|
  | Default | `clamp(320px, 40%, 560px)` | Followed as the row changes until the user picks a width |
  | Minimum | 280 | The narrowest the column has been built and checked at; its fixed rows obey the narrow-width rule ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)), whose design width is this same 280 |
  | Maximum | row − 480 | 480 is where a diff stays readable; the list cannot take it from the detail column. Below a 760px row the minimum wins and the detail gets what is left — the case at 1024 beside the sidebar's 320px default, where the column stays at 280 and the detail gets about 424 |

  - **One width for every segment**, stored as `localStorage["pockode:gitListWidth"]`, per browser rather than per worktree, so the segmented control and the list under it do not move when the segment changes — a control that moves once pressed sends the next press somewhere else.
  - A drag moves the edge by the pointer's travel; a press that does not move stores nothing. The keyboard moves it as the sidebar's does — arrows 16px, Home and End to the limits — and **double-click resets** it to the default, which then follows the row again.
  - **A narrower window clamps what is drawn, not what is stored**: the chosen width comes back once there is room for it again. A stored width under the minimum is drawn at the minimum the same way ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)).
- **The app header names the workspace**, `Git`, and its `←` leaves the workspace: one header cannot name two layers. Each layer names itself in a **column heading** at the top of the right column — the layer's `PageHeader`, drawn inline as a bar of its own by `InlinePageHeaders` rather than portalled into the app header. It is a switch rather than a wrapper that comes and goes, so a resize across 1024 moves the heading without remounting the page under it.
- **Diff, branch and commit have no `←` in their heading**: their parent is the left column, already on screen (`PageHeader`'s `back` is optional for exactly this). Commit-diff and commit-file keep theirs, back to the layer above (commit-file → commit-diff → commit), and the History list keeps the commit lit throughout. A commit opened from a branch keeps its `←` too, `Back to branch`: what is beside it is the Branches list, not the branch it was opened from ([git-branches-ui.md](git-branches-ui.md#opening-a-commit)); the list keeps that branch's row lit under it and its file layers.
- The selected row in the left column wears the usual active treatment.
- **With nothing chosen**, the right column says so in one muted, centred line rather than standing blank, so it cannot be taken for a column still loading (`EmptyDetail`):

  | Segment | Left column | Right column |
  |---|---|---|
  | Changes | has changes | `Select a file to see its diff` |
  | Changes | clean | `No changes to review` |
  | History | has commits | `Select a commit to see what it changed` |
  | History | unborn HEAD | `No commits yet` |
  | History | a search or file filter with no match | `No matching commits` |
  | Branches | has branches | `Select a branch to see its commits` |
  | Branches | none (an unborn branch and no other) | `No branches yet` |
  | any | loading, or its read failed | blank — the left column is already saying it |

- **One skeleton for every segment.** List column | splitter | detail column, whatever the segment: nothing about the layout depends on which segment is on screen. Branches was once the exception — a branch had no detail, and the layout carried a two-columns flag, a `max-w-xl` list and a wrapper holding the segmented control at the shared width to hide that — and none of it is left now that a branch has a detail ([git-branches-ui.md](git-branches-ui.md#at-expanded)).

**Why Git splits into two columns when the Stories screen does not.** [project-ui.md §7](project-ui.md#7-deliberately-not-done) rejects a master-detail split there: a story's detail is read one at a time, and a list, a detail and a sidebar would share the space of one chat. A diff is read in a run — file after file, then a commit — and walking back and forth between a list and a full-screen diff is exactly the cost this layout removes. The same reasoning, with the opposite answer, because the reading is different.

### Rows follow their column's width

The file, commit and branch rows are built for the narrow column: the primary text — file name, subject, branch name — has a line to itself, and what describes it sits on a second line. A wider column makes that a waste, so each list's rows switch to **one line** once *the list* is wide enough, with the secondary text beside the primary rather than under it. What each row puts where is its own document's: [the file row](git-changes-ui.md#the-file-row), [the commit row](git-history-ui.md#one-line-in-a-wide-list), [the branch row](git-branches-ui.md#the-row). What they share is here.

**A row goes wide only where its primary text keeps the room it has in the 320px default column.** One line costs the primary text whatever the secondary takes beside it, so "as soon as it fits" would trade a readable name for a tidy row. The thresholds follow from that rule:

| Lists | Threshold | Token (`web/src/index.css`) | Variant | Why that number |
|---|---|---|---|---|
| Changes, Branches | 600px | `--container-git-row` | `@git-row:` | A branch name keeps ≈228px beside its 17rem of state, counts and age (≈236 today); a file name gets up to 60% of its text cell |
| History, and a branch's commits in its detail | 768px | `--container-git-commit-row` | `@git-commit-row:` | 8 + 74 (a four-lane graph) + 8 + 298 (author, date, hash and their gaps) + 36 (`⋯`) leaves the subject ≈344px, about 50 characters — a whole conventional summary line. At 640 it would get ≈250, less than its own line gives it in the narrow layout |

- **The width measured is the list's, not the viewport's.** Each list's scroll box carries Tailwind's `@container` — the `min-h-0 flex-1 overflow-y-auto` box of Changes and of Branches, and `HistoryList`'s root, which is History's scroll box and, in a branch's detail, the commit list inside the detail's own scroll box — so there it follows the detail column. Nothing between that box and the rows declares another container.
- **One container per list, not per row**, so every row of a list switches together: in tree mode a file row's text cell narrows with its depth, and per-row containers would leave shallow rows on one line and deep ones on two in the same list.
- **History does not switch on its JS `textWidth`** (what the graph leaves): the graph column grows as pages arrive, and a threshold on what it leaves could fold rows back into two lines under the reader as a page lands. The list's width does not move.
- **These are container widths, not rungs of [the width ladder](responsive-ui.md#the-width-ladder)**, so they are not in `BREAKPOINTS` and `responsiveTokens.test.ts` does not compare them. They are named `@theme` tokens in px, like the ladder, so they do not move with the root font size and no `@min-[600px]:` repeats the number in three files. They live in `web` only; `web-cluster` draws no Git lists.
- **Tailwind's own container sizes are refused.** `@sm:` is 384px and `@lg:` 512px, which read like the ladder's `sm:` (640) and `lg:` (1024) and are not; they cannot be retired, since `max-w-sm` reads the same tokens, so `web/tests/widthLadder.test.ts` rejects `@3xs:`…`@7xl:` in source instead.

**Who sees the wide rows.** At `expanded` the list column's default, `clamp(320px, 40%, 560px)`, never reaches 600: on a PC rows go wide once the user widens the column, which is the user asking for that room, and History's one line needs a Git row of at least 1248px. Below `expanded` the list is the window's full width, so a landscape phone or a tablet gets them by default.

**What every row holds to, in both layouts:**

- **The narrow layout, pixel for pixel.** Every wide-only class sits behind the variant. What is not — `@container` on the box, the `title`s below, and an empty secondary text left out (below) — draws the narrow row as it was.
- **Row heights** (files `min-h-[44px]`, branches `min-h-[52px]`, commits 52px fixed): a row that changed height on a resize would move the scroll position under the reader, and History's virtual list needs its fixed height.
- **Targets, selection and names.** Nothing new is pressable — the columns are inside the row's existing button — so a landscape phone gets the wide rows with the same targets: the width picks the layout, the pointer the target size ([responsive-ui.md](responsive-ui.md#the-two-axes)). The active treatment, `aria-current`, accessible names and `aria-describedby` ids are those of the narrow rows.
- **Which end truncates.** Branch and ref names and directories from the head; subjects, file stems, file status words, branch details and authors at the tail.
- **What lines up is the right side.** The commit and branch rows' secondary columns are fixed widths anchored at the right, so they line up down the list and every pixel past the threshold goes to the primary text; a file row's path follows its name instead, and only its counts line up ([why](git-changes-ui.md#the-file-row)). A secondary text that can be empty is left out rather than drawn as an empty box: in a baseline-aligned row an empty box becomes the line's baseline and sets its neighbours off the primary's.

**Every element that can truncate carries a `title`** with its whole value, in both layouts — what each one is, is in the row's document. A `title` is hover only, added and never needed ([responsive-ui.md](responsive-ui.md#progressive-disclosure-hover-reveal)): each value is also in the row's accessible name, its `⋯` sheet or its detail page. Ref chips carry theirs only under a fine pointer, as their `+N` already did; every other `title` is ungated, like `BranchName`'s.

### The Changes list

The list — its rows, checkboxes, header, flat and tree views, the file's action sheet and the clean, loading and failed states — is [git-changes-ui.md](git-changes-ui.md#the-changes-segment)'s. It replaced two groups, `Staged` and `Changes`, under L3 group headers: a partially staged file was two rows, and staging a file moved it across the screen out from under the thumb.

## Commit

The bottom bar holds at most one primary button (L1), beside a secondary `Discard unchecked…` that discards every unstaged change while there is one ([git-changes-ui.md](git-changes-ui.md#the-bottom-bar)), and renders only while committing is on the table. `describeCommitAction` decides the commit button — the discard button beside it has rules of its own — and returns `null` for the two states that have no button:

| Working tree | Bar |
|--------------|-----|
| n files staged in the root | `Commit n files` (`Commit 1 file`) — enabled |
| changes, nothing staged anywhere | `Commit` — disabled, `Check a file to commit` as an `sr-only` hint |
| staged only inside a submodule | `Commit` — disabled, with a **visible** line saying why |
| a merge, rebase, cherry-pick or revert in progress, or conflicts left unresolved | `Commit` — disabled, with a **visible** line saying why ([git-conflict-ui.md](git-conflict-ui.md#what-stops-while-an-operation-is-in-progress)) |
| clean | **no bar** |
| `git.status` unreadable | **no bar** — the Changes segment is already showing why |

Keeping the disabled button in the second case is deliberate: the user is on their way to committing, and a target that pops into existence as they stage the first file is worse than one that is visibly not ready yet.

Keeping it in the clean case is not: there is nothing to commit and nothing on its way to being committed, and 56px of permanently dead accent-coloured button is the loudest thing on a screen that has nothing to say. The bar no longer falls back to `Amend last commit` either — see [Amend](#amend).

**Whether a hint is `sr-only` follows one test: does the screen already show the reason?** `Check a file to commit` names the checkboxes sitting right above the bar, so a line of text would repeat on screen what the screen already says — worth saying to a screen reader, not worth 20px. The submodule case fails that test, and gets a visible line.

That case exists because the two counts behind the bar are deliberately different. The **enabled count is the root repository's** staged files, since that is what `git.commit` records ([Submodules](#submodules)). Whether the bar renders at all follows the **flattened** counts, since those are what the list above it shows — so the bar and the list cannot disagree about whether there is anything on screen. They diverge in exactly one state: files staged inside a submodule. There the rows read as staged like any other and nothing else on screen accounts for a dead button, so the bar spends a line on `Only submodule files are staged; ask the agent in chat to commit them.` — the same referral the sync sheet makes for a diverged branch. The alternative, letting the bar vanish out from under a list of staged rows, is a silent failure.

The hint renders **above** the button, on the same rule the sheets follow: the bar already sits at the bottom edge, so a line under the button is the first thing an on-screen keyboard covers.

Tapping opens the **Commit sheet** rather than editing inline. A permanently mounted message box would cost ~80px of a list that is what the segment is for, on a phone that has none to spare once the on-screen keyboard is up, for an action taken a few times an hour; a sheet gives the textarea real room, lets the on-screen keyboard push it up, and costs one extra tap.

**The bar comes and goes; the sheet does not.** `CommitBar` renders the two as siblings rather than nesting the sheet inside the bar. Nesting them means a background refresh that finds the tree clean — an agent in chat committing or reverting while the user is typing — unmounts the sheet and throws away the half-written message with it.

```
┌──────────────────────────────────┐
│ ═══                              │
│ Commit                        ✕  │
├──────────────────────────────────┤
│ 2 files staged        [✨ Draft] │
│ ┌──────────────────────────────┐ │
│ │ Add branch bar to git panel  │ │
│ │                              │ │
│ └──────────────────────────────┘ │
│ ☐ Amend last commit              │
├──────────────────────────────────┤
│ [ Commit & push ] [   Commit   ] │
└──────────────────────────────────┘
```

**The footer has no `Cancel`.** It used to read `[ Cancel ] [ Commit ]`; a third button does not fit at 320px — `Commit & push` alone is ~130px at `text-sm px-4` — and `Cancel` was the one that said nothing new: the header's `✕`, the backdrop and Escape all close the sheet, and all three are disabled in exactly the states `Cancel` was. The footer is now the two ways to finish, `Commit` keeping the primary (L1, `th-accent`) weight and `Commit & push` beside it as the secondary (`bg-th-bg-tertiary`, the weight `Cancel` had). Commit stays primary because it is the one that is always available; a remote, an attached HEAD and a pushable branch are conditions, and a primary button that comes and goes would move the thumb's target.

- The message textarea autofocuses and starts at ~3 rows, growing to a cap. An empty message keeps Commit disabled — no `-m ""`, no auto-generated placeholder.
- With nothing staged the first line says what is left to do: `Nothing staged — only the message changes` while Amend is on, `Nothing staged — stage a file, or amend the last commit` when it is off and there is a commit to amend, plain `Nothing staged` when there is not. Commit is disabled in the second and third cases — git would refuse them, and a button that says so beats a round trip that always ends in `nothing to commit`.
- **Amend** replaces the previous commit, so the toggle reveals what is about to be replaced instead of asking a modal question the user has no way to answer:

  ```
  ☑ Amend last commit
  ⚠ Replaces "Show what the permission mode does…"
    This commit is already on origin/main —
    pushing afterwards needs a force push
    from Sync.
  ```

  Turning it on prefills the message from HEAD, but only when the user has not typed anything, so toggling never eats input. The second warning line appears only when HEAD is contained in the upstream, and names that upstream rather than assuming it is `origin`. No `ConfirmDialog` here: the toggle is already a deliberate act with its consequence spelled out on screen, and a modal stacked on a sheet reads worse on a phone than the warning it would deliver.
- While committing, the button that was pressed becomes a spinner plus `Committing…`; the other commit button, `Draft`, the amend toggle and the textarea are disabled; the `✕`, backdrop and Escape do nothing, and on success the sheet closes. On failure it stays open with the error inline (see [Feedback and errors](#feedback-and-errors)) — hooks, `commit-msg` rules and a missing `user.email` all fail here, and the user needs the raw message to act on any of them. The missing identity is the one failure with a summary of its own above git's text: git's advice is to run `git config`, which is exactly what this user cannot do, so the summary points at the agent in chat instead.

### Drafting the message with AI

Typing a commit message on a phone keyboard is the slowest part of committing, and the product's premise is that the AI writes. `✨ Draft` asks the AI CLI once — a one-off call the user's press starts, outside any session — for a message describing what is staged, in the style of this repository's recent commits. The result goes into the textarea and nowhere else: nothing is committed until the user presses a commit button, so the draft is always read before it is recorded.

**Where.** Right-aligned on the staged-count line, directly above the textarea it fills: an L4 text button (`Sparkles` icon + `Draft`, `text-th-accent`, no fill), `min-h-[36px]` and 44 on a coarse pointer. Not in the footer — the footer is the two ways to *finish*, and a third button there would sit between the thumb and `Commit` — and not inside the textarea, where it would overlap the text it is about to replace and move with the on-screen keyboard. The staged line is the natural shelf: it already says what the draft will describe.

**Which AI CLI.** The workspace belongs to a worktree, not to a session, but it is never opened from nowhere: its URL carries `session`, the chat it was opened over, which is what the app header's `←` returns to ([Routes](#routes-segments-and-back)). The draft uses **that session's engine** — its agent type, model and effort, exactly as its session panel shows them. Without a `session` in the URL, or with one this worktree's session list does not have (a deep link, a deleted session), it uses the **global default engine** (`useGlobalEngine`), the one a new session would start on. There is no picker: the user already chose an engine for the chat they came from, and asking again on every draft would be a question with an obvious answer. The frontend resolves the engine — one hook, so the label and the request cannot name different engines — and sends it with the request; the server validates the combination the way it validates one for a new session.

What the sheet relies on from the call itself — the backend's contract is in [git.md](git.md#drafting-a-commit-message), with the input, the size cap, the timeout and the error kinds:

- **No tools, no session.** Nothing appears in the session list and nothing the CLI does can change the worktree; the only output is text. A diff cut to size is said so in the prompt; the UI says nothing about it.
- **Slow, paid, and cancellable.** The server gives up after 90 seconds and answers `timeout`; the client's own RPC timeout for this request outlasts that — the default 30 s would answer `Request timed out` long before, and leave the CLI running — and the request is never retried, since each try is a paid model call ([code/websocket-rpc.md](code/websocket-rpc.md#request-timeout)). Each draft carries a fresh client-chosen id, and `Stop`, closing the sheet, leaving the workspace, switching worktree and the client's own timeout running out (the server's 90 seconds start only once git has read the change) all send a cancel naming it; a dropped connection cancels on the server's side. An answer for a draft the sheet no longer waits for — stopped, or from the worktree it was switched away from — is dropped, never filled.

**States of the row:**

| State | Staged line, right side | Textarea | Commit buttons, amend toggle |
|---|---|---|---|
| Ready | `✨ Draft` | editable | as usual |
| Nothing for the draft to describe — nothing staged in the root with Amend off, including *only submodule files staged* | `✨ Draft`, disabled, accessible name `Draft a message (nothing staged)` | editable | as usual |
| Asking whether to replace | the replace strip below | editable | as usual |
| Drafting | spinner + `Drafting with Claude…` + `Stop` | read-only, dimmed | disabled |
| Failed | `✨ Draft` again; the failure under the row | editable, untouched | as usual |

- **Disabled exactly where Commit is disabled for having nothing to record.** Nothing staged with Amend on is *not* that state: amend is then a message-only change, and redrafting the message of the commit being replaced is a real use. The submodule-only case keeps its existing `… in vendor/sdk are not included` line, which already explains the dead button; the sentence the disabled `Draft` adds is for a screen reader only, by the same test as the commit bar's hints.
- **While drafting, `Draft` becomes `Stop`.** The spinner and the engine's name (`Drafting with Codex…`) take the staged count's place for the duration — the count is not what the user is reading then, and naming the engine says whose time and quota is being spent. `Stop` is the only cancel; it ends the request and puts the row back to Ready with nothing reported, since the user knows why it stopped.
- **The textarea is read-only while drafting**, not merely discouraged: the draft is about to land there, and text typed in the meantime would need a second "replace?" question at the moment the answer arrives. The commit buttons and the amend toggle are disabled for the same reason — the message is about to change, and amend changes what the draft describes.
- **The sheet can be closed while drafting, and closing cancels.** Unlike committing, drafting holds nothing irreversible and nothing the user cannot get back by pressing `Draft` again, so there is no reason to hold the sheet shut; and unlike sync, nothing outlives the sheet, because the draft's only destination is a textarea that is gone. It is still the sheet's existing close: a message written by hand is not kept across closing today, and a draft is not either.
- **The result** replaces the textarea's contents and focus stays where it was — focusing the textarea would raise the on-screen keyboard over the draft the user now wants to read. A polite live region says `Draft inserted`. The textarea grows to fit, as for typed text.

**Replacing what is there.** Pressing `Draft` with text in the box asks first — but only if that text is the user's. Two kinds of text are not: the message Amend prefilled from HEAD, still untouched, and a previous draft, still untouched. Replacing either is what the user is asking for (redrafting is "try again"), and asking would only add a tap. This is the same "untouched" test Amend's toggle already uses to take its prefill back. Turning Amend off takes an untouched draft written with Amend on back the same way: it described HEAD's own changes too, which a plain commit would not record.

The question is an inline strip, not a `ConfirmDialog`: sheets do not stack, and the reason is the one Amend's warning gives — a modal over a sheet reads worse on a phone than a line of text in it. It appears between the staged line and the textarea — right under the button that raised it, with the text it would replace still in view below — in the amend warning's form (`bg-th-bg-tertiary`, `text-xs`):

```
│ 2 files staged                   │
│ ┌──────────────────────────────┐ │
│ │ Replace your message with an │ │
│ │ AI draft?                    │ │
│ │       [ Keep mine ][Replace] │ │
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │ fix: the thing I was typing  │ │
```

`Replace` starts the draft; `Keep mine` takes the strip away. Focus moves to `Replace` when it appears and back to `Draft` when it goes. Escape inside the strip is `Keep mine`, and the strip claims it ([answering-ui.md](answering-ui.md#who-owns-escape)) so the sheet does not close with it. Typing in the textarea while the strip is up leaves it up — what the user is about to lose has only grown.

**Failure** is said under the staged row in `text-th-error` with `role="alert"`, the sheet's existing form, with the CLI's own output in `GitOutput` when there is any. It is a separate block from the commit failure above the message: one per source, each replaced by the next run of its own kind — a commit failure stays on screen while a draft is attempted, and vice versa. The draft's block goes when the next draft starts.

| Kind (from the server) | Shown |
|---|---|
| `timeout` | `Drafting took too long and was stopped.` |
| `auth_failed` / `cli_not_found` — the CLI is not signed in, or not installed | `Could not draft: Claude is not signed in. Sign in under Settings → AI CLIs.` / `… is not installed.` — the CLI named by `getAgentLabel`; no link: following it would close the sheet and take the message with it |
| `nothing_staged` — the index emptied between the press and the run (an agent committed) | `Nothing is staged any more.` — the staged line above updates on its own |
| `empty` — the CLI answered with no message | `The AI returned an empty message. Try again.` |
| `tool_use` — the model called a tool and the server stopped it | `The AI tried to use a tool, so the draft was stopped. Try again.` |
| `failed` — the CLI exited non-zero, a usage limit, anything else — and a request that failed on the way (the connection dropped, a refused parameter) | `Could not draft a message.` + the CLI's output, or what went wrong with the request |
| cancelled | nothing |

### Commit & push

Committing is almost always followed by pushing, and between the two the user has to close one sheet and open another. `Commit & push` does both: it commits, and **only after the commit has succeeded** starts a push.

**Shown** whenever the sync chip is — a remote, and HEAD on a branch (`hasSyncStatus`). With no remote or on a detached HEAD there is nowhere to push to, so the button is absent rather than disabled, and `Commit` alone takes the footer. Its label follows the push it will run:

| Branch | Label |
|---|---|
| Has an upstream | `Commit & push` |
| No upstream, or `upstream_gone` (`needsPublish`) | `Commit & publish` — the push publishes the branch and sets its upstream, as `Publish branch` does |

**Disabled, with the reason on screen**, when the push it promises would not be a plain push:

| State | Why a plain push cannot follow | Where the reason is |
|---|---|---|
| Amend on, and HEAD is already on the upstream (`lastCommit.pushedTo`) | The rewritten commit needs a force push | The amend warning, which gains a clause: `… pushing afterwards needs a force push from Sync.` |
| `behind > 0`, on a branch with an upstream (not `needsPublish`, where the counts mean nothing) | The new commit would diverge from the upstream, and pushing a diverged branch is a force push | A line inside the footer, above the buttons (`text-xs text-th-text-muted`) — not in the body, which scrolls and would carry it off-screen under a long message: `origin/main has 2 commits this branch does not — pull before pushing.` |
| A sync is running in this worktree | The sync store refuses a second run, so the push would never start | The same line: `Waiting for the fetch to finish.` (naming the running operation) |

Force push stays where it is today — the Sync sheet's `Push (force)` behind its `ConfirmDialog`. Offering it here would mean that confirmation stacked on this sheet, for an action this button exists to make *quick*. `behind` is only as fresh as the last fetch; a stale zero lets the press through and the push is then rejected as non-fast-forward, which is reported like any other failed push, below.

**Running.** The press starts the commit exactly as `Commit` does: the pressed button reads `Committing…`, and the sheet cannot be closed — the commit is the part that holds the user's message. When the commit succeeds **the sheet closes and the push is handed to the sync store** (`gitSyncActions.start(worktree, "push", …)` with the Sync sheet's own push action and failure summary — shared, not copied — filed under the worktree the commit was made in), and from there it is an ordinary push started from the Sync sheet and then left: the chip spins, a success waits in the Sync sheet as `Pushed 1 commit.`, and a failure comes back in the top bar's banner — or in the Sync sheet, if the user opens it ([Feedback and errors](#feedback-and-errors)). The commit sheet does not stay open to show `Pushing…`: its job — the message — is done, and the push already has a place that reports it and can be left, so a second, smaller copy of that place here would hold the user for nothing.

- **A failed push keeps the commit.** Nothing is rolled back; the commit is on the branch, the chip now says `↑ Push 1`, and the banner's failure is the same one a push from the Sync sheet would have produced, with the same `Details`.
- **A failed commit pushes nothing.** The sheet stays open with the commit failure, exactly as for `Commit`.
- **The push is plain or publish, never force**, which the disabled states above guarantee before it starts.

### The title length hint

A commit's first line is its title: `git log --oneline`, GitHub and most tools cut it at 72 characters. The sheet counts it — never enforces it.

```
│ ┌──────────────────────────────┐ │
│ │ Move Git into a full-screen /│ │
│ │ git workspace with a sidebar │ │
│ │ overview and three entries   │ │
│ └──────────────────────────────┘ │
│                   Title 81 / 72  │
```

- **Counts the first line only**, in code points (`[...title].length`), so a Chinese or emoji title is not counted double.
- **Absent below 50**, so a short title shows nothing. **Muted (`text-th-text-muted`) from 50 to 72**: the user is close and might want to stop. **Past 72 the count goes up to `text-th-text-secondary` behind a `TriangleAlert` in `text-th-warning`**, still just the count. The hue is on the glyph rather than the text: `text-th-warning` at `text-xs` is far under AA 4.5 in the light themes, while a glyph owes only the 3:1 non-text floor — the same split the sidebar's question count makes.
- Right-aligned under the textarea, `text-xs`, `tabular-nums` so it does not jitter. It is tied to the textarea by `aria-describedby` only past 72, so a screen reader hears it once it matters rather than on every keystroke.
- **Never disables a commit button.** A long title is a convention broken, not a commit git refuses, and the user may have reasons.

### Amend

Amend is not a commit-bar label. It belongs to the last commit, and the last commit is already on screen: HEAD's row in the History segment. Every row there carries a trailing L5 `⋯` that opens the commit's menu, and on HEAD that menu has `Amend this commit` ([git-history-ui.md](git-history-ui.md#the-commit-menu)), which opens the same commit sheet with **Amend** pre-toggled — the same warning copy, the same force-push consequence line described above.

```
   Add branch bar to git panel          ⋯   ← HEAD: the menu has Amend
   9692fc9 sijiaoh, 2h ago
   Render every codex_changes event     ⋯
   1c4b8e0 sijiaoh, 5h ago
```

HEAD is the commit carrying the `HEAD` ref, not the first row: in `All branches` another branch's newer commits come above it ([git-history-ui.md](git-history-ui.md#the-commit-menu)). That includes a detached HEAD, where amending is still legal. An unborn HEAD has no rows, which is the correct answer for "there is nothing to amend".

This costs zero permanent pixels, it is where a desktop client such as GitHub Desktop puts it, and it puts the message about to be replaced directly under the control that replaces it. The previous arrangement did the opposite: the old panel's loudest control wore its sharpest and rarest action, and it stood in exactly the state — a clean tree — where the user had come to read history.

Every entry point — the commit bar, the review's `Commit n files` and amend — goes through `GitCommitSheet.tsx`, which is where `stagedCount`, `submodules`, `lastCommit` and the commit mutation are assembled; `CommitSheet` itself takes them as props and already understood `amendInitially`.

### History

History is a segment of its own, the commit graph over the chosen range (`HistorySection` around `HistoryList`), with no collapse and no default to decide. Its commit graph, range, search and file filter, and a commit's detail and `⋯` menu are [git-history-ui.md](git-history-ui.md)'s. It used to be a collapsible `HISTORY` group under the file lists, collapsed while there were changes and expanded on a clean tree, with the user's toggle remembered in `lib/gitPanelStore.ts` — all of that was a way of sharing one narrow column between two lists. With a segment each, there is nothing to share, and the store went with it.

A failing `git.log` is said in the list's place (`Failed to load history` and the reason); the collapsed group used to swallow that error. A refetch that fails keeps the log already on screen. An unborn HEAD reads `No commits yet`.

### Viewing a file from a commit

A commit's diff is one file at two versions, so `CommitDiffView` — the layer a file in `CommitView`'s list opens, one file as one commit changed it — offers both, at opposite ends of the screen and with no overlap in what they mean:

| Entry | Where | Opens |
|-------|-------|-------|
| The title | The app header, as in `DiffView` | `{ type: "file" }` — the **working tree** file, editable |
| `View this file at <hash>` | Bottom bar, a `FileClock` icon | `{ type: "commit-file" }` — that commit's version, read-only |

The title keeps the meaning it already has one screen over in `DiffView`, so there is no second rule to learn; only its accessible name changes, to `Open current <file>`, since "open" alone is ambiguous where two versions exist. Nothing special happens when the working-tree file is gone or renamed — the viewer says "File not found", which is the truth.

**A commit that deletes a file has no version of it to show.** The blob lives in the parent, and `git.show.file` on this hash returns not-found ([git.md](git.md#historical-file-contents)). The button is therefore disabled for `status: "D"`, with the reason in its accessible name — `... (deleted in this commit)` — the same rule the Edit button follows. Showing `hash^` instead was rejected: a merge commit has more than one parent, so "the version before" is not always a single thing, and the deletion diff already carries the whole old content.

`CommitFileView` is read-only in three ways that do not repeat each other: the title is plain text rather than a button, one banner names both the version and the constraint (`Read-only — this file as of <hash> · <subject>`), and **the bottom bar carries no write action at all**. A greyed-out Edit would read as a bug or a permission problem; editing history is not a thing that exists. Download is not a write, so it stays, as on the binary and too-large cards — streamed from a raw capability for the commit's file, since the working tree is not where that version lives ([file.md](file.md#downloading)). The same rule reaches inside the body: `FileBody` takes `readOnly`, which drops the `Editing is disabled for …` footnote from the binary and too-large cards. That footnote explains `FileView`'s disabled Edit button; with no such button on screen it would point at a control that is not there, and imply that a file which happened not to be binary could be edited here.

The body is `getFileViewState` + `FileBody` — empty, image, binary and too-large are rendered by the same code as for a current file, the subtraction above aside, which is the point of `git.show.file` returning the `file.get` shape. The one addition is a plain-text toggle in the bottom bar: it drops Markdown to its source so `CodeHighlighter`'s copy button can take the whole file, which rendered Markdown offers no way to do. It stays off by default and is **not** reset when the file changes.

An HTML page renders here as in the Files tab ([file.md](file.md#html-pages)), from the commit's own files, so it shows as it stood in that commit; with nothing to watch it never reloads by itself. For a page — of any size — the same toggle and the same state switch between the page and its source (`Code` icon, "Show source" / "Show page"): it means the same thing, dropping the rendering to source.

The toggle appears only where pressing it could change something — a highlighted `text` body, or a page. An image, a binary and an empty file have no rendering to drop to source, and a file past `HIGHLIGHT_LIMIT` is already plain with a banner saying so; in all of those the control is **absent rather than inert**, by the same rule that keeps a disabled Edit off this screen. The bottom bar itself stays regardless, because the hash on it is identity, not an action. One consequence: an SVG's source, which `FileView` reaches through Edit, has no route here — a read-only screen has no Edit to borrow.

`useCommitFile` neither watches the filesystem nor expires (`staleTime: Infinity`): what a commit holds is immutable. It does not retry a request its own clock gave up on either — a blob is as large as a working-tree file, and `useContents` skips that retry for the same reason ([code/websocket-rpc.md](code/websocket-rpc.md#request-timeout)).

### Submodules

Submodule files are listed with the rest, their path prefixed and `· Submodule` on their second line, and `git.add` stages them in the *submodule's* index. A root-repo `git commit` would silently leave those files staged and uncommitted, which is exactly the silent failure the project forbids.

So: **commit operates on the root repository only.** `Commit n files` counts root-repo staged files, and when submodule entries are staged the sheet says so plainly — `2 staged files in vendor/sdk are not included`. The rejected alternative is committing in each submodule and then the root: that is several commits from one tap, sharing one message, with no rollback if the third fails. Discard, by contrast, does apply to submodule paths, and must resolve into the submodule directory the way `Add` and `Reset` already do.

## Discard

Two entry points, neither a one-tap icon on a row:

- **Per file** — `Discard changes` (`Delete file` for an untracked one), last in the row's `⋯` action sheet behind a divider ([git-changes-ui.md](git-changes-ui.md#the-files-action-sheet-)), and only while the file has unstaged changes: a staged-only file is unstaged first, which its checkbox does.
- **All unstaged** — `Discard unchecked…`, the left button of the list's bottom bar, over every file with unstaged changes: what is not checked is not wanted. It is not there when nothing is unstaged ([git-changes-ui.md](git-changes-ui.md#the-bottom-bar)).

Both always go through `ConfirmDialog` with `variant="danger"`, and the wording differs by what is actually lost, because these are two operations with two different blast radii. `ConfirmDialog`'s `message` is a plain string, so the copy stays prose — no code formatting, no markup:

| Target | Title | Message | Confirm |
|--------|-------|---------|---------|
| Tracked file (`M` / `D` / `R`) | Discard changes? | Your edits to src/foo.ts will be lost. This cannot be undone. | Discard |
| Tracked file with a staged side too (partly staged) | Discard unstaged changes? | Your unstaged edits to src/foo.ts will be lost. Its staged changes are kept. This cannot be undone. | Discard |
| Untracked file (`?`) | Delete file? | notes.txt is not tracked by git and will be permanently deleted. This cannot be undone. | Delete |
| Several files, mixed (unchecked) | Discard unchecked changes? | The unchecked edits in 3 files will be lost and 1 untracked file will be deleted. Checked changes are kept. This cannot be undone. | Discard |
| Several files, tracked only (unchecked) | Discard unchecked changes? | The unchecked edits in 2 files will be lost. Checked changes are kept. This cannot be undone. | Discard |
| Several files, untracked only (unchecked) | Delete unchecked files? | 2 untracked files will be permanently deleted. Checked changes are kept. This cannot be undone. | Delete |

The confirm button is labelled with the verb of the outcome rather than the default `Confirm`: it is the last thing read before something irreversible happens, and "Delete" against a title asking about deletion is the one word that has to be unambiguous.

Every entry point discards a file's unstaged side only — restore comes from the index ([git.md](git.md#discard)) — so a partly staged file keeps its staged side, and its copy says so rather than "your edits", which would claim more than is lost. The action sheet, the review's `Discard file` and a batch of one all pick that variant the same way: the file has a staged side in the current status. Several files only ever come from `Discard unchecked…`, so their copy says "unchecked", never "all", and "Checked changes are kept" covers a partly checked file among them without singling it out.

A batch of one — which `Discard unchecked…` produces whenever a single file is unstaged — takes the single-file wording, partly staged variant included, because naming the file beats counting it. The classification behind all of this belongs to the server: the list on screen is as old as its last refresh, and the request carries paths only (see [git.md](git.md#discard)).

"This cannot be undone" is literal here: discarded worktree changes are not in the reflog, unlike nearly every other git mistake. That is why discard is the one file-level action in the workspace behind a modal.

If a discarded file's review is open, the workspace moves it on to the next file on success, or to the Changes list when nothing follows ([git-changes-ui.md](git-changes-ui.md#when-the-list-changes-under-the-review)) — **replacing** the review in history rather than pushing, as every move in the review does, and leaving for the list the way the review itself does. Only while that review is still the page: the discard answers after the press, and a reader who has moved to another page meanwhile — including the same path in another worktree — must not have it replaced under them. So `ChangesSection` reports every discarded path with the worktree it ran in and the file that follows it, and `AppShell`'s `handleCloseGitFile(path, worktree, next)` checks the route at the moment the answer lands, not the one the discard was confirmed on (the reader may have opened one of the discarded files since).

## Branch

The **Branches segment** (`BranchesSection` around `BranchList`), reached from the segmented control, the top bar's branch name or the sidebar's `Branches` entry. A row opens its branch's detail (`BranchDetail`), never switches; switching is `Switch to this branch`, first in the row's `⋯` and in the detail. Which branches it lists, in which groups and order, what each row says (state, ahead/behind against the default branch, age), the branch's detail, and what the `⋯` and the detail offer — switching, deleting a local branch, asking the agent to merge one into the current branch — are [git-branches-ui.md](git-branches-ui.md)'s; the rules below — the pinned area, what a switch does, creating — are this section's.

- Long names truncate at the head, not the tail, so `…/git-ui` keeps the part that tells branches apart.
- The filter input appears once there are more than eight branches. It filters the list and nothing else; it never creates a branch.
- **The filter and any failure — a switch's, a delete's, the merge handoff's — are pinned above the rows**, in one `sticky top-0` container at the top of the scrolling body. A list long enough to scroll is a list where filtering is the fast path, and a filter that scrolls away is one the user has to scroll back up to reach. The failure is pinned for a sharper reason: the user's real path is to scroll halfway down and switch from a row's `⋯`, so a message rendered at the top of the scroll area lands off-screen and the press reads as having done nothing — a silent failure. A narrow branch detail pins the same box at its own top ([git-branches-ui.md](git-branches-ui.md#the-pinned-area)). Git's verbatim output under it goes through `GitOutput` like everywhere else — when there is any, which a worktree-busy refusal has none of ([Feedback and errors](#feedback-and-errors)) — and it matters more here than anywhere: `would be overwritten by checkout` names every file in the way, and an unbounded refusal would pin more of the page than the list it is pinned over. The failure carries a `✕`: in the sheet this list used to live in, closing the sheet was how it was put away, and a page has no sheet to close. Several failures at once, each with up to `max-h-32` of git's words, would push the list off a 568px-tall phone, so the failures (not the filter, which stays where the thumb expects it) share one box capped at `max-h-[40dvh]` that scrolls on its own; none is dropped to make room.
- Switching to a remote-only branch creates a local tracking branch of the same name and checks it out; its detail says so before the press.
- **Uncommitted changes are neither stashed nor discarded.** The switch is attempted as-is, which git allows whenever no modified file differs between the two branches — the common case. When git refuses, the failure shows the refusal with the offending paths plus one line of guidance: *Commit or discard these changes first.*
- **While a switch runs**, the row of the branch being switched to shows a spinner in place of its `⋯`, and every `Switch to this branch` and `New branch…` are unavailable. Rows stay openable: reading a branch writes nothing. A switch that succeeds stays where it was pressed — the list or the detail: the check moves to the new branch, the detail's facts turn to `current`, and the top bar's name changes, which is the whole report of it — no message of its own, on the rule sync's success follows.
- **A switch can be walked away from** — the segmented control, the top bar and Back all leave the page while it runs, which the sheet this replaced never allowed. Coming back mid-switch still shows the spinner and still refuses a second switch, and a failure that settled while the user was elsewhere is waiting for them ([Results that outlive the page](#results-that-outlive-the-page)).
- `New branch…` is fixed under the list and opens a small sheet with a single name field. The base is fixed to current HEAD and stated as text (`Branches from feature/git-ui`) rather than offered as a third input: this is not the place to build a branch-from-arbitrary-ref picker, and `WorktreeCreateSheet` already covers that case. Uncommitted changes carry over to the new branch, which is standard git behaviour and worth one line of helper text. It stays a sheet — it holds typed input, and cannot be closed while creating — and on success it closes onto the segment with the new branch current.
- A failing `git.branches` is said in the list's place; with branches already cached the list keeps showing them.

**The branch sheet used to be unusable with many branches, and the cause was in `Sheet`, not in the list.** The content box capped its height in its drawer form (`max-h-[90dvh]`) and not in its modal form (`mx-4 max-w-md rounded-xl`). Centred inside a `fixed inset-0` container, it spilled off the top and the bottom at once as soon as the list made it taller than the viewport, and nothing scrolled: the body is `min-h-0 flex-1 overflow-y-auto`, but `flex-1` of an uncapped column is the content's own height, so there was never any overflow to scroll — the `New branch…` footer went off-screen with the rest. The modal form now caps at `max-h-[85dvh]` too. That is a fix in `Sheet`, so every one of its users stops being able to reach that state — the three sheets in this document plus `Worktree/WorktreeCreateSheet`. The branch list has since left the sheet for a page of its own.

## Remote sync

The **Sync sheet**, opened from the chip:

```
┌──────────────────────────────────┐
│ ═══                              │
│ Sync                          ✕  │
├──────────────────────────────────┤
│ origin/feature/git-ui            │
│ 2 commits to pull · 1 to push    │
│ Last fetched 4m ago              │
│                                  │
│ [ ⟳   Fetch                    ] │
│ [ ↓   Pull (2)                 ] │
│ [ ↑   Push (1)                 ] │
└──────────────────────────────────┘
```

Full-width buttons, each `min-h-[44px]`. The counts are restated in words above them because `↓2 ↑1` is a chip abbreviation, not an explanation.

**Which buttons appear follows the branch's state** — `operationOrder(needsPublish, upstream_gone)` in `SyncSheet.tsx` returns the list, and a separate record holds what each button renders, so the ordering rule has one representation:

| State | Buttons, in order |
|-------|-------------------|
| Upstream exists | `Fetch`, `Pull`, `Push (n)` / `Push (force)` |
| No upstream | `Publish branch`, `Fetch` |
| `upstream_gone` | `Fetch`, `Publish branch` |

`Pull` is **removed** from the two publish states rather than disabled. A branch with no upstream has nothing to pull *from*: pull there is not unavailable, it is not applicable, and a greyed-out control teaches the user nothing about which of the two it is. `upstream_gone` leads with `Fetch` because a pruned or never-fetched remote-tracking ref is more often repaired than recreated.

- `Last fetched` is when *this* workspace last fetched, never the repository as a whole (see [git.md](git.md#remote-sync)); before its first fetch the line reads `Never fetched`.
- **Fetch** never touches the working tree, so it is always enabled and never confirmed, and it is the repair action for a stale chip — including for the `Upstream missing here` state above.
- **Pull is enabled whenever an upstream exists**, not when the workspace believes there is something to pull:

  ```
  canPull = sync.has_remote && !needsPublish
  ```

  The earlier rule, `!needsPublish && sync.behind > 0`, gated on a counter only as fresh as the last fetch — and at the time nothing fetched on its own, since `git.Fetch` is reachable only from the `git.fetch` RPC. `behind` was therefore 0 on a freshly opened workspace and stayed 0, disabling the button at exactly the moment someone reached for it. The [automatic fetch](#automatic-fetch) narrows that gap without closing it — counts can still be ten minutes old, or older after a fetch that failed — so the rule stands. It was also gating on the wrong thing: the backend's `git pull --ff-only` fetches first (`server/git/remote.go` says so, and measures the count afterwards for that reason), so pull is most useful precisely when the stale counter says there is nothing to pull. `behind` now shapes only the label — `Pull (2)` when positive, `Pull` when not. A pull with nothing to bring in ends in `Already up to date.`, which is a truthful answer and a cheap one.

  `has_remote &&` is logically redundant here: the server's `syncInfo` returns before it ever looks up an upstream when the repository has no remote (`server/git/remote.go`), so `upstream != "" ⟹ has_remote`. It is kept because this is a wire boundary, and because `canPush` beside it has the same shape — a second spelling of the same condition would be the thing worth avoiding.
- **Pull is fast-forward only.** A merge started by one tap on a phone can strand the user in a conflicted worktree, where the workspace offers only an abort or a handoff to the agent ([git-conflict-ui.md](git-conflict-ui.md)) — it starts no merge itself. When `--ff-only` fails because the branches diverged, the sheet reports that plainly and points at the escape hatch that does exist on a phone: asking the agent in chat to merge or rebase, which is the product's whole premise.
- **Push** is a plain push. With no upstream the button reads `Publish branch` and sets upstream on success.
- **Force push exists only as a consequence of amend.** When the local branch has diverged such that a normal push cannot succeed, the Push button becomes `Push (force)` in `text-th-error` and requires a `ConfirmDialog` (`variant="danger"`): *Overwrites origin/feature/git-ui with your local history. Commits pushed by others will be lost.* The push itself uses `--force-with-lease`, so a race with someone else's push fails loudly instead of destroying their work. No unconditional `--force` anywhere in the UI.
- These are the only operations in the workspace that wait on a machine other than this one. While one runs, its button shows a spinner and the gerund (`Pushing…`) and the others are disabled — but **the sheet can still be closed.** Holding a sheet shut is a way of saying "this is over in a moment", and it only tells the truth where the wait is bounded; these three are network round trips whose only ceiling is the backend's five-minute `networkTimeout` ([git.md](git.md#remote-sync)), so holding this one shut would be a promise the workspace cannot keep.

  **Closing is leaving, not cancelling.** The operation keeps running, the chip carries its progress, a failure comes back under the top bar, and reopening the sheet shows *that same run* — the running button still spinning, or the outcome it ended in — rather than a blank sheet offering to start it again. That works because the run, its result and the guard against a second one all live in `lib/gitSyncStore.ts` rather than in the sheet; the sheet is a renderer of state it does not own. Nothing here cancels git: a cancelled push is not a push that did not happen, and the workspace does not offer an action it cannot honestly undo.

  **Leaving leaves the rest of the workspace usable, and mostly it really is usable.** Staging, discarding and committing while a fetch or a push runs all go through — not because nothing arbitrates them, but because the server's arbitration is split by what git commands actually contend for, and staging conflicts with a fetch in no way at all ([git.md](git.md#serialising-writes)). Nothing in the UI holds them back either: the sheet no longer covers the workspace, and the sync store's guard stops only a *second sync*.

  What a running fetch or push does hold up is the writes that move the same refs it does: **pull, switching branch and creating one**. A running *pull* holds up everything, because it is the one sync that fast-forwards the working tree as well. Either way the second write waits briefly and, since the sync is usually still going, is refused before it starts. The refusal is not a race lost to `index.lock` — the second command never ran — so what comes back is a sentence naming what to wait for rather than git's words about a lock file: *This worktree is busy fetching. Try again once it finishes.* ([Feedback and errors](#feedback-and-errors))

  The sheet *is* held while the force-push confirmation is up: `Sheet` and `ConfirmDialog` both listen for Escape on `document`, so a single key press would otherwise close the dialog and the sheet behind it. And it stays open after success long enough to show the outcome (`Pushed 1 commit.`): a sheet that closes on its own leaves the user unsure whether anything happened over a slow relay link.

Branch and sync both read the root repository. Submodules keep their own HEAD and upstream, and the workspace does not expose them.

## Feedback and errors

The project has no toast system — `WorktreeSwitcher` still carries a `TODO` about it — and the workspace does not introduce one. The rule instead is **feedback appears where the action started** — and where the starting place can be left mid-action, the workspace itself carries what the action leaves behind:

| Action | Started from | Its failure is shown |
|---|---|---|
| Stage, unstage, discard (checkboxes, the list header, the action sheets, the bottom bar's `Discard unchecked…`) | Changes segment | The Changes segment's banner — including a failure that settled while the user was elsewhere |
| Stage, unstage, discard from the review | The review (`diff`) layer | `DiffView`'s own banner; one that answers after the reader left the file, the Changes list's banner |
| Commit, amend | Commit sheet | In the sheet |
| Draft with AI | Commit sheet | In the sheet, under the staged line, apart from a commit failure; nowhere once the sheet is closed, since closing cancels it ([Drafting](#drafting-the-message-with-ai)) |
| Commit & push | Commit sheet | The commit: in the sheet. The push: as a push from the Sync sheet that was then closed ([Commit & push](#commit--push)) |
| Switch branch | A row's `⋯` sheet, or a branch's detail | A branch-failure surface on screen — the Branches list at any width, a branch's detail below `expanded` — pins it. Anywhere else in the workspace: a top-bar banner ([git-branches-ui.md](git-branches-ui.md#the-pinned-area)) |
| Create branch | New-branch sheet | In the sheet |
| Read what deleting a branch would lose | A row's `⋯` sheet, or a branch's detail | In the sheet; in the detail, above its actions |
| Delete branch | The delete confirm | The confirm closes. Then as a switch's ([git-branches-ui.md](git-branches-ui.md#flow)) |
| Ask AI to merge into current branch (the new chat's create) | A row's `⋯` sheet, or a branch's detail | The sheet closes. Then as a switch's ([git-branches-ui.md](git-branches-ui.md#asking-the-agent-to-merge)) |
| Fetch, pull, push | Sync sheet | Sheet open: in the sheet. Sheet closed: a top-bar banner |
| Automatic fetch | Nobody — the workspace, on the way in | The chip's `⚠`, the sidebar overview's line, and the reason in the sheet ([Automatic fetch](#automatic-fetch)) |

- **Actions started in a sheet the user cannot leave** (commit, create) render their error inside that sheet, in the `text-th-error` + `role="alert"` form `WorktreeCreateSheet` already uses. The sheet stays open and the user's typed input survives.
- **Fetch, pull and push** are started in a sheet that *can* be closed while they run ([Remote sync](#remote-sync)), so one outcome is rendered in whichever place is on screen. Sheet open: the same in-sheet `role="alert"` block as above, unchanged. Sheet closed: an **error banner** under the top bar, below. There is one outcome either way, not two copies of it — opening the sheet moves the message into it and takes the banner away, closing it brings the banner back, and there is no "already seen" state in between. A success is not banner material at all: its signal is the chip's spinner stopping and the counts refreshing, and it waits in the sheet as `Already up to date.` or `Pushed 2 commits.` for whoever reopens it.
- **Actions started inline from a row** — stage, unstage, discard, discard all — have no sheet to hold the result, so they use that same dismissible **error banner**: one line of plain-language summary, git's stderr behind a `Details` disclosure in a mono block, and a `✕`. It covers stage and unstage rather than discard alone, and not for symmetry: a failed stage used to reach nothing on screen at all — no surface rendered the mutation's error and the panel's own handler let the rejection escape — which is precisely the silent failure the project forbids. The banner clears on dismissal, or when a later attempt succeeds on one of the paths that failed. An unrelated file succeeding is not a retry: dropping the message then would leave the file that failed sitting in the list with nothing on screen explaining why.
- **A banner holds at most one failure *per source***, each with its own `✕`: under the top bar, from `BranchBar`, the sync banner, the branch-switch banner, the branch-delete banner and the merge handoff's banner — at most four, never merged — and in the Changes segment, between the segmented control and the list, the inline row actions' banner from `ChangesSection`. Several sources can be unacknowledged at once and all are real; collapsing them to "the most recent failure" would silently drop one. Within a source there is only ever one: a new run replaces the outcome of the last. `DiffView` carries a banner of its own for its bottom bar's writes, which are on a layer where the list may not be on screen. A write that answers after the reader left the file — Back to the list, or another file of the review (each path is its own `DiffView`, so nothing about one is shown on the next) — does not navigate, and a failure then goes to the Changes list's banner through the store rather than to nobody; a success clears that banner for its path, as a retry from the list would.
- **A refused request has no `Details`, because git never ran.** The server refuses a write while another one it would collide with holds the worktree — which pairs those are is the server's to decide and is decided narrowly, a fetch never standing in the way of staging a file ([git.md](git.md#serialising-writes)). That refusal is a fact about the workspace's own traffic rather than anything git said — quoting the server's English sentence back under a summary of itself would be the workspace talking to itself. The same holds for `-32002`, a request that reached a project which has just stopped being a repository. So `utils/gitErrors.ts` is the one place the two kinds of failure are told apart, by error code and never by matching the sentence, and every surface renders the outcome: a summary always, git's words only when there are any. The sentence names the operation to wait for in the workspace's own vocabulary (`switching branches`, not `checkout`), and falls back to "another git operation" for an operation name it does not know, so a write added on the server is still explained rather than mis-explained. A branch switch or delete embeds the sentence in its own — `Could not switch to <branch>. This worktree is busy pushing.`, `Could not delete <branch>. …` — because the branch list is taller than the screen and the row that was pressed is usually scrolled away, or the user has left the page altogether, while the refusal by itself cannot say which branch it was.
- **The workspace queues its own fast writes rather than leaning on that refusal.** Stage, unstage and discard run one at a time per worktree through `lib/gitWriteStore.ts`: tapping two files' checkboxes in a row is two `git.add` requests, each checkbox goes busy only *itself* while its own request is in flight, and react-query does not serialise mutations — so without the queue the commonest interaction in the workspace would be answered with *This worktree is busy staging files*, an error the user did nothing to earn. They **queue** rather than being dropped, unlike the sync store's guard: the second tap names a different file, so it is a second thing the user asked for and not a duplicate of the first. Requests are not merged into one batch either, though the server would take it: merging means either a debounce, which makes a single tap slower for nothing, or bookkeeping that re-derives which row's spinner and which banner a combined failure belongs to. Only the fast writes are queued — commit runs hooks and the three sync operations wait on another machine, so queueing behind one of those is the hang the server's bounded wait exists to prevent, and each of them is behind a single control that cannot be double-tapped into a collision.

  **A queued write is dropped if the user leaves the worktree before its turn.** A `git.*` request names no worktree: the server answers it against whichever one the connection is bound to, and `worktree.switch` rebinds it. Sending each write immediately used to make that safe by itself, since one connection is answered in order — a queue is what gives a switch room to land in between, so the queue is what has to check, at the moment the request would go out. Nothing is shown when one is dropped: nothing was written, so there is nothing to report. The uploads queue cancels for the same reason, and does say so, because its queue stays on screen per worktree.
- **The sync banner yields to the sheet only when the sheet is really on screen**, not when it is merely the selected one: without branch data there is no sheet to render, and a banner suppressed by a sheet that is not there is a silent failure. For the same reason it is not gated on the chip either — a run that ends after HEAD went detached, or after `git.branches` started failing, has lost the chip that was carrying its progress, and losing progress is acceptable where losing a failure is not. Nor does leaving the workspace lose it: the outcome is stored state rather than a notification, so it is still under the top bar when the user comes back, which is exactly what a toast would not have managed.

### Results that outlive the page

The Git panel was always mounted — the sidebar hid its inactive tabs with a class — and a branch switch ran inside a sheet that could not be closed until it finished. Two guarantees came free with that, and neither survives becoming a page that can be left at any moment. So both are stated, and kept by moving the result out of the component and into a store keyed by worktree:

- **The inline-action banner outlives the segment and the workspace.** A stage, unstage or discard failure lives in `gitWriteStore`'s `failures`, not in `ChangesSection`: switching to History and back, or going back to the chat and returning, still shows an unacknowledged failure, and one that settled while the user was away is there when they return. Without that, "stage, then switch segment at once" would put a failure nowhere. The clearing rule is unchanged: `✕`, or a later success on one of the paths that failed. It is filed under the worktree the write was sent to, so switching worktree hides it and switching back shows it again — an earlier version of the panel dropped it on a switch instead.
- **A branch switch outlives the page that started it.** Its progress and its failure live in `gitCheckoutStore`, on the same terms as a sync's: one switch per worktree, a new switch clears the last failure, success leaves nothing. A failure is shown in exactly one place — pinned on a branch-failure surface while one is on screen (the Branches list at any width, a branch's detail below `expanded`), a top-bar banner anywhere else in the workspace (the top bar is where "which branch am I on" is answered) — and moves between them as the user does; all read the same record, and `BranchBar`'s `branchFailureSurface`, worked out by `GitWorkspace` from the layer and the width, decides which one draws it ([git-branches-ui.md](git-branches-ui.md#the-pinned-area)) — except that a surface with no branches to draw (the read failed with nothing cached) cannot pin it, and the banner keeps the failure then. It clears on `✕`, on the next switch starting, or on success. The reason this is not optional is what happens without it: a switch that fails while the user is elsewhere, a user who believes it worked, and an agent then set to work on the wrong branch — a costlier silent failure than any stage.
- **A branch delete outlives the segment the same way.** Its confirm closes when the user navigates away while the request keeps running, so its run and failure sit in `gitCheckoutStore` beside the switch's, with fields of their own: one delete per worktree, shown by the same `branchFailureSurface` rule, cleared on `✕`, on the next delete starting, or on success.
- **A merge handoff outlives the segment, not the workspace.** Its hook is `GitWorkspace`'s rather than the segment's, so a new session still being created keeps the list held, and its failure is shown by the same `branchFailureSurface` rule. It is not in a store: leaving the workspace is leaving for somewhere the prefill handoff already accounts for ([agent-handoff-ui.md §1.4](agent-handoff-ui.md#14-no-current-session)), as `Resolve with agent`'s is.
- **All of these but the merge handoff's (a session-create failure, not a git one), like sync's outcomes and an abort's failure (`gitOperationStore`, [git-conflict-ui.md](git-conflict-ui.md#abort)), are dropped when the project starts or stops being a repository** ([below](#when-the-answer-changes)).

Verbatim git output is capped and scrollable wherever it appears, by going through one component — `Git/GitOutput.tsx`, `max-h-32 overflow-auto`. A rejected push runs to a dozen lines of `hint:`, and inside a height-capped sheet those lines come out of the very buttons the message is telling the user to press. The cap belongs to the output rather than to each of the four places that show it — written out four times, no two of the four fully agreed.

Both surfaces show git's own output *under* the summary rather than in place of it, matching the project's split between user errors (guidance) and system errors (technical detail) — the reader is a developer who needs to see `hook declined to update refs/heads/main`.

In-flight rules, uniform across the workspace: the triggering control shows a spinner and a gerund label, controls whose outcome the running operation would change are disabled, and nothing is fired optimistically. A mutation then refreshes immediately rather than waiting out `GitWatcher`'s 3-second poll, invalidating what it can actually have changed: staging and unstaging touch only the status query, while commit, discard, checkout, create, abort and the three sync operations move HEAD or the counts and so invalidate status, log and branches together. Deleting a branch moves no HEAD and invalidates branches alone.

**Refusing to close the surface is not one of those uniform rules.** It applies only to bounded operations, which is why the sync sheet no longer does it ([Remote sync](#remote-sync)). The commit and new-branch sheets still do — and for commit that is not because committing is always quick, since a `pre-commit` hook can take as long as it likes. It is because those two hold typed input: closing them would have to answer "is what I wrote still there", and a commit message is the one thing in the workspace the user cannot get back. The sync sheet holds no input and only has to answer "where did the result go" — which the chip and the banner answer. A branch switch used to be held shut by the sheet it ran in, though it holds no input either; as a page it cannot hold anyone, so it answers that same question the way sync does ([above](#results-that-outlive-the-page)). Inside the commit sheet the same test splits two runs: a commit holds the sheet shut, an AI draft does not — the draft has no result anyone else waits for, closing simply cancels it, and pressing `Draft` again gets it back ([Drafting](#drafting-the-message-with-ai)).

Discard is the one that refreshes whether it succeeded or not. It is several git invocations behind a single tap, and a batch that failed part-way has still deleted files; refreshing only on success would leave those rows on screen until the next poll.

## The sidebar's Git tab

The Git tab (`Git/GitTab.tsx`) is the workspace's doorplate, the same shape as the Project tab: a read-only overview — the branch name and one line of sync state drawn from the chip's own `describeSyncStatus` — and three entries, `Changes`, `History` and `Branches`, each landing on its segment's list. Nothing in it writes. Its shape and rules are [sidebar-ui.md](sidebar-ui.md#the-git-tab)'s; what it shares with the workspace is the sync description above and the count below.

## The change count on the tab

The Git tab's icon carries a badge with the number of files holding uncommitted
changes, so the workspace does not have to be on screen for the user to know
there is something here to look at. It counts the list's rows — one per path, submodules
included, so a partially staged file, which is both a staged and an unstaged
entry of `git.status`, is one changed file.

| State | Badge |
|-------|-------|
| One or more changed files | the count, capped at `99+` — past that the exact figure decides nothing |
| Nothing changed | **no badge**, never a `0` |
| No status yet — the first read has not answered, or it failed | **no badge** — a badge is not an error channel. A status the workspace cannot read is reported by the Changes segment itself, in place of its file lists |

A *later* refresh that fails is not in the table: react-query keeps the answer
it already has, so the last known count stays on the icon rather than blinking
out. Stale is the right of the two: the number is behind, but "some files
changed" is still closer to the truth than "nothing changed".

The badge is `aria-hidden` and the number reaches a screen reader through the
tab button's own label instead (`Git, 5 changed files`) — and the tab's `Changes` entry
reads the same number, in the same words (`describeChangeCount`) — through the same
truncation the eye gets — `formatBadgeCount` is exported from `ui/BadgeCount`
rather than the `99+` rule being written twice. There is deliberately **no
`aria-live`**: while an agent is editing files the count moves every few
seconds, and announcing each step would turn a screen reader into a counter.
Shape and colour live in `ui/BadgeCount`: the same `th-accent` fill and the same
corner of the same icon box as the plain `ui/BadgeDot` on the Sessions and
Files tabs, so the two read as one family
([sidebar-ui.md](sidebar-ui.md#visual-weight)). Named rather than said as
"the other tabs": the Project tab's badge is the one exception, and it is
`th-warning` ([lifecycle-ui.md §4](lifecycle-ui.md#4-attention-dots)).

The badge rides in the sidebar's tab bar, so it is visible exactly when that bar
is: a closed drawer or a collapsed column takes the whole bar with it. The
header button that brings the sidebar back does wear a dot for the other tabs'
badges, but not for this one
([responsive-ui.md](responsive-ui.md#at-expanded-the-column-collapses)) — a
count of changed files is the state of the repository, not something that
happened. A change indicator outside the sidebar would be a different feature.

### Who subscribes to `git.changed`

`SessionSidebar` holds the single `useGitWatch` — the count is the reason.
Scoping the subscription to the Git tab being *active* is what the panel used
to do, and it cannot feed a badge that exists to be read from the other tabs:
`useGitStatus` never refetches on its own, so the number would be whatever it
was when the user last left the tab. Subscribing unconditionally is no answer
either, because a closed drawer and a collapsed column are hidden with a class
rather than unmounted — the server's 3-second poll would then run for a whole
session in which the sidebar was never on screen.

So it runs while somebody can read the answer, and stops otherwise:

```typescript
enabled: isGitRepo && (
  (!SidebarContent && isOpen) ||
  activeGitSegment !== null ||
  reviewRowCanShow
)
```

- `isGitRepo` — **there is a repository to watch**, confirmed by the server;
  unknown counts as no ([below](#projects-without-a-repository)).
- `isOpen` — **the tab bar is on screen**: an open drawer below `expanded`, a
  column that is not collapsed at and above it. A closed drawer or a collapsed
  column is what this excludes, and it is the whole reason a condition is
  needed at all — both are `hidden`, not gone. The term used to be
  `isExpanded || isOpen`, from when the column could not be collapsed; the tier
  says which sidebar there is, not whether it is visible
  ([responsive-ui.md](responsive-ui.md#at-expanded-the-column-collapses)).
- `!SidebarContent` — an extension supplying its own sidebar replaces the tab
  bar outright, so there is no badge or overview to feed. It qualifies
  `isOpen` alone.
- `activeGitSegment !== null` — **the workspace is on screen**, at any layer
  (`gitSegmentOf` of the route, which `AppShell` passes down). It renders in
  the main area rather than the sidebar, and on a phone an entry closes the
  drawer behind it; without this term the lists, and the diff's previous/next,
  would freeze exactly while they were being used. It stands outside the
  `!SidebarContent` term on purpose: a custom sidebar takes away the badge, not
  the workspace.
- `reviewRowCanShow` — **the chat's review row may show**: the strip's
  `N changed files · Review` reads the same count, on a phone with the drawer
  closed. `ChatPanel` owns the gate and reports it up through `AppShell`; it is
  only true while no turn is open, so a turn ending resubscribes and refetches
  at the moment the row may appear. Outside `!SidebarContent` like the
  workspace's term
  ([agent-handoff-ui.md §2.4](agent-handoff-ui.md#24-keeping-the-count-live)).

Re-enabling resubscribes, and `useGitWatch` refreshes on `onSubscribed`, so
opening the drawer, expanding the column or entering the workspace shows a
current answer rather than a stale one for a frame.

## Data behind the workspace

None of these queries runs on a refetch interval; `git.changed` is what drives them all together, and the subscription it arrives on belongs to the sidebar rather than to the workspace ([above](#who-subscribes-to-gitchanged)). `git.status` backs the file lists, `git.log` the history (paged; [git-history-ui.md](git-history-ui.md#paging-and-states)), `git.show` an open commit — re-read too, since the refs on it move — and `git.branches` answers with HEAD (branch or detached hash, plus the message amend prefills), the local branches annotated with the worktree occupying each and their upstream, the remote-only branches — each with its last commit's time and committer and its standing against the default branch — the branches recently checked out here, and the sync state — one answer, so the branch name and the chip beside it — and the sidebar's overview — can never disagree about which branch they describe.

Beyond the components named above, the workspace's own supporting modules are:

| Module | Role |
|--------|------|
| `lib/gitChanges.ts` | The one record per changed path (`collectChanges`), the checkbox rules, the line sums, and the **one ordering** the list and the review share — `orderChanges`, `compareChangePaths` and `adjacentChange`, which finds the next file by position rather than index ([git-changes-ui.md](git-changes-ui.md#review-order)) |
| `lib/gitChangesViewStore.ts` | Flat or tree (remembered per browser) and which tree folders are collapsed (per worktree, in memory) — a store rather than the list's state because the review reads the view for its order, and collapse state outlives the list unmounting on a segment switch |
| `ui/iconButtonClass.ts` | The L5 icon button's classes, used by the Changes list's checkboxes and `⋯`, the History rows' `⋯`, `BranchList` and `ErrorBanner` here, by the file tree row's `…` in the Files panel, and by chat's message actions — the `…` beside every user bubble, which is the one caller that asks for the overlay instead of a grown box, and the icon row under every agent message ([session-fork-ui.md](session-fork-ui.md)). It used to live under `Git/` while the tree wrote its own copy, because the two rungs disagreed on height — 36 against 44 — and parameterising that would have meant sharing everything about the rung except the part that made it a rung. The disagreement turned out to be one rung measured two ways: 36 of visual weight, 44 of hit area on a coarse pointer ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)). With both stated here, there is one definition and it belongs to no single surface |
| `Git/GitOutput.tsx` | The capped, scrollable block holding git's own words, shared by the error banner, the pinned branch failures, and the commit and sync sheets. Every one of them renders it conditionally: a refused write has no git output to hold ([above](#feedback-and-errors)) |
| `Git/GitCommitSheet.tsx` | The connecting layer between the commit sheet and the workspace's queries, shared by the commit bar, the review's bottom bar and the commit menu's amend |
| `Git/CommitActions.tsx` | A commit's `⋯` menu and the sheets it leads to — amend, `Create branch here…`, the revert handoff — mounted by the History segment and a branch's commits (each through `useCommitMenu`) and by the commit's page for as long as each is on screen, so the handoff's failure outlives the menu that started it ([git-history-ui.md](git-history-ui.md#the-commit-menu)) |
| `Git/BranchList.tsx` | The branch rows and their filter, with the pinned area the failures are drawn in |
| `Git/BranchActions.tsx` | What a branch offers, for both surfaces that offer it: `useBranchActions` (switch, merge handoff, delete and its confirm, over `useBranchCheckout`, the handle on `gitCheckoutStore`), `BranchActionRows` (the three `MenuRow`s with their reasons, in the `⋯` sheet and inline in the detail) and `PinnedBranchFailures` (the capped box the list and a narrow detail pin) |
| `Git/BranchDetail.tsx`, `Git/BranchCommits.tsx` | The `branch` layer: the branch's facts and actions, and its commits not on the default branch in the page's one scroll area — [git-branches-ui.md](git-branches-ui.md#the-branch) |
| `lib/gitBranches.ts`, `Git/BranchMenu.tsx`, `hooks/useBranchMergeHandoff.ts` | The branch list's groups, row text, the detail's lines and the actions' reasons (pure functions), the row's `⋯` sheet, and the merge handoff the workspace holds so it outlives the segment — [git-branches-ui.md](git-branches-ui.md) |
| `ui/SegmentedControl.tsx` | The segmented control, shared with the Stories screen; it holds no state, since the segment is in the URL |
| `lib/gitSyncStore.ts` | Which fetch/pull/push is in flight in each worktree, whether it is the automatic fetch (`auto`), and how the last one ended, so a run outlives the sheet that started it. Keyed by worktree because switching worktrees mid-run is reachable, and one record would show A's outcome under B or let A's run disable B's buttons |
| `lib/gitCheckoutStore.ts` | Which branch switch and which branch delete are in flight in each worktree and how the last of each failed, so either outlives the page that started it ([Results that outlive the page](#results-that-outlive-the-page)). A store of its own rather than a part of `gitWriteStore`, whose queue is for quick local writes ([frontend-state.md](code/frontend-state.md#why-a-run-in-flight-is-a-store)) |
| `lib/gitWriteStore.ts` | One serial queue per worktree for stage, unstage — of files or of hunks — and discard, plus the paths (and hunks) each has pending and the Changes list's unacknowledged failure, so two taps in a row cannot overlap and a write — and how it failed — outlives the view that started it. Keyed by worktree for `gitSyncStore`'s reason |
| `utils/gitSyncStatus.ts` | `describeSyncStatus`, the one reading of the sync state the chip and the sidebar's overview both draw, and `shouldAutoFetch` with its ten-minute threshold |
| `hooks/useGitSync.ts` | `useGitSyncRunner`, the way into the three sync operations and the automatic fetch, and `useAutoFetch`, which decides whether to run it |
| `hooks/useGitWrites.ts` | `useGitWriteRunner`, the single way into those three writes — the file list and the open diff both go through it, which is what makes one queue cover them together |
| `lib/diffHunks.ts` | A diff's `@@` hunks read by their headers' counts — range, function context, lines, and the row each layout draws last, where the review hangs the [hunk bar](git-changes-ui.md#staging-a-hunk). The i-th hunk here is the one `hunk_ids[i]` names |
| `lib/diffRows.ts` | The review's rows in unified order, gap lines included, and everything a [line selection](git-changes-ui.md#handing-lines-to-the-agent) is: how a press moves it, its label, what `Copy` and `Ask AI to edit…` produce, and whether a refreshed diff still holds it — pure functions |
| `ui/lineGutter.ts` | The diff library's line-number cells read as the selection control, and the marks `index.css` draws a selection from; the library redraws its rows on its own, so the marks are laid again after each redraw |
| `utils/gitErrors.ts` | The one place "git never ran" and "git ran and failed" are told apart, and the sentence a refusal is shown as (a stale hunk, `-32005`, is recognised here by `isHunkStale`, but its sentence names the side on screen and is the review's own: [git-changes-ui.md](git-changes-ui.md#in-flight-and-after)) — pure functions, so the wording and the code-not-prose rule are testable without a screen around them |
| `lib/gitOperation.ts`, `lib/gitOperationStore.ts`, `Git/OperationBanner.tsx`, `Git/ConflictView.tsx` | What the workspace shows and stops while the repository is in the middle of a merge, rebase, cherry-pick or revert — [git-conflict-ui.md](git-conflict-ui.md#where-it-lives) |
| `utils/gitSyncMessages.ts` | Every sentence the three sync operations produce, and the patterns that tell git's rejections apart — pure functions, so the wording is testable without a sheet around it |

The writes are `git.add` and `git.reset`, which the panel had from the start, plus `git.hunk.stage`, `git.hunk.unstage`, `git.discard`, `git.commit`, `git.checkout`, `git.branch.create`, `git.branch.delete`, `git.fetch`, `git.pull`, `git.push` and `git.abort`. A failure that git produced comes back as git's own words — stderr for most of them, stdout as well for commit, which is where git puts `nothing to commit` — and that text is what both surfaces above show under their summary; a write refused before it started has no such text ([above](#feedback-and-errors)). Shapes, and the server-side reasoning behind them, are in [git.md](git.md).

## Projects without a repository

A project need not be a git repository, and many Pockode users are not engineers: to them the workspace, the switcher and every git affordance are noise. So outside a repository **they are not there** — not disabled, not explained, and with no "initialize git" prompt. Someone who wants git asks the AI to run `git init`, and the UI follows by itself. A greyed-out button only raises the question of why it cannot be pressed.

The answer comes from one place, `worktreeStore.isGitRepo`, which only the server's replies write ([frontend-state.md](code/frontend-state.md#store-patterns)). It is three-valued, and **unknown hides like no**: until the first `worktree.list` or `worktree.subscribe` reply, nothing that exists only for git is drawn. A git user sees the Git tab arrive a few hundred milliseconds late; a user without git never sees it flash in and out.

| Surface | Outside a repository |
|---|---|
| Worktree switcher (sidebar header) | Plain text: the project's name (`projectTitle`), falling back to `Pockode`. No dropdown, so creating and deleting worktrees go with it. While the answer is unknown it stays the skeleton |
| Git tab, its count badge, `git.changed` | Not in the tab list, and with it every entry into the workspace; the other tabs keep their order. The sidebar's `useGitWatch` is not enabled ([above](#who-subscribes-to-gitchanged)). `useGitStatus`, `useGitLog` and `useGitBranches` gate themselves rather than trusting whoever mounts them, because the count badge reads `git.status` with no Git tab mounted |
| The Git workspace, every layer (`git`, `diff`, `branch`, `commit`, `commit-diff`, `commit-file` — `isGitOverlay`) | Reached by URL or history, `AppShell` replaces the route with the current session, or the worktree's home. `ChatPanel` holds the workspace back, blank, while the answer is unknown, so it never sends reads that can only fail |
| Worktree badge on work rows | Main's badge hidden, and a leftover feature name drawn as gone ([work-system.md](code/work-system.md#displaying-a-works-worktree)) |
| Settings → Worktree | Hidden with its heading and its nav entry, through the section's `visibility`; the saved values are left alone |
| Files search `.gitignore` chip | Hidden ([file.md](file.md#search-ui)) |
| File page `History of this file` | Hidden; it leads into the workspace ([git-history-ui.md](git-history-ui.md#entering-them)) |
| `/pockode-lead` | Left out of the palette, refused if typed ([pockode-commands.md](pockode-commands.md#when-the-server-refuses)) |

The session filter's worktree dimension is not in the table: it reads which worktrees hold sessions on disk, not git, so a project that stopped being a repository still lists its old worktrees there — as deleted, which is what they now are.

### When the answer changes

`worktree.changed` carries the new answer within about 3 seconds of `git init` or of `.git` being deleted, and the caches that depended on the old answer are dropped ([frontend-state.md](code/frontend-state.md#store-patterns)).

**Becoming a repository adds and never moves.** The Git tab appears in its place, the header becomes the switcher, the settings section and main's badge come back — and nothing takes focus: no switch to the Git tab, no toast. The tab and view the user was on stay on screen. Before the first commit the workspace still has to work; the server's side of that is in [git.md](git.md#before-the-first-commit).

**Ceasing to be one removes, and moves only whoever was standing on what went away.**

- On the Git tab: `TabbedSidebar` falls back to its `defaultTab` whenever the active tab is no longer in its list. That is a general rule of the component rather than a git case, and it is kept in state, not only in what is drawn, so the tab does not reopen itself when it comes back.
- In the Git workspace, at any layer: the route guard above replaces it. There is deliberately no "no longer a repository" page — every git view already leaves, and the Git tab disappearing beside it is the explanation; a page of its own would be a second rule.
- On the settings page: the section and its nav entry disappear and the page stays where it is.
- In a non-main worktree: its URL now names a worktree the list does not have, so the existing redirect to main handles it. The git-view guard stands aside in that case, so the two do not both navigate at once.
- A git write in flight refused with `-32002`: the surface that started it, if still there, reports it as a refusal — *This project is no longer a git repository.*, no `Details` ([Feedback and errors](#feedback-and-errors)) — and nothing more is said once that surface is gone; the UI changing is already the explanation. A fetch/pull/push outcome is stored rather than rendered, so `gitSyncStore` drops its outcomes whenever the answer changes — the automatic fetch's failure mark with them — and `gitCheckoutStore`, `gitWriteStore` and `gitOperationStore` drop their failures on the same signal: one refused after `.git` went would otherwise reappear as a banner after a later `git init`. What is still running is left alone; its settling lifts the guard.

## Out of scope

Deliberately excluded, to keep the workspace at "the everyday operations, done well": conflict resolution (what the workspace shows while the repository is stopped mid-merge, -rebase, -cherry-pick or -revert, and its two ways out, is [git-conflict-ui.md](git-conflict-ui.md)), interactive rebase, cherry-pick, running a revert or a merge itself (a commit's `Ask AI to revert` and a branch's `Ask AI to merge into current branch` hand them to the agent — [git-history-ui.md](git-history-ui.md#ask-ai-to-revert), [git-branches-ui.md](git-branches-ui.md#asking-the-agent-to-merge)), tags, stash, remote branch deletion, remote management, submodule commit/branch/sync, and a global toast system.

Left for later rather than excluded: keyboard navigation. The list column is resizable ([Layout](#layout)). Per-hunk staging and handing selected lines to the agent are built, in the review ([staging a hunk](git-changes-ui.md#staging-a-hunk), [handing lines to the agent](git-changes-ui.md#handing-lines-to-the-agent)).

---

**Why this file lives here.** `docs/` holds per-feature design documents (`file.md`, `agent-chat.md`, `git.md`); `docs/code/` is reserved for explaining why the code of a *core module* is built the way it is (WebSocket, Agent, Work, Subscription, Relay), and `docs/projects/` for the project-management system. A UI design for a feature is none of those, so it sits beside `git.md` as `git-ui.md` — `git.md` keeps describing the git backend and links here for the surface built on top of it. What the Git tab and the Files panel have to agree on, rather than what either one looks like, is one level up in [sidebar-ui.md](sidebar-ui.md).
