# Git Branches UI

The Branches segment of the Git workspace (`Git/BranchesSection.tsx` around `Git/BranchList.tsx`): which branches it lists and in what order, what each row says, and the two things a branch's `⋯` offers — deleting a local branch, and handing a merge into the current branch to the agent.

Everything not mentioned here — the top bar, segments and routes, switching and `New branch…`, the feedback and error rules — stays as [git-ui.md](git-ui.md#branch) describes it. The handoff to the agent is the existing [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), unchanged; this file defines only its text and where its entry sits.

Copy below is the UI's English.

> **Status: built** — the list, the menu, deleting a local branch and the merge handoff.

## Goals and constraints

- **Answer "which branch do I go to" on the row.** The list used to be names only. Choosing where to switch — or what to clean up — needs two more facts per branch: how far it is from the default branch, and when it last moved. Both go on the row, in muted text, so the name stays what is read first.
- **The branches the user is working with are within reach without filtering.** A repository an agent works in grows branches fast; the ones that matter today are few, and they are the ones checked out recently, not merely the ones committed to recently (an agent in another worktree commits to its own branch all day).
- **Deleting is possible and says exactly what it costs.** A branch whose commits are all somewhere else is cheap to delete and gets an ordinary confirm. A branch with commits nowhere else gets a danger confirm with the number of commits that go with it. Nothing is deleted on one tap, and nothing that would break another worktree can be deleted at all.
- **The workspace never merges.** A merge can stop on conflicts, and a conflicted worktree on a phone is what [git-conflict-ui.md](git-conflict-ui.md) exists to get out of. So "merge this branch" is a prefill for the agent, never a `git merge` run by the UI — the rule pull's `--ff-only` already follows ([git-ui.md](git-ui.md#remote-sync)).
- **Switching and creating do not change.** A switch is still attempted as-is with uncommitted changes, refused in place with git's words, never stashed; `New branch…` still branches from HEAD ([git-ui.md](git-ui.md#branch)).
- **Existing vocabulary.** `th-*` tokens, `MenuRow` in a `Sheet` for the row's menu, `ConfirmDialog` for both confirms, `ErrorBanner` / `GitOutput` for failures, `utils/gitErrors.ts` for telling git's refusals from the server's, `usePrefillComposer` for the handoff, `formatRelativeDate` for ages, `BranchName` for head-truncated names; the narrow-width rule ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)) and the 44px touch rule ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)).

**Out of scope:** deleting remote branches (it changes what everyone else sees, and has no single-device undo), renaming, setting an upstream, picking the default branch by hand, a branch detail column at `expanded`, comparing two arbitrary branches.

## What the list reads from the server

`git.branches` keeps its shape and gains the fields below; how the server computes them is [git.md](git.md#branches)'s to define. One answer still carries everything, so the rows, the top bar and the chip cannot describe different moments.

| Field | Where | Meaning |
|---|---|---|
| `default_branch` | top level | What the counts are taken against, as displayed: `main`, or `origin/main` when there is no local one. Empty when the repository has none, and then no row shows counts |
| `recent` | top level | Local branches checked out in **this worktree**, most recent first, current branch included — read from this worktree's HEAD reflog (its last 1000 moves). Not capped by count; the list takes what it shows ([Groups](#groups)) |
| `committed_at` | each local and remote row | ISO date of the branch's last commit |
| `vs_default` | each local and remote row | `{ ahead, behind }` against `default_branch`. Absent on the default branch itself, with no default branch, and on remote rows when git predates `%(ahead-behind)` (2.41 — Apple's git is older), where counting each remote branch would cost a process apiece |

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
│   review                      ⋯  │  greyed  │
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
| **Remote** | Remote-only branches, as today | Last commit, newest first |

- **"Recent" means checked out here recently, not committed to recently.** Local is already sorted by commit time; a Recent group sorted the same way would just repeat its top rows. What commit time cannot tell is which branches *this user, in this worktree* has been moving between — the review branch they hop to and back, `main` they keep returning to — and the reflog of this worktree's HEAD records exactly that. It is per worktree on purpose: in another worktree the user works on other things. It is the definition GitHub Desktop's "Recent branches" uses, which is a reasonable thing for a user to already expect.
- **Five rows at most** (the current branch plus four): enough for the branches in active rotation, few enough to see without scrolling on a phone with the filter above. The cap is the list's, not the server's.
- **A branch is listed once.** A branch in Recent is not repeated in Local. Repeating it would make a long list longer and make a filter match show twice.
- **No Recent group in a small repository.** When the whole list is at most eight branches — the existing `FILTER_THRESHOLD`, the point at which the list fits on screen — there is no Recent group and no Local header: one list, the current branch first, then by last commit, then Remote under its header. Grouping a list that already fits is noise.
- **The current branch is the first row** whenever it has one. Two states have none: HEAD **detached** (no branch), and HEAD on an **unborn** branch (no commit yet, so no ref to list — and no HEAD to read a reflog from, so `recent` is empty). In both, Recent holds only what `recent` gives, and its header is drawn only if that is non-empty.
- **Headers** are the existing `Remote` header's style (`text-xs uppercase text-th-text-muted`, a top border on all but the first). They scroll with the rows; only the filter, the operation-paused line and failures are pinned — a second pinned band would eat the screen the pinning was meant to save.
- **Filtering** keeps the groups: a match is shown in its group, a group with no matches drops its header, and `No branches match.` when none do. The filter matches the name only, as today.
- **`Compared with main`** — one muted `text-xs` line above the first group, scrolling with the list, naming `default_branch`. The rows say `3 ahead`; this line says ahead of what, once, instead of on every row. Absent when `default_branch` is empty.

### The pinned area

Its rules — what is pinned, why, and the one capped box the failures share — are [git-ui.md](git-ui.md#branch)'s. This design adds two failure sources beside a switch's: a delete, and the merge handoff's session create ([below](#asking-the-agent-to-merge)) — each its own pinned failure (the summary, git's words in a `GitOutput` when there are any, its own `✕`), never merged, per [git-ui.md](git-ui.md#feedback-and-errors).

### The row

Two lines, `min-h-[52px]`, the row's button and its `⋯` siblings as in the Changes list ([git-changes-ui.md](git-changes-ui.md#the-file-row)):

| Part | Content |
|---|---|
| Left gutter | `Check` in `th-success` on the current branch; an empty 16px slot otherwise, so names line up |
| Line 1 | The name, `text-sm`, `BranchName` (truncates from the head). Remote rows show `ref` (`origin/x`), as today |
| Line 2, left (`min-w-0 truncate`) | Muted `text-xs`, parts joined by ` · `: the **state word** (below), `n ahead`, `n behind`. A part with nothing to say is dropped — `0 ahead` is never written |
| Line 2, right (`shrink-0`) | The age, `formatRelativeDate(committed_at)` (`2h ago`, `yesterday`, `3mo ago`) |
| Far right: `⋯` | L5 icon button, `More actions for <name>`. **Absent on the current branch's row**, whose every action would be unavailable (an empty slot keeps the names aligned) |

**State word** — at most one, the first that holds:

| Branch | Word |
|---|---|
| Current | `current` |
| Checked out in another worktree | `in <worktree>` — the existing wording, `in main worktree` for the main checkout ([git.md](git.md#branches)) |
| The default branch | `default` |

- **Counts are words, not arrows.** The top bar's chip already uses `↑ 2` / `↓ 3` for *this branch against its upstream*; arrows here, meaning *a branch against the default*, would read as the same fact about a different pair. `3 ahead · 12 behind` costs a few characters and cannot be confused with it.
- **All of line 2 is `th-text-muted`.** None of it is a failure or an action, so none of it earns colour ([sidebar-ui.md](sidebar-ui.md#visual-weight)); `40 behind` on an old branch is information, not a warning.
- **Occupied rows are greyed as today** — the row's button is disabled, line 1 in `th-text-muted` — but their `⋯` stays enabled: an occupied branch can still be merged from, and its menu says why it cannot be deleted.
- **Width.** At 320px the text column is about 210–230px once the row's padding, the gutter and the `⋯` are taken. An ordinary row (`2 ahead · 40 behind` beside `3mo ago`) fits; an occupied one with large counts does not — `in main worktree · 12 ahead · 140 behind` beside `11mo ago` needs about 290px. The age keeps its place and the left part truncates at its tail, so what goes is the end of the counts (`in main worktree · 12 ahead · 1…`) and what stays is the state word: `in <worktree>` is the reason a row is greyed and must not be the part cut.
- **Accessible name** of the row's button: the name, the state word, the counts against the default spelled once, and the age as shown — `old-spike, 2 ahead of main, 40 behind, last commit 3mo ago`. The `Compared with…` line is not something a screen reader user can be relied on to have passed.
- **While a switch runs** the tapped row shows the spinner in place of `⋯`; every other row's button is disabled as today, and their `⋯` stays openable — the menu's items say what is waiting.

## The branch's menu (`⋯`)

The project's menu shape: a `Sheet` of `MenuRow`s on both layouts, titled with the branch name as line 1 shows it (`origin/x` for a remote) — truncated as `Sheet` already truncates `ChangedFileMenu`'s long paths. Order is frequency; the destructive item is last, behind a divider, in `danger` style — as `ChangedFileMenu` and `FileEntryMenu`.

| Item | Shown on | Unavailable (`disabled`, with the sentence as `description`), first reason that holds |
|---|---|---|
| `Ask AI to merge into current branch` (`Sparkles`) | Local and remote rows | An operation in progress: `Finish or abort the <kind> first.` · HEAD detached: `Switch to a branch to merge into.` · A switch running: `Wait for the branch switch to finish.` · This branch's delete running: `Wait for the branch delete to finish.` · A merge handoff waiting for its new chat: `Wait for the new chat to open.` |
| — divider — | | |
| `Delete branch` (`Trash2`, danger) | **Local rows only** | An operation in progress: `Finish or abort the <kind> first.` · Checked out in another worktree: `Checked out in <worktree>.` · A switch running: `Wait for the branch switch to finish.` · Another delete running: `Wait for the branch delete to finish.` |

- **Remote rows have no `Delete branch`, not a disabled one.** `MenuRow`'s rule is that an action that *could* apply is kept and says why not; deleting a remote branch never applies here, so it is absent, as `Pull` is absent rather than disabled on an unpublished branch ([git-ui.md](git-ui.md#remote-sync)).
- **The merge waits for an operation before it asks for a branch.** A rebase detaches HEAD, and `Switch to a branch` is not the way out of a rebase — nor possible during one.
- **The merge label does not name the current branch.** It would have to be head-truncated inside a `MenuRow` label, which is a plain string, and the current branch is in the top bar directly above the sheet. The prompt the label leads to names both branches ([below](#asking-the-agent-to-merge)).
- **Delete stops for any operation in progress**, not only for the branch the operation is on. During a rebase HEAD is detached, so the branch being rebased is neither `current` nor occupied by the list's reckoning, yet `git branch -D` refuses it; rather than special-case that one row, delete waits like the other ref-moving writes, and the server refuses it the same way (`refuseDuringOperation`, as checkout and create do). A rebase running in *another* worktree has the same blind spot and is not detected here: git refuses the delete, and the refusal is shown as any delete failure is.
- **On an unborn branch** the merge is available — git merges into an unborn branch by pointing it at the merged commit, and the agent can do that.
- **No `Switch to` item.** Tapping the row is that, and a second way to the same thing would only raise the question of whether it is different.

## Deleting a local branch

### What "merged" means here

**A branch is merged when deleting it loses no commit**: every commit on it is also reachable from another local branch or a remote-tracking ref. The count in the danger confirm is the commits for which that is not so (the command is [git.md](git.md#deleting-a-branch)'s).

That is deliberately not `git branch -d`'s test (merged into HEAD or into the branch's upstream). What the user is deciding is whether anything is lost, and `-d`'s answer depends on which branch happens to be checked out: a branch merged into `main` reads as unmerged from a feature branch, and the confirm would cry wolf. With "lost commits" as the measure there is one number, it means the same thing from every branch, and "merged" is simply that number being zero.

Two cases read differently from what the user might expect, and the copy stays with what is true rather than guessing:

- **A squash-merged branch reads as unmerged**, because its commits really are on no other branch — their changes are, under different commits. The user who merged it knows.
- **Remote-tracking refs are as fresh as the last fetch.** A branch whose commits survive only in `origin/x` reads as merged; if the remote deleted `x` since the last fetch (a merged pull request with auto-delete), the next automatic fetch prunes `origin/x` and the commits go with it. The confirm says `origin/x stays on the remote` only as of the last fetch, which the sync chip dates. Fetching before every inspect would make Delete wait on the network, and the automatic fetch already keeps the window short ([git-ui.md](git-ui.md#automatic-fetch)).

### Flow

1. **`Delete branch` in the menu** asks the server for the cost: `git.branch.inspect { name }` → `{ tip, subject, unique, upstream }` — the tip's full hash (the copy shows it abbreviated; the delete sends it back whole, since an abbreviation can be ambiguous) and its subject, the lost-commit count, and the upstream ref (`origin/old-spike`) when one is configured **and** its remote-tracking ref exists; otherwise absent, since there is then nothing to say stays on the remote. The row shows `MenuRow`'s `busy` spinner meanwhile; a second press is ignored. If the inspect fails, the sheet stays open and the failure is an `ErrorBanner` at its top. That includes a branch that is gone (`old-spike no longer exists.`); the next `git.changed` refresh drops its row, and the sheet goes with it, since a menu for a branch that is not there has nothing left to offer.
2. **The sheet closes and the confirm opens** — sheets do not nest, and a dialog over a sheet would be two dismissals for one decision (`ChangedFileMenu`'s order).
3. **Confirming** sends `git.branch.delete { name, tip }`. The dialog stays up, working, while it runs (`onConfirm` returns its promise) — but that promise always resolves: **a failure closes the dialog and goes to the list's [pinned area](#the-pinned-area)** (or the top bar, off the segment), through `gitErrors` like every other write. Where the run and its failure are kept so that they outlive the dialog, and when the failure clears, is [git-ui.md](git-ui.md#results-that-outlive-the-page)'s. `ConfirmDialog`'s own error line is one uncapped paragraph with no summary/detail split; git's stderr does not belong in it, and a server refusal (busy, operation in progress, branch changed) is not something retrying from the same dialog can fix.
4. **On success** the dialog closes and the row is gone on the refresh the write invalidates — no message of its own, the rule switch and sync follow. If the branch had an upstream, it now appears under Remote: that is the upstream, untouched, as the confirm said.

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

- **The hook belongs to the workspace** (`useBranchMergeHandoff`, called by `GitWorkspace`, which renders `OperationBanner` with its own handoff at the same level), not to the sheet nor to `BranchesSection` — the sheet closes on select and the segment unmounts when the user moves to another, and a pending state or an error handed to a component that has unmounted is one nobody sees ([agent-handoff-ui.md §1.4](agent-handoff-ui.md#14-no-current-session)). `isPending` is the whole hook's, so it also remembers which row was pressed: that row's `⋯` slot shows the spinner (`Opening a new chat` to a screen reader). While it is pending (a new session being created; with a current session there is no pending state) the rows and `New branch…` are disabled as during a switch — the prompt already names the current branch, and a switch now would make it wrong; and since the hold is the workspace's, leaving the segment and coming back finds it still in place. A switch and a pending handoff therefore never overlap, so one row never has two spinners. A failed create (`Couldn't start a new chat`) is a failure in the [pinned area](#the-pinned-area) while Branches is on screen, and an `ErrorBanner` under the top bar anywhere else in the workspace — the `branchesOnScreen` rule a switch's failure follows. Leaving the workspace altogether is the prefill handoff's own case: the text waits in the new session's draft.
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

Unchanged from [git-ui.md](git-ui.md#at-expanded-two-columns): no right column, the list left-aligned up to `max-w-xl`. The two-line rows, the menu sheet and the dialogs are the same component at every width.

## Decisions not to lose

- **Recent = checked out here recently, from this worktree's reflog**, capped at five rows by the list, and a branch appears in one group only. Commit time already orders Local.
- **Ahead/behind is against the default branch**, local when there is one, in words, not arrows — arrows are the chip's, and mean the upstream.
- **"Merged" is "deleting loses no commit"**, counted against every other branch and remote-tracking ref, not `git branch -d`'s HEAD-or-upstream test.
- **The lost-commit count is asked when Delete is pressed**, not carried in the list, and the delete is bound to the tip that was counted.
- **Delete failures go to the pinned area (or the top bar, off the segment), not the dialog**, held in a per-worktree store so they outlive the page, with git's words capped and no retry offered that cannot work.
- **No remote deletion, no UI-run merge.** Remote deletion affects others; a merge can strand a phone in conflicts, so it goes to the agent.
