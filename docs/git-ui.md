# Git Workspace UI

How the Git workspace (`web/src/components/Git/`, entry `GitWorkspace`) presents the four everyday operations — commit, discard, branch, remote sync — and how the sidebar's Git tab (`GitTab`) leads into it. Backend architecture is in [git.md](git.md); this document covers entry points, navigation, layout, interaction flow, feedback and confirmation policy. The layouts and copy below are what the workspace does — where the implementation departed from the original design, this file records the implementation.

The rules the workspace's rows share with the sidebar's Files panel — the visual weight ladder its `L1`–`L5` references point at, what `th-accent` is allowed to mean, and the narrow-width rule every fixed row below obeys — are in [sidebar-ui.md](sidebar-ui.md), which also owns the Git tab's shape.

## Goals and constraints

- **The workspace is a place; the sidebar is its doorplate.** Git used to be a panel inside the tabbed sidebar — a 288px drawer on a phone, a 240–500px column on desktop — and every layout was drawn at 288px. It is now a page of the main content area, `/git`, with the sidebar's Git tab reduced to a read-only overview and three entries into it ([The sidebar's Git tab](#the-sidebars-git-tab)). Everything that writes appears once, in the workspace; nothing in the sidebar writes.
- **Still narrow where it matters.** Below `expanded` (1024) the workspace has a phone's width to itself; at and above it, its list column is `clamp(280px, 35%, 400px)` ([Layout](#layout)). Every fixed row still obeys the narrow-width rule, which is about containers, not about the sidebar ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)).
- **One-handed and touch-first.** Full-width rows are `min-h-[44px]`; icon-only buttons inside a row are `min-h-[36px] min-w-[36px]` (L5), defined once in `ui/iconButtonClass.ts` so stage, unstage, discard, amend and dismiss cannot drift apart in weight. 36 is the visual rung; a coarse pointer grows the box to 44 ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)).
- **One level of grouping.** `Staged` / `Changes` are the Changes segment's only hierarchy; nothing wraps them in a second section that also has a header. The segments themselves are a filter over the page, not a level of it.
- **Reuse the existing vocabulary.** `th-*` tokens, `ConfirmDialog` and `Sheet` from `@pockode/shared`, `BottomActionBar`, `SidebarListItem`, `PageHeader`, the segmented control the Stories screen already had (`ui/SegmentedControl.tsx`, extracted so both pages draw one), and lucide icons.
- **Nothing stashes implicitly.** Pockode runs in worktrees that share one stash stack with the main checkout and every other worktree, so a stash the user did not ask for can be popped by a different session. No operation here creates one — a switch that git refuses is reported, not worked around.

## Routes, segments and Back

The workspace is three segments, each a list, and the existing diff and commit pages become layers under two of them:

| Screen | URL (under the usual `/w/<worktree>` prefix, with `session`) | Segment |
|---|---|---|
| Changes list | `/git` | `changes` — the absence of the parameter: never written as `segment=changes`, though accepted if typed |
| History list | `/git?segment=history` | `history` |
| Branches list | `/git?segment=branches` | `branches` |
| A file's diff | the `diff` route (staged or unstaged) | `changes` |
| A commit | the `commit` route | `history` |
| A file as a commit changed it | the `commit-diff` route | `history` |
| A file as of a commit | the `commit-file` route | `history` |

**A layer does not carry its segment.** A diff can only have come from Changes and a commit only from History, so the layer's type decides its parent — `gitSegmentOf(overlay)` in `types/overlay.ts`, which is also what `isGitOverlay` is built on. This is unlike the Stories detail, which carries the segment it was opened from because either segment can open it ([project-ui.md §5](project-ui.md#5-where-the-segment-lives)). There is no second set of URLs for the wide layout either: the same URL is one layer on a phone and two columns on a desktop, so resizing never invalidates where the user is.

Navigation is `AppShell`'s, on the Stories screen's model:

| Action | Result | History |
|---|---|---|
| A segment in the segmented control | That segment's list, at the top. At `expanded`, a detail open in the right column is dropped — it belonged to the other segment | push, so Back walks the segments |
| The branch name in the top bar | The Branches list | push |
| A file or a commit in a list | Its layer | push, at every width, so Back stays right across a resize |
| A press that names the layer already on screen — the bare list of the segment it is on | nothing | no entry |
| The lit segment while a detail is open beside it | The bare list, detail dropped | push |
| The app header's `←` on a list, or at `expanded` on anything | Back to the chat the workspace was opened over (`session`), or the worktree's home | as every page over the chat |
| The app header's `←` on a narrow layer | The **parent**: diff → Changes (`Back to changes`), commit → History (`Back to history`), commit-diff → commit, commit-file → commit-diff | navigates *to* the parent URL rather than `history.back()`, so a deep-linked diff still has a list to go back to |
| A sidebar entry | That segment's list — never a detail it remembers | push |

`handleSelectGitSegment` serves the segment control, the branch name, the back of the narrow diff and commit layers, and the sidebar's entries, so all of them land on a list the same way.

**Switching worktree inside the workspace stays inside it**, at the same segment's list: every worktree has one, where the path or hash of the detail on screen may not exist over there (`useWorktree.select` reads the current route). Each worktree's own failures stay with it ([Results that outlive the page](#results-that-outlive-the-page)), and the automatic fetch decides again for the new worktree ([Automatic fetch](#automatic-fetch)).

**There is no composer anywhere in the workspace.** The chat input is hidden on every layer — `git`, `diff`, `commit`, `commit-diff`, `commit-file` are in `ChatPanel`'s `inputBarHiddenOverlays`, beside the Stories pages. The workspace's bottom edge belongs to Git's own primary actions — the commit bar, the diff's previous/next and stage bar, `New branch…` — and a composer under them would be a third stacked bar on a phone, all of them competing for the thumb. Viewing a diff or a commit — and a commit's file layers — used to keep the composer under it; those are the places this is a change. To talk to the agent the user goes back, which the app header's `←` always offers; and the way Git hands work to the agent is planned to bring the user back to the session's input with a prefilled message, rather than to grow a second input here.

## The top bar

One row, `min-h-[44px]`, directly under the app header, on **every** layer — the narrow diff and commit layers included. That is not decoration: a sync left running when its sheet was closed reports through the sync chip and nowhere else, and a layer without the bar would lose both that progress and the automatic fetch's failure mark. It is split into two independent targets so it stays a single line (`Git/BranchBar.tsx`):

| Region | Content | Tap |
|--------|---------|-----|
| Left (`flex-1`, truncate from the head) | `GitBranch` icon + branch name | Opens the **Branches** segment (`Branches, currently on <name>`) — not a sheet |
| Right (chip button, never truncated) | Sync state | Opens the **Sync sheet** |

Detached, the left region reads `detached @ 9692fc9` and still leads to Branches. The bar shows whatever branch data it has, even while a refetch is failing: react-query keeps the last value alongside the error, and swapping a known branch name for a message would take the bar down for exactly the reason it renders outside the lists' error branches. While loading it is a skeleton; only with nothing cached at all does it read `Branch unavailable`, with the query's error message in the title attribute, and then it is not pressable (the Branches segment says why it cannot read the list). The placeholder is `Git/HeadPlaceholder.tsx`, shared with the sidebar's overview.

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

The sidebar header shows a `GitBranch` icon with the worktree name, and the top bar and the sidebar's overview show a branch name. They are kept apart by what they name: the header switches *workspace* and is labelled by worktree name (`review`), the top bar names *the branch within this workspace* and always renders the real ref name. A branch already checked out in another worktree cannot be checked out here — git refuses — so the Branches list marks those rows disabled with an `in <worktree>` hint instead of letting the user find out through an error. Linked worktrees are named as the switcher names them; the main checkout reads `in main worktree`, because the switcher labels *it* by branch and "branch X is held by branch X" says nothing (see [git.md](git.md#branches)).

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
│ STAGED 2                     ⊖   │  L3, sticky   ┐
│  M  GitTab.tsx               ⊖   │               │
│  A  BranchBar.tsx            ⊖   │               │
│                                  │               ├ scroll area
│ CHANGES 3                 ↶  ⊕   │  L3, sticky   │
│  M  git.md                ↶  ⊕   │               │
│  ?  notes.txt             ↶  ⊕   │               ┘
├──────────────────────────────────┤
│ [          Commit (2)          ] │  commit bar — Changes only, when committable
└──────────────────────────────────┘
```

Each segment's root is a flex column whose scroll area is a plain `min-h-0 flex-1 overflow-y-auto` box, with the fixed rows as its siblings rather than content inside it. The top bar, the banners above the list, the segmented control and the commit bar therefore stay reachable however far the list has scrolled, and they render outside the list's `isLoading` / `error` branch: a failing `git.status` must not take the branch name, or the other segments, down with it. The segmented control is the Stories screen's — full width, outside the scroll area, no counts ([project-ui.md §2.1](project-ui.md#21-the-segmented-control)); each segment opens at the top.

**A detail layer** (here a diff):

```
┌──────────────────────────────────┐
│ ←  git.md · Unstaged             │  app header — the layer's own title; ← to its list
├──────────────────────────────────┤
│ ⑂ feature/git-ui      ↓ Pull 2   │  top bar, as on every layer
├──────────────────────────────────┤
│ (DiffView, with its own banner)  │
├──────────────────────────────────┤
│ ⟨ prev  next ⟩        [ Stage ]  │  DiffView's own bottom bar
└──────────────────────────────────┘
```

A layer has **no segmented control** — the segments filter the lists, and a layer belongs to exactly one — and **no commit bar**, since the layer has a bottom bar of its own and two stacked bottom bars are not acceptable. The list stays mounted under the layer rather than unmounted, so Back returns the reader to where they were in it. It is covered the way the transcript is under an overlay — `invisible absolute inset-0`, `inert`, inside a `CoveredSurface` so a sheet it raised closes — and not with the `hidden` attribute: `display: none` destroys the very scroll box it is kept for ([answering-ui.md](answering-ui.md)).

### At `expanded`: two columns

```
┌──────────────────────────────────────────────────────────────────┐
│ ←  Git                                                           │  app header — always "Git"
├──────────────────────────────────────────────────────────────────┤
│ ⑂ feature/git-ui                                     ↓ Pull 2    │  top bar, across both columns
├──────────────────────────────────────────────────────────────────┤
│ ⚠ Push failed · Details                                       ✕  │  top-bar banners, across both
├────────────────────────┬─────────────────────────────────────────┤
│ [Changes] History Bra… │ git.md · Unstaged                       │  column heading (L2)
├────────────────────────┼─────────────────────────────────────────┤
│ STAGED 2           ⊖   │                                         │
│▌M  git.md          ⊖   │   (the diff)                            │
│ CHANGES 3       ↶  ⊕   │                                         │
├────────────────────────┼─────────────────────────────────────────┤
│ [   Commit (2)       ] │ ⟨ prev  next ⟩              [ Unstage ] │  each column's own bottom bar
└────────────────────────┴─────────────────────────────────────────┘
```

- **Two columns follow the tier** (`useIsExpanded`), not the main area's measured width, as everywhere else in the app. At 1024 with a 288px sidebar the main area is about 736px; a user who drags the sidebar to 500 has made that trade themselves ([responsive-ui.md](responsive-ui.md#the-width-ladder)).
- The left column is `clamp(280px, 35%, 400px)` and holds everything the narrow list layer holds — segmented control, banner, list, commit bar. It is not resizable.
- **The app header names the workspace**, `Git`, and its `←` leaves the workspace: one header cannot name two layers. Each layer names itself in a **column heading** at the top of the right column — the layer's `PageHeader`, drawn inline as a bar of its own by `InlinePageHeaders` rather than portalled into the app header. It is a switch rather than a wrapper that comes and goes, so a resize across 1024 moves the heading without remounting the page under it.
- **Diff and commit have no `←` in their heading**: their parent is the left column, already on screen (`PageHeader`'s `back` is optional for exactly this). Commit-diff and commit-file keep theirs, back to the layer above (commit-file → commit-diff → commit), and the History list keeps the commit lit throughout.
- The selected row in the left column wears the usual active treatment.
- **With nothing chosen**, the right column says so in one muted, centred line rather than standing blank, so it cannot be taken for a column still loading (`EmptyDetail`):

  | Segment | Left column | Right column |
  |---|---|---|
  | Changes | has changes | `Select a file to see its diff` |
  | Changes | clean | `No changes to review` |
  | History | has commits | `Select a commit to see what it changed` |
  | History | unborn HEAD | `No commits yet` |
  | either | loading, or its read failed | blank — the left column is already saying it |

- **Branches has no right column.** A branch has no detail layer, and a column that could only ever stay empty would promise one. The segmented control keeps its place and its width all the same — a control that moves once pressed sends the next press somewhere else — and the branch list starts at the left column's edge and widens to `max-w-xl`, left-aligned rather than centred. A later story that gives branches a detail can make this two columns too.

**Why Git splits into two columns when the Stories screen does not.** [project-ui.md §7](project-ui.md#7-deliberately-not-done) rejects a master-detail split there: a story's detail is read one at a time, and a list, a detail and a sidebar would share the space of one chat. A diff is read in a run — file after file, then a commit — and walking back and forth between a list and a full-screen diff is exactly the cost this layout removes. The same reasoning, with the opposite answer, because the reading is different.

### Group headers

`Staged` / `Changes` are L3 (`GroupHeader.tsx`): `text-xs uppercase tracking-wide text-th-text-muted`, no hover fill, count appended to the label rather than parenthesised. The top bar stays L2 and, with a layer's column heading at `expanded`, is the only header-weight row below the app header — the earlier `▾ Changes` section header, which wrapped two groups that already carried headers and counts, is gone along with its collapse state and its count.

**The headers are 36px, not the 32px the ladder names.** The container is `min-h-[32px]`, but a group with actions contains 36px L5 buttons and flex grows the row to fit them. Shrinking the row would mean shrinking the touch targets, and the touch target is the one of the two that a thumb can miss. On a coarse pointer the container is `min-h-11` and the whole header goes to 44 — grown behind the pointer gate, so the rung is untouched for a mouse ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)).

Each group header is `sticky top-0` inside its own `flex flex-col` box, so it pins only over the list it labels and gives way as the next group arrives. That is the need the deleted collapse toggle was actually serving — collapsing `Changes` was how you scrolled past a long list to reach what was under it.

`Unstaged` is renamed **`Changes`**, matching VS Code's source-control naming — with the parent header gone there is nothing left for it to be confused with. The group actions are icon-only (`Plus` / `Minus`, the same icons the per-row stage buttons use) rather than the previous `Stage All` / `Unstage All` text, so their labels moved into `aria-label`: `Stage all files` / `Unstage all files`, derived from `staged`, and a constant `Discard all changes`. The discard label used to be built from the group title, which the rename would have turned into `Discard all changes changes`.

**A clean tree shows one muted `No changes` row** in place of both groups. It is a line of explanation instead of a blank band, so "clean" and "not loaded yet" cannot be confused.

## Commit

The bottom bar holds at most one primary button (L1), and renders only while committing is on the table. `describeCommitAction` returns `null` for the two states that have no button:

| Working tree | Bar |
|--------------|-----|
| n files staged in the root | `Commit (n)` — enabled |
| changes, nothing staged anywhere | `Commit` — disabled, `Stage a file to commit` as an `sr-only` hint |
| staged only inside a submodule | `Commit` — disabled, with a **visible** line saying why |
| clean | **no bar** |
| `git.status` unreadable | **no bar** — the Changes segment is already showing why |

Keeping the disabled button in the second case is deliberate: the user is on their way to committing, and a target that pops into existence as they stage the first file is worse than one that is visibly not ready yet.

Keeping it in the clean case is not: there is nothing to commit and nothing on its way to being committed, and 56px of permanently dead accent-coloured button is the loudest thing on a screen that has nothing to say. The bar no longer falls back to `Amend last commit` either — see [Amend](#amend).

**Whether a hint is `sr-only` follows one test: does the screen already show the reason?** `Stage a file to commit` names the stage buttons sitting right above the bar, so a line of text would repeat on screen what the screen already says — worth saying to a screen reader, not worth 20px. The submodule case fails that test, and gets a visible line.

That case exists because the two counts behind the bar are deliberately different. The **enabled count is the root repository's** staged files, since that is what `git.commit` records ([Submodules](#submodules)). Whether the bar renders at all follows the **flattened** counts, since those are what the file groups above it show — one function, `flattenGitStatus`, shared with `ChangesSection`, so the bar and the groups cannot disagree about whether there is anything on screen. They diverge in exactly one state: files staged inside a submodule. There the rows read as staged like any other and nothing else on screen accounts for a dead button, so the bar spends a line on `Only submodule files are staged; ask the agent in chat to commit them.` — the same referral the sync sheet makes for a diverged branch. The alternative, letting the bar vanish out from under a list of staged rows, is a silent failure.

The hint renders **above** the button, on the same rule the sheets follow: the bar already sits at the bottom edge, so a line under the button is the first thing an on-screen keyboard covers.

Tapping opens the **Commit sheet** rather than editing inline. A permanently mounted message box would cost ~80px of a list that is what the segment is for, on a phone that has none to spare once the on-screen keyboard is up, for an action taken a few times an hour; a sheet gives the textarea real room, lets the on-screen keyboard push it up, and costs one extra tap.

**The bar comes and goes; the sheet does not.** `CommitBar` renders the two as siblings rather than nesting the sheet inside the bar. Nesting them means a background refresh that finds the tree clean — an agent in chat committing or reverting while the user is typing — unmounts the sheet and throws away the half-written message with it.

```
┌──────────────────────────────────┐
│ ═══                              │
│ Commit                        ✕  │
├──────────────────────────────────┤
│ 2 files staged                   │
│ ┌──────────────────────────────┐ │
│ │ Add branch bar to git panel  │ │
│ │                              │ │
│ └──────────────────────────────┘ │
│ ☐ Amend last commit              │
├──────────────────────────────────┤
│ [ Cancel ]       [    Commit   ] │
└──────────────────────────────────┘
```

- The message textarea autofocuses and starts at ~3 rows, growing to a cap. An empty message keeps Commit disabled — no `-m ""`, no auto-generated placeholder.
- With nothing staged the first line says what is left to do: `Nothing staged — only the message changes` while Amend is on, `Nothing staged — stage a file, or amend the last commit` when it is off and there is a commit to amend, plain `Nothing staged` when there is not. Commit is disabled in the second and third cases — git would refuse them, and a button that says so beats a round trip that always ends in `nothing to commit`.
- **Amend** replaces the previous commit, so the toggle reveals what is about to be replaced instead of asking a modal question the user has no way to answer:

  ```
  ☑ Amend last commit
  ⚠ Replaces "Show what the permission mode does…"
    This commit is already on origin/main —
    pushing afterwards needs a force push.
  ```

  Turning it on prefills the message from HEAD, but only when the user has not typed anything, so toggling never eats input. The second warning line appears only when HEAD is contained in the upstream, and names that upstream rather than assuming it is `origin`. No `ConfirmDialog` here: the toggle is already a deliberate act with its consequence spelled out on screen, and a modal stacked on a sheet reads worse on a phone than the warning it would deliver.
- While committing, the Commit button becomes a spinner plus `Committing…`, Cancel and backdrop dismissal are disabled, and on success the sheet closes. On failure it stays open with the error inline (see [Feedback and errors](#feedback-and-errors)) — hooks, `commit-msg` rules and a missing `user.email` all fail here, and the user needs the raw message to act on any of them. The missing identity is the one failure with a summary of its own above git's text: git's advice is to run `git config`, which is exactly what this user cannot do, so the summary points at the agent in chat instead.

### Amend

Amend is not a commit-bar label. It belongs to the last commit, and the last commit is already on screen: the first row of the History segment is HEAD. That row carries a trailing L5 `⋯` (`Amend this commit`) which opens the same commit sheet with **Amend** pre-toggled — the same warning copy, the same force-push consequence line described above.

```
   Add branch bar to git panel          ⋯   ← HEAD only
   9692fc9 sijiaoh, 2h ago
   Render every codex_changes event
   1c4b8e0 sijiaoh, 5h ago
```

Only the first row carries it. `git.Log` runs `git log -nN` from HEAD in reverse-chronological order (`server/git/git.go`), so `commits[0]` *is* HEAD whenever the list is non-empty — including on a detached HEAD, where amending is still legal. An unborn HEAD has no rows, which is the correct answer for "there is nothing to amend".

This costs zero permanent pixels, it is where a desktop client such as GitHub Desktop puts it, and it puts the message about to be replaced directly under the control that replaces it. The previous arrangement did the opposite: the old panel's loudest control wore its sharpest and rarest action, and it stood in exactly the state — a clean tree — where the user had come to read history.

Both entry points go through `GitCommitSheet.tsx`, which is where `stagedCount`, `submodules`, `lastCommit` and the commit mutation are assembled; `CommitSheet` itself takes them as props and already understood `amendInitially`.

### History

History is a segment of its own, the commit log from HEAD down (`HistorySection` around `LogList`), with no collapse and no default to decide. It used to be a collapsible `HISTORY` group under the file lists, collapsed while there were changes and expanded on a clean tree, with the user's toggle remembered in `lib/gitPanelStore.ts` — all of that was a way of sharing one narrow column between two lists. With a segment each, there is nothing to share, and the store went with it.

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

`flattenGitStatus` merges submodule files into the same Staged / Unstaged lists with their path prefixed, and `git.add` stages them in the *submodule's* index. A root-repo `git commit` would silently leave those files staged and uncommitted, which is exactly the silent failure the project forbids.

So: **commit operates on the root repository only.** `Commit (n)` counts root-repo staged files, and when submodule entries are staged the sheet says so plainly — `2 staged files in vendor/sdk are not included`. The rejected alternative is committing in each submodule and then the root: that is several commits from one tap, sharing one message, with no rollback if the third fails. Discard, by contrast, does apply to submodule paths, and must resolve into the submodule directory the way `Add` and `Reset` already do.

## Discard

Two entry points, both hanging off things that already exist:

- **Per file** — unstaged rows gain a second action button, `Undo2`, placed *left* of the existing stage button. The frequent, benign action keeps the rightmost (most thumb-reachable) slot; the destructive one sits inboard. Staged-only rows get no discard button: unstage first, which is what the `⊖` beside it already does.
- **All unstaged** — an `Undo2` icon button in the `CHANGES n` group header, separated by a gap from the stage-all button so the two are not flush neighbours. The `STAGED n` header has no discard-all: its rows have no per-file discard either, for the same reason — unstage first.

Both always go through `ConfirmDialog` with `variant="danger"`, and the wording differs by what is actually lost, because these are two operations with two different blast radii. `ConfirmDialog`'s `message` is a plain string, so the copy stays prose — no code formatting, no markup:

| Target | Title | Message | Confirm |
|--------|-------|---------|---------|
| Tracked file (`M` / `D` / `R`) | Discard changes? | Your edits to src/foo.ts will be lost. This cannot be undone. | Discard |
| Untracked file (`?`) | Delete file? | notes.txt is not tracked by git and will be permanently deleted. This cannot be undone. | Delete |
| Mixed selection (all) | Discard all changes? | 3 files will lose their edits and 1 untracked file will be deleted. This cannot be undone. | Discard |
| Tracked only (all) | Discard all changes? | 2 files will lose their edits. This cannot be undone. | Discard |
| Untracked only (all) | Delete all files? | 2 untracked files will be permanently deleted. This cannot be undone. | Delete |

The confirm button is labelled with the verb of the outcome rather than the default `Confirm`: it is the last thing read before something irreversible happens, and "Delete" against a title asking about deletion is the one word that has to be unambiguous.

A batch of one — which the group header produces whenever a single file is unstaged — takes the single-file wording, because naming the file beats counting it. The classification behind all of this belongs to the server: the list on screen is as old as its last refresh, and the request carries paths only (see [git.md](git.md#discard)).

"This cannot be undone" is literal here: discarded worktree changes are not in the reflog, unlike nearly every other git mistake. That is why discard is the one file-level action in the workspace behind a modal.

If the unstaged diff of a discarded file is open, the workspace leaves it on success — otherwise the diff view sits on a file that no longer has a diff. It goes to the Changes list, **replacing** the diff in history rather than pushing, because Back must not lead to a diff that no longer exists: below `expanded` that is the list layer, at `expanded` the right column's empty state. Only while that diff is still the page: the discard answers after the press, and a reader who has moved to another page meanwhile — including the same path in another worktree — must not have it replaced under them. So `ChangesSection` reports every discarded path with the worktree it ran in, and `AppShell`'s `handleCloseGitFile(path, worktree)` checks the route at the moment the answer lands, not the one the discard was confirmed on (the reader may have opened one of the discarded files since). The staged view of that same file is left open: throwing away unstaged edits does not empty it.

## Branch

The **Branches segment** (`BranchesSection` around `BranchList`), reached from the segmented control, the top bar's branch name or the sidebar's `Branches` entry:

```
┌──────────────────────────────────┐
│ ⑂ feature/git-ui         ⟳ Synced│  top bar
├──────────────────────────────────┤
│  Changes   History  [ Branches ] │
├──────────────────────────────────┤
│ [ Filter branches…             ] │  pinned  ┐
│ ⚠ Could not switch to main. …  ✕ │  pinned  │
│ ✓ feature/git-ui        current  │          │
│   main                           │          ├ scroll area
│   fix-session-create             │          │
│   review             in review   │          │
│ ── Remote ────────────────────── │          │
│   origin/colleague-branch        │          ┘
├──────────────────────────────────┤
│ [ +  New branch…               ] │  fixed
└──────────────────────────────────┘
```

- Rows are `min-h-[44px]`. Long names truncate at the head, not the tail, so `…/git-ui` keeps the part that tells branches apart.
- The filter input appears once there are more than eight branches. It filters the list and nothing else; it never creates a branch.
- **The filter and any checkout failure are pinned above the rows**, in one `sticky top-0` container at the top of the scrolling body. A list long enough to scroll is a list where filtering is the fast path, and a filter that scrolls away is one the user has to scroll back up to reach. The failure is pinned for a sharper reason: the user's real path is to scroll halfway down and tap a branch, so a message rendered at the top of the scroll area lands off-screen and the tap reads as having done nothing — a silent failure. Git's verbatim output under it goes through `GitOutput` like everywhere else — when there is any, which a worktree-busy refusal has none of ([Feedback and errors](#feedback-and-errors)) — and it matters more here than anywhere: `would be overwritten by checkout` names every file in the way, and an unbounded refusal would pin more of the page than the list it is pinned over. The failure carries a `✕`: in the sheet this list used to live in, closing the sheet was how it was put away, and a page has no sheet to close.
- Remote-only branches form a second group; picking one creates a local tracking branch of the same name and checks it out.
- **Uncommitted changes are neither stashed nor discarded.** The switch is attempted as-is, which git allows whenever no modified file differs between the two branches — the common case. When git refuses, the failure shows the refusal with the offending paths plus one line of guidance: *Commit or discard these changes first.*
- **While a switch runs**, the tapped row shows a spinner and every other row, and `New branch…`, is disabled. A switch that succeeds stays on the segment: the check moves to the new branch and the top bar's name changes, which is the whole report of it — no message of its own, on the rule sync's success follows.
- **A switch can be walked away from** — the segmented control, the top bar and Back all leave the segment while it runs, which the sheet this replaced never allowed. Coming back mid-switch still shows the spinner and still refuses a second switch, and a failure that settled while the user was elsewhere is waiting for them ([Results that outlive the page](#results-that-outlive-the-page)).
- `New branch…` is fixed under the list and opens a small sheet with a single name field. The base is fixed to current HEAD and stated as text (`Branches from feature/git-ui`) rather than offered as a third input: this is not the place to build a branch-from-arbitrary-ref picker, and `WorktreeCreateSheet` already covers that case. Uncommitted changes carry over to the new branch, which is standard git behaviour and worth one line of helper text. It stays a sheet — it holds typed input, and cannot be closed while creating — and on success it closes onto the segment with the new branch current.
- Branch deletion stays out: destructive, rarely urgent from a phone, and with no safe single-tap form.
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
- **Pull is fast-forward only.** A merge started by one tap on a phone can strand the user in a conflicted worktree with no tooling to get out. When `--ff-only` fails because the branches diverged, the sheet reports that plainly and points at the escape hatch that does exist on a phone: asking the agent in chat to merge or rebase, which is the product's whole premise.
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
| Stage, unstage, discard (list rows and group headers) | Changes segment | The Changes segment's banner — including a failure that settled while the user was elsewhere |
| Stage from a diff | The diff layer | `DiffView`'s own banner; one that answers after the reader left the diff, the Changes list's banner |
| Commit, amend | Commit sheet | In the sheet |
| Switch branch | A Branches row | Branches on screen: its pinned area. Anywhere else in the workspace: a top-bar banner |
| Create branch | New-branch sheet | In the sheet |
| Fetch, pull, push | Sync sheet | Sheet open: in the sheet. Sheet closed: a top-bar banner |
| Automatic fetch | Nobody — the workspace, on the way in | The chip's `⚠`, the sidebar overview's line, and the reason in the sheet ([Automatic fetch](#automatic-fetch)) |

- **Actions started in a sheet the user cannot leave** (commit, create) render their error inside that sheet, in the `text-th-error` + `role="alert"` form `WorktreeCreateSheet` already uses. The sheet stays open and the user's typed input survives.
- **Fetch, pull and push** are started in a sheet that *can* be closed while they run ([Remote sync](#remote-sync)), so one outcome is rendered in whichever place is on screen. Sheet open: the same in-sheet `role="alert"` block as above, unchanged. Sheet closed: an **error banner** under the top bar, below. There is one outcome either way, not two copies of it — opening the sheet moves the message into it and takes the banner away, closing it brings the banner back, and there is no "already seen" state in between. A success is not banner material at all: its signal is the chip's spinner stopping and the counts refreshing, and it waits in the sheet as `Already up to date.` or `Pushed 2 commits.` for whoever reopens it.
- **Actions started inline from a row** — stage, unstage, discard, discard all — have no sheet to hold the result, so they use that same dismissible **error banner**: one line of plain-language summary, git's stderr behind a `Details` disclosure in a mono block, and a `✕`. It covers stage and unstage rather than discard alone, and not for symmetry: a failed stage used to reach nothing on screen at all — no surface rendered the mutation's error and the panel's own handler let the rejection escape — which is precisely the silent failure the project forbids. The banner clears on dismissal, or when a later attempt succeeds on one of the paths that failed. An unrelated file succeeding is not a retry: dropping the message then would leave the file that failed sitting in the list with nothing on screen explaining why.
- **A banner holds at most one failure *per source***, each with its own `✕`: under the top bar, from `BranchBar`, the sync banner and then the branch-switch banner — at most two, never merged — and in the Changes segment, between the segmented control and the list, the inline row actions' banner from `ChangesSection`. Several sources can be unacknowledged at once and all are real; collapsing them to "the most recent failure" would silently drop one. Within a source there is only ever one: a new run replaces the outcome of the last. `DiffView` carries a banner of its own for its stage button, which is on a layer where the list may not be on screen. A stage that answers after the reader left the diff — Back to the list, or another file opened beside it (each file is its own `DiffView`, so nothing about one is shown on the next) — does not navigate, and a failure then goes to the Changes list's banner through the store rather than to nobody; a success clears that banner for its path, as a retry from the list would.
- **A refused request has no `Details`, because git never ran.** The server refuses a write while another one it would collide with holds the worktree — which pairs those are is the server's to decide and is decided narrowly, a fetch never standing in the way of staging a file ([git.md](git.md#serialising-writes)). That refusal is a fact about the workspace's own traffic rather than anything git said — quoting the server's English sentence back under a summary of itself would be the workspace talking to itself. The same holds for `-32002`, a request that reached a project which has just stopped being a repository. So `utils/gitErrors.ts` is the one place the two kinds of failure are told apart, by error code and never by matching the sentence, and every surface renders the outcome: a summary always, git's words only when there are any. The sentence names the operation to wait for in the workspace's own vocabulary (`switching branches`, not `checkout`), and falls back to "another git operation" for an operation name it does not know, so a write added on the server is still explained rather than mis-explained. A branch switch is the one failure that embeds the sentence in its own — `Could not switch to <branch>. This worktree is busy pushing.` — because the branch list is taller than the screen and the row that was tapped is usually scrolled away, or the user has left the segment altogether, while the refusal by itself cannot say which branch it was.
- **The workspace queues its own fast writes rather than leaning on that refusal.** Stage, unstage and discard run one at a time per worktree through `lib/gitWriteStore.ts`: tapping two files' stage buttons in a row is two `git.add` requests, each row disables only *itself* while its own request is in flight, and react-query does not serialise mutations — so without the queue the commonest interaction in the workspace would be answered with *This worktree is busy staging files*, an error the user did nothing to earn. They **queue** rather than being dropped, unlike the sync store's guard: the second tap names a different file, so it is a second thing the user asked for and not a duplicate of the first. Requests are not merged into one batch either, though the server would take it: merging means either a debounce, which makes a single tap slower for nothing, or bookkeeping that re-derives which row's spinner and which banner a combined failure belongs to. Only the fast writes are queued — commit runs hooks and the three sync operations wait on another machine, so queueing behind one of those is the hang the server's bounded wait exists to prevent, and each of them is behind a single control that cannot be double-tapped into a collision.

  **A queued write is dropped if the user leaves the worktree before its turn.** A `git.*` request names no worktree: the server answers it against whichever one the connection is bound to, and `worktree.switch` rebinds it. Sending each write immediately used to make that safe by itself, since one connection is answered in order — a queue is what gives a switch room to land in between, so the queue is what has to check, at the moment the request would go out. Nothing is shown when one is dropped: nothing was written, so there is nothing to report. The uploads queue cancels for the same reason, and does say so, because its queue stays on screen per worktree.
- **The sync banner yields to the sheet only when the sheet is really on screen**, not when it is merely the selected one: without branch data there is no sheet to render, and a banner suppressed by a sheet that is not there is a silent failure. For the same reason it is not gated on the chip either — a run that ends after HEAD went detached, or after `git.branches` started failing, has lost the chip that was carrying its progress, and losing progress is acceptable where losing a failure is not. Nor does leaving the workspace lose it: the outcome is stored state rather than a notification, so it is still under the top bar when the user comes back, which is exactly what a toast would not have managed.

### Results that outlive the page

The Git panel was always mounted — the sidebar hid its inactive tabs with a class — and a branch switch ran inside a sheet that could not be closed until it finished. Two guarantees came free with that, and neither survives becoming a page that can be left at any moment. So both are stated, and kept by moving the result out of the component and into a store keyed by worktree:

- **The inline-action banner outlives the segment and the workspace.** A stage, unstage or discard failure lives in `gitWriteStore`'s `failures`, not in `ChangesSection`: switching to History and back, or going back to the chat and returning, still shows an unacknowledged failure, and one that settled while the user was away is there when they return. Without that, "stage, then switch segment at once" would put a failure nowhere. The clearing rule is unchanged: `✕`, or a later success on one of the paths that failed. It is filed under the worktree the write was sent to, so switching worktree hides it and switching back shows it again — an earlier version of the panel dropped it on a switch instead.
- **A branch switch outlives the Branches segment.** Its progress and its failure live in `gitCheckoutStore`, on the same terms as a sync's: one switch per worktree, a new switch clears the last failure, success leaves nothing. A failure is shown in exactly one place — the segment's pinned area while Branches is on screen, a top-bar banner anywhere else in the workspace (the top bar is where "which branch am I on" is answered) — and moves between the two as the user does; both read the same record, and `BranchBar`'s `branchesOnScreen` decides which one draws it — except that the pinned area belongs to the list, so on a Branches segment with no list to draw (the read failed with nothing cached) the banner keeps the failure. It clears on `✕`, on the next switch starting, or on success. The reason this is not optional is what happens without it: a switch that fails while the user is elsewhere, a user who believes it worked, and an agent then set to work on the wrong branch — a costlier silent failure than any stage.
- **Both, like sync's outcomes, are dropped when the project starts or stops being a repository** ([below](#when-the-answer-changes)).

Verbatim git output is capped and scrollable wherever it appears, by going through one component — `Git/GitOutput.tsx`, `max-h-32 overflow-auto`. A rejected push runs to a dozen lines of `hint:`, and inside a height-capped sheet those lines come out of the very buttons the message is telling the user to press. The cap belongs to the output rather than to each of the four places that show it — written out four times, no two of the four fully agreed.

Both surfaces show git's own output *under* the summary rather than in place of it, matching the project's split between user errors (guidance) and system errors (technical detail) — the reader is a developer who needs to see `hook declined to update refs/heads/main`.

In-flight rules, uniform across the workspace: the triggering control shows a spinner and a gerund label, controls whose outcome the running operation would change are disabled, and nothing is fired optimistically. A mutation then refreshes immediately rather than waiting out `GitWatcher`'s 3-second poll, invalidating what it can actually have changed: staging and unstaging touch only the status query, while commit, discard, checkout, create and the three sync operations move HEAD or the counts and so invalidate status, log and branches together.

**Refusing to close the surface is not one of those uniform rules.** It applies only to bounded operations, which is why the sync sheet no longer does it ([Remote sync](#remote-sync)). The commit and new-branch sheets still do — and for commit that is not because committing is always quick, since a `pre-commit` hook can take as long as it likes. It is because those two hold typed input: closing them would have to answer "is what I wrote still there", and a commit message is the one thing in the workspace the user cannot get back. The sync sheet holds no input and only has to answer "where did the result go" — which the chip and the banner answer. A branch switch used to be held shut by the sheet it ran in, though it holds no input either; as a page it cannot hold anyone, so it answers that same question the way sync does ([above](#results-that-outlive-the-page)).

Discard is the one that refreshes whether it succeeded or not. It is several git invocations behind a single tap, and a batch that failed part-way has still deleted files; refreshing only on success would leave those rows on screen until the next poll.

## The sidebar's Git tab

The Git tab (`Git/GitTab.tsx`) is the workspace's doorplate, the same shape as the Project tab: a read-only overview — the branch name and one line of sync state drawn from the chip's own `describeSyncStatus` — and three entries, `Changes`, `History` and `Branches`, each landing on its segment's list. Nothing in it writes. Its shape and rules are [sidebar-ui.md](sidebar-ui.md#the-git-tab)'s; what it shares with the workspace is the sync description above and the count below.

## The change count on the tab

The Git tab's icon carries a badge with the number of files holding uncommitted
changes, so the workspace does not have to be on screen for the user to know
there is something here to look at. It counts the file lists above, but **deduplicated by
path** across `Staged` and `Changes`, submodules included: a partially staged
file is two rows in the list and one changed file to someone reading a digit
off an icon.

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
enabled: isGitRepo && ((!SidebarContent && isOpen) || activeGitSegment !== null)
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

Re-enabling resubscribes, and `useGitWatch` refreshes on `onSubscribed`, so
opening the drawer, expanding the column or entering the workspace shows a
current answer rather than a stale one for a frame.

## Data behind the workspace

None of these queries runs on a refetch interval; `git.changed` is what drives all three together, and the subscription it arrives on belongs to the sidebar rather than to the workspace ([above](#who-subscribes-to-gitchanged)). `git.status` backs the file lists, `git.log` the history, and `git.branches` answers with HEAD (branch or detached hash, plus the message amend prefills), the local branches annotated with the worktree occupying each, the remote-only branches, and the sync state — one answer, so the branch name and the chip beside it — and the sidebar's overview — can never disagree about which branch they describe.

Beyond the components named above, the workspace's own supporting modules are:

| Module | Role |
|--------|------|
| `Git/GroupHeader.tsx` | The L3 group header — label and optional L5 actions. One definition, so the sticky background and the rung's typography cannot drift between the two file groups |
| `ui/iconButtonClass.ts` | The L5 icon button's classes, used by `DiffFileItem`, `DiffFileList`, `LogList`, `BranchList` and `ErrorBanner` here, by the file tree row's `…` in the Files panel, and by chat's message actions — the `…` beside every user bubble, which is the one caller that asks for the overlay instead of a grown box, and the icon row under every agent message ([session-fork-ui.md](session-fork-ui.md)). It used to live under `Git/` while the tree wrote its own copy, because the two rungs disagreed on height — 36 against 44 — and parameterising that would have meant sharing everything about the rung except the part that made it a rung. The disagreement turned out to be one rung measured two ways: 36 of visual weight, 44 of hit area on a coarse pointer ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)). With both stated here, there is one definition and it belongs to no single surface |
| `Git/GitOutput.tsx` | The capped, scrollable block holding git's own words, shared by the error banner, the branch list's pinned failure, and the commit and sync sheets. Every one of them renders it conditionally: a refused write has no git output to hold ([above](#feedback-and-errors)) |
| `Git/GitCommitSheet.tsx` | The connecting layer between the commit sheet and the workspace's queries, shared by the commit bar and the HEAD row's amend |
| `Git/BranchList.tsx` | The branch rows, their filter and the pinned failure, and `useBranchCheckout`, the Branches segment's handle on `gitCheckoutStore` |
| `ui/SegmentedControl.tsx` | The segmented control, shared with the Stories screen; it holds no state, since the segment is in the URL |
| `lib/gitSyncStore.ts` | Which fetch/pull/push is in flight in each worktree, whether it is the automatic fetch (`auto`), and how the last one ended, so a run outlives the sheet that started it. Keyed by worktree because switching worktrees mid-run is reachable, and one record would show A's outcome under B or let A's run disable B's buttons |
| `lib/gitCheckoutStore.ts` | Which branch switch is in flight in each worktree and how the last one failed, so a switch outlives the segment that started it ([Results that outlive the page](#results-that-outlive-the-page)). A store of its own rather than a part of `gitWriteStore`, whose queue is for quick local writes ([frontend-state.md](code/frontend-state.md#why-a-run-in-flight-is-a-store)) |
| `lib/gitWriteStore.ts` | One serial queue per worktree for stage, unstage and discard, plus the paths each has pending and the Changes list's unacknowledged failure, so two taps in a row cannot overlap and a write — and how it failed — outlives the view that started it. Keyed by worktree for `gitSyncStore`'s reason |
| `utils/gitSyncStatus.ts` | `describeSyncStatus`, the one reading of the sync state the chip and the sidebar's overview both draw, and `shouldAutoFetch` with its ten-minute threshold |
| `hooks/useGitSync.ts` | `useGitSyncRunner`, the way into the three sync operations and the automatic fetch, and `useAutoFetch`, which decides whether to run it |
| `hooks/useGitWrites.ts` | `useGitWriteRunner`, the single way into those three writes — the file list and the open diff both go through it, which is what makes one queue cover them together |
| `utils/gitErrors.ts` | The one place "git never ran" and "git ran and failed" are told apart, and the sentence a refusal is shown as — pure functions, so the wording and the code-not-prose rule are testable without a screen around them |
| `utils/gitSyncMessages.ts` | Every sentence the three sync operations produce, and the patterns that tell git's rejections apart — pure functions, so the wording is testable without a sheet around it |

The writes are `git.add` and `git.reset`, which the panel had from the start, plus `git.discard`, `git.commit`, `git.checkout`, `git.branch.create`, `git.fetch`, `git.pull` and `git.push`. A failure that git produced comes back as git's own words — stderr for most of them, stdout as well for commit, which is where git puts `nothing to commit` — and that text is what both surfaces above show under their summary; a write refused before it started has no such text ([above](#feedback-and-errors)). Shapes, and the server-side reasoning behind them, are in [git.md](git.md).

## Projects without a repository

A project need not be a git repository, and many Pockode users are not engineers: to them the workspace, the switcher and every git affordance are noise. So outside a repository **they are not there** — not disabled, not explained, and with no "initialize git" prompt. Someone who wants git asks the AI to run `git init`, and the UI follows by itself. A greyed-out button only raises the question of why it cannot be pressed.

The answer comes from one place, `worktreeStore.isGitRepo`, which only the server's replies write ([frontend-state.md](code/frontend-state.md#store-patterns)). It is three-valued, and **unknown hides like no**: until the first `worktree.list` or `worktree.subscribe` reply, nothing that exists only for git is drawn. A git user sees the Git tab arrive a few hundred milliseconds late; a user without git never sees it flash in and out.

| Surface | Outside a repository |
|---|---|
| Worktree switcher (sidebar header) | Plain text: the project's name (`projectTitle`), falling back to `Pockode`. No dropdown, so creating and deleting worktrees go with it. While the answer is unknown it stays the skeleton |
| Git tab, its count badge, `git.changed` | Not in the tab list, and with it every entry into the workspace; the other tabs keep their order. The sidebar's `useGitWatch` is not enabled ([above](#who-subscribes-to-gitchanged)). `useGitStatus`, `useGitLog` and `useGitBranches` gate themselves rather than trusting whoever mounts them, because the count badge reads `git.status` with no Git tab mounted |
| The Git workspace, every layer (`git`, `diff`, `commit`, `commit-diff`, `commit-file` — `isGitOverlay`) | Reached by URL or history, `AppShell` replaces the route with the current session, or the worktree's home. `ChatPanel` holds the workspace back, blank, while the answer is unknown, so it never sends reads that can only fail |
| Worktree badge on work rows | Main's badge hidden, and a leftover feature name drawn as gone ([work-system.md](code/work-system.md#displaying-a-works-worktree)) |
| Settings → Worktree | Hidden with its heading and its nav entry, through the section's `visibility`; the saved values are left alone |
| Files search `.gitignore` chip | Hidden ([file.md](file.md#search-ui)) |
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
- A git write in flight refused with `-32002`: the surface that started it, if still there, reports it as a refusal — *This project is no longer a git repository.*, no `Details` ([Feedback and errors](#feedback-and-errors)) — and nothing more is said once that surface is gone; the UI changing is already the explanation. A fetch/pull/push outcome is stored rather than rendered, so `gitSyncStore` drops its outcomes whenever the answer changes — the automatic fetch's failure mark with them — and `gitCheckoutStore` and `gitWriteStore` drop their failures on the same signal: one refused after `.git` went would otherwise reappear as a banner after a later `git init`. What is still running is left alone; its settling lifts the guard.

## Out of scope

Deliberately excluded, to keep the workspace at "the everyday operations, done well": conflict resolution, interactive rebase, cherry-pick, revert, tags, stash, branch deletion, remote management, per-hunk staging, submodule commit/branch/sync, and a global toast system.

Left for later rather than excluded — the workspace was built as a frame for them, with its current contents moved in unchanged: a redesigned changes list (grouping, a directory tree, batch actions) and a diffstat beside the sidebar's `Changes` count, which `git.status` does not carry yet; a review flow through the diffs; a commit graph; branch details — per-branch ahead/behind, deletion, and the right column Branches does not have yet; AI help such as a generated commit message, which would bring the user back to the session's input with it prefilled ([no composer](#routes-segments-and-back)); a conflict-resolution mode; and resizable columns and keyboard navigation.

---

**Why this file lives here.** `docs/` holds per-feature design documents (`file.md`, `agent-chat.md`, `git.md`); `docs/code/` is reserved for explaining why the code of a *core module* is built the way it is (WebSocket, Agent, Work, Subscription, Relay), and `docs/projects/` for the project-management system. A UI design for a feature is none of those, so it sits beside `git.md` as `git-ui.md` — `git.md` keeps describing the git backend and links here for the surface built on top of it. What the Git tab and the Files panel have to agree on, rather than what either one looks like, is one level up in [sidebar-ui.md](sidebar-ui.md).
