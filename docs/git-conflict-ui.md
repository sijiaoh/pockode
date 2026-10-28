# Git In-Progress Operation UI

What the Git workspace shows when the repository has stopped partway through a **merge, rebase, cherry-pick or revert** — usually on conflicts — and the two ways out it offers: hand the work to the agent, or abort. The workspace never starts these operations itself ([git-ui.md](git-ui.md#out-of-scope)); the agent, or the user somewhere else, does. Without it nothing on screen would say the repository is in that state, and on a phone there would be no way to tell, let alone get out.

Everything not mentioned here — the top bar, segments and routes, the Changes list and the review, the commit sheet, feedback and error banners, the write queue — stays as [git-ui.md](git-ui.md) and [git-changes-ui.md](git-changes-ui.md) describe it. The handoff to the agent is the existing [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), unchanged; this file defines only its text and where its entries sit.

Copy below is the UI's English.

## Goals and constraints

- **Say the state; offer the agent and a way back.** The workspace does not resolve conflicts and does not continue the operation. It makes the state legible — what is happening, between what, how far along, which files are in the way — and offers exactly two actions: `Resolve with agent` and `Abort`.
- **Nothing that would make it worse is one tap away.** Several everyday controls mean something different, or something dangerous, in the middle of an operation: staging a conflicted file records its conflict markers as the resolution; committing during a rebase inserts a commit in the middle of it. Those controls stop, and each says why ([What stops while an operation is in progress](#what-stops-while-an-operation-is-in-progress)).
- **It is live state, never an event.** The banner is drawn from what the server says about the repository now, and goes the moment the repository leaves the state — whoever finished it. Nothing is recorded ([AGENTS.md](../AGENTS.md), "Events are events, state is state").
- **Existing vocabulary.** `th-*` tokens, `ErrorBanner`, `ConfirmDialog`, `GitOutput`, `usePrefillComposer`, lucide icons; the narrow-width rule ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)) and the 44px touch rule ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)) hold for every row below.

**Out of scope:** picking "current" or "incoming" per file, a `Continue` button, `git am`, bisect, and in-progress operations inside submodules — the root repository only, as for branch and sync ([git-ui.md](git-ui.md#remote-sync)).

## What the workspace reads from the server

The server's side is [git.md](git.md)'s to define; it rides on `git.status`, so the banner, the list's conflict rows and the change count are one snapshot and cannot disagree about which files are conflicted. `git.changed` already fires on the index and `.git` changes that start and end an operation. What the UI reads, for the root repository of the worktree on screen:

| Field | Used for |
|---|---|
| `operation.kind` — `merge` · `rebase` · `cherry-pick` · `revert` | Every title, the abort, the prompt |
| `operation.commit` — `{hash, subject, ref?}` | Merge: what is merged in, by `ref` when a branch points at it, else its short hash. Rebase: the commit being replayed. Cherry-pick, revert: the commit picked or reverted. Absent between two commits of a sequence |
| `operation.branch` | Rebase only: the branch being rewritten, since HEAD itself is detached. For the other kinds the branch is HEAD's, from `git.branches` as the top bar already reads it |
| `operation.onto` — `{hash, subject, ref?}` | Rebase: what it replays onto, by `ref` or short hash |
| `operation.step` — `{current, total}` | Rebase progress. Absent when git does not keep count; never guessed |
| `conflicted` — paths | The banner's file list and the conflict rows |

What kind of conflict a path is comes from the status letters it already carries on its two sides, so nothing more is sent: `D` on both sides is *both deleted*, `D` on one side *deleted on one side, changed on the other*, anything else (`UU`, `AA`, `AU`, `UA`) a content conflict.

On the client a conflicted path is one `ChangedFile` with a `conflict` field and no sides (`collectChanges`): git lists it on both sides as `U` (or `A`/`D`), and drawn from those it would read as a partially staged file whose checkbox stages it — exactly the press this design removes.

Below, *incoming* is `commit.ref` or else `commit`'s short hash, and *onto* likewise.

## The banner

Fixed, across the full width of the workspace, directly under the top bar's own error banners and above the segmented control — on every list layer, at every segment. It is not an error banner: no `✕`, no `role="alert"`; it is a `role="region"` labelled by its title, and it is there for as long as the state is. Its appearance is not announced (as with the change count, an agent working the repository would make a screen reader narrate it).

### Below `expanded`

```
┌──────────────────────────────────┐
│ ←  Git                           │
├──────────────────────────────────┤
│ ⑂ feature/git-ui · rebasing      │  top bar (see below)
├──────────────────────────────────┤
│ ⚠ Rebase stopped on conflicts  ⌃ │  header row — 44px, disclosure
│   Rebasing feature/git… · 3 of 7 │  context line, muted
│   At 9692fc9 Add branch bar to … │  commit line, muted (rebase/pick/revert)
│ ┌──────────────────────────────┐ │
│ │ ⚠ GitTab.tsx  web/src/comp… ›│ │  conflicted files, 44px rows
│ │ ⚠ git.md      docs          ›│ │
│ │ ⚠ old.ts      server        ›│ │
│ │   Show all 5 files           │ │
│ └──────────────────────────────┘ │
│ Commits and branch switches are  │  pause sentence, muted xs
│ paused until the rebase is       │
│ finished or aborted.             │
│ [ ✨ Resolve with agent ] [Abort]│  actions
├──────────────────────────────────┤
│ [ Changes ]  History   Branches  │
├──────────────────────────────────┤
│   (the segment's list)           │
```

- **Surface.** `bg-th-bg-secondary` with a 3px `th-warning` left rule; the `TriangleAlert` glyph in `text-th-warning`, the text in the ordinary tokens (warning hue on text fails AA at `text-xs` in the light themes — the split [git-ui.md](git-ui.md#the-title-length-hint) already makes).
- **Header row.** Glyph, title (`text-sm font-medium`, the row's one `flex-1 min-w-0`, truncating), and a `ChevronUp`/`ChevronDown` L5 toggle, `aria-expanded`, `Hide details` / `Show details`. The glyph, title and chevron are one button, the toggle; at `expanded`, where the actions join this row, they are siblings of that button, never inside it.
- **Expanded by default.** While an operation is in progress the workspace's ordinary work is paused, so this is the most important thing on the screen and earns the space. Collapsing keeps the header row and the actions; the choice is remembered in memory per worktree **and per operation** (its kind and `commit` hash — for a rebase, its `branch` and `onto`, since its `commit` changes at every step), so a new operation opens expanded again. Not persisted: it is a reading state of this visit.
- **Conflicted files.** Each row: the `TriangleAlert` glyph, the file name (tail-truncated, extension kept, as the Changes row does), the directory muted and head-truncated, a `ChevronRight`. Up to **three** rows; past that a text button `Show all n files` expands the list in place — one way, for as long as the operation lasts — into a box capped at five and a half rows that scrolls on its own (the half row says there is more). Order is the Changes list's flat order (`compareChangePaths`), whatever view the list is in — the banner is not a tree. Tapping a row opens that file's review layer, which draws the conflict ([Viewing a conflicted file](#viewing-a-conflicted-file)); its name is `Review <path>, conflicted`, as the Changes row's. On the Changes segment the press is a list row's press — pushed with the list's `REVIEW_FROM_LIST_STATE` mark, since the list is behind it. From History or Branches it is the chat review row's press (`handleOpenReview`'s shape): pushed without the mark, so leaving the review replaces it with the Changes list rather than going back to a segment the review did not come from.
- **The pause sentence** — `Commits and branch switches are paused until the <kind> is finished or aborted.` — says once, where the state is described, why several controls further down have stopped. It is part of the details: collapsing hides it, and the controls that stop each still carry a reason of their own.
- **Actions.** `Resolve with agent` is the L1 primary (`th-accent`, `Sparkles` icon, `flex-1`); `Abort` a secondary (`bg-th-bg-tertiary`) in `text-th-error`, `shrink-0` — the `Push (force)` treatment, since it throws work away. At 320px the pair is about 190 + 80px and fits. Both `min-h-[44px]`.

### Copy

**Title**

| `kind` | Conflicted paths > 0 | None |
|---|---|---|
| merge | `Merge stopped on conflicts` | `Merge not finished` |
| rebase | `Rebase stopped on conflicts` | `Rebase paused` |
| cherry-pick | `Cherry-pick stopped on conflicts` | `Cherry-pick not finished` |
| revert | `Revert stopped on conflicts` | `Revert not finished` |

**Context line** — what is being combined with what. Branch and ref names in `font-mono`; a missing part is left out, never shown as `?`.

| `kind` | Context line | Commit line |
|---|---|---|
| merge | `Merging main into feature/git-ui` | — |
| rebase | `Rebasing feature/git-ui onto main · 3 of 7` | `At 9692fc9 Add branch bar to git panel` |
| cherry-pick | `Picking onto feature/git-ui` | `9692fc9 Add branch bar to git panel` — absent between two commits of a sequence |
| revert | `Reverting on feature/git-ui` | `9692fc9 Add branch bar to git panel` |

The context line is the part that truncates (at the tail); the progress after it is `shrink-0`, so `3 of 7` is never the part cut. The progress is the rebase's `step.current` / `step.total`, left out when `step` is absent. It reads "3 of 7" rather than "3/7" for the screen reader's sake, and it is `tabular-nums`. The commit line truncates at the tail: the hash is the identity and comes first.

**No conflicts left** — all conflicts resolved and staged, or a rebase stopped at `edit` / `break` / a failed `exec`, or a merge made with `--no-commit`. The file list is replaced by one muted line, and the primary's label changes:

| | Line in place of the files | Primary |
|---|---|---|
| merge, cherry-pick, revert | `No conflicts left. The <kind> still has to be finished.` | `✨ Finish with agent` |
| rebase | `No conflicts left. The rebase is paused at step 3 of 7.` (without the step when unknown) | `✨ Finish with agent` |

The pause sentence and `Abort` are unchanged: the repository is still mid-operation, and everything that was paused stays paused.

### At `expanded`

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ⑂ feature/git-ui · rebasing                                                   │
├───────────────────────────────────────────────────────────────────────────────┤
│ ⚠ Rebase stopped on conflicts       [ ✨ Resolve with agent ] [ Abort ]    ⌃  │
│   Rebasing feature/git-ui onto main · 3 of 7  ·  At 9692fc9 Add branch bar to …│
│   ⚠ GitTab.tsx  web/src/components/Git  ›   ⚠ git.md  docs  ›                 │
│   ⚠ old.ts  server                      ›   Show all 5 files                  │
│   Commits and branch switches are paused until the rebase is finished…        │
├────────────────────────┬──────────────────────────────────────────────────────┤
│ [Changes] History Bra… │ (detail column)                                      │
```

The same component and content; only the arrangement follows the tier (`useIsExpanded`), as the rest of the workspace does. The actions move up into the header row, `Resolve with agent` at its natural width; the context and commit lines join into one; the file rows sit in an auto-fill grid (`minmax(260px, 1fr)`), and `Show all` expands the grid in place under the same cap. Banner spans both columns, like the top bar's banners.

### On detail layers

A layer below `expanded` has no room for the whole banner over a diff, and the actions are not lost by leaving them off: they are one `←` away on the list, and the conflict view carries the handoff in its own action bar (`Ask agent`). So at the top of a layer, under the app header — a layer has no top bar ([git-ui.md](git-ui.md#the-top-bar)) — it draws one non-interactive line, `min-h-[36px]`, on the banner's surface — the title, which truncates, and the progress, which does not:

```
│ ⚠ Rebase stopped on conflicts · 3 of 7 │
```

At `expanded` the full banner is above both columns already, so there is no second form.

### The top bar during a rebase

A rebase detaches HEAD, so today's top bar would read `detached @ 4be1f20` — true, and useless. While `kind` is `rebase` with a `branch`, the left region reads `⑂ feature/git-ui · rebasing` (the suffix muted), accessible name `Branches, rebasing feature/git-ui`. It still opens Branches. The sync chip stays hidden as it is for any detached HEAD. A rebase of a detached HEAD has no `branch`, and the bar stays `detached @ <hash>`. Merge, cherry-pick and revert leave HEAD where it was, and the bar is unchanged.

## Resolve with agent

The [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), as it is: `usePrefillComposer().prefill(text)` from the banner (which outlives the press), the current session or a new one, appended to the draft, never sent. Pending: the button's spinner, disabled. A failed session create: an `ErrorBanner` inside the operation banner, under its details (above the actions below `expanded`; at `expanded` the actions are in the header row) — the handoff's rule of reporting where the action started.

**The text is built at the press**, from the state as it is then (`describeOperationPrompt` in `lib/gitOperation.ts`, pure and tested), never from what the banner rendered a moment earlier. Prose only, paths as they are relative to the repository root:

With conflicts:

```
The repository is in the middle of a rebase of feature/git-ui onto main (step 3 of 7, replaying 9692fc9 "Add branch bar to git panel"), stopped on conflicts in:
- web/src/components/Git/GitTab.tsx
- docs/git.md
- server/old.ts

Resolve these conflicts, keeping what both sides meant. Stage each file once it is resolved, then continue the rebase. If a conflict cannot be resolved safely, stop and explain it instead of guessing.
```

Without conflicts:

```
The repository is in the middle of a merge of main into feature/git-ui. There are no conflicts left. Check the result, then finish the merge.
```

| `kind` | Opening clause |
|---|---|
| merge | `a merge of <incoming> into <branch>` |
| rebase | `a rebase of <branch> onto <onto> (step 3 of 7, replaying <hash> "<subject>")` — the parenthesis drops the parts it does not know |
| cherry-pick | `a cherry-pick of <hash> "<subject>" onto <branch>` |
| revert | `a revert of <hash> "<subject>" on <branch>` |

- **A part the server did not send is left out**, the clause staying grammatical: a merge on a detached HEAD is `a merge of main`, a cherry-pick between two commits of a sequence `a cherry-pick onto feature/git-ui`.
- **Continue is the agent's.** The UI has no `Continue`; the text asks for it because finishing the operation is the point of handing it over, and the user reads the request before it goes.
- **The list is capped at 20 paths**, then `- … and 14 more (see git status)`. A prefill is read in a composer on a phone; the agent can list the rest itself.
- **The same text twice is added once** — the handoff's own rule. A second press with nothing changed adds nothing; a press after the agent resolved some files is a different text, and appends.
- **Not gated on the agent being busy**, as no handoff is ([agent-handoff-ui.md §1.5](agent-handoff-ui.md#15-the-targets-state-does-not-gate-the-handoff)).

## Abort

`Abort` opens `ConfirmDialog`, `variant="danger"`, the confirm button named by the outcome. Message is a plain string.

| `kind` | Title | Message | Confirm |
|---|---|---|---|
| merge | Abort the merge? | feature/git-ui goes back to how it was before main was merged in. Conflicts resolved so far are lost and cannot be recovered. | Abort merge |
| rebase | Abort the rebase? | feature/git-ui goes back to how it was before the rebase. The 2 commits already replayed and any conflicts resolved so far are lost and cannot be recovered. | Abort rebase |
| cherry-pick | Abort the cherry-pick? | feature/git-ui goes back to how it was before the cherry-pick began. Conflicts resolved so far are lost and cannot be recovered. | Abort cherry-pick |
| revert | Abort the revert? | feature/git-ui goes back to how it was before the revert began. Conflicts resolved so far are lost and cannot be recovered. | Abort revert |

- **"Resolved so far" is the point of the dialog.** Those resolutions may be the agent's work of the last ten minutes; the dialog exists to say it before they go. With no conflicts left the sentence becomes `The finished resolutions are lost and cannot be recovered.` — the same loss, said for that state.
- `The 2 commits already replayed` uses `step − 1` and appears only when `step` is known and above 1. A cherry-pick or revert says `before the cherry-pick began` rather than naming the commit it stopped on: in a sequence of several, the abort undoes the commits already made for the earlier ones too. A missing branch name (a detached HEAD) reads `HEAD`; a missing incoming or commit drops its clause (`… before the merge.`).
- **Running.** The button shows a spinner and `Aborting…`, and `Resolve with agent` is disabled beside it — a prompt for an operation about to be thrown away would land in the composer describing a state that no longer exists. The file rows and the disclosure stay usable; they only read. It is a bounded local write, so nothing holds the user on the page. The spinner belongs to the operation pressed, by `operationKey`: a new one of the same kind showing up in the status after the answer starts from its own state. While the worktree is switching, both `Resolve with agent` and `Abort` are disabled and an open confirmation closes — the status on screen is still the worktree being left, while a request would go to the one being entered. Success says nothing of its own: the banner leaves when the refreshed status no longer has an operation — the spinner stays until then, on the no-optimism rule — and the top bar, the list and the paused controls return together. Abort invalidates status, log and branches, as checkout does, whether it succeeded or not.
- **Failure** — an `ErrorBanner` inside the operation banner, where the handoff's failure goes: `Could not abort the rebase.` with git's output under `Details` through `GitOutput`, or the refusal sentence and no `Details` when the server refused it as busy ([git-ui.md](git-ui.md#feedback-and-errors)). It is filed per worktree, like the other results that outlive the page, so leaving and coming back still shows it; it clears on `✕`, the next abort, or the operation ending.
- **The operation ended or changed meanwhile.** The request names the kind the user confirmed, and the server refuses rather than abort something else (`-32008`, nothing ran). If nothing is in progress any more there is nothing to say: the banner is already leaving. If a different operation is now in progress, the in-banner failure reads `The rebase is no longer in progress — a merge is. Nothing was aborted.`, with no `Details`, and the banner already shows the new one.
- **The branch was not moved back.** Between two commits of a cherry-pick or revert sequence, after a commit was made on the branch by hand, git ends the sequence without moving the branch back, and the server says so (`head_kept`). That is the one success with something to say, since the user confirmed losing work that is still there: once the banner has left, a dismissible notice (an `<output>`, so it is announced) takes its place, until it is dismissed or a new operation begins — `The cherry-pick has ended, but the commits made during it are still on feature/git-ui. The branch was not moved back.` The dialog's message already allows for it in that state (`… unless commits were made on it since — git keeps those`).
- **Not gated on the agent.** An agent may be resolving right now; aborting under it is the user's call, as sending into an open turn is. The dialog's sentence already says what is lost.

## Viewing a conflicted file

A conflicted file's diff route opens the **conflict view** in the review layer — the same layer, the same toolbar, the same `‹ ›` and review order, at both widths (the right column at `expanded`). Opened from a banner row, from the file's row in the Changes list, by `‹ ›`, or by a deep link: one place, so there is no second rule to learn. The diff route has nothing useful to draw for it — the index holds stages rather than a version and `git diff` answers in a combined form the diff component cannot read — so the conflict view replaces it rather than sitting beside it; no diff is requested or watched for a conflicted file.

```
┌──────────────────────────────────┐
│ ←  GitTab.tsx                    │  title opens the working-tree file (edit)
├──────────────────────────────────┤
│ ⑂ feature/git-ui · rebasing      │
│ ⚠ Rebase stopped on co… · 3 of 7 │  the layer's one-line form
├──────────────────────────────────┤
│ ‹  2 / 5  ›  web/src/compo…  ↵   │  review toolbar — no whitespace toggle
│ Conflict 1 of 3          ⌃   ⌄   │  conflict row
├──────────────────────────────────┤
│  38   const a = 1;               │
│  39 ▌<<<<<<< HEAD                │  marker line — band
│  40 ▌  const b = old;            │  region — left rule
│  41 ▌=======                     │
│  42 ▌  const b = new;            │
│  43 ▌>>>>>>> 9692fc9 (Add bra…)  │
│  44   return b;                  │
├──────────────────────────────────┤
│ [ ✨ Ask agent ]  [    Next     ] │
└──────────────────────────────────┘
```

**The body is the working-tree file**, read with the file layer's own reader (`useContents`, which watches the file), highlighted as the file layer highlights it, line numbers on, the review's wrap setting applied. It is the file with its markers, which is what the agent and the user will both edit — not a reconstruction of "ours" and "theirs".

- **Marker lines** (`<<<<<<< `, `|||||||` , `=======`, `>>>>>>> ` at the start of a line, the diff3 base marker included) carry a full-width `bg-th-warning/15` band. Every line from `<<<<<<<` through `>>>>>>>` carries a 3px `th-warning` left rule, so a region reads as one block when its middle is scrolled to. Not red and green: neither side is a deletion or an addition, and the review has taught those colours to mean exactly that.
- **The conflict row** — `Conflict 1 of 3` and two L5 buttons `Previous conflict` / `Next conflict` (`ChevronUp` / `ChevronDown`) — scrolls the body so the region's `<<<<<<<` line sits at the top. On a phone a conflict at line 400 of a 600-line file is otherwise a hunt. The count follows the scroll: it names the region whose start is nearest above the top of the view, and reads `3 conflicts` while none is (and in a file short enough not to scroll). At the bottom of the file, where a later region can no longer reach the top, it names the last region whose start is in view. With no region above, `⌃` is disabled; past the last, or once the view is scrolled to the bottom, `⌄` — so in a file too short to scroll both are. Regions are found client-side (`findConflictRegions` in `lib/gitOperation.ts`), only markers that pair up count, and an unpaired marker is left plain. The jump puts a region's first line where the text's first line sits, below the body's padding, so a conflict on line 1 counts as the one at the top.
- **Over the highlight limit** the body is plain text with the usual banner, and markers still band — they are found on the text, not the tokens.
- **The view follows the file.** When the agent edits it, the body updates; when the agent stages it, the file is no longer conflicted and the same page becomes the ordinary review of that file — the route already names a path and a side, and the page is one instance per path.

**When the conflict is not in the text**, the body is one centred card instead — there are no markers to show, whatever the working tree holds:

| Conflict | Card |
|---|---|
| Deleted on one side, changed on the other | `One side deleted this file and the other changed it.` + an `Open file` text button when the working tree still has the file |
| Both deleted | `Both sides deleted this file.` (the title is plain text: there is no file to open) |
| Binary | `Binary file — the conflict cannot be shown.` |
| Too large to read | The file layer's too-large card |

These are the agent's to resolve: none has a text whose markers could be checked, so none offers `Mark resolved`.

**A content conflict with no paired marker left** — resolved by hand through the title's `Open file`, not staged yet — shows the file as usual under one muted line: `No conflict markers left. The file stays conflicted until it is marked resolved.` The conflict row is absent; there is nothing to jump between. If an opening, closing or diff3 base marker is still there but pairs with nothing — a region a stray line broke up, or markers longer than seven characters from a `conflict-marker-size` attribute — the line reads `Conflict markers are left that do not pair up. Fix them in the file, or ask the agent.` instead, and `Mark resolved` is not offered.

Who deleted it is deliberately not named: in a rebase "ours" is the branch being rebased onto and "theirs" the user's own commit, the opposite of a merge, and getting that backwards on screen is worse than not saying it. The agent reads the stages itself.

**Bottom bar.** The review's, so it is placed by the same rule: in the toolbar at `expanded`, above the chat's composer below it, and gone while the composer holds a soft keyboard ([git-ui.md](git-ui.md#where-a-details-actions-go)).

| File | Left (secondary) | Primary |
|---|---|---|
| Conflicted, markers present, or a card | `✨ Ask agent` | `Next`; on the last file `Back to changes` |
| Conflicted content, no marker left | `✨ Ask agent` | `Mark resolved` |

- **`Next` stays on the right**, where `Stage & next` is on every other file, so the thumb's "go on" never moves. The handoff is the secondary here because the banner's primary is one Back away; it is the same press with the same text ([above](#resolve-with-agent)). Conflicts with no operation in progress (a `git stash pop`) have no banner but still open here, so the text then opens `The repository has unresolved conflicts in:` and asks only to resolve and stage — there is nothing to continue. Its label is shortened to `Ask agent` (accessible name `Ask agent to resolve the conflicts`, which keeps the visible words) so that at 320px it sits beside the primary: `Resolve with agent` would take more than half the bar.
- **`Mark resolved`** is `git.add` with `resolve` through the write queue — the review's `Stage` by another name, and the one stage the server lets through for a conflicted path, offered only when the text no longer contains an opening, closing or diff3 base (`|||||||`) marker of any length, paired or not (a bare `=======` is a setext heading, and allowed), so it cannot record markers as a resolution. It is not offered while the file is being re-read — the primary is `Next` until the read settles, except after its own press, where it stays in place, disabled — and the text is read once more at the press — the cached text may be a moment behind the disk — staging nothing if markers are back. Spinner and `Marking…` while queued; a failure goes to the layer's banner as a stage failure does. It **stays on the file**, as the last file's `Stage` does: the file is no longer conflicted, so the page becomes its ordinary review, on the staged side — the resolution as it will be committed — with the ordinary review's primary on the right: `Next`, or on the last file the commit button, disabled while the operation lasts. It is the one way to finish a file resolved by hand; it stages and does not continue anything. A marker that is really part of the file (a test fixture) is the agent's case.
- **No discard.** git refuses to check out an unmerged path, and picking a side is out of scope.
- The whitespace toggle, the split toggle and the side row are absent: there is no diff to filter or split and no second side. So are the review's hunk bars and line selection, which need a diff ([git-changes-ui.md](git-changes-ui.md#which-hunks-have-a-stage-button)).

## The Changes list

A conflicted file is a row like any other, in its place in the order — rows never move ([git-changes-ui.md](git-changes-ui.md#goals-and-constraints)).

```
│ ▣ 5 files  +142 −37      [≣|⌸]   │
│ ⚠  GitTab.tsx                  ⋯ │  checkbox replaced by the glyph
│    web/src/components/Git · Conflict
│ ☑  notes.txt           +9      ⋯ │
```

- **No checkbox.** In the checkbox's gutter, a `TriangleAlert` in `text-th-warning`, `aria-hidden`; the row's button is named `Review <path>, conflicted`. Staging a conflicted file is git's way of saying it is resolved; one tap must not record markers as a resolution. A file is staged from the conflict view's `Mark resolved`, or by the agent.
- **Line 2** reads `<dir> · Conflict`, muted like every status word. No counts (the server has none).
- **The `⋯` sheet** keeps `Open file` (disabled when both sides deleted it) and `Copy path`, and has no `Discard`.
- **Select all and folder checkboxes** aggregate and act over the files without conflicts only. With conflicts present, select all's name becomes `Stage 3 of 5 files, 2 conflicted` (it still contains the visible count, for voice control). A folder holding only conflicted files has no checkbox — its gutter stays empty so the column of boxes stays aligned — and if every file is conflicted, select all goes the same way.
- **`Discard unchecked…`** in the bottom bar covers the files with unstaged changes that are not conflicted, and its copy counts those; with none, the button is absent. The server refuses unmerged paths in `git.discard` on its own as well, naming them ([git.md](git.md#discard)): the boundary is where the rule is enforced, the list only keeps the user from meeting it.

## What stops while an operation is in progress

Every write the workspace offers, reviewed. "Disabled" keeps the control in place with a reason; "absent" removes it — by the workspace's existing test: a control the user is on the way to pressing stays, visibly not ready, so the target does not jump; a control that is merely not applicable goes ([git-ui.md](git-ui.md#commit)).

| Operation | During any operation | Form | Reason, and where |
|---|---|---|---|
| Stage / unstage a conflicted file, whole or by hunk | stopped | absent (glyph in its place; the conflict view has no hunk bars) | The row's `Conflict`; `Mark resolved` in the conflict view is the deliberate route |
| Stage / unstage other files, whole or by hunk | allowed | — | Ordinary index edits; the operation's result is built from the index |
| Selecting lines of another file's diff, `Copy`, `Ask AI to edit…` | allowed | — | They write nothing; the prefilled message goes into the composer like any other handoff |
| Discard a conflicted file | stopped | absent from `⋯` | git refuses it; picking a side is out of scope |
| Discard other files, `Discard unchecked…` | allowed, conflicted files excluded | — | — |
| Commit (list's bar, the review's commit button) | stopped | **disabled**, labelled `Commit` with no count, visible line above the button | `Can't commit during a rebase.` (the kind named). Committing would finish a merge, pick or revert — the `Continue` left to the agent — and would insert a stray commit into a rebase. Visible rather than `sr-only`: the banner may be collapsed or scrolled out of mind, and nothing next to the button says why |
| The commit sheet, if open when an operation begins | stays open (it holds the message) | `Commit` / `Commit & push` disabled | The same line, in the footer where the push reasons go |
| Amend (a commit's `⋯` menu, on HEAD) | stopped | absent | Not on the user's way: an entry in a menu, not a target to keep. git refuses amend mid-merge, and mid-rebase HEAD is not the branch's commit. The banner's pause sentence says why commits stopped |
| `✨ Draft` | — | unreachable (the sheet cannot be opened) | — |
| `Switch to this branch` (a branch's `⋯` and its detail) | stopped | **disabled**, with `Branch switching is paused during the rebase.` as its description; rows stay openable, since reading a branch writes nothing | The full sentence is pinned at the top of the list where a checkout failure goes: `Branch switching is paused during the rebase. Abort it, or let the agent finish it.` |
| `New branch…` | stopped | **disabled** | The same pinned line |
| `Delete branch` (a branch's `⋯` and its detail) | stopped | **disabled** | `Finish or abort the rebase first.` as the menu row's description ([git-branches-ui.md](git-branches-ui.md#the-branchs-menu-)) |
| `Ask AI to merge into current branch` (a branch's `⋯` and its detail) | stopped | **disabled** | The same description: a merge cannot start inside another operation |
| The new-branch sheet, if open when an operation begins | stays open (it holds the name) | `Create` disabled | The same sentence, in the sheet |
| `Create branch here…` (a commit's `⋯` menu) | stopped | the menu row stays; the sheet opens with `Create` **disabled** | The same sentence, in the sheet: the menu has no line of its own to say it in ([git-history-ui.md](git-history-ui.md#create-branch-here)) |
| `Ask AI to revert` (a commit's `⋯` menu) | allowed | — | It writes nothing itself; the prefilled message goes into the composer, and the agent meets the operation there ([agent-handoff-ui.md §1.5](agent-handoff-ui.md#15-the-targets-state-does-not-gate-the-handoff)) |
| Fetch | allowed | — | Touches no working tree |
| Pull | stopped (merge, cherry-pick, revert; during a rebase the chip is hidden) | **disabled** in the Sync sheet | A line under the button rows: `Can't pull during a merge.` git refuses it; the sheet should say so rather than relay the refusal |
| Push | allowed when on a branch | — | Pushes the branch as of its last commit; nothing in progress is sent |
| Automatic fetch | allowed | — | — |
| Reading History, commits, files | allowed | — | During a rebase the log runs from the detached HEAD, which is the truth of the moment |

**Conflicts with no operation** — a `git stash pop` that did not apply cleanly — have no banner and pause nothing but commit: git refuses to commit over them, so the bar and the sheet disable it the same way with `Resolve the conflicts to commit.`, and the conflicted rows are drawn as above.

The server refuses the stopped writes on its own as well — commit, amend, checkout, new branch, branch delete and pull while an operation is in progress, and stage, unstage (whole or by hunk) or discard of a conflicted path ([git.md](git.md#writes-refused-during-an-operation)) — so a client that has not yet seen the operation begin meets a sentence naming it, not git's refusal or, worse, its consent. Both are refusals, read by code in `utils/gitErrors.ts` and shown without `Details`: `This worktree is in the middle of a rebase. Abort it, or let the agent finish it.` (`-32006`) and `Nothing was discarded: a.ts has unresolved conflicts.` (`-32007`; `staged` / `unstaged` for the other two writes). A write refused as busy behind an abort reads `This worktree is busy aborting an operation. Try again once it finishes.`

The chat's review row is unchanged; a conflict-aware version of it is left for later.

## The sidebar's Git tab

The overview is the workspace's doorplate ([sidebar-ui.md](sidebar-ui.md#the-git-tab)); a repository stuck mid-rebase is exactly what it should say. While an operation is in progress, the overview's second line becomes the banner's title — `⚠ Rebase stopped on conflicts`, glyph in `th-warning`, text in the line's usual token — in place of the sync line, and its branch name follows the top bar's (`feature/git-ui · rebasing`). Still read-only; the `Changes` entry is where to go. The tab badge is unchanged: conflicted files are already in its count.

## Where it lives

| Piece | Place | Note |
|---|---|---|
| The banner | `Git/OperationBanner.tsx`, rendered by `GitWorkspace` above the segments and as its one-line form on layers | Always mounted, and owns the handoff hook and the abort request, so their pending state and errors outlive the press and a rebase's next step |
| Title, context, prompt text, abort copy, conflict regions, paused reasons | `lib/gitOperation.ts` — `describeOperation`, `describeOperationPrompt`, `describeAbort`, `describeAbortFailure`, `describeHeadKept`, `findConflictRegions`, `hasConflictMarkers`, `branchSwitchPausedReason`, `pullPausedReason`; the commit's reason is `commitPausedReason` in `types/git.ts`, beside `describeCommitAction` | Pure, so every sentence is testable without a screen |
| The prompt at the press | `operationPromptAtPress` in `hooks/gitQueries.ts` | Reads the status cache at the press; the banner and the conflict view share it |
| The conflict view | `Git/ConflictView.tsx` (`useConflictFile` reads the working tree), a branch of `DiffView` for a file whose record carries `conflict` | Same page per path, so a file the agent stages turns into its ordinary review in place |
| Conflict on the change record | `lib/gitChanges.ts` (`collectChanges`, the checkbox rules) | One record per path, as for every other state |
| Abort in flight, its failure, the `head_kept` notice, disclosure state | `lib/gitOperationStore.ts`, per worktree (disclosure also per operation, by `operationKey` from `lib/gitOperation.ts`) | In memory. An answer is only settled by a status fetched after it, so an older status cannot clear it; the failure and the notice are dropped when the project stops being a repository, as the other outcomes are |

## Decisions not to lose

1. **The banner is live state** drawn from the server's answer, in the same snapshot as `git.status`; it never records anything and leaves the moment the operation ends, whoever ended it.
2. **Two actions only: `Resolve with agent` and `Abort`.** No `Continue`, no per-file side picking. The agent's prompt asks it to resolve and continue; the user reads it before it goes.
3. **The prompt is built at the press**, names the operation, the refs, the step and the commit when known, and lists up to 20 conflicted paths.
4. **Abort always confirms**, says that resolutions made so far are lost, and names its verb on the button.
5. **A conflicted file never has a checkbox.** It is marked resolved only from the conflict view, only when no marker is left, and the page then shows the resolution's ordinary review.
6. **A conflicted file opens in the review layer**, as the working-tree text with its markers banded and a conflict-by-conflict jump — one place for every entry, at both widths.
7. **Commit and branch switching are disabled with a visible reason; amend is absent; pull is disabled; staging, discarding non-conflicted files, fetch and push stay.**
8. **Expanded by default** on every width; collapse is remembered only for this operation in this worktree.
