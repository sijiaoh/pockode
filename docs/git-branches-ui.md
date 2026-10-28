# Git Branches UI

The Branches segment of the Git workspace (`Git/BranchesSection.tsx` around `Git/BranchList.tsx`): which branches it lists and in what order, what each row says, the branch's detail a row opens — what the branch is, what only it has, and what can be done with it — and the three things a branch offers: switching to it, handing a merge into the current branch to the agent, and deleting a local branch.

Everything not mentioned here — the top bar, segments and routes, switching and `New branch…`, the feedback and error rules — stays as [git-ui.md](git-ui.md#branch) describes it. The handoff to the agent is the existing [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), unchanged; this file defines only its text and where its entry sits.

Copy below is the UI's English.

> **Status:** everything below is built — the list, the row that opens a branch, the `⋯` menu with `Switch to this branch`, the branch detail with its commits, a commit stacked on the branch, deleting a local branch, the merge handoff, and the list | splitter | detail skeleton at `expanded`. Where the implementation settled something the design left open, this file records the implementation.

## Goals and constraints

- **Answer "which branch do I go to" on the row.** The list used to be names only. Choosing where to switch — or what to clean up — needs two more facts per branch: how far it is from the default branch, and when it last moved. Both go on the row, in muted text, so the name stays what is read first.
- **The branches the user is working with are within reach without filtering.** A repository an agent works in grows branches fast; the ones that matter today are few, and they are the ones checked out recently, not merely the ones committed to recently (an agent in another worktree commits to its own branch all day).
- **Deleting is possible and says exactly what it costs.** A branch whose commits are all somewhere else is cheap to delete and gets an ordinary confirm. A branch with commits nowhere else gets a danger confirm with the number of commits that go with it. Nothing is deleted on one tap, and nothing that would break another worktree can be deleted at all.
- **The workspace never merges.** A merge can stop on conflicts, and a conflicted worktree on a phone is what [git-conflict-ui.md](git-conflict-ui.md) exists to get out of. So "merge this branch" is a prefill for the agent, never a `git merge` run by the UI — the rule pull's `--ff-only` already follows ([git-ui.md](git-ui.md#remote-sync)).
- **A row selects; it does not act.** In Changes and History a row opens a detail, and only a deliberate second step writes. A Branches row that switched on one tap was the odd one out, and on a phone a stray tap while scrolling moved HEAD under the user — and under any agent working in the worktree. A row now opens the branch's detail, at every width; switching is a named action in the detail and in the `⋯`.
- **See a branch before acting on it.** Switch, merge and delete are all decisions about what a branch contains. The detail answers that first — its commits that the default branch lacks, where it lives, who last moved it — and puts the three actions beside the answer.
- **One skeleton for every segment.** At `expanded` the workspace is list column | splitter | detail column whatever the segment, so the segmented control, the list and its bottom bar never change place or width when the segment changes. Branches having no detail was the only reason that was not so.
- **Switching and creating do not change.** A switch is still attempted as-is with uncommitted changes, refused with git's words, never stashed; `New branch…` still branches from HEAD ([git-ui.md](git-ui.md#branch)).
- **Existing vocabulary.** `th-*` tokens, `MenuRow` in a `Sheet` for the row's menu, `ConfirmDialog` for both confirms, `ErrorBanner` / `GitOutput` for failures, `utils/gitErrors.ts` for telling git's refusals from the server's, `usePrefillComposer` for the handoff, `formatRelativeDate` for ages, `BranchName` for head-truncated names, the commit graph's `HistoryList` and `CommitRow` for a branch's commits, the commit layers (`CommitView`, `CommitDiffView`, `CommitFileView`) for opening one, `EmptyDetail` for the column with nothing chosen; the narrow-width rule ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)) and the 44px touch rule ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)).

**Out of scope:** deleting remote branches (it changes what everyone else sees, and has no single-device undo), renaming, setting an upstream, picking the default branch by hand, comparing two arbitrary branches, a branch's standing against its own upstream anywhere but the current branch's sync chip.

## What the list reads from the server

`git.branches` keeps its shape and gains the fields below; how the server computes them is [git.md](git.md#branches)'s to define. One answer still carries everything, so the rows, the top bar and the chip cannot describe different moments.

| Field | Where | Meaning |
|---|---|---|
| `default_branch` | top level | What the counts are taken against, as displayed: `main`, or `origin/main` when there is no local one. Empty when the repository has none, and then no row shows counts |
| `recent` | top level | Local branches checked out in **this worktree**, most recent first, current branch included — read from this worktree's HEAD reflog (its last 1000 moves). Not capped by count; the list takes what it shows ([Groups](#groups)) |
| `committed_at` | each local and remote row | ISO date of the branch's last commit |
| `vs_default` | each local and remote row | `{ ahead, behind }` against `default_branch`. Absent on the default branch itself, with no default branch, and on remote rows when git predates `%(ahead-behind)` (2.41 — Apple's git is older), where counting each remote branch would cost a process apiece |
| `committer` | each local and remote row | The committer name of the branch's last commit (`%(committername)`), for the detail's `Last commit` line ([The branch](#the-branch)). The committer, not the author, because `committed_at` is the committer date: the line pairs a time and a name from the same act |
| `upstream` | each local row | The configured upstream as displayed (`origin/topic`); absent when none is configured |
| `upstream_gone` | each local row | The upstream is configured but its remote-tracking ref is missing — the per-branch form of the sync chip's `upstream_gone` ([git-ui.md](git-ui.md#the-sync-chip)) |

**The last three fields come from the `for-each-ref` the list already runs**, so they add no process and no walk: `%(committername)` and `%(upstream)` are read off each ref, and `upstream_gone` is that upstream not being among the refs the same command lists — the answer the sync chip gets for the current branch from `rev-parse --verify <ref>^{commit}` (`server/git/remote.go`), read off the listed refs instead; the two agree, since the list already leaves out a remote ref that is not a commit. Not `%(upstream:track)`: it counts ahead/behind against every branch's upstream, a walk per branch, to print `[gone]`. They are in the one answer for the reason above: the detail reads the list's own query, and a detail that read a second one could show a branch the list has already dropped. Nothing else the detail shows needs new server data — its commits are `git.log`'s existing `scope=branch` ([git.md](git.md#history)), and the occupying worktree, the age and the counts are already on the row.

**The default is the local branch when there is one** ([why](git.md#branches)). The consequence for the UI: the `default` row shows no counts — its standing against its upstream is the chip's when it is checked out, and is deliberately not repeated here when it is not.

**The "commits that would be lost" count is not in the list.** It is one `rev-list` per branch, and the list is re-read on every `git.changed`; it is asked for when Delete is pressed ([Flow](#flow)).

## The list

```
┌──────────────────────────────────┐
│ ⑂ feature/git-ui         ⟳ Synced│  top bar
├──────────────────────────────────┤
│  Changes   History  [ Branches ] │
├──────────────────────────────────┤
│ [ Filter branches…             ] │  pinned  ┐
│ ⚠ Could not switch to main. …  ✕ │  pinned  │
│ Compared with main               │          │
│ RECENT                           │          │
│ ✓ feature/git-ui                 │          │
│   current · 3 ahead       2h ago │          │
│   fix-session-create          ⋯  │          │
│   1 ahead · 4 behind   yesterday │          │
│   main                        ⋯  │          ├ scroll area
│   default                 3h ago │          │
│ LOCAL                            │          │
│   review                      ⋯  │          │
│   in review · 5 ahead    20m ago │          │
│   old-spike                   ⋯  │          │
│   2 ahead · 40 behind    3mo ago │          │
│ REMOTE                           │          │
│   origin/colleague-branch     ⋯  │          │
│   7 ahead · 1 behind      2d ago │          ┘
├──────────────────────────────────┤
│ [ +  New branch…               ] │  fixed
└──────────────────────────────────┘
```

### Groups

| Group | Contains | Order |
|---|---|---|
| **Recent** | The current branch, then the first four other branches of `recent` | Current first, then most recently checked out |
| **Local** | Every other local branch | Last commit, newest first |
| **Remote** | Remote-only branches | Last commit, newest first |

- **"Recent" means checked out here recently, not committed to recently.** Local is already sorted by commit time; a Recent group sorted the same way would just repeat its top rows. What commit time cannot tell is which branches *this user, in this worktree* has been moving between — the review branch they hop to and back, `main` they keep returning to — and the reflog of this worktree's HEAD records exactly that. It is per worktree on purpose: in another worktree the user works on other things. It is the definition GitHub Desktop's "Recent branches" uses, which is a reasonable thing for a user to already expect.
- **Five rows at most** (the current branch plus four): enough for the branches in active rotation, few enough to see without scrolling on a phone with the filter above. The cap is the list's, not the server's.
- **A branch is listed once.** A branch in Recent is not repeated in Local. Repeating it would make a long list longer and make a filter match show twice.
- **No Recent group in a small repository.** When the whole list is at most eight branches — the existing `FILTER_THRESHOLD`, the point at which the list fits on screen — there is no Recent group and no Local header: one list, the current branch first, then by last commit, then Remote under its header. Grouping a list that already fits is noise.
- **The current branch is the first row** whenever it has one. Two states have none: HEAD **detached** (no branch), and HEAD on an **unborn** branch (no commit yet, so no ref to list — and no HEAD to read a reflog from, so `recent` is empty). In both, Recent holds only what `recent` gives, and its header is drawn only if that is non-empty.
- **Headers** are the existing `Remote` header's style (`text-xs uppercase text-th-text-muted`, a top border on all but the first). They scroll with the rows; only the filter, the operation-paused line and failures are pinned — a second pinned band would eat the screen the pinning was meant to save.
- **Filtering** keeps the groups: a match is shown in its group, a group with no matches drops its header, and `No branches match.` when none do. The filter matches the name only.
- **`Compared with main`** — one muted `text-xs` line above the first group, scrolling with the list, naming `default_branch`. The rows say `3 ahead`; this line says ahead of what, once, instead of on every row. Absent when `default_branch` is empty.

### The pinned area

Its rules — what is pinned, why, and the one capped box the failures share — are [git-ui.md](git-ui.md#branch)'s. This design adds two failure sources beside a switch's: a delete, and the merge handoff's session create ([below](#asking-the-agent-to-merge)) — each its own pinned failure (the summary, git's words in a `GitOutput` when there are any, its own `✕`), never merged, per [git-ui.md](git-ui.md#feedback-and-errors).

**Where the three failures are drawn** — still exactly one place, read from the same records (`gitCheckoutStore`, the workspace's handoff), whichever surface started the action. The detail is a second surface that can start them, so where they are drawn depends on the layer and the width, not on the segment:

| Width | What is on screen | The failures are |
|---|---|---|
| At `expanded` | The Branches segment — the list alone, or beside a branch or a commit opened from one | Pinned above the list |
| Below `expanded` | The Branches list, no layer over it | Pinned above the list |
| Below `expanded` | A branch detail layer | Pinned at the top of the detail's scroll area — the same `PinnedFailure`s in the same capped box ([The branch](#the-branch)) |
| Below `expanded` | A commit (or its file layers) opened from a branch | The top-bar banners |
| Either | Any other segment or layer | The top-bar banners |

- **The surface must be able to draw them.** A Branches list with nothing to draw — `git.branches` failed with nothing cached — leaves the failures to the top bar, and so does a narrow detail in that state, which shows only the read's failure ([When the branch goes away](#when-the-branch-goes-away)).
- **So the rule is not the segment.** `BranchBar` is told whether *a branch-failure surface* is drawn (`branchFailureSurface`, computed in `GitWorkspace` from the layer and the width by the table above); read off the segment, it would hide the top-bar banners under a narrow commit opened from a branch, where the list's pinned area is covered — a failure drawn nowhere.
- **At `expanded` they stay with the list, even for an action pressed in the detail.** The list's pinned area is on screen and pinned, so the failure is seen; giving the detail column a copy too would break "one place", and giving it the failure *instead* would move a failure from a `⋯` pressed in the list to the other column.
- **A narrow detail is where the press was**, and with the list covered under it, a pinned area there is the only place the failure is seen. It is `sticky` at the top of the detail's scroll area — over the gone notice too, since a delete that failed because the branch went is still a failure to show. The capped box and each `PinnedFailure` are one component, `PinnedBranchFailures` (`Git/BranchActions.tsx`), which the list and the detail both render.

### The row

Two lines, `min-h-[52px]`, the row's button and its `⋯` siblings as in the Changes list ([git-changes-ui.md](git-changes-ui.md#the-file-row)). **The row's button opens the branch's detail** ([The branch](#the-branch)), pushed, at every width — never a switch. Switching is `Switch to this branch`, first in the `⋯` and first in the detail.

| Part | Content |
|---|---|
| Left gutter | `Check` in `th-success` on the current branch; an empty 16px slot otherwise, so names line up |
| Line 1 | The name, `text-sm`, `BranchName` (truncates from the head). Remote rows show `ref` (`origin/x`) |
| Line 2, left (`min-w-0 truncate`) | Muted `text-xs`, parts joined by ` · `: the **state word** (below), `n ahead`, `n behind`. A part with nothing to say is dropped — `0 ahead` is never written |
| Line 2, right (`shrink-0`) | The age, `formatRelativeDate(committed_at)` (`2h ago`, `yesterday`, `3mo ago`) |
| Far right: `⋯` | L5 icon button, `More actions for <name>`. **Absent on the current branch's row**, whose every action would be unavailable (an empty slot keeps the names aligned) — the row itself still opens its detail |

**State word** — at most one, the first that holds:

| Branch | Word |
|---|---|
| Current | `current` |
| Checked out in another worktree | `in <worktree>` — the existing wording, `in main worktree` for the main checkout ([git.md](git.md#branches)) |
| The default branch | `default` |

- **Counts are words, not arrows.** The top bar's chip already uses `↑ 2` / `↓ 3` for *this branch against its upstream*; arrows here, meaning *a branch against the default*, would read as the same fact about a different pair. `3 ahead · 12 behind` costs a few characters and cannot be confused with it.
- **All of line 2 is `th-text-muted`.** None of it is a failure or an action, so none of it earns colour ([sidebar-ui.md](sidebar-ui.md#visual-weight)); `40 behind` on an old branch is information, not a warning.
- **No row is greyed.** An occupied row's button used to be disabled and line 1 muted, because the button *was* the switch. A row that opens a detail has nothing to refuse: reading an occupied branch's commits is exactly as useful as reading any other's. Line 1 is `th-text-primary` on every row; what the grey used to say is said by the state word on line 2 (`in review-wt`) and, where it matters, by `Switch to this branch` being unavailable with `Checked out in review-wt.` in the menu and the detail.
- **Width.** At 320px the text column is about 210–230px once the row's padding, the gutter and the `⋯` are taken. An ordinary row (`2 ahead · 40 behind` beside `3mo ago`) fits; an occupied one with large counts does not — `in main worktree · 12 ahead · 140 behind` beside `11mo ago` needs about 290px. The age keeps its place and the left part truncates at its tail, so what goes is the end of the counts (`in main worktree · 12 ahead · 1…`) and what stays is the state word: `in <worktree>` is the reason the branch cannot be switched to here, and must not be the part cut.
- **Accessible name** of the row's button: the name, the state word, the counts against the default spelled once, and the age as shown — `old-spike, 2 ahead of main, 40 behind, last commit 3mo ago`. The `Compared with…` line is not something a screen reader user can be relied on to have passed. It names the branch, not an action, since the button now opens a page like every other list row in the workspace.
- **Selected, at `expanded`**: the row whose detail is open beside the list wears the active treatment History's rows wear — `bg-th-bg-tertiary` and the accent bar at the left edge, `aria-current="true"` on the button — and keeps it while a commit opened from that branch is on screen ([Opening a commit](#opening-a-commit)), as History keeps a commit lit under its commit-diff. The current branch's `Check` stays in the gutter beside the bar: one says where HEAD is, the other what is being read. Below `expanded` the list is covered whenever a detail is up, so nothing is lit.
- **While a switch runs** the row of the branch being switched to shows the spinner in place of `⋯`, wherever the switch was pressed — the menu or the detail. Every row's button stays enabled — opening a detail writes nothing, so there is nothing for the switch to collide with — while every `Switch to this branch` and `New branch…` are unavailable, as the switch itself already makes them. The same holds while a merge handoff waits for its new chat, and while an operation pauses switching: the pinned `Branch switching is paused…` line stays, and `New branch…` still points at it with `aria-describedby`.

## The branch's menu (`⋯`)

The project's menu shape: a `Sheet` of `MenuRow`s on both layouts, titled with the branch name as line 1 shows it (`origin/x` for a remote) — truncated as `Sheet` already truncates `ChangedFileMenu`'s long paths. Order is frequency; the destructive item is last, behind a divider, in `danger` style — as `ChangedFileMenu` and `FileEntryMenu`. The detail offers the same three actions, with the same labels, icons and reasons, in the same order ([The branch](#the-branch)): the menu is the quick path from the list, the detail the considered one.

| Item | Shown on | Unavailable (`disabled`, with the sentence as `description`), first reason that holds |
|---|---|---|
| `Switch to this branch` (`ArrowRightLeft`) | Local and remote rows | An operation in progress: `Branch switching is paused during the <kind>.` · Checked out in another worktree: `Checked out in <worktree>.` · A switch running: `Wait for the branch switch to finish.` · This branch's delete running: `Wait for the branch delete to finish.` · A merge handoff waiting for its new chat: `Wait for the new chat to open.` |
| `Ask AI to merge into current branch` (`Sparkles`) | Local and remote rows | An operation in progress: `Finish or abort the <kind> first.` · HEAD detached: `Switch to a branch to merge into.` · A switch running: `Wait for the branch switch to finish.` · This branch's delete running: `Wait for the branch delete to finish.` · A merge handoff waiting for its new chat: `Wait for the new chat to open.` |
| — divider — | | |
| `Delete branch` (`Trash2`, danger) | **Local rows only** | An operation in progress: `Finish or abort the <kind> first.` · Checked out in another worktree: `Checked out in <worktree>.` · A switch running: `Wait for the branch switch to finish.` · Another delete running: `Wait for the branch delete to finish.` |

- **Remote rows have no `Delete branch`, not a disabled one.** `MenuRow`'s rule is that an action that *could* apply is kept and says why not; deleting a remote branch never applies here, so it is absent, as `Pull` is absent rather than disabled on an unpublished branch ([git-ui.md](git-ui.md#remote-sync)).
- **The merge waits for an operation before it asks for a branch.** A rebase detaches HEAD, and `Switch to a branch` is not the way out of a rebase — nor possible during one.
- **The merge label does not name the current branch.** It would have to be head-truncated inside a `MenuRow` label, which is a plain string, and the current branch is in the top bar directly above the sheet. The prompt the label leads to names both branches ([below](#asking-the-agent-to-merge)).
- **Delete stops for any operation in progress**, not only for the branch the operation is on. During a rebase HEAD is detached, so the branch being rebased is neither `current` nor occupied by the list's reckoning, yet `git branch -D` refuses it; rather than special-case that one row, delete waits like the other ref-moving writes, and the server refuses it the same way (`refuseDuringOperation`, as checkout and create do). A rebase running in *another* worktree has the same blind spot and is not detected here: git refuses the delete, and the refusal is shown as any delete failure is.
- **On an unborn branch** the merge is available — git merges into an unborn branch by pointing it at the merged commit, and the agent can do that.
- **`Switch to this branch` is first.** It was absent while tapping the row was the switch and a second way to the same thing would only have raised the question of whether it differed. The row no longer switches, so the menu is where the quick path is: on a phone, `⋯` → `Switch to this branch` is two deliberate taps from the list, where one stray tap used to be enough. It is the most frequent of the three, so it leads. On a remote row it creates the local tracking branch and checks it out, as switching to one always has ([git-ui.md](git-ui.md#branch)); the label stays the same, and the detail is where that is spelled out.
- **The switch's pause reason is the pinned line's, shortened.** The list already pins `Branch switching is paused during the rebase. Abort it, or let the agent finish it.` (`branchSwitchPausedReason`); the item says the first sentence only, since the way out is on the banner above. The switch reasons become `branchSwitchUnavailableReason(row, state)` in `lib/gitBranches.ts`, beside the other two, and the detail calls the same three functions.
- **The switch waits for this branch's delete only.** A delete of another branch moves no ref a checkout depends on; if the two meet on the server, its refusal is shown as any switch failure is.

## The branch

A layer of the Branches segment, `{ type: "branch", ref, remote }` — `ref` is the name the list shows and `git.log`'s `branch` takes (`topic` for a local branch, `origin/topic` for a remote-only one), and `remote` says which of the two the row was: a local branch may itself be named `origin/topic`, beside a remote-only `origin/topic`, and both rows read the same. Together they are the row's `key` (`local:topic`, `remote:origin/topic`), which is what `findBranchRow` takes. Its route is `/branch/<ref>`, a splat because branch names have slashes, with `remote=1` in the search for a remote-only branch. `gitSegmentOf` gives it `branches`; it carries no history query.

**Where it is registered** — the places every Git layer is: the `OverlayState` member and `gitSegmentOf` (and through it `isGitOverlay`) in `types/overlay.ts`; `branch: "/branch/$"` in `ROUTES` and `WT_ROUTES` (`lib/routes.ts`) and both route definitions in `router.tsx`; the route → overlay match in `hooks/useRouteState.ts`; the overlay → route mapping and its search params in `lib/navigation.ts` (`branch` and `remote` on a commit layer beside, never with, `scope` / `q` / `file`); `ChatPanel`'s `inputBarHiddenOverlays` (no composer anywhere in the workspace, [git-ui.md](git-ui.md#routes-segments-and-back)); and `GitLayer` in `GitWorkspace`.

### Below `expanded`

A full-screen layer, as a review or a commit is ([git-ui.md](git-ui.md#below-expanded-one-layer-per-screen)):

```
┌──────────────────────────────────┐
│ ←  …/branch-detail               │  app header — BranchName; ← Back to branches
├──────────────────────────────────┤
│ ⑂ feature/git-ui         ⟳ Synced│  top bar, as on every layer
├──────────────────────────────────┤
│ ⚠ Could not switch to …        ✕ │  pinned failures (narrow only)   ┐
│ feature/git-branch-detail-with-a │  full name, wraps                │
│ -very-long-suffix                │                                  │
│ in review-wt                     │  state word, as on the row       │
│ Tracks origin/feature/git-bran…  │  where it lives                  │
│ 3 ahead of main · 12 behind      │                                  │
│ Last commit 2h ago by sijiaoh    │                                  │
├──────────────────────────────────┤                                  │
│ ⇄  Switch to this branch         │  the actions, MenuRows           ├ one scroll area
│    Checked out in review-wt.     │  — reason under a disabled one   │
│ ✦  Ask AI to merge into current… │                                  │
│ ──────────────────────────────── │                                  │
│ 🗑  Delete branch                │  danger                          │
│    Checked out in review-wt.     │                                  │
├──────────────────────────────────┤                                  │
│ NOT ON MAIN (3)                  │  section heading                 │
│ ○   Draw the detail layer       ⋯│  CommitRow, dot only, no lines   │
│     a1b2c3d sijiaoh, 2h          │                                  │
│ ●   Add the branch route        ⋯│                                  │
│     Older commits are on main too│  end row                         ┘
└──────────────────────────────────┘
```

No bottom bar: the actions say why they are unavailable, which a bar of buttons has no room for, and the segment's own bar (`New branch…`) belongs to the list.

**App header.** The branch as the list's line 1 shows it, through `BranchName` (head-truncated — the header has one line; the body has the whole name). `←` is `Back to branches`, to the parent list, on the commit's rule rather than the review's: it navigates *to* the list, pushed, so a deep-linked detail still has a list to go back to ([git-ui.md](git-ui.md#routes-segments-and-back)). The review can go *back* instead because it is one history entry; a branch is not — each row tapped pushes, as each commit in History does.

**The facts**, top to bottom, in the scroll area so a long name cannot push the commits off a phone:

| Line | Content | When |
|---|---|---|
| Name | The full name (`ref`), `text-base` `font-medium`, `break-all` — wrapped, **never truncated**: this is the one place the whole name is guaranteed to be readable, and it is selectable for copying | Always |
| State | The row's state word, `text-xs text-th-text-muted`: `current`, `in <worktree>`, `default`. Unlike the row, more than one may hold here and all are said, joined by ` · ` (`in main worktree · default`) — the row stops at one for width, the detail has room | When any holds |
| Where it lives | Local with `upstream`: `Tracks origin/topic`. With `upstream_gone`: `Tracks origin/topic, which is missing here — not fetched yet, or deleted on the remote` (the sync chip's `Upstream missing here`, in a sentence). Local without: `Local only — not published`. Remote-only: `Only on origin. Switching to it creates a local topic that tracks it.` — the switch to a remote row as it has always worked ([git-ui.md](git-ui.md#branch)); where another remote has a branch of the same name git refuses the ambiguous name, and that refusal is shown as any switch failure is | Always |
| Against the default | `3 ahead of main · 12 behind` — the row's counts, the default named once since there is no `Compared with` line here; `3 ahead of main` or `12 behind main` when only one is non-zero, `Up to date with main` when both are 0. The default branch itself: `The default branch — other branches are compared with it` | When `vs_default` is present, or the branch is the default |
| Last commit | `Last commit 2h ago by sijiaoh` — `formatRelativeDate(committed_at)` and `committer`, the full date and time in its `title`. The commit rows below show the author, as History's do; on a rebased branch the two names can differ, and both are true | Always |

**The default is named as the list names it** — `default_branch` from `git.branches`, so `origin/main` where there is no local `main`, matching the list's `Compared with origin/main` — in every line and heading here: `NOT ON origin/main`, `Older commits are on origin/main too`. `git.log`'s own `default_branch` names the same branch without the remote and is not used for copy.

All facts but the name and the state line are `text-sm text-th-text-secondary`; nothing here is a warning, as on the row ([The row](#the-row)). No ahead/behind against the branch's own upstream: the server counts that for the current branch only, and the sync chip already says it for that one.

**The actions** — the menu's three `MenuRow`s ([The branch's menu](#the-branchs-menu-)), the same labels, icons, order, divider and unavailable reasons, laid inline in the page instead of in a sheet. A disabled row shows its reason as its `description`, so every reason is visible without a press. They do what the menu's do: Switch switches (the row shows `MenuRow`'s `busy` while it runs); Ask AI is the handoff, unchanged ([below](#asking-the-agent-to-merge)); Delete inspects, its `busy` spinner on the row, then opens the confirm — an inspect that fails is an `ErrorBanner` above the actions, where a menu shows it at the top of the sheet.

- **The current branch's detail has no actions**, as its row has no `⋯`: every one of them would be unavailable for the same reason, and three disabled rows saying `This is the current branch.` would be noise. The facts already say `current`.
- **Remote-only branches have no `Delete branch`**, as in the menu.

### Commits not on the default branch

`git.log` with `scope=branch, branch=ref` ([git.md](git.md#history)): exactly the commits the row counts as `ahead`. Under a section heading in `CommitView`'s style (`text-xs uppercase text-th-text-muted`), `Not on main (3)`, drawn `NOT ON MAIN (3)` — the default branch's name, the count from `vs_default.ahead`, no count where `vs_default` is absent; no heading at all on the default branch or with no default branch, where there is nothing to be "not on". The count and the rows are the same test from two reads, both re-read on the same `git.changed`; between those two answers they can differ for a moment, as History's header count and its rows can.

- **No graph — dots without lines**, History's filtered form ([git-history-ui.md](git-history-ui.md#what-the-list-shows)): each `CommitRow` with its one-lane dot (pushed, not pushed, merge), no lines, ref chips kept. The range is cut where it meets the default branch, and the cut is not one place: the branch's first commit has its parent on the default branch, and so does every `Merge main into topic` on it. The lane layout holds a lane open for every parent it is still waiting for, so a branch that merged `main` in five times would grow five lines running to the bottom of the list — lines to commits that are never listed, which is what [git-history-ui.md](git-history-ui.md#goals-and-constraints) refuses to draw. No notice says so, unlike a search's: the heading, `Not on main`, already says the list is a selection.
- **Paging**, its loading and failed rows and `Retry` are History's ([git-history-ui.md](git-history-ui.md#paging-and-states)); the end row reads `Older commits are on main too` — **in a shallow clone as well**. `git.log`'s `shallow` describes the clone, not the walk: the range stops at the default branch long before it reaches the clone's edge, so History's `Older history isn't in this clone` would be wrong here.
- **A row's `⋯`** is History's commit menu, with one difference in what it knows. History tells "in HEAD's history" by walking down from the row carrying `HEAD` (`headHistoryFlags`), which assumes HEAD is a tip of the range; in `scope=branch` it is not, unless this branch is current. So on the current branch's detail every commit is in HEAD's history (the range is HEAD's own commits), and on any other branch's the list does not know — the filtered list's case, where `Ask AI to revert` is offered and the prompt itself asks the agent to stop if the commit is not on the branch ([git-history-ui.md](git-history-ui.md#the-commit-menu)).
- **Shared with History, not copied** — `useHistoryPaging` (when the next page is asked for, `Retry`, the footer; each caller passes its own end text) and `useCommitMenu` (the `⋯` state, its target resolved against the current rows, and the mounted `CommitActions` the menu and the revert handoff live in), both in `Git/`, moved out of `HistorySection` for this. `HistoryList` itself has one addition, below.

| Case | In the commits' place |
|---|---|
| The branch is the default | `This is the default branch.`, muted, and no read: `git.log` lists nothing for it |
| No default branch (`default_branch` empty) | `No default branch to compare with.`, muted, and no read: `git.log` refuses the scope then |
| A remote row a local branch shares the name of | `Can't list these commits: a local branch is also named origin/topic.`, muted, and no read (why is below the table) |
| `vs_default.ahead` is 0 | `Nothing here that main doesn't have.`, muted, and no read — the branch is merged, by the list's own count |
| The first page is empty | The same line — the read and the count are two answers, and disagreed for a moment |
| First page loading / failed | History's centred spinner / `Failed to load commits` and the reason |

The four cases that ask nothing are tested in that order, so the first that holds is the one said (`unlistedReason` in `Git/BranchCommits.tsx`).

**One scroll area.** The facts, the actions and the commits scroll together, as `CommitView`'s header, parents and files do: on a 568px phone a fixed header this tall would leave the commits a strip. `HistoryList` scrolls on its own in History; here it is given the page's scroll area through its `scroller` prop (`{ element, margin }` — `useVirtualizer`'s `getScrollElement` and `scrollMargin`, with each row translated by its start less the margin, and the kept top row counted from the margin). The block above it changes height — a pinned failure, the inspect's banner, the name wrapping differently after a resize — so the margin is measured live by `hooks/useOffsetWithin` (a `ResizeObserver` on the scroll area's content), not once. `BranchDetail` holds the scroll area and its content in state rather than refs: the list mounts only once the scroll area exists, and its margin is followed once the content does. `BranchDetail.browser.test.tsx` holds this in a real browser: rows start under the heading, and the mounted range still matches the screen after the content above grows.

**Live.** The detail reads `git.branches` through the list's own query (`useGitBranches`) and finds its row by key (`findBranchRow`), so it is re-read on every `git.changed` with the list and the facts cannot describe a different moment from the list's rows. The commits re-read on the same notification, as History's do. **The commits are asked for only while the row is found** (`useGitLog`'s `enabled`): `git.log` refuses an unknown branch as invalid params, and a detail of a branch that is gone must say that, not `Failed to load commits`. That includes the moment its own delete is answering, when the page still shows its last row ([When the branch goes away](#when-the-branch-goes-away)) but the branch is no longer listed.

**A local branch named like a remote one.** Where a local `origin/topic` exists beside a remote-only `origin/topic`, `git.log` resolves the name to the local one, so the remote row's detail cannot list its own commits: in their place it says `Can't list these commits: a local branch is also named origin/topic.`, muted, and asks nothing. Its facts and actions are its own, read from its row.

### Beside the list

The same page in the right column, its `PageHeader` drawn as the column heading by `InlinePageHeaders` with **no `←`**: its parent, the list, is on screen beside it — as for a commit beside History ([git-ui.md](git-ui.md#at-expanded-two-columns)). The row stays lit; another row tapped pushes that branch's detail in its place, as another commit does in History. The pinned failures are not drawn here ([The pinned area](#the-pinned-area)). A resize across the breakpoint keeps the same URL, so the same branch, as every layer does.

### Opening a commit

A commit row in the detail opens the commit layer, **stacked on the branch** the way commit-diff stacks on commit: `{ type: "commit", hash, branch: { ref, remote } }`, URL `/commit/<hash>?branch=<ref>` plus `remote=1` for a remote-only branch — the branch's whole identity, so `Back to branch` and the lit row find the row the commit was opened from. `branch` is what makes it the Branches segment's — `gitSegmentOf` gives `branches` when it is present and `history` otherwise — and it is carried on, as the history query is, by everything opened from there: commit-diff, commit-file, and a parent row, which pushes another commit with the same `branch`. A commit layer carries `branch` or a history query, never both.

| Width | Commit opened from a branch |
|---|---|
| Below `expanded` | Full screen, as from History. Its `←` reads `Back to branch` and goes to `/branch/<ref>` (with `remote=1` when it was carried) — a navigate to the parent, pushed, as commit-diff → commit is |
| At `expanded` | Left column: the Branches list, that branch's row lit. Right column: the commit, its heading keeping a `←` back to the branch — the branch is not on screen, so unlike a commit beside History it has a parent to go back to |

Both `←`s are `GitWorkspace` handing `CommitView` an `onBack` that opens the branch's detail; its label follows the layer (`Back to branch` when `branch` is carried, `Back to history` otherwise). The commit page is otherwise unchanged — its own `⋯` included, which already keeps to what it knows without a list ([git-history-ui.md](git-history-ui.md#the-commit-menu)). What a commit layer carries on is one function, `commitOriginOf(overlay)` in `types/overlay.ts` — the branch of a branch's detail, or the `branch` or history query a commit layer already has — used by `AppShell`'s `handleSelectCommit`, `CommitView`'s parent and file rows, `CommitDiffView`'s neighbours, commit version and back, `CommitFileView`'s back, and `lib/navigation.ts`; `useRouteState` reads it back, and a typed URL naming both `branch` and a History query is taken as the branch's.

**Accepted: back to a branch starts at the top of its page.** Opening a commit replaces the branch's detail layer, which unmounts it; `Back to branch`, or the browser's Back, opens a fresh page, scrolled to the top of the facts rather than to the commit row the reader left. History does not have this, because what a commit stacks on there is the list itself, which stays mounted (covered) under a layer below `expanded` — the branch's page is a layer, not the list, and only one layer is mounted at a time. Keeping the place would mean remembering a scroll offset per branch past the page's life, a store of its own for a page that is short above its commits and usually read from the top; that cost was judged not worth it. At `expanded` the list beside the commit keeps its own place, as every list does.

### When the branch goes away

- **After Switch.** The detail stays: the switch's report is the facts turning to `current` and the actions going, and the top bar's name changing — the same "success shows where the user is looking" a switch from the list has.
- **A remote-only branch that became local.** Once a local `topic` exists, `origin/topic` is no longer remote-only and has no row (the list hides a remote branch that has a local one). Whoever made it — a switch from this detail, from the list's `⋯` beside it, an agent — the detail of `remote:origin/topic` then **replaces** its route with the detail of `local:topic`: the same work, now under the name the list shows it by, not a page for a ref that left the list. The local name is the remote row's `name` (what checkout takes) — not something to cut out of `ref`, since a remote's name may have slashes — so the detail keeps the last row it found, as it does while a delete runs. A detail that never saw the remote row — opened after the change, by a commit's `Back to branch` or a link — finds the local branch by its `upstream` instead. The replace goes through the same `handleRepointBranch`, once per page; until it lands the page shows neither the row nor the gone notice.
- **Deleted from this workspace.** A delete of the branch whose detail is on screen — pressed in the detail, or in the `⋯` of its lit row at `expanded` — leaves the detail for the list when it **succeeds**, replacing the route, so Back does not reopen a branch that is gone; at `expanded` that is the list with the empty-detail line. The row is gone from it, which is the whole report, as from the menu. If the branch had an upstream, it now appears under Remote, and is not selected: the user deleted a branch, not asked to read another. What tells success apart is the delete's own outcome, not the row going: `gitCheckoutActions.startDelete` never rejects — a failure is kept in `gitCheckoutStore` — but resolves to whether the branch was deleted, and only then does `useBranchActions` report it (`onBranchDeleted`, whichever surface pressed it). The workspace hands that to `AppShell`'s `handleRepointBranch(from, null, worktree)`, which replaces the route only if that branch's detail is still the page, in the worktree the delete ran in — `handleCloseGitFile`'s guard, for its reason: the answer can land after the reader moved on. A failed delete leaves the detail where it was, the failure where [The pinned area](#the-pinned-area) puts it. The delete invalidates the list before it answers, so the row can be gone a moment before the outcome arrives: from the moment that branch's delete is running (`deleting`) until the branch is listed again, the detail keeps showing what it last had instead of the notice below — past the delete's end too, since `deleting` clears a render before the route is replaced, and the notice would flash in between.
- **Gone some other way** — deleted by an agent or in another worktree, pruned by a fetch — and a deep link or a typed URL naming no branch: the detail says so in its place, `No branch named <ref>.`, muted and centred, with a `Back to branches` text button (L4), until the user leaves. It does not leave on its own: a page that vanishes under a reader looks like a bug. At `expanded` no row is lit. A commit opened from that branch stays open — commits do not go with a branch name — and its `Back to branch` leads to the same notice (unless the branch became local, above).
- **While `git.branches` loads** the facts are skeletons; when it failed with nothing cached, `Failed to load branches` and the reason, as the list says.

## Deleting a local branch

### What "merged" means here

**A branch is merged when deleting it loses no commit**: every commit on it is also reachable from another local branch or a remote-tracking ref. The count in the danger confirm is the commits for which that is not so (the command is [git.md](git.md#deleting-a-branch)'s).

That is deliberately not `git branch -d`'s test (merged into HEAD or into the branch's upstream). What the user is deciding is whether anything is lost, and `-d`'s answer depends on which branch happens to be checked out: a branch merged into `main` reads as unmerged from a feature branch, and the confirm would cry wolf. With "lost commits" as the measure there is one number, it means the same thing from every branch, and "merged" is simply that number being zero.

Two cases read differently from what the user might expect, and the copy stays with what is true rather than guessing:

- **A squash-merged branch reads as unmerged**, because its commits really are on no other branch — their changes are, under different commits. The user who merged it knows.
- **Remote-tracking refs are as fresh as the last fetch.** A branch whose commits survive only in `origin/x` reads as merged; if the remote deleted `x` since the last fetch (a merged pull request with auto-delete), the next automatic fetch prunes `origin/x` and the commits go with it. The confirm says `origin/x stays on the remote` only as of the last fetch, which the sync chip dates. Fetching before every inspect would make Delete wait on the network, and the automatic fetch already keeps the window short ([git-ui.md](git-ui.md#automatic-fetch)).

### Flow

1. **`Delete branch` in the menu or the detail** asks the server for the cost: `git.branch.inspect { name }` → `{ tip, subject, unique, upstream }` — the tip's full hash (the copy shows it abbreviated; the delete sends it back whole, since an abbreviation can be ambiguous) and its subject, the lost-commit count, and the upstream ref (`origin/old-spike`) when one is configured **and** its remote-tracking ref exists; otherwise absent, since there is then nothing to say stays on the remote. The row shows `MenuRow`'s `busy` spinner meanwhile; a second press is ignored. If the inspect fails, the sheet stays open and the failure is an `ErrorBanner` at its top — in the detail, above its actions. That includes a branch that is gone (`old-spike no longer exists.`); the next `git.changed` refresh drops its row, and the sheet goes with it, since a menu for a branch that is not there has nothing left to offer — the detail turns to its gone notice ([When the branch goes away](#when-the-branch-goes-away)).
2. **The sheet closes and the confirm opens** — sheets do not nest, and a dialog over a sheet would be two dismissals for one decision (`ChangedFileMenu`'s order). From the detail there is no sheet; the confirm opens over the page.
3. **Confirming** sends `git.branch.delete { name, tip }`. The dialog stays up, working, while it runs (`onConfirm` returns its promise) — but that promise always resolves: **a failure closes the dialog and goes to the [pinned area](#the-pinned-area)** — the list's, a narrow detail's, or the top bar's, by that section's rule, through `gitErrors` like every other write. Where the run and its failure are kept so that they outlive the dialog, and when the failure clears, is [git-ui.md](git-ui.md#results-that-outlive-the-page)'s. `ConfirmDialog`'s own error line is one uncapped paragraph with no summary/detail split; git's stderr does not belong in it, and a server refusal (busy, operation in progress, branch changed) is not something retrying from the same dialog can fix.
4. **On success** the dialog closes and the row is gone on the refresh the write invalidates — no message of its own, the rule switch and sync follow. If the branch had an upstream, it now appears under Remote: that is the upstream, untouched, as the confirm said. A delete from the detail also leaves the detail for the list ([When the branch goes away](#when-the-branch-goes-away)).

**The server deletes only the tip that was confirmed.** `git.branch.delete` refuses when the branch no longer points at `tip` — something committed to it, or reset it, between the inspect and the confirm — and the failure reads `old-spike has changed since. Open its menu again to see what deleting it would lose.` That refusal has an RPC code of its own (`-32009`, beside `-32008`, which tells abort its operation changed; a branch deleted meanwhile gets the same code with `gone`, read as `old-spike no longer exists.`), so `gitErrors` recognises it by code and words it for the client — never by matching the server's sentence. The count the user agreed to is a count of *those* commits; deleting whatever the branch holds now would be deleting commits nobody was told about. This is `--force-with-lease`'s rule applied to a local ref, for the same reason ([git-ui.md](git-ui.md#remote-sync)).

Server-side, the delete takes the refs lock only, is refused during an operation in progress (`-32006`) and for the current branch or one another worktree has checked out (`-32010`), and then runs `git branch -D` — the order and the reasons are [git.md](git.md#deleting-a-branch)'s. What the client adds: `gitErrors`' busy names include `branch-delete: "deleting a branch"`, and `-32010` reads `Could not delete review: it is checked out in review-wt.` (`…: it is the current branch.` when `worktree` is empty) — the menu already says so, and the server is the boundary for a list that is out of date.

### Copy

**Merged** (`unique` is 0) — `ConfirmDialog`, default variant:

| | |
|---|---|
| Title | `Delete old-spike?` |
| Message | `Its commits are all on other branches, so nothing is lost.` — plus, when `upstream` is present, ` origin/old-spike stays on the remote.` |
| Confirm | `Delete branch` |

**Unmerged** (`unique` > 0) — `ConfirmDialog`, `variant="danger"`:

| | |
|---|---|
| Title | `Delete old-spike and 2 commits?` (`1 commit` in the singular) |
| Message | `2 commits on old-spike are on no other branch and no remote, and will be lost. Latest: 9692fc9 "Try a new layout"` — plus the upstream sentence as above |
| Confirm | `Delete 2 commits` |

- **The confirm button names the loss**, not the branch: on the danger dialog the thing being agreed to is the commits, and `Delete branch` would let a thumb agree to that without reading. `Abort`'s confirm is named by its outcome for the same reason ([git-conflict-ui.md](git-conflict-ui.md#abort)).
- **The latest commit is quoted** (`tip` and `subject` from the inspect) so the user can recognise the branch's work rather than trust a count.
- **No promise of recovery.** Deleting a branch deletes its reflog; whether its commits survive in some HEAD reflog depends on where they were made. The copy does not offer a way back it cannot guarantee.

## Asking the agent to merge

`Ask AI to merge into current branch` is the [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), as it is: the current session or a new one, appended to the draft, never sent.

- **The hook belongs to the workspace** (`useBranchMergeHandoff`, called by `GitWorkspace`, which renders `OperationBanner` with its own handoff at the same level), not to the sheet nor to `BranchesSection` — the sheet closes on select and the segment unmounts when the user moves to another, and a pending state or an error handed to a component that has unmounted is one nobody sees ([agent-handoff-ui.md §1.4](agent-handoff-ui.md#14-no-current-session)). `isPending` is the whole hook's, so it also remembers which branch was pressed: that row's `⋯` slot shows the spinner (`Opening a new chat` to a screen reader), and so does the detail's `Ask AI…` row when that branch's detail is open (`MenuRow`'s `busy`). While it is pending (a new session being created; with a current session there is no pending state) every `Switch to this branch` and `New branch…` are unavailable — the prompt already names the current branch, and a switch now would make it wrong; and since the hold is the workspace's, leaving the segment and coming back finds it still in place. Rows stay openable: reading a branch changes nothing the prompt names. A switch and a pending handoff therefore never overlap, so one row never has two spinners. A failed create (`Couldn't start a new chat`) is a failure where [The pinned area](#the-pinned-area) puts the others. Leaving the workspace altogether is the prefill handoff's own case: the text waits in the new session's draft.
- **The text is built at the press** from the branches as they are then (`describeMergePrompt` in `lib/gitBranches.ts`, beside the rest of the list's copy), never from what the menu rendered. Prose only:

```
Merge old-spike into feature/git-ui, the branch checked out in this worktree. If the merge stops on conflicts, resolve them keeping what both sides meant, then finish the merge. If a conflict cannot be resolved safely, stop and explain it instead of guessing.
```

  A remote row names its ref, `Merge origin/colleague-branch into feature/git-ui, …` — that ref, as fetched, is what was shown and what will be merged; the agent may fetch first, which is its call. On an unborn branch the sentence is the same; the current branch is named by `head.branch` either way.

- **The default row warns the agent that it may be stale.** Local `main` is often checked out in the main worktree, so this workspace has no way to bring it up to date — Sync pulls only the current branch, and `main` cannot be switched to here. Its prompt therefore adds one sentence the user can delete, worded as a condition because the list does not know whether `main` has an upstream: `If main tracks a remote branch that is ahead of it, fetch and merge that branch instead.` It is added only when the repository has a remote (`sync.has_remote`); without one it could never apply. Other local rows are merged as they are.
- **Uncommitted changes do not gate it**, nor does the agent being busy ([agent-handoff-ui.md §1.5](agent-handoff-ui.md#15-the-targets-state-does-not-gate-the-handoff)). The agent sees the worktree; the user reads the request before it goes.
- **Nothing gates on "already merged"**: the list has no count against the *current* branch, only against the default, and an agent asked to merge something already contained says so in one line.
- **Afterwards**, if the agent's merge stops on conflicts, the workspace's operation banner takes over ([git-conflict-ui.md](git-conflict-ui.md)) — the handoff does not need to know.

## At `expanded`

The workspace's one skeleton ([git-ui.md](git-ui.md#at-expanded-two-columns)): list column | splitter | detail column, the list column the width every segment shares, resizable by the same handle. The Branches list fills its column like the other lists — the segmented control above it, `New branch…` as the column's bottom bar — and the branch, or a commit opened from one, is in the right column.

```
┌──────────────────────────────────────────────────────────────────┐
│ ←  Git                                                           │
├──────────────────────────────────────────────────────────────────┤
│ ⑂ feature/git-ui                                     ⟳ Synced    │
├────────────────────────┬─────────────────────────────────────────┤
│ Changes History [Bra…] │ …/branch-detail                         │  column heading, no ←
├────────────────────────┤─────────────────────────────────────────┤
│ [ Filter branches…   ] │ feature/branch-detail                   │
│ RECENT                 │ Tracks origin/feature/branch-detail     │
│ ✓ feature/git-ui       │ 3 ahead of main · 12 behind             │
│▌  feature/branch-de… ⋯ │ Last commit 2h ago by sijiaoh           │
│   main               ⋯ │ ⇄  Switch to this branch                │
│ LOCAL                  │ ✦  Ask AI to merge into current branch  │
│   old-spike          ⋯ │ 🗑  Delete branch                        │
│                        │ NOT ON MAIN (3)                         │
│                        │ ○  Draw the detail layer              ⋯ │
├────────────────────────┤                                         │
│ [ + New branch…      ] │                                         │
└────────────────────────┴─────────────────────────────────────────┘
```

- **With nothing chosen** the right column is `EmptyDetail`'s muted, centred line, `Select a branch to see its commits` — what the detail is mostly for, as History's says `Select a commit to see what it changed`; `No branches yet` when the list has none (an unborn branch and no other); blank while the list loads or its read failed, as for the other segments.
- **What went away.** Branches used to be the one segment without a right column, and the layout had grown three patches to keep that from showing: a flag for whether the segment has two columns, a `max-w-xl` cap on the list's width, and a wrapper holding the segmented control at the shared width when the list below it was not. They existed only because the skeleton depended on the segment; with every segment a list and a detail, it does not, and none of them is kept in any form. The splitter is drawn on Branches as on the others. `GitWorkspace.browser.test.tsx` holds it: a list dragged to a width of its own keeps its left edge and width, and the segmented control's, through History → Branches → Changes.
- The two-line rows, the menu sheet and the dialogs are the same components at every width.

## Decisions not to lose

- **Recent = checked out here recently, from this worktree's reflog**, capped at five rows by the list, and a branch appears in one group only. Commit time already orders Local.
- **Ahead/behind is against the default branch**, local when there is one, in words, not arrows — arrows are the chip's, and mean the upstream.
- **"Merged" is "deleting loses no commit"**, counted against every other branch and remote-tracking ref, not `git branch -d`'s HEAD-or-upstream test.
- **The lost-commit count is asked when Delete is pressed**, not carried in the list, and the delete is bound to the tip that was counted.
- **Delete failures go to the pinned area (or the top bar, off the segment), not the dialog**, held in a per-worktree store so they outlive the page, with git's words capped and no retry offered that cannot work.
- **A row selects, it does not act** — at every width. Switching is `Switch to this branch`, first in the `⋯` and in the detail; no row is greyed, since opening a detail has nothing to refuse.
- **The detail is a layer of Branches, `{ type: "branch", ref, remote }`** — the row's key, since a local and a remote row can read the same — reading the list's own query; a commit opened from it carries that same identity as `branch` and stacks under it, with a way back to the branch.
- **The detail's commits are `<default>..<branch>`**, the very commits the row counts as `ahead`, as History's filtered list — dots, no lines, since the range is cut wherever it meets the default branch.
- **Back to a branch starts at the top of its page** — the detail is a layer, unmounted under a commit opened from it; remembering its place would take a store of its own, and was judged not worth one.
- **The detail leaves on its own only after this workspace deleted its branch**; gone any other way, it says so and waits for the user.
- **The detail offers the menu's actions with the menu's reasons**, inline, none on the current branch; failures stay in one place — the list's pinned area while the list is on screen, a narrow detail's top while it is not.
- **One skeleton at `expanded`**: list | splitter | detail for every segment, with no Branches-only width rule left over.
- **No remote deletion, no UI-run merge.** Remote deletion affects others; a merge can strand a phone in conflicts, so it goes to the agent.
