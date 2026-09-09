# Git Panel UI

How the Git panel (`web/src/components/Git/`, entry `DiffTab`) presents the four everyday operations: commit, discard, branch, remote sync. Backend architecture is in [git.md](git.md); this document covers entry points, interaction flow, feedback and confirmation policy. The layouts and copy below are what the panel does — where the implementation departed from the original design, this file records the implementation.

The rules this panel shares with the Files panel — the visual weight ladder its
`L1`–`L5` references point at, what `th-accent` is allowed to mean, and the
narrow-width rule every fixed row below obeys — are in
[sidebar-ui.md](sidebar-ui.md).

## Goals and constraints

- **The panel is narrow.** `DiffTab` renders inside the tabbed sidebar: a `w-72` (288px) drawer on mobile, a 240–500px resizable column on desktop. Every layout below is drawn at 288px, and nothing may rely on width the panel does not have.
- **One-handed and touch-first.** Full-width rows are `min-h-[44px]`; icon-only buttons inside a row are `min-h-[36px] min-w-[36px]` (L5), defined once in `iconButtonClass.ts` so stage, unstage, discard, amend and dismiss cannot drift apart in weight.
- **One level of grouping.** `Staged` / `Changes` / `History` are the panel's only hierarchy; nothing wraps them in a second section that also has a header. *(This retires the earlier constraint "don't rewrite the information architecture — Changes / History stay exactly as they are". It was the right constraint while four operations were being added to a working panel, and it is what left the panel with two stacked header rows once they landed. See [sidebar-ui.md](sidebar-ui.md).)*
- **Reuse the existing vocabulary.** `th-*` tokens, `ConfirmDialog` from `@pockode/shared`, `BottomActionBar`, `SidebarListItem`, lucide icons, and the bottom-sheet-on-mobile / centered-modal-on-desktop pattern already used by `WorktreeCreateSheet` (extracted as `ui/Sheet`, which the four sheets below share).
- **Nothing stashes implicitly.** Pockode runs in worktrees that share one stash stack with the main checkout and every other worktree, so a stash the user did not ask for can be popped by a different session. No operation here creates one — a switch that git refuses is reported, not worked around.

## Layout

`DiffTab`'s root is a flex column with `overflow-hidden`, and `PullToRefresh` inside it is `flex-1` with its own scroll. That gives three bands: a fixed header, the scroll area, and a fixed footer, with the bars as siblings of `PullToRefresh` rather than content inside it.

```
┌──────────────────────────────────┐
│ ⑂ feature/git-ui         ↓2 ↑1   │  branch bar   — fixed, L2
├──────────────────────────────────┤
│ ⚠ Discard failed · Details     ✕ │  error banner — fixed, only after a failure
├──────────────────────────────────┤
│ STAGED 2                     ⊖   │  L3, sticky   ┐
│  M  DiffTab.tsx              ⊖   │               │
│  A  BranchBar.tsx            ⊖   │               │
│                                  │               │
│ CHANGES 3                 ↶  ⊕   │  L3, sticky   ├ scroll area
│  M  git.md                ↶  ⊕   │               │
│  ?  notes.txt             ↶  ⊕   │               │
│                                  │               │
│ ▸ HISTORY                        │  L3           ┘
├──────────────────────────────────┤
│ [          Commit (2)          ] │  commit bar — only when committable
└──────────────────────────────────┘
```

Both bars sit outside the scroll area, so branch identity and the commit action stay reachable no matter how far the user has scrolled into History. They also render outside the current `isLoading` / `error` branch: a failing `git.status` must not take the branch bar down with it.

### Group headers

`Staged` / `Changes` / `History` are L3 (`GroupHeader.tsx`): `text-xs uppercase tracking-wide text-th-text-muted`, no hover fill, count appended to the label rather than parenthesised. The branch bar stays L2 and is the panel's only header-weight row — the earlier `▾ Changes` section header, which wrapped two groups that already carried headers and counts, is gone along with its collapse state and its count.

**The headers are 36px, not the 32px the ladder names.** The container is `min-h-[32px]`, but a group with actions contains 36px L5 buttons and flex grows the row to fit them. Only `HISTORY`, which has no actions, is 32px. Shrinking the row would mean shrinking the touch targets, and the touch target is the one of the two that a thumb can miss.

Each group header is `sticky top-0` inside its own `flex flex-col` box, so it pins only over the list it labels and gives way as the next group arrives. That is the need the deleted collapse toggle was actually serving — collapsing `Changes` was how you scrolled past a long list to reach History.

> **Not yet verified on a device.** The scroll area is `PullToRefreshify`, which transforms its content during the pull gesture. `sticky` is expected to hold, since it resolves against the scrollport rather than the transformed box, and the gesture only starts at `scrollTop === 0` where the header is at its natural position anyway. That reasoning is from the library's source and the CSS spec, not from a rendered page — the sandbox has no browser and jsdom does no layout. **Confirm it on a real device.** If it does not hold, the fallback is removing `sticky top-0 z-10 bg-th-bg-secondary` from the one row of classes in `Git/GroupHeader.tsx`; nothing else in this section depends on it.

`Unstaged` is renamed **`Changes`**, matching VS Code's source-control naming — with the parent header gone there is nothing left for it to be confused with. The group actions are icon-only (`Plus` / `Minus`, the same icons the per-row stage buttons use) rather than the previous `Stage All` / `Unstage All` text, so their labels moved into `aria-label`: `Stage all files` / `Unstage all files`, derived from `staged`, and a constant `Discard all changes`. The discard label used to be built from the group title, which the rename would have turned into `Discard all changes changes`.

**A clean tree shows one muted `No changes` row** in place of both groups. It is a line of explanation instead of a blank band, so "clean" and "not loaded yet" cannot be confused, and History expands into everything below it.

## Branch bar

One row, `min-h-[44px]`, split into two independent targets so the whole thing stays a single line:

| Region | Content | Tap |
|--------|---------|-----|
| Left (`flex-1`, truncate) | `GitBranch` icon + branch name | Opens the **Branch sheet** |
| Right (chip button) | Sync state | Opens the **Sync sheet** |

Chip states, in priority order:

| State | Chip | Meaning |
|-------|------|---------|
| Diverged | `↓2 ↑1` | 2 to pull, 1 to push |
| Behind | `↓2` | |
| Ahead | `↑1` | |
| In sync | `⟳` | nothing to do, but fetch is still one tap away |
| No upstream | `Publish` | branch exists only locally |
| Upstream missing here | `Publish` | an upstream is configured but its remote-tracking ref is not in this repository — never fetched, or pruned after the remote branch was deleted. The counts are unknown rather than zero, so the chip must not read `⟳`; the sheet names the ref and offers fetch to update it or push to recreate it |
| No remote | chip hidden | nothing to sync with; the Sync sheet has no entry point |
| Detached HEAD | left region reads `detached @ 9692fc9`, chip hidden | commit still works; switching from here is an ordinary switch |

Counts are only as fresh as the last fetch, so the Sync sheet states when that was — `↓0 ↑0` must never silently stand for "up to date".

The bar shows whatever branch data it has, even while a refetch is failing: react-query keeps the last value alongside the error, and swapping a known branch name for a message would take the bar down for exactly the reason it renders outside `DiffTab`'s error branch. Only with nothing cached at all does it read `Branch unavailable`, with the query's error message in the title attribute.

**On the relationship with `WorktreeSwitcher`.** The sidebar header already shows a `GitBranch` icon with the worktree name, so two branch-shaped controls now sit in one column. They are kept apart by what they name: the header switches *workspace* and is labelled by worktree name (`review`), the branch bar switches *branch within this workspace* and always renders the real ref name. A branch already checked out in another worktree cannot be checked out here — git refuses — so the Branch sheet marks those rows disabled with an `in <worktree>` hint instead of letting the user find out through an error. Linked worktrees are named as the switcher names them; the main checkout reads `in main worktree`, because the switcher labels *it* by branch and "branch X is held by branch X" says nothing (see [git.md](git.md#branches)).

## Commit

The bottom bar holds at most one primary button (L1), and renders only while committing is on the table. `describeCommitAction` returns `null` for the two states that have no button:

| Working tree | Bar |
|--------------|-----|
| n files staged in the root | `Commit (n)` — enabled |
| changes, nothing staged anywhere | `Commit` — disabled, `Stage a file to commit` as an `sr-only` hint |
| staged only inside a submodule | `Commit` — disabled, with a **visible** line saying why |
| clean | **no bar** |
| `git.status` unreadable | **no bar** — the panel is already showing why |

Keeping the disabled button in the second case is deliberate: the user is on their way to committing, and a target that pops into existence as they stage the first file is worse than one that is visibly not ready yet.

Keeping it in the clean case is not: there is nothing to commit and nothing on its way to being committed, and 56px of permanently dead accent-coloured button is the loudest thing on a panel that has nothing to say. The bar no longer falls back to `Amend last commit` either — see [Amend](#amend).

**Whether a hint is `sr-only` follows one test: does the panel already show the reason?** `Stage a file to commit` names the stage buttons sitting right above the bar, so a line of text would repeat on screen what the screen already says — worth saying to a screen reader, not worth 20px. The submodule case fails that test, and gets a visible line.

That case exists because the two counts behind the bar are deliberately different. The **enabled count is the root repository's** staged files, since that is what `git.commit` records ([Submodules](#submodules)). Whether the bar renders at all follows the **flattened** counts, since those are what the file groups above it show — one function, `flattenGitStatus`, shared with `DiffTab`, so the bar and the groups cannot disagree about whether there is anything on screen. They diverge in exactly one state: files staged inside a submodule. There the rows read as staged like any other and nothing else on the panel accounts for a dead button, so the bar spends a line on `Only submodule files are staged; ask the agent in chat to commit them.` — the same referral the sync sheet makes for a diverged branch. The alternative, letting the bar vanish out from under a list of staged rows, is a silent failure.

The hint renders **above** the button, on the same rule the sheets follow: the bar already sits at the bottom edge, so a line under the button is the first thing an on-screen keyboard covers.

Tapping opens the **Commit sheet** rather than editing inline. A permanently mounted message box would cost ~80px of a 288px-wide, keyboard-crowded panel for an action taken a few times an hour; a sheet gives the textarea real room, lets the on-screen keyboard push it up, and costs one extra tap.

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

Amend is not a commit-bar label. It belongs to the last commit, and the last commit is already on screen: the first row of `HISTORY` is HEAD. That row carries a trailing L5 `⋯` (`Amend this commit`) which opens the same commit sheet with **Amend** pre-toggled — the same warning copy, the same force-push consequence line described above.

```
▾ HISTORY
   Add branch bar to git panel          ⋯   ← HEAD only
   9692fc9 sijiaoh, 2h ago
   Render every codex_changes event
   1c4b8e0 sijiaoh, 5h ago
```

Only the first row carries it. `git.Log` runs `git log -nN` from HEAD in reverse-chronological order (`server/git/git.go`), so `commits[0]` *is* HEAD whenever the list is non-empty — including on a detached HEAD, where amending is still legal. An unborn HEAD has no rows, which is the correct answer for "there is nothing to amend".

This costs zero permanent pixels, it is where a desktop client such as GitHub Desktop puts it, and it puts the message about to be replaced directly under the control that replaces it. The previous arrangement did the opposite: the panel's loudest control wore its sharpest and rarest action, and it stood in exactly the state — a clean tree — where the user had come to read history.

Both entry points go through `GitCommitSheet.tsx`, which is where `stagedCount`, `submodules`, `lastCommit` and the commit mutation are assembled; `CommitSheet` itself takes them as props and already understood `amendInitially`.

### History

`HISTORY` is a collapsible L3 group whose default follows what the panel has to show: **collapsed when there are changes, expanded when there are none.** The diff is the subject when a diff exists; on a clean tree history is the only thing to look at, and expanding it fills the panel.

The default is recomputed as the change count crosses zero, but only until the user toggles the section by hand. After that their choice stands for the rest of the session. That decision lives in `lib/gitPanelStore.ts` rather than in `DiffTab`'s own state, so it does not depend on the panel staying mounted — the tabbed sidebar hides inactive tabs with a class rather than unmounting them, but that is a layout detail, and the layout does remount across the desktop breakpoint ([frontend-state.md](code/frontend-state.md#why-a-store-for-panel-ui-state)). `useHistoryExpanded(changeCount)` returns `override ?? changeCount === 0`.

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

A batch of one — which the group header produces whenever a single file is unstaged — takes the single-file wording, because naming the file beats counting it. The classification behind all of this belongs to the server: the panel's list is as old as its last refresh, and the request carries paths only (see [git.md](git.md#discard)).

"This cannot be undone" is literal here: discarded worktree changes are not in the reflog, unlike nearly every other git mistake. That is why discard is the one file-level action in the panel behind a modal.

If the file currently open in the content area is among the discarded paths, the selection is cleared on success — otherwise the diff view sits on a file that no longer has a diff. The staged view of that same file is left open: throwing away unstaged edits does not empty it.

## Branch

The **Branch sheet**, opened from the left region of the branch bar:

```
┌──────────────────────────────────┐
│ ═══                              │
│ Switch branch                 ✕  │
├──────────────────────────────────┤
│ [ Filter branches…             ] │
│ ✓ feature/git-ui        current  │
│   main                           │
│   fix-session-create             │
│   review                in review│
│ ── Remote ────────────────────── │
│   origin/colleague-branch        │
├──────────────────────────────────┤
│ [ +  New branch…               ] │
└──────────────────────────────────┘
```

- Rows are `min-h-[44px]`. Long names truncate at the head, not the tail, so `…/git-ui` keeps the part that tells branches apart.
- The filter input appears once there are more than eight branches. It filters the list and nothing else; it never creates a branch.
- **The filter and any checkout refusal are pinned above the rows**, in one `sticky top-0` container at the top of the scrolling body. A list long enough to scroll is a list where filtering is the fast path, and a filter that scrolls away is one the user has to scroll back up to reach. The refusal is pinned for a sharper reason: the user's real path is to scroll halfway down and tap a branch, so a message rendered at the top of the scroll area lands off-screen and the tap reads as having done nothing — a silent failure. Git's verbatim output under it goes through `GitOutput` like everywhere else, which matters more here than anywhere: `would be overwritten by checkout` names every file in the way, and an unbounded refusal would pin more of the sheet than the list it is pinned over.
- Remote-only branches form a second group; picking one creates a local tracking branch of the same name and checks it out.
- **Uncommitted changes are neither stashed nor discarded.** The switch is attempted as-is, which git allows whenever no modified file differs between the two branches — the common case. When git refuses, the sheet stays open and shows the refusal with the offending paths plus one line of guidance: *Commit or discard these changes first.*
- `New branch…` opens a small sheet with a single name field. The base is fixed to current HEAD and stated as text (`Branches from feature/git-ui`) rather than offered as a third input: the panel is not the place to build a branch-from-arbitrary-ref picker, and `WorktreeCreateSheet` already covers that case. Uncommitted changes carry over to the new branch, which is standard git behaviour and worth one line of helper text.
- Branch deletion stays out: destructive, rarely urgent from a phone, and with no safe single-tap form.

**The sheet used to be unusable with many branches, and the cause was in `Sheet`, not here.** The content box capped its height on mobile (`max-h-[90dvh]`) and not on desktop (`mx-4 max-w-md rounded-xl`). Centred inside a `fixed inset-0` container, it spilled off the top and the bottom at once as soon as the list made it taller than the viewport, and nothing scrolled: the body is `min-h-0 flex-1 overflow-y-auto`, but `flex-1` of an uncapped column is the content's own height, so there was never any overflow to scroll — the `New branch…` footer went off-screen with the rest. Desktop now caps at `max-h-[85dvh]`. That is a fix in `ui/Sheet`, so every one of its users stops being able to reach that state — the four sheets in this document plus `Worktree/WorktreeCreateSheet`.

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
- **Pull is enabled whenever an upstream exists**, not when the panel believes there is something to pull:

  ```
  canPull = sync.has_remote && !needsPublish
  ```

  The earlier rule, `!needsPublish && sync.behind > 0`, gated on a counter only as fresh as the last fetch — and nothing in the panel fetches on its own, since `git.Fetch` is reachable only from the `git.fetch` RPC that the Fetch button calls. `behind` is therefore 0 on a freshly opened workspace and stays 0, disabling the button at exactly the moment someone reaches for it. It was also gating on the wrong thing: the backend's `git pull --ff-only` fetches first (`server/git/remote.go` says so, and measures the count afterwards for that reason), so pull is most useful precisely when the stale counter says there is nothing to pull. `behind` now shapes only the label — `Pull (2)` when positive, `Pull` when not. A pull with nothing to bring in ends in `Already up to date.`, which is a truthful answer and a cheap one.

  `has_remote &&` is logically redundant here: the server's `syncInfo` returns before it ever looks up an upstream when the repository has no remote (`server/git/remote.go`), so `upstream != "" ⟹ has_remote`. It is kept because this is a wire boundary, and because `canPush` beside it has the same shape — a second spelling of the same condition would be the thing worth avoiding.
- **Pull is fast-forward only.** A merge started by one tap on a phone can strand the user in a conflicted worktree with no tooling to get out. When `--ff-only` fails because the branches diverged, the sheet reports that plainly and points at the escape hatch that does exist on a phone: asking the agent in chat to merge or rebase, which is the product's whole premise.
- **Push** is a plain push. With no upstream the button reads `Publish branch` and sets upstream on success.
- **Force push exists only as a consequence of amend.** When the local branch has diverged such that a normal push cannot succeed, the Push button becomes `Push (force)` in `text-th-error` and requires a `ConfirmDialog` (`variant="danger"`): *Overwrites origin/feature/git-ui with your local history. Commits pushed by others will be lost.* The push itself uses `--force-with-lease`, so a race with someone else's push fails loudly instead of destroying their work. No unconditional `--force` anywhere in the UI.
- These are the only operations in the panel with unbounded duration. While one runs, its button shows a spinner and the gerund (`Pushing…`), the others are disabled, and the sheet cannot be dismissed. Nor can it while the force-push confirmation is up: `Sheet` and `ConfirmDialog` both listen for Escape on `document`, so a single key press would otherwise close the dialog and the sheet behind it. It stays open after success long enough to show the outcome (`Pushed 1 commit.`): a sheet that closes on its own leaves the user unsure whether anything happened over a slow relay link.

Branch and sync both read the root repository. Submodules keep their own HEAD and upstream, and the panel does not expose them.

## Feedback and errors

The project has no toast system — `WorktreeSwitcher` still carries a `TODO` about it — and the panel does not introduce one. The rule instead is **feedback appears where the action started**:

- **Actions started in a sheet** (commit, switch, create, fetch/pull/push) render their error inside that sheet, in the `text-th-error` + `role="alert"` form `WorktreeCreateSheet` already uses. The sheet stays open and the user's typed input survives.
- **Actions started inline** (discard, discard all) have no sheet to hold the result, so the panel gets a dismissible **error banner** directly under the branch bar: one line of plain-language summary, a `Details` disclosure revealing git's stderr in a mono block, and a `✕`. It holds the most recent failure only, and clears on dismissal or when a later discard succeeds on one of the paths that failed. An unrelated file succeeding is not a retry: dropping the message then would leave the file that failed sitting in the list with nothing on screen explaining why.

Verbatim git output is capped and scrollable wherever it appears, by going through one component — `Git/GitOutput.tsx`, `max-h-32 overflow-auto`. A rejected push runs to a dozen lines of `hint:`, and inside a height-capped sheet those lines come out of the very buttons the message is telling the user to press. The cap belongs to the output rather than to each of the four places that show it — written out four times, no two of the four fully agreed.

Both surfaces show git's own output *under* the summary rather than in place of it, matching the project's split between user errors (guidance) and system errors (technical detail) — the reader is a developer who needs to see `hook declined to update refs/heads/main`.

In-flight rules, uniform across the panel: the triggering control shows a spinner and a gerund label, controls whose outcome the running operation would change are disabled, and nothing is fired optimistically. A mutation then refreshes immediately rather than waiting out `GitWatcher`'s 3-second poll, invalidating what it can actually have changed: staging and unstaging touch only the status query, while commit, discard, checkout, create and the three sync operations move HEAD or the counts and so invalidate status, log and branches together.

Discard is the one that refreshes whether it succeeded or not. It is several git invocations behind a single tap, and a batch that failed part-way has still deleted files; refreshing only on success would leave those rows on screen until the next poll.

## Data behind the panel

None of these queries runs on a refetch interval; `git.changed` is what drives all three together. `git.status` backs the file lists, `git.log` the history, and `git.branches` answers with HEAD (branch or detached hash, plus the message amend prefills), the local branches annotated with the worktree occupying each, the remote-only branches, and the sync state — one answer, so the branch name and the chip beside it can never disagree about which branch they describe.

Beyond the components named above, the panel's own supporting modules are:

| Module | Role |
|--------|------|
| `Git/GroupHeader.tsx` | The L3 group header — label, optional collapse toggle, optional L5 actions. One definition, so the sticky background and the rung's typography cannot drift between the file groups and History |
| `Git/iconButtonClass.ts` | The L5 icon button's classes, shared by `DiffFileItem`, `DiffFileList`, `LogList` and `ErrorBanner`. It stays under `Git/`, and the Files panel's square in-row L5 — the tree row's `…` — writes its own copy instead of importing it. The two sit in the same kind of place, so what keeps them apart is the one thing this file exists to hold fixed: the 36px floor, which the tree's `…` takes at 44 instead. Promoting this to `components/common/` would therefore mean parameterising the height, which is to say sharing everything about the rung except the part that made it a rung. That divergence is not a Git-side decision and is flagged for resolution in [sidebar-ui.md](sidebar-ui.md#visual-weight) |
| `Git/GitOutput.tsx` | The capped, scrollable block holding git's own words, shared by the error banner and the commit, branch and sync sheets |
| `Git/GitCommitSheet.tsx` | The connecting layer between the commit sheet and the panel's queries, shared by the commit bar and the HEAD row's amend |
| `lib/gitPanelStore.ts` | History's expanded state for the session (see [History](#history)) |

The writes are `git.add` and `git.reset`, which the panel already had, plus `git.discard`, `git.commit`, `git.checkout`, `git.branch.create`, `git.fetch`, `git.pull` and `git.push`. A failure comes back as git's own words — stderr for most of them, stdout as well for commit, which is where git puts `nothing to commit` — and that text is what both surfaces above show under their summary. Shapes, and the server-side reasoning behind them, are in [git.md](git.md).

## Out of scope

Deliberately excluded, to keep the panel at "the everyday operations, done well": conflict resolution, interactive rebase, cherry-pick, revert, tags, stash, branch deletion, remote management, per-hunk staging, submodule commit/branch/sync, and a global toast system.

---

**Why this file lives here.** `docs/` holds per-feature design documents (`file.md`, `agent-chat.md`, `git.md`); `docs/code/` is reserved for explaining why the code of a *core module* is built the way it is (WebSocket, Agent, Work, Subscription, Relay), and `docs/projects/` for the project-management system. A UI design for a feature panel is none of those, so it sits beside `git.md` as `git-ui.md` — `git.md` keeps describing the git backend and links here for the surface built on top of it. What this panel and the Files panel have to agree on, rather than what either one looks like, is one level up in [sidebar-ui.md](sidebar-ui.md).
