# Git Changes and Review UI

The Git workspace's **Changes segment** and its **review layer**, the `diff` layer: a list of changed files in groups — Conflicts, Unstaged, Staged — with a stage button per row, and a review page that walks those files one by one so that "review → stage → commit" can be done one-handed on a phone.

The list is `ChangesSection` and the components it draws, the review is `DiffView`, and the ordering both walk is `lib/gitChanges.ts`. Everything not mentioned here — the top bar, the segments and their routes, the commit sheet, the discard confirmation copy, feedback and error banners, the write queue, projects without a repository — stays as [git-ui.md](git-ui.md) describes it, and this file refers to it rather than restating it.

Copy below is the UI's English. What is left for later is in [git-ui.md](git-ui.md#out-of-scope).

## Goals and constraints

- **Staged and unstaged are places.** The list is grouped, `Unstaged` and `Staged`, a row per path and side, and staging moves a row from one group to the other. It was once one list with a checkbox per file, so that a row never moved; that was reversed for two reasons. Users expect the Staged / Unstaged convention of the clients they know — VS Code, Fork, Sublime Merge, GitKraken — and a column of checkboxes over a bottom bar read as a selection, "tick the files, then act on them", which is not what the boxes did ([The stage buttons](#the-stage-buttons)).
- **Every action is a visible tap.** No swipe and no long press: in a browser they fight iOS's edge-back, page scrolling and system text selection. Everything below has a control you can see.
- **Touch targets.** Rows are at least 44px; every control inside a row or a bar reaches 44×44 on a coarse pointer, by the usual means ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)). The visual sizes below are for a fine pointer.
- **Discard is unchanged in substance.** Same `ConfirmDialog`, same copy table ([git-ui.md](git-ui.md#discard)), no undo. Only where the entry points live changes.
- **Existing rules hold.** Commit records the root repository only and counts only its staged files; submodule files are staged in the submodule's index ([git-ui.md](git-ui.md#submodules)). Nothing is fired optimistically; writes go through `gitWriteStore`'s queue; failures appear where the action started.

## What the list reads from the server

Each `git.status` entry carries its own side's line counts — or `binary`, or nothing when the count is unknown — and a staged rename carries its source; what each case yields is [git.md](git.md#status)'s. A row shows **its own side's** counts, since it stands for that side alone ([The groups](#the-groups)); the list header and the sidebar's totals are the **sum of every file's two sides**: that is exactly the diffs the review shows, so the number is the amount there is to read. A line edited on both sides counts twice, which is accepted for that reason. A path without counts is not an error of the status read; the row simply shows none.

A path listed in `conflicted` — a merge, rebase, cherry-pick, revert or stash pop that stopped on it — is one record carrying `conflict` rather than two sides, and its group, its row, its `⋯` sheet and what its review draws are [git-conflict-ui.md](git-conflict-ui.md#the-changes-list)'s; everything below is about the files without one.

## The Changes segment

### Below `expanded`

```
┌──────────────────────────────────┐
│ ←  Git                           │  app header
├──────────────────────────────────┤
│ ⑂ feature/git-ui      ↓ Pull 2   │  top bar (unchanged)
├──────────────────────────────────┤
│ [ Changes ]  History   Branches  │  segmented control (unchanged)
├──────────────────────────────────┤
│ ⚠ Discard failed · Details     ✕ │  inline-action banner (unchanged)
│   5 files  +142 −37      [≣|⌸]   │  list header — sticky
├──────────────────────────────────┤
│ Unstaged 3           [Stage all] │  group header
│ +  git.md              +80 −12 ⋯ │  a partly staged file: its unstaged side
│    docs                          │
│ +  notes.txt           +9      ⋯ │
│    Untracked                     │
│ +  old.ts               −14    ⋯ │  name struck through
│    server · Deleted              │
│ Staged 3           [Unstage all] │
│ −  git.md              +8 −8   ⋯ │  … and its staged side
│    docs                          │
│ −  logo.png         Binary     ⋯ │
│    site/static · Renamed from …  │
│ −  GitTab.tsx          +12 −3  ⋯ │
│    web/src/components/Git        │
├──────────────────────────────────┤
│ [Discard unstaged…] [Commit 3…]  │  bottom bar
└──────────────────────────────────┘
```

**Every control answers one question.** A control that answers none is not there, and two that answer the same one are one. That is why the list has no `Review` button (tapping a row is the way in), no `⋯` in its header (its one item is the bottom bar's `Discard unstaged…` now) and no `View history` on a clean tree (the segmented control's `History` is right above it). The one control kept while it answers nothing is `Discard unstaged…` with nothing unstaged, held rather than hidden, for what its absence hid ([The bottom bar](#the-bottom-bar)).

### The groups

Top to bottom: **Conflicts**, only while there are any; **Unstaged**; **Staged**. Conflicts come first because they stop everything else ([git-conflict-ui.md](git-conflict-ui.md#the-changes-list)). Unstaged comes before Staged because new work appears there and review starts there, and it leaves Staged right above `Commit`, which takes it.

- **One row per path and side.** A file with only unstaged changes (untracked included) is a row in Unstaged, one with only staged changes a row in Staged, and a partly staged file a row in each. A conflict, which has no side, is one row in Conflicts and nowhere else (`groupChanges` in `lib/gitChanges.ts`).
- **A row describes its side and nothing else** (`sideOnly`): its counts, its status words — a file added in the index and then deleted from the working tree reads `Added` in Staged and `Deleted` in Unstaged — and whether its `⋯` sheet offers a discard. Each row is what the review shows on that side.
- **The header** is a `min-h-[44px]` row: the group's name and its row count, muted and tabular (`Unstaged 3`), as an `h3` that labels the group's `section`, and at its end a text button, `Stage all` in Unstaged and `Unstage all` in Staged (`th-bg-tertiary`, 36px tall, 44 on a coarse pointer). The button's accessible name starts with its visible words and holds the count, `Stage all 3 unstaged files` / `Unstage all 3 staged files`, so a voice-control user says what they see. It is one queued batch over the group's rows; while any row of the group has a write it shows the spinner and is `aria-busy` / `aria-disabled`, focusable and ignoring presses. Conflicts has no button: no press stages a conflict.
- **Both groups are always drawn** while the tree has changes. An empty one keeps its header without the button and says `No unstaged changes.` / `No staged changes.` in muted text, so the place a staged or unstaged file goes to is on screen before the first one goes there — and `No staged changes.` right above the bar is what the commit hint points at ([The bottom bar](#the-bottom-bar)).
- **Not sticky.** Only the list header is; a group's header scrolls with its rows.

### The file row

| Part | Content | Tap |
|---|---|---|
| Left: stage button | `+` in Unstaged, `−` in Staged, its 36px hit area (44 on a coarse pointer) the left gutter of the row ([below](#the-stage-buttons)). A conflict's row has the `TriangleAlert` glyph in its place, and no button | Stages or unstages the file |
| Middle, line 1 | File name, `text-sm`, truncated **at the tail** with the extension kept (`very-long-na….tsx`) — the name is what is read, so it is not cut from the head as the old row was. CSS cannot cut in the middle, so the stem and the extension are two spans: the stem `truncate`, the extension `shrink-0` | Opens the review layer at this file, on this row's side |
| Middle, line 2 | Muted `text-xs`: the directory, then ` · ` and a status word where there is one. The directory truncates **from the head** (`…/components/Git`), since the deepest folder is the one that tells files apart | (part of the row) |
| Right | This side's `+a −d` in `text-xs` tabular figures; `Binary` for a binary file; nothing when the server has no counts. Zero sides are dropped (`+9`, `−14`), never `+0` | (part of the row) |
| Far right: `⋯` | L5 button, `More actions for <path>` | Opens the file's action sheet |

The row is the L4 row (`SidebarListItem` with `min-h-[44px]`, here two lines tall), with the usual active treatment while its side is open in the review — beside it in the main area at `expanded`, where the list is the sidebar's. Of a partly staged file's two rows only the one on the side under review is lit; a conflict's row is lit whenever its file is open. The stage button and `⋯` are siblings of the row's button, never nested inside it.

**In a list 600px wide or more** (`@git-row:`, measured on the list's scroll box — the threshold and why are [git-ui.md](git-ui.md#rows-follow-their-columns-width)'s) the row is one line, its details on the name's baseline:

```
+  name.tsx   …/components/Git · Renamed from x  ……………  +12 −3  ⋯
```

- The name keeps its natural width up to **60% of the text cell**, then its stem truncates as before.
- The details — the same element, so `aria-describedby` still points at it — take the rest, 12px after the name. Inside them nothing changes: the directory still gives way first, from the head, and the status words last. Past their natural width the room is left blank before the counts.
- **The path is not a column.** File names vary too much: a fixed name column would cut long names and leave holes after short ones, and in tree mode the indent already staggers where rows start. What lines up is the right side: the counts stay against the `⋯`, as in the narrow row.
- Unchanged: the stage button's gutter, the tree indent, `min-h-[44px]`, folder rows (already one line) and the `line-through` on a deleted file's name alone.

**`title`s**, in both layouts: the name span carries the file name, the directory span the directory, the status words span the whole words (`Renamed from <old path>`) — each is what that span may cut.

**Status words on line 2** (the status letter column goes; a word says it once, in full), of the row's side:

| File | Line 2 |
|---|---|
| Modified | the directory only |
| Added (staged new file) | `<dir> · Added` |
| Untracked | `<dir> · Untracked` |
| Deleted | `<dir> · Deleted`, and line 1's name `line-through` |
| Renamed | `<dir> · Renamed from <old>` — `<old>` is the old file name when only the name changed, the full old path when the directory changed too |
| Inside a submodule | `<dir> · Submodule` appended after any other word (`vendor/sdk/src · Untracked · Submodule`) |

A file at the root shows its status word alone, or nothing for a modified file. Line 2 is all `th-text-muted`: none of these states is a failure, so none of them earns `th-error` ([sidebar-ui.md](sidebar-ui.md#visual-weight)). For the same reason `+a −d` is not green and red but `th-text-muted` like line 2: colour in this list is reserved for the one primary action, and the diff itself is where green and red mean something.

### The stage buttons

**An action, not a state.** The row's group already says whether it is staged, so its button has nothing left to show but what pressing it does: move the row's side to the other group.

| Row in | Button | Name | Request |
|---|---|---|---|
| Unstaged | `+` (`Plus`) | `Stage <path>` | `git.add` — the whole file, so on a partly staged one the rest of it |
| Staged | `−` (`Minus`) | `Unstage <path>` | `git.reset` — the whole file |

Neither throws anything away: a partly staged file's `+` joins its unstaged side to the staged one, its `−` returns everything to Unstaged. No press of a row's button makes a file partly staged; that comes from staging a hunk in the review, or from staging done elsewhere. Unstaging a staged rename unstages its source path with it: in the index a rename is the old path deleted and the new one added, and restoring the new path alone would split the row into `Deleted` and `Untracked`.

**Drawn bare.** An L5 icon button (`iconButtonClass`): 36px, 44 on a coarse pointer, a `size-4` glyph and no box, border or fill around it. A box is what made the old control read as a selection checkbox, and the groups exist to retire that reading. A conflict's row keeps the column with the warning glyph (`StageGutter`), and a folder of conflicts with nothing, so the buttons stay one column a thumb can run down.

**While the write is in flight** the glyph gives way to the small spinner, the button is `aria-busy="true"` and `aria-disabled="true"` and ignores presses — not `disabled`, which drops focus and would leave a keyboard user who pressed Space on nothing. Busy is per path, so both rows of a partly staged file show it. The row does not move until the refreshed status says so — the workspace's no-optimism rule. A failure goes to the Changes banner as stage/unstage failures do today.

**Focus follows the place, not the row.** The pressed button leaves with its row, and the focus would go with it to `<body>`. The group hands it on to the stage button now standing where the pressed one stood — the same position among the group's buttons, its `Stage all` and folder buttons counted — or the last one when the group got shorter, or the group's heading (`tabIndex={-1}`) once the group is empty. So a keyboard user staging file after file stays in the group they were working down. Only a focus left on `<body>` is moved: one the user put somewhere else meanwhile is theirs. And the hand-off belongs to the press, not to the row: it is dropped once the focus leaves the pressed button for another control, or when the write answers — failed, refused, or written but with the row still in place because the file changed again meanwhile — so a row that leaves later — committed by the agent, say — never pulls the focus back into the list.

**Names.** `Stage <path>` / `Unstage <path>`, the row's own button `Review <path>`, `⋯` `More actions for <path>`; focus ring as every control, the heading that takes the focus of an emptied group included. A partly staged file's two rows add their side — `Review <path>, unstaged` / `Review <path>, staged`, and the same on `⋯` — since otherwise two controls with one name would open different diffs, and a voice-control user saying the name could not tell them apart.

### The file's action sheet (`⋯`)

The project's menu shape: a `Sheet` of `MenuRow`s on both layouts, titled with the file's full path (`FileEntryMenu` explains why a sheet and not a dropdown).

| Item | Shown | Does |
|---|---|---|
| `Open file` | Always; **disabled** for a deleted file, with `(deleted)` in its name | The `file` layer, as the diff's title did |
| `Copy path` | Always | Copies the path as the list knows it — relative to the root repository, a submodule file with its submodule prefix. The row reads `Copied` with a check for about a second, then the sheet closes; on failure it reads `Copy failed` and the sheet stays open, the path being in its title (`useCopyToClipboard`'s states) |
| `Discard changes` / `Delete file` (untracked) | Only from a row in Unstaged: a staged side is never discarded, so a Staged row's sheet has none, a partly staged file's included — a staged change is unstaged first | Closes the sheet and opens the existing `ConfirmDialog` with the single-file copy, its partly staged variant included ([git-ui.md](git-ui.md#discard)). Disabled, with `Wait for the change in progress to finish.`, while the file has a write queued — the queue drops a path it already holds, so a discard let through would report success without running; the bottom bar's `Discard unstaged…` waits the same way while any file has one. Destructive styling as `FileEntryMenu`'s delete, and last in the sheet, after a divider |

Order is frequency, and the destructive item comes last behind a divider in `danger` style — the arrangement `FileEntryMenu` already uses for Delete, so the two menus read alike.

### The list header

One row, sticky at the top of the scroll area, `min-h-[44px]`:

```
5 files  +142 −37              [≣|⌸]
```

- **The count is by path**, `5 files`: a partly staged file, a row in each group, counts once — the review's `k / n` counts the same ([Review order](#review-order)). The totals beside it are the sum of both sides of every file (binary files and files without counts add nothing).
- **Flat / Tree** — a two-icon segmented toggle (`List` / `FolderTree`), `aria-label="Flat list"` / `"Folder tree"`, `aria-pressed`. The choice is remembered in `localStorage` (`pockode:gitChangesView`), per browser rather than per worktree: it is a reading preference. Default flat.
- **At narrow widths** the row obeys [the narrow-width rule](sidebar-ui.md#the-narrow-width-rule): the label-and-totals group is the one `flex-1 min-w-0` element, and the totals are what truncate away first (they are also on every row and in the sidebar); the toggle is `shrink-0`. At the sidebar's 280px minimum this is what keeps the row on one line.
- **It stages nothing.** Select all went with the checkboxes: each group's header moves its own rows, and a third button over both would answer the same question twice.
- **Nothing destructive.** Discarding every file used to be the one item of a `⋯` here; it is the bottom bar's `Discard unstaged…` now ([below](#the-bottom-bar)), away from the controls tapped all day.

### Flat and tree

**Order is the same rule in every group, and it is also the review order** ([Review order](#review-order)):

- **Flat**: by full path, case-insensitively, `/` sorting before any other character, so a directory's files stay together and line 2 reads in runs.
- **Tree**: at each level, folders first, then files, each by name. This is the order a depth-first walk of the tree reads on screen.

**Tree rows.** Each group draws a tree of its own, of its own rows:

```
Unstaged 3                 [Stage all]
+ ▾ web/src/components     +28 −3
    +  BranchBar.tsx       +28 −3  ⋯
+ ▸ docs                   +80 −12
Staged 1                 [Unstage all]
− ▾ web/src/components     +12 −3
    −  GitTab.tsx          +12 −3  ⋯
```

- A folder row is one line, `min-h-[44px]`: its stage button, a chevron, the folder name, the summed `+a −d` of its group's rows under it. No `⋯`. Files are indented under it by 16px per level; the button column stays aligned on the left edge.
- **Single-child chains are compacted** into one row (`web/src/components`), as editors do, so a deep change is not five rows of folders above one file.
- **Tapping the folder row** (name or chevron) expands or collapses it; that button carries `aria-expanded`. All folders start expanded; collapse state is per worktree, in memory, and is lost on reload — it is a navigation state of this visit, not a preference. It is kept per group and path (`<group>:<path>`), so `docs` folded in Unstaged stays open in Staged.
- **The folder's button** moves every row under it, at any depth, collapsed or not, to the other group: `+` named `Stage folder web/src/components, 1 file` in Unstaged, `−` named `Unstage folder …` in Staged, the count being its group's rows. It is a batch over paths — one queued request, as `Stage all` is — never a `git add <dir>`, which would also pick up files the list does not show. A folder in Conflicts has no button, only the empty gutter.
- A collapsed folder's files still count in its button, in its group's count, in the header's total and in the review sequence.

### The bottom bar

`[ Discard unstaged… ]  [ Commit n files ]`. It renders on the same condition the commit bar always has — `describeCommitAction` returns non-null — so a clean tree and an unreadable status have no bar.

| Working tree | Left | Right (L1) |
|---|---|---|
| n files staged in the root, some changes unstaged | `Discard unstaged…` | `Commit n files` (`Commit 1 file`) |
| every change staged | `Discard unstaged…`, held | `Commit n files` |
| changes, nothing staged anywhere | `Discard unstaged…` | `Commit` disabled, `sr-only` hint `Stage a file to commit` |
| staged only inside a submodule | `Discard unstaged…`, held when nothing is unstaged | `Commit` disabled, the existing **visible** submodule line above the bar |
| only conflicts left | none | `Commit` disabled, with the conflict's visible line ([git-conflict-ui.md](git-conflict-ui.md#what-stops-while-an-operation-is-in-progress)) |

**Left takes away, right keeps.** The bar reads the review's bar at the scale of the list: there the left button takes away and the right one keeps, for one file; here the same, for every file at once — `Commit` takes the Staged group, `Discard unstaged…` throws away the Unstaged one. It is the AI workflow in two presses — go through what the agent changed, stage what is good, discard what is not, commit.

- **`Discard unstaged…`** is a secondary button in the review's `Discard file` style (`th-bg-tertiary` fill, `th-error` text), at most half the width, 12px from Commit as in the review's bar. At the sidebar's default width its label is wider than its half, so it wraps to two lines inside the 44px button rather than truncating (`CommitBar.browser.test.tsx`); only at the sidebar's narrowest does it take three and the bar grows a few pixels. Half rather than the review's 40%, which would cost the third line at the default width too. It opens the existing `ConfirmDialog` with the batch copy ([git-ui.md](git-ui.md#discard)), which counts the files and says what stays: `Discard unstaged changes?`, `The unstaged edits in n files will be lost and m untracked files will be deleted. Staged changes are kept.` — `Delete untracked files?` when every one is untracked — or the single-file wording when the batch is one file, its partly staged variant included.
- **What it takes is the Unstaged group**: every file's unstaged side, as discard-all always took. A file with only unstaged changes loses them, an untracked one is deleted. A partly staged file loses its unstaged side only, and stays in Staged. A file only in Staged is untouched. A conflicted file has no unstaged side and is passed over, as its own sheet offers no discard ([git-conflict-ui.md](git-conflict-ui.md#the-changes-list)). Renames and submodule files go through the same `git.discard` as a single file's discard, so what each loses is unchanged.
- **Held, not hidden, when nothing is unstaged.** By the rule above a control that answers nothing is not there, and the button used to go whenever everything was staged. Hidden, it took with it two things the list teaches nowhere else: that discarding many files lives here, and that staged changes are safe from it — and staging everything is exactly when a user goes looking for the first and needs to know the second. So it stays, held, and a press says `Nothing is unstaged. Unstage a file to discard it.`, which teaches both. It is hidden only when neither Unstaged nor Staged has a row — conflicts alone are left, which no discard here touches.
- **Held, too, while any file in the list has a write queued**: the write queue drops a path it already holds, so a discard let through then would skip that file and report success. A press then says `Wait for the changes in progress to finish.`, which wins when both hold: the state is still changing.
- **Held is `aria-disabled`, not `disabled`** — the button looks disabled (half opacity, not-allowed cursor) but still takes a press, and a press while held opens nothing and shows its reason in a `text-xs` muted line above the bar, where the commit hint goes, tied to the button by `aria-describedby`. A `title` would never be seen on touch ([responsive-ui.md](responsive-ui.md#progressive-disclosure-hover-reveal)). The line stays until its reason ends and does not come back by itself: every stage press is a short write, and a line that came and went with each would jolt the bar.
- A file under review that it discards is done with — a partly staged one included, whose staged part waits in Staged — and the review moves on, as for any discard from the list ([When the list changes under the review](#when-the-list-changes-under-the-review)).
- **No separate multi-select mode.** The groups are the list's one meaning of "chosen": Staged is what `Commit` takes, Unstaged what `Discard unstaged…` takes. A selection on top would be a third set that neither button reads.
- The `sr-only` hint `Stage a file to commit` stays sr-only by git-ui.md's test, at any scroll: with nothing staged every row on screen carries a `+` stage button, the list opens on `Stage all` and ends on `No staged changes.` right above the bar. The Staged group alone would not pass — a long Unstaged list scrolls it out of view.
- `Commit n files` opens the existing commit sheet. n is the root repository's staged count, as before.
- The bar and the sheet stay siblings, so a refresh that empties the tree does not unmount a half-written message ([git-ui.md](git-ui.md#commit)).
- The chat's [review row](agent-handoff-ui.md#25-pressing-review) starts at the first file in review order, through `firstReviewTarget` in `lib/gitChanges.ts` — not necessarily the list's first row, which is the first conflict or unstaged change.

### Clean, loading, failed

- **Clean**: in place of the header and the list, centred and muted, `No changes`, and nothing else: History is one tap away in the segmented control above. No bottom bar.
- **Loading**: the spinner, as today. No header, no bar.
- **Status unreadable**: `Failed to load git status` and the reason, as today. No header, no bar.

## The review layer

The review layer is the `diff` layer redesigned: one file at a time, in [review order](#review-order), with "stage and go to the next file" as its primary action. A conflicted file is reviewed in the same layer and order but draws the conflict view instead, with its own bottom bar ([git-conflict-ui.md](git-conflict-ui.md#viewing-a-conflicted-file)).

### Below `expanded`

```
┌──────────────────────────────────┐
│ ←  GitTab.tsx                    │  app header — file name; tap opens the file
├──────────────────────────────────┤
│ ‹  2 / 5  ›  web/src/compo…  ↵ ␣ │  review toolbar — no top bar over a layer
├──────────────────────────────────┤
│ ⚠ Stage failed · Details       ✕ │  the layer's banner
│  40   import { Foo }             │
│  41 − const a = «old»;           │  «» = word-level highlight
│  41 + const a = «new»;           │
│ Lines 40–48 · functi… ⋮≡ [Stage] │  hunk bar (Staging a hunk)
│ ┄┄┄ ⌄ 24 unchanged lines ⌃ ┄┄┄  │  collapsed context, tap to expand
│  66   …                          │
├──────────────────────────────────┤
│ [ Discard file ]  [Stage & next] │  bottom bar — gone while the keyboard is up
├──────────────────────────────────┤
│ [+] Message…                 [↑] │  the chat's composer
└──────────────────────────────────┘
```

**App header.** The file name as the title, tappable to open the working-tree file (`Open <path>`) as the diff's title is today — except for a deleted file, where it is plain text. `←` goes to the parent, the Changes list (`Back to changes`), the way every way out of the review does ([below](#what-the-two-bottom-buttons-say)). At `expanded` the same press is drawn as the way back to the chat: the Changes list's URL is the chat there, with the list in the sidebar beside it ([At `expanded`](#at-expanded)).

**Review toolbar**, one row, `min-h-[44px]`, under the app header:

| Part | Content |
|---|---|
| `‹` `›` | L5 buttons, `Previous file` / `Next file`: move without staging. Disabled at the ends |
| Position | `2 / 5`, tabular figures; `aria-live` off. Its accessible text is `File 2 of 5` |
| Path | The directory, muted, truncated from the head — the full path is the header plus this |
| `↵` wrap | `ToggleIconButton` (`WrapText`), `Wrap lines` / `Don't wrap lines` |
| `␣` whitespace | The existing `ALargeSmall` toggle and store, moved here from the bottom bar |
| Split | `Columns2`, at `expanded` only ([below](#at-expanded)) |
| The file's actions | At `expanded` only: the bottom bar's two buttons, at the row's end ([below](#at-expanded)) |

The toggles go in the toolbar rather than the bottom bar because the bottom bar now carries two text buttons and is for deciding about the file; the toolbar is for how to read it. When the row is too narrow, the path is what gives way — it is the row's one `flex-1 min-w-0` element and truncates to nothing before any control moves. At 360px on a coarse pointer the fixed parts are four 44px buttons, `2 / 5` and the 8px gaps between them, about 260px, so they always fit.

**Side row**, only for a partially staged file: a second row under the toolbar, `Partly staged` in muted text and a segmented control `Unstaged | Staged` ([Partially and fully staged files](#partially-and-fully-staged-files)). It is a row of its own rather than a toolbar part because a 140px control beside four buttons and the position would overflow a phone's toolbar, and because it only exists for the one case in which it says something.

**Bottom bar** (`BottomActionBar`): a secondary button on the left, the L1 primary on the right taking the remaining width, with a gap between them so the destructive one is not flush against the one used all day. It stands above the chat's composer, which is under every Git detail, and goes while the composer holds a soft keyboard; at `expanded` its buttons are in the toolbar instead. Which of the three is [git-ui.md](git-ui.md#where-a-details-actions-go)'s rule, shared with a commit's file layers.

### What the two bottom buttons say

The left button acts on **the side on screen**, the primary on **the file**:

| Side on screen | Left |
|---|---|
| Unstaged (the file has unstaged changes) | `Discard file` (`Delete file` if untracked) — discards exactly what is on screen |
| Staged | `Unstage` — unstages the whole file, which is what is on screen plus nothing else |
| None — the file no longer has changes ([below](#when-the-list-changes-under-the-review)) | no button |

| The file | Primary |
|---|---|
| Has unstaged changes, not the last file | `Stage & next` |
| Has unstaged changes, the last file | `Stage` — and once that succeeds the page stays, and the primary becomes `Commit n files` |
| Fully staged, not the last file | `Next` |
| Fully staged, the last file | `Commit n files` |
| No longer changed | `Next`, or `Commit n files` when nothing sorts after it, or `Back to changes` when the tree is clean |

- **`Stage & next`** queues `git.add` for this file; the button shows the spinner and `Staging…`; on success the layer moves to the next file. On failure it stays, with the failure in the layer's banner, as the diff's stage failure does today — and one that answers after the reader left goes to the Changes banner, as today.
- **The last file stages and stays** rather than jumping straight into the commit sheet: the reader sees the file go to Staged and the count become right before being asked to commit, and a stage failure is never hidden behind a sheet.
- **`Commit n files`** opens the existing commit sheet, over the review layer. It follows `describeCommitAction` exactly as the list's bar does: disabled with the visible submodule line when only submodule files are staged; disabled with `Stage a file to commit` (sr-only) when nothing is staged — possible when every earlier file was skipped with `›`. The sheet is a sibling of the bottom bar, not inside it, so a refresh that changes the buttons under it — or the bar going while the keyboard is up — does not unmount a half-written message. **A successful commit started here ends the review**: the reader is taken to the Changes list (at `expanded`, the chat beside the sidebar's list), since what the reader came to do is done; files left unstaged are waiting in the list. This is the one move that leaves the review by itself, and it does so only because the reader asked for it — a change made by somebody else never does ([below](#when-the-list-changes-under-the-review)).
- **`Discard file`** opens the existing `ConfirmDialog` with the single-file copy. It discards the unstaged side only, as discard always has, so on a partly staged file the dialog reads `Discard unstaged changes?` and says the staged changes are kept ([git-ui.md](git-ui.md#discard)). On success the layer moves to the next file — replacing, since the discarded file has no review left to come back to — or to the list when it was the last.
- **`Unstage`** queues `git.reset` and stays on the file, on its unstaged side; the buttons then follow the tables again. A staged side has nothing to discard, so the left slot offers the undo of staging instead — the same rule as the action sheet.
- Moving between files — `‹ ›`, `Stage & next`, `Next`, discard — **replaces** the history entry rather than pushing. A review is one place: Back leaves it for the list in one step, instead of walking back through every file read. At `expanded`, a row tapped in the sidebar's list beside an open review moves the review too, replacing as `‹ ›` would; only the tap that opens a review from the list pushes. **Leaving** the review — `←`, a commit made from it, discarding its last file, `Back to changes` — goes *back* to the list when the review was pushed from it, so the history is what it was before the review opened: neither the list twice (a Back that does nothing on screen) nor a list pushed over the review (a Back that reopens it). The push marks its history entry and every move inside carries the mark (`REVIEW_FROM_LIST_STATE` in `lib/navigation.ts`); a review reached any other way — a link, a URL typed in, the chat's review row — has no list behind it, and is replaced by the list instead (`hooks/useLeaveReview.ts`).

### Review order

**The sequence is per path, in the list's path order** — flat or tree, as chosen ([Flat and tree](#flat-and-tree)) — over every changed file, staged ones included, collapsed folders included. `2 / 5` is the file's place in that sequence and its length, and `5` is the list header's `5 files`.

**The list is grouped; the review is not.** A partly staged file is one entry with a side switch ([below](#partially-and-fully-staged-files)), not one per group: a reader deciding about a file sees both of its parts in one place, and a walk of the groups would visit it twice. So the review walks the paths in the order each group draws its rows, but across the groups: it is not the list's top-to-bottom order, and its first file need not be the list's first row.

- **Fully staged files stay in the sequence.** Leaving them out would make `n / m` jump as the reader stages, and a review that skips files is not a review of what is about to be committed. They cost one tap (`Next`).
- **"Next" is found by position in the order, not by index.** The next file is the first file in the *current* list that sorts after the file on screen. So a file added, removed or re-staged elsewhere while the reader is on the page never makes `Next` skip one or land on the same file twice; and since the order is by path, not by group, staging the file on screen changes nothing about what comes next. Previous is the mirror.
- **The total is live.** If the agent changes another file while the reader is reviewing, `5` becomes `6` and the new file takes its place in the order.

### Partially and fully staged files

The review layer keeps the diff route's two sides — the route still names a path and which side is on screen. A list row opens its own side, so a partly staged file's Staged row opens the staged side. Everything else — `‹ ›`, `Stage & next`, the chat's review row — picks a *file*, and the side follows it:

| File | Side opened | Side switch |
|---|---|---|
| Only unstaged changes (incl. untracked) | Unstaged (index → working tree) | none |
| Only staged | Staged (HEAD → index) | none |
| Both | Unstaged | `Unstaged | Staged` — the part about to be staged, and the part already staged |

Opening the unstaged side of a partially staged file is the useful default: it is exactly what `Stage & next` would add. The side switch replaces the history entry like any other move inside the review. After `Unstage` the file has only an unstaged side; after `Stage` only a staged one — the layer follows to the side that still exists, replacing the route so that it keeps naming the side on screen. The page is one instance per *path*, not per side, so following a side, or switching it, does not start the page over or drop a stage still on its way.

### When the list changes under the review

The file on screen can stop being changed while it is read — the agent commits or reverts it, or it is discarded from the list at `expanded`. The page is **not** yanked away from the reader:

- The diff area says `This file no longer has changes` in one muted, centred line; the toolbar shows `– / 5` (the live total, and no position); the left button disappears and the primary follows the table above. `‹ ›` keep working by position.
- If the whole tree becomes clean, the primary reads `Back to changes`, which goes to the list's `No changes`.
- An open commit sheet stays open through all of this, for the reason the list's does.

A file discarded from the list while it is under review is done with, as the review's own `Discard file` treats it: the review moves on to the next file — replacing, as every move in it does — or to the list when nothing follows. That holds on either side, the staged side of a partly staged file included: the reader decided about the file from the list, and the staged part still waits in Staged. `ChangesSection` names the file that follows from the list as it is when the discard answers — which may not have heard of the discard yet, so a file the same discard left with no changes is passed over, and one with something staged is named on its staged side — and `AppShell`'s `handleCloseGitFile` moves only if that review is still the page ([git-ui.md](git-ui.md#discard)).

### The diff itself

- **Wrap** is on by default below `expanded` and off at `expanded`: on a phone sideways scrolling inside a vertically scrolling page is the gesture conflict this story removes; on a desktop wide lines are better read unbroken. The reader's choice is remembered (`pockode:gitReviewWrap`), and once set it is used at every width. It is a setting of its own and not the chat's `wrapLines`: tool-call diffs are short snippets with a different default.
- **Word-level highlight.** Within a modified line pair, the changed words carry a stronger tint than the line's own — `@git-diff-view` does this from the hunks and both contents, which the diff result already carries, and `index.css` already themes it (`--diff-add-content-highlight--` and its pair). Syntax highlighting stays.
- **Collapsed context.** Three lines of context around each hunk, as git produces. Between hunks, and before the first and after the last, a separator row says `24 unchanged lines` with an expand control; each press reveals more of the gap, and a gap fully revealed joins the hunks. The separator row is `min-h-[44px]` on a coarse pointer and its whole width is the target — the library's own expand rows (themed in `index.css` as `--diff-expand-*`) are too small for a thumb and are restyled, not replaced. Expansion is lost when the file changes; it is a reading state. Between two hunks the library has two controls, one carrying on down from the hunk above and one up from the hunk below; on a coarse pointer each is 44px, stacked, and a press elsewhere on the row is the downward one — reading order (`components/ui/collapsedContext.ts`).
- **Ignore whitespace** is the existing toggle and store. When hiding whitespace leaves no diff, the area says `Only whitespace changed` with a text button `Show whitespace`, rather than the bare `No changes` that read as a bug.
- **A commit's file diff reads the same way.** It is drawn by the same `DiffContent`, so wrap — the same remembered setting — word highlight, collapsed context and the whitespace notice all apply there too; its bottom bar carries the wrap toggle beside the whitespace one. Reading a file's change does not depend on whether it has been committed yet.

### Special files

| File | Row | Review |
|---|---|---|
| Binary | `Binary` instead of counts | The existing `Binary file - cannot display diff` card; the bottom bar works as for any file |
| Over the inline limit | counts as git gives them; none for an untracked file over the server's read limit | The existing too-large card |
| Untracked | `+n` (all added), `· Untracked` | All lines added; left button `Delete file`, with the untracked copy |
| Added (staged) | `· Added` | All lines added |
| Deleted | name struck through, `−n`, `· Deleted` | All lines removed; the title is plain text and `Open file` is disabled — there is no working-tree file |
| Renamed | `· Renamed from <old>` | The staged diff against the old path ([git.md](git.md#status)); the toolbar's path is the new path. A rename with no edit shows `No content changes`. git reports a rename on the staged side; an unstaged move is a deletion plus an untracked file, and is shown as exactly that |
| Mode change only, or empty | no counts | `No content changes` |
| Inside a submodule | `· Submodule` | Like any file. Staging goes to the submodule's index; the commit button's existing submodule rules explain what is not committed |

### Staging a hunk

Each hunk of the diff gets a row of its own, the **hunk bar**, carrying a `Stage` button — `Unstage` on the staged side. It is the bottom bar's `Stage` / `Unstage` scaled down to one hunk: the same words, the bottom bar's for the whole file and the bar's for this part of it, the pattern of VS Code's Stage Block and GitHub Desktop. The rules for in flight and failure are the file's. Per-line staging is not offered. Lines can be selected only to hand them to the agent ([below](#handing-lines-to-the-agent)).

```
│  40   import { Foo }             │
│  41 − const a = «old»;           │
│  41 + const a = «new»;           │
│ Lines 40–48 · functi… ⋮≡ [Stage] │  hunk bar, under the hunk's last row
│ ┄┄┄ ⌄ 24 unchanged lines ⌃ ┄┄┄  │  gap row (unchanged)
```

**What the bar holds**, left to right:

| Part | Content |
|---|---|
| Range | `Lines 40–48`, from the side's new numbering (`+40,9` in git's header): the working tree's lines on the unstaged side, the index's on the staged side (the commit's, in a commit's diff). A hunk of one line reads `Line 40`. A hunk that only removes lines (`-41,3 +40,0`, or a deleted file's `+0,0`) reads `Removed lines 41–43` in the old numbering, the label the selection bar uses for the same case. `text-xs`, tabular figures |
| Context | git's function context, the text after the second `@@`, muted, and the row's one `flex-1 min-w-0` part, truncating at the tail. Absent when git gives none |
| Select | An L5 icon button (`TextSelect`), `Select lines 40–48`: selects the hunk's rows for [handing to the agent](#handing-lines-to-the-agent) and moves focus to the selection bar. It is the keyboard's way to a selection, and a one-tap way for a thumb to take a whole hunk |
| Stage | At the right end, after Select: a small text button (`th-bg-tertiary`, `text-xs`, 36px tall, 44px on a coarse pointer), `Stage` on the unstaged side and `Unstage` on the staged side. Absent when the hunk has no ID or is the side's only hunk ([below](#which-hunks-have-a-stage-button)) |

- **Height.** The bar's buttons sit between two other targets. Above it is the gutter cell of the hunk's last line, which selects. Below it is the next gap row, whose whole width expands. A tap that lands a little off either one must not stage the hunk, so the buttons keep the floor's spacing from both ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)). On a coarse pointer the bar is 60px, with the 44px hit area centred and 8px of no target above and below it. On a fine pointer it is 44px, with the 36px area centred and 4px either side. The fill is `th-bg-secondary`, the tint the library's `@@` row had, so the bar reads as the seam between one hunk and what follows.
- **Not sticky.** A hunk is its change plus three lines of context, so its bar is rarely out of sight. A sticky row inside the library's tables, which are two side-by-side tables when split view is unwrapped, is fragile out of proportion to what it would add.
- **It is not the gap row.** The gap row is the library's, and its whole width is the expand target. The bar is the hunk's own row, under the hunk's last line. When a gap is fully expanded and two hunks join on screen, both bars stay: the hunks are git's, taken from the diff text, and expanding context does not merge them. In split view the bar is in the half its anchoring line is on (see below).
- **Accessible name** `Stage lines 40–48` (or `Unstage removed lines 41–43`): the visible verb first, so a voice-control user says what they see, then the range.

**Why under the hunk, not above it.** A title row above the hunk was the first intent, and the library does not allow it. `@git-diff-view/react` 0.0.35 renders, per line, the gap row, the line, its widget row and its extend row, in that order. The gap row renders nothing once its gap is fully expanded, and a hidden line renders no extend row. So the library has no slot directly *above* a hunk that exists in every state, and a `<tr>` written into its React-managed `<tbody>` from outside does not survive its next render. `DiffViewer` therefore hands the bar to `renderExtendLine` on the hunk's last line, which is always visible because it belongs to the hunk. Which line that is depends on the layout — unified draws a change block's additions after its removals, split pairs them up — and `lib/diffHunks.ts` works it out per layout from the hunk's text. In split view the library gives each half's extend row a cell of its own, wrapped or not, so the bar is in the half the last line is on rather than across both. A cost that follows from the library rather than from the position: a staged or unstaged hunk changes the diff, a changed diff is a new model in the library, and a new model starts with every gap collapsed again, so context the reader expanded is folded back after each press. The page still keeps the next bar where the pressed one was.

#### Which hunks have a Stage button

Those the server gives an ID, on a side with more than one hunk. Every `git.diff.subscribe` reply and `git.diff.changed` notification carries `hunk_ids`, one per `@@` hunk, in order, and the i-th hunk takes the i-th ID. Where the hunks cannot be applied as shown, the IDs are absent. The cases are [git.md](git.md#staging-hunks)'s table. The client does not decide this a second time. Without IDs the bars still draw, for their range, context and Select button, but carry no Stage button. A submodule's file has them, and they apply to the submodule's index, as staging the file does.

**A conflicted file has no hunks to stage.** Its review is the conflict view, which draws the working-tree file with its markers rather than a diff, so there are no hunk bars and no line selection: the handoff there is `Ask agent`, and the one stage it offers is `Mark resolved` ([git-conflict-ui.md](git-conflict-ui.md#viewing-a-conflicted-file)). A hunk write that names a conflicted path anyway, from a diff older than the conflict, is refused as a whole-file one is (`-32007`, [git.md](git.md#writes-refused-during-an-operation)), with the same refusal sentence. The other files keep their Stage buttons while a merge or rebase is in progress: staging part of a file is an index edit like staging all of it ([git-conflict-ui.md](git-conflict-ui.md#what-stops-while-an-operation-is-in-progress)).

**A side with one hunk has no Stage button.** That hunk is the whole side, so staging it is the bottom bar's `Stage` / `Unstage` — the same operation under two buttons. The bottom bar's is also the one that finishes what a hunk cannot carry: a mode change is part of no hunk, and a staged rename stays staged when its hunks are unstaged ([git.md](git.md#staging-hunks)). An untracked, added or deleted file is always one hunk. Since a file's hunks have IDs all together or not at all, either every bar of a side has the button or none has, and the Select buttons line up down the side either way. The bar still draws, for its range, context and Select.

#### The two sides read the same way

The button names what pressing it does, so it is fixed by the side it is drawn on:

| Side on screen | Button | Press | Afterwards |
|---|---|---|---|
| Unstaged (index → working tree) | `Stage` on every hunk | `git.hunk.stage` | The hunk leaves this side and appears on the staged one |
| Staged (HEAD → index) | `Unstage` on every hunk | `git.hunk.unstage` | The hunk leaves this side and appears on the unstaged one |

**Why a button and not a checkbox.** The bar used to carry the file's checkbox scaled down to a hunk. Two things were wrong with it. A column of boxes over a bottom bar with a `Stage` button is the commonest "tick, then act" pattern there is, so it read as "check the hunks, then press Stage below" — which is not what it did. And a box drawn on one side could only ever show one state, ☐ on every unstaged hunk and ☑ on every staged one, so the one thing a checkbox is for, seeing the state change, never happened on screen. An action button says what it does, in the bottom bar's words.

#### In flight, and after

**A hunk is busy until a diff read after its write arrives.** The press queues the write, and the button shows the spinner over its label, which keeps its width so nothing beside it moves, and is `aria-busy` / `aria-disabled` — focusable, ignoring presses — exactly as the file's stage buttons are while its write runs. After the write **succeeds** it stays that way, until a diff read after the write was answered arrives, or until the side is gone. That diff no longer has the hunk, so in practice the button leaves with it. The write's slot in `gitWriteStore` ends when the write answers. The diff comes back separately, and the server's diff watcher polls every 3 s, so for up to that long the button would sit idle in front of a hunk that is already staged. A second press there would be refused, and the stale message below would be a lie. So that the wait is short, the page asks for the diff again as soon as the write succeeds, rather than waiting for the poll. That refresh is **soft**: the diff on screen stays until the new one replaces it, with no loading state in between, since a spinner in its place would empty the scroll box and throw away the position the next paragraph keeps. `useGitDiffWatch`'s `refresh` resubscribes without the loading flag, which is kept for a new path, side or whitespace setting. A refresh that fails replaces the diff with `Failed to load` and the reason, as a first read that fails does; nothing reads it again on its own, so a spinner left in its place would never end. Only a subscribe reply counts as that diff: a notification already on its way when the write answered may predate it. The hunk leaves the view only with that diff, never before (no optimism). A write that fails ends the busy state with its answer, since nothing was written and the hunk is still there.

**The other hunks stay pressable**, and their writes queue behind it. IDs are content, not positions ([git.md](git.md#staging-hunks)), so a press queued behind an earlier hunk of the same file still names its hunk after the earlier one has moved the numbers. Two hunks with identical lines are told apart by order. Pressing the second while the first is in flight can therefore be refused as stale. That is safe, and rare.

**The busy sets.** `gitWriteStore` drops a path it already holds, so hunk writes are deduplicated on their own set, keyed by path and ID. Keyed by path alone, the second hunk's press would be dropped and still report success. They also mark their path busy, the way a file's write does. So while any hunk of the file is in flight, the file's stage buttons in the list show the spinner, and the review's `Discard file`, `Stage & next` and `Unstage` are disabled, as the file's action sheet already is ("Wait for the change in progress to finish."). The reverse holds too: while a file-level `git.add`, `git.reset` or discard is pending on the path, every hunk button of the file is busy. A hunk pressed behind a whole-file write would only be refused as stale once the write had moved it.

**Where the page goes.** When the hunk leaves, the page keeps the next hunk's bar where the pressed bar was, so a run of presses walks down the file under a still thumb, the way `Stage & next` walks the list. With the bar under its hunk, that leaves the next hunk to decide about directly above the thumb. With no hunk below, the page keeps the previous hunk where it was. The successor is the pressed hunk's neighbour by ID, not by index, so two hunks pressed in a row that leave in one diff still hand the place to the hunk after the second. The side follows the existing rules ([Partially and fully staged files](#partially-and-fully-staged-files)). After staging the first hunk of an unstaged-only file, the file is partly staged and the side row appears, with `Unstaged` still selected. After staging the last unstaged hunk, the layer follows to the staged side, replacing the route. Hunk staging never moves to the next file: `Stage & next` is the one control that advances.

**Focus goes with the place.** A keyboard user who pressed a hunk's button finds focus on the Stage button of the hunk that took its place. When that hunk is the last one left, it has no Stage button ([above](#which-hunks-have-a-stage-button)), and focus lands on its Select button instead.

**Failure** goes to the layer's banner, `Stage failed` / `Unstage failed` with the details, and the button returns to its label. The rule is the one `Stage & next` follows, including the fallback to the Changes banner when the answer comes after the reader left.

**When the file changed under the hunk.** The diff on screen can be older than the file: the agent edits it, or the user saves elsewhere, and the watcher has not polled yet. The server then refuses with `-32005` (`CodeGitHunkStale`), having written nothing. The user sees:

- The banner: `This part of the file changed before it could be staged.` (`unstaged` for the staged side), with no details link, because nothing failed that the user could act on. There is no automatic retry: the hunk the user decided about is gone, and staging whatever now sits in its place is the user's decision to make again.
- The diff asked for again at once, softly, as after a success. The page keeps the bar nearest the refused one where the refused one was.

**Hidden whitespace.** With `Ignore whitespace` on, the hunks on screen come from `-w`, so the server sends no IDs and the bars have no Stage button. One muted line above the diff says `Show whitespace to stage parts of this file`, with the existing `Show whitespace` text button. It is left out when the status already says the file would have no IDs anyway: binary, conflicted, or turned into a symlink or back (`gitChanges.ts`'s `stagesOnlyWhole`). The bottom bar's whole-file actions are unaffected.

**The Changes list needs nothing new.** A file with some hunks staged is in both of `git.status`'s lists, which the list already draws as a row in each group ([The groups](#the-groups)). Its Unstaged row's `+` stages the rest and its Staged row's `−` unstages everything, by Decision 3: neither throws away a hunk the user staged on purpose.

**No per-hunk discard.** `Discard file` keeps discarding the side on screen. A one-tap destructive control on every hunk is the kind of control this redesign moved behind a menu.

### Handing lines to the agent

The user selects a range of the diff by its line numbers and gets two actions: `Ask AI to edit…`, which goes through the [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), and `Copy`. Selection exists only for these two. It stages nothing. A commit's file diff offers the same ([below](#where-it-is-offered)); what this section says of the review holds there unless that says otherwise.

#### Selecting

The **line-number gutter** is the control. Its cells are `user-select: none`, so a press there never starts the system's text selection, and the code beside it stays selectable the usual way. There is no long press: on a phone it is the system's own text selection ([Goals](#goals-and-constraints)).

How a press reads depends on **what pressed**, decided per event from `PointerEvent.pointerType`. It is not decided by the `pointer-fine` / `pointer-coarse` gates. Those are deliberately not complements ([responsive-ui.md](responsive-ui.md#they-are-deliberately-not-complements)): a touchscreen laptop matches both, and one plain press must not mean "start again" under the mouse and "extend" under the finger on the same screen.

| | Mouse (`pointerType` `mouse`) | Touch or pen |
|---|---|---|
| Start | Click a line number: that line alone, the anchor | Tap a line number: that line alone, the anchor |
| Extend | Shift-click a number: anchor to it. Or drag down or up the gutter | Tap another number: anchor to it. Each tap moves the range's far end, so a tap that lands one line off is corrected by the next one |
| Start again elsewhere | Click a number without Shift | ✕, or a tap outside ([below](#how-it-goes-away)), then a new tap |
| Clear | ✕, Escape, a click outside, or clicking the only selected line again | ✕, a tap outside, or tapping the only selected line again |
| Whole hunk | The hunk bar's Select button | The same |
| Hint | `cursor: pointer` and the hover tint on the number cell | None. The first tap shows what the gutter does |

Touch has no Shift, and a drag in the gutter on a touch screen is the page's scroll. A mouse drag is tracked with pointer events, gutter only, as gesture tracking is everywhere ([responsive-ui.md](responsive-ui.md#which-event-primitive)). The `click` that ends a drag is the drag's own: it lands on whatever contains both ends, and it must not count as the click outside that clears the selection the drag just made.

- **The unit is a diff row**: context, added and removed lines alike. In unified view the library draws the old and new numbers in one cell per row, and pressing it selects the row. The range runs in row order. In split view a range stays on the side it started on. Pressing the other side's numbers starts a new selection there.
- **A range may cross a collapsed gap.** The gap row is highlighted with the rest, and the hidden lines are part of the range ([below](#what-ask-ai-to-edit-writes)). Expanding a gap inside the range keeps the selection and shows what it already held.
- **Drawn as** a `th-accent` tint across the selected rows, laid over the add and remove tints rather than replacing them, plus a 2px `th-accent` bar on the gutter's left edge and the selected numbers in `th-accent`. The selection reads as "the user's" and the change colours still read as the diff.
- **Hit area.** A gutter cell is one line of code tall, under the 44px coarse floor. That is a deliberate exemption, recorded with its reasons and the cells' widths in [responsive-ui.md](responsive-ui.md#a-diffs-line-numbers). The one neighbour that executes something, the hunk bar's Stage button, keeps the floor's spacing (above).
- **Keyboard and screen readers** reach a selection through the hunk bar's Select button, a hunk at a time. One focusable stop per line would put a thousand stops in a long file. Selecting any range by keyboard waits for keyboard navigation of the review as a whole ([git-ui.md](git-ui.md#out-of-scope)).

**The selection is a reading state**, like the expanded gaps, and is cleared when the rows it names may be gone:

- A different file (`‹ ›`, `Stage & next`, a list row at `expanded`), the side switch, or the whitespace or split toggle clears it.
- A refreshed diff for the file keeps it when every selected row is still there, with the same text and the same number on the side the range is named by. The other side's numbers do not count: on the unstaged side the old numbers are the index's, and staging a hunk above the selection moves them while the lines picked are unchanged. A connection being re-established, with no diff for a moment, keeps it too. Otherwise it is cleared, with the polite announcement `Selection cleared — the file changed`. An agent editing elsewhere in the file pushes a new diff every few seconds, and a selection that vanished on each of them could never be used. A hunk staged or unstaged from this page leaves the view, so a selection inside it clears.
- Wrap keeps it, since the same rows are only drawn differently.
- `Ask AI to edit…` keeps it: the handoff writes into the composer under the page and the user stays on it, so the same range can still be copied or narrowed.
- Leaving the page drops it.

#### The selection bar

```
│  41 + const a = «new»;           │  selected rows
│  42 + const b = 2;               │
├──────────────────────────────────┤
│ Lines 41–42   [Copy] [✦ Ask AI…] ✕│  selection bar, under the diff's scroll area
├──────────────────────────────────┤
│ [ Discard file ]  [Stage & next] │  bottom bar — gone while the keyboard is up
├──────────────────────────────────┤
│ [+] Message…                 [↑] │  the chat's composer
└──────────────────────────────────┘
```

- **Where.** Docked at the bottom of the diff area, directly above the review's bottom bar, and so above the composer under it. It is full width below `expanded`. At `expanded` it spans the main area, over the composer — the bottom bar's buttons are in the toolbar there — and the sidebar's list is untouched. **It stays with the keyboard up**, when the bottom bar goes: typing an instruction is exactly when the user wants a piece of the code in it. A press on it then does not take focus from the text field the caret is in — it would drop the keyboard, the bottom bar would come back under this one before the press's click arrived, and the button would move out from under the finger; and the user goes on typing after the insert, which lands at that caret ([agent-handoff-ui.md §1.2](agent-handoff-ui.md#in-at-the-caret)). With no caret in a field, a press takes focus as usual ([git-ui.md](git-ui.md#where-a-details-actions-go)). It is a raised strip (`th-bg-secondary`, top border, the sheets' shadow), not a bubble beside the selection: a bubble would have to follow the range as the page scrolls, would cover the code it points at, and on a phone would sit where the thumb is not. It is laid out in the page's column, between the diff's scroll area and the bottom bar (or the composer), rather than over the diff: while it is up the scroll area simply ends at its top edge, so the last selected line can always be scrolled clear of it. It is not portalled, so it mounts and unmounts with the review page and never floats over a page the user moved to.
- **What it holds.** First the range label, the row's one `flex-1 min-w-0` part: `Lines 41–42`, `Line 41`, `Removed lines 41–43` when every selected row is a removed one, or `Old lines 41–48` for a range made on the old side in split view. Then `Copy`, then `Ask AI to edit…` with the `Sparkles` icon the commit sheet's `Draft` uses. Both are secondary buttons (`th-bg-tertiary`), each with a minimum width that holds its busy and done labels (`Copied`, `Opening chat…`), so a pressed button never moves the one beside it. Last is ✕, an L5 button named `Clear selection`. Every control reaches 44px on a coarse pointer by growing the box, as in the bottom bar. Neither action is L1: the bottom bar's primary is still the page's one primary, and both are on screen at once.
- **For assistive technology** the bar is a `role="group"` named `Selected lines`, with its buttons in tab order. It is not a `toolbar`, which would promise arrow-key focus. A selection made by pointer announces `Lines 41–42 selected` politely, since tapping the gutter moves no focus. One made with the hunk bar's Select button moves focus to `Copy`. When the bar goes while it holds focus (✕, Escape, a refresh), focus returns to the Select button of the hunk the selection was in, or the nearest one left.
- **At 360px on a coarse pointer** the label truncates first. The fixed parts (the two text buttons, ✕, gaps and padding) take roughly 320–330px, so the label keeps only a few dozen pixels and shows the start of its range.
- **`Copy`** copies the code as it stands on the side the range is numbered on. That is the new side's lines from the first to the last selected, verbatim, hidden gap lines included, read from the full content the diff already carries. For a removed-only range, or one made on the old side in split view, it is the old side's lines. No `+` / `-` markers: someone who copies code wants code. A diff for the agent is what the other button is for. Feedback is `useCopyToClipboard`'s: `Copied` with a check for about a second, or `Copy failed`, which stays until the next press so that it cannot flash past a reader who looked away. Both are also said politely. The selection stays, so `Ask AI to edit…` can follow.
- **`Ask AI to edit…`** puts the text below into the draft through `usePrefillComposer().insert`, which resolves the session and writes the draft ([agent-handoff-ui.md §1](agent-handoff-ui.md#1-prefill-handoff)). With the route's session, that is the composer under the page: the text goes in **at the composer's caret**, as a block of its own, and the caret ends on a fresh line under it ([agent-handoff-ui.md §1.2](agent-handoff-ui.md#in-at-the-caret)) — the user who typed half an instruction and then picked the lines gets the lines where they were writing, and carries on. A composer the user has not been in yet gets it appended, as any prefill. The user stays on the diff either way; only a session that has to be created first takes the user to its chat. The ellipsis is the usual promise that something follows before anything is done: the user writes the instruction there, and nothing is sent. The hook is called by the page (`DiffView`, `CommitDiffView`, through `useLineSelection`), not by the bar. The bar unmounts whenever the selection clears, which a diff refresh can do while a new session is still being created, and an unmounted caller loses the hook's error. While a session is being created (`isPending`) the button shows the spinner and `Opening chat…`, and the rest of the bar stays usable. A failure goes to the layer's banner with the hook's own summary and details, and is dismissed with it.

#### How it goes away

The bar has no backdrop, so it follows the shared conventions for overlays without one ([AGENTS.md](../AGENTS.md), `useOutsideClick` and Escape):

- **✕** and **pressing the only selected line again** clear it.
- **Escape** clears it. The bar listens on `document` and claims the key with `preventDefault`. It stands down in two cases, which between them cover everything that can be over the review ([answering-ui.md](answering-ui.md#who-owns-escape)). First, while `useIsPageCovered()` is true. `Sheet` and `ConfirmDialog` count as covering through their scroll lock, and they claim Escape with `stopPropagation`, which does not stop another listener on `document`, so the count is what keeps the bar from clearing under a sheet that is closing. Second, when the press is already `defaultPrevented`, which is how `Sidebar` and `ResponsivePanel` mark theirs. The bar does not call `useCoverPage` itself: it is part of the surface, not a layer over it.
- **A click outside** (`useOutsideClick`, so a scroll on a phone never dismisses) clears it, and is claimed with `stopPropagation`, but only when the click lands on non-interactive content: the code, the empty part of the diff area, the headers. A click on the bar, on a gutter number, or on any control (a hunk's Stage or Select button, a gap row, the toolbar, the bottom bar, the composer, a list row at `expanded`) is not a dismissal and passes untouched. Whatever that control does then decides: staging a hunk or moving file changes the rows and clears the selection by the rules above, and opening the commit sheet leaves the selection waiting under it. One press never does two things.

#### What `Ask AI to edit…` writes

````
`web/src/components/Git/DiffView.tsx`, lines 40–48 (working tree):

```diff
 import { Foo } from "./foo";
-const a = old;
+const a = new;
… 24 unchanged lines …
 return a;
```
````

| Part | Rule |
|---|---|
| Path | In backticks, as the list knows it: relative to the root repository, a submodule file with its prefix. The agent works in that root, and the handoff carries text only ([agent-handoff-ui.md §1.2](agent-handoff-ui.md#12-what-is-written)) |
| Range | As the bar's label, lower-cased: `lines 40–48`, `line 41`, `removed lines 41–43`, `old lines 41–48`. New-side ranges run from the first to the last selected row that has a new-side number |
| Version | Names the file version the numbers belong to. New-side numbers are `(working tree)` on the unstaged side, the file the agent will open, and `(staged)` on the staged side, where they are the index's. Old-side numbers are `(index)` on the unstaged side, whose old side is the index (which is HEAD's content when nothing is staged), and `(HEAD)` on the staged side. In a commit's diff they are `(as of commit <hash>, not the working tree)` and `(before commit <hash>, not the working tree)`, with the full hash — a short one can be ambiguous in a large repository, and the agent resolves it with git: these lines are history, and without saying so the agent would edit the file as though they were what is on disk. The code is quoted either way, so the agent does not have to reconcile numbers from a version it is not looking at |
| Code | A `diff` fence holding the selected rows with their markers (space, `-`, `+`). Each collapsed gap inside the range is one line, `… 24 unchanged lines …`, in place of lines the user did not read. The fence is one backtick longer than the longest run of backticks in the code, and at least three |
| Too long | Over 200 selected rows (gap lines not counted), the fence is left out and the text is just the path, the range and the version, ending in a period. The agent reads the file itself, and a draft that fills the composer several times over is not something the user can review before sending |

The text is prose plus a fence, never a Pockode command, as the handoff requires. Its last line is the closing fence. Where it goes in at the caret, the handoff leaves the caret on a fresh line under it, for the instruction ([agent-handoff-ui.md §1.2](agent-handoff-ui.md#in-at-the-caret)). Where it is appended instead (the same section says when), the handoff trims what it writes and the caret lands right after the fence: the instruction starts with one line break, the one keystroke every appended prefill costs.

**Same press, same text.** Pressing `Ask AI to edit…` twice for one selection adds nothing the second time, and leaves the caret where it is. That is the handoff's verbatim check, and it holds because the text depends only on the selection and the diff.

#### Where it is offered

In the review layer, on both sides, for every file whose diff has rows, including files whose hunks have no IDs; and in a commit's file diff (`CommitDiffView`), for the same files. There the lines are history, and the version says so ([above](#what-ask-ai-to-edit-writes)): the agent is told which commit the code is quoted from and that the working tree may differ, and reads the working tree itself.

The commit's diff takes everything above from the same code (`useLineSelection`, which both pages call), with what follows from a commit not being a review:

- **Hunk bars without Stage.** Every hunk gets its bar — range, function context, Select — so a keyboard has its way in and focus has a Select to return to, as in the review; nothing in a commit can be staged, so there is no Stage button on any of them. The range is in the commit's numbering.
- **Fewer reading-state rules.** There is no side, no staging and no split view (that toggle is the review's), so of the rules that clear it only the whitespace toggle, another file or commit, and leaving the page remain — with ✕, Escape and a click outside. A commit's diff does not change under the user, but a refetch is held to the same refresh rule, and clears a selection whose rows it no longer has.
- **Where the bar sits** follows the page's own action bar ([git-ui.md](git-ui.md#where-a-details-actions-go)): above it below `expanded`, above the composer at `expanded`, where the actions are under the header.
- A failed handoff is the layer's `ErrorBanner`, as in the review.

### At `expanded`

```
┌──────────────────────────┬──────────────────────────────────────────┐
│ ⑂ feature/git-ui  ↓ Pull │ ←  git.md                                │  top bar | app header — ← back to the chat
│ [Changes] History Branc… │ ‹1/5› docs ↵ ␣ ⫴ [Discard file] [Stage…] │  segments | review toolbar, with the file's actions
│   5 files +142 −37     ≣ │                                          │
│ Unstaged 3   [Stage all] │                                          │
│▌+ git.md        +80 −12⋯ │   (the diff, unified or split)           │
│ + notes.txt     +9     ⋯ │                                          │
│ Staged 3   [Unstage all] │                                          │
│ − git.md        +8 −8  ⋯ │                                          │
├──────────────────────────┼──────────────────────────────────────────┤
│ [Discard…] [Commit 3…]   │ [+] Message…                         [↑] │  the list's bar | the chat's composer
└──────────────────────────┴──────────────────────────────────────────┘
```

- The Changes list is the sidebar's Git tab and the review is the main area, across its whole width ([git-ui.md](git-ui.md#at-expanded-the-sidebars-list-and-the-detail)): the same URL, the file name as the app header's title, the row on screen lit in the list and brought into view. The `←` is drawn as the way back to the chat, which is what the Changes list's URL shows there; so is the bottom bar's `Back to changes` on a clean tree or a conflict's last file, which keeps its words and lands on the chat with the Changes list beside it.
- **Changes are on screen without opening anything**: with nothing open the main area is the chat, and the sidebar's Git tab, once selected, shows the list, as the sidebar's Git panel once did.
- **Split view**: a `Columns2` toggle in the toolbar, `Side by side` / `Inline`, `aria-pressed`, remembered (`pockode:gitReviewSplit`). Default inline. It is offered only at `expanded` — below it there is no width for two columns — and follows the tier, not the measured width, as the layout does ([git-ui.md](git-ui.md#at-expanded-the-sidebars-list-and-the-detail)); at 1024 with an open sidebar the main area is narrow enough that inline is the better choice, which is why it is the default. Split keeps wrap, word highlight and collapsed context: the separator row carries its label on the old side, and a press on either half expands it — unwrapped, each side is a table of its own and the new side's half of the row is an empty placeholder whose buttons are in the other table (`components/ui/collapsedContext.ts`). Unwrapped, each half also scrolls sideways on its own, in step with the other, rather than handing that to the page as inline view does. A commit's file diff stays inline: the toggle is the review's.
- Staging or unstaging a file from the list while it is in the review changes the review's buttons with it, since both read the same status.
- **The file's actions are in the review's toolbar**, at its end: the bottom of the screen is the composer's alone ([git-ui.md](git-ui.md#where-a-details-actions-go)). The buttons keep their full labels — the folder path beside them is what gives way — and fit at 480px (`DiffView.browser.test.tsx`), under the narrowest main area at `expanded`. The commit hint, which on a phone is a line above the bottom bar's buttons, is a line under the toolbar.
- Two primary buttons are on screen at once: the list's in its bottom bar in the sidebar, the review's in its toolbar. On the last file both read `Commit n files` and open the same sheet.

## The sidebar's overview

Below `expanded`, where the Git tab is doors rather than the workspace's list, its `Changes` door carries the totals beside the count: `Changes   5  +142 −37`, the same muted figures as the list header, from the same sums. Its accessible name becomes `Changes, 5 changed files, 142 lines added, 37 removed`. With no counts at all (every file binary or too large) the figures are left out, never `+0 −0`. At `expanded` the tab is the list, and its header carries them. The tab badge is unchanged — a digit on an icon has no room for a diffstat.

Under the door the changed files are listed read-only, drawn by this list's own `ChangedFileRow` (its `readOnly` form: no stage button, no `⋯`, a file's two sides one row) in [review order](#review-order) through the same `useOrderedChanges` the list and the review read, always flat — so a row's place is its `k / n` in the review. The cap, the lit row and what a press opens are [sidebar-ui.md](sidebar-ui.md#below-expanded-the-doorplate)'s.

## Decisions not to lose

1. **Staged and unstaged are groups; the review is per path.** The list draws Conflicts (only while there are any), Unstaged and Staged, a row per path and side, so a partly staged file has a row in each and staging moves a row to the other group — the convention of every Git client users know, where a checkbox list read as a selection. The list's groups and the review share one ordering function over paths, and "next" is computed by that order from the current path, not by index.
2. **`git.status` carries per-side line counts (with binary marked) and the rename source; the row sums the sides.** Without them neither the row nor the sidebar's totals can be drawn.
3. **A stage button moves the whole file.** `+`, `Stage all` and a folder's button only ever stage the rest; `−`, `Unstage all` and a folder's only ever unstage everything; partly staged comes from hunk staging or from elsewhere. Conflicts get no button anywhere.
4. **A stage button is an action, drawn bare**: a plain `<button>` with a `+` / `−` glyph and no box, named `Stage <path>` / `Unstage <path>`, `aria-disabled` and `aria-busy` (not `disabled`) while its write is queued, never moving its row before the status says so, and handing focus to the button that takes its place.
5. **Discard leaves the row** for the action sheet — from an Unstaged row only — and the review's bottom bar, where the left button acts on the side on screen. Discarding many files is the list's bottom bar: `Discard unstaged…` throws away the Unstaged group — left takes away, right keeps, as in the review's bar. It is held, not hidden, when nothing is unstaged, with a reason on press, because hidden it hid where discarding lives and that staged changes are safe from it; it is hidden only when conflicts alone are left. No separate multi-select mode: the groups are the list's one meaning of chosen. The dialog is the existing one; its batch copy says "unstaged" rather than "all", since staged changes are kept.
6. **The review is one history entry.** Moves inside it replace; Back and `←` leave it, and so does a commit made from it — back to the list it was pushed from, so the history is as if it had never opened.
7. **The last file stages and stays**; only then does the primary become `Commit n files`, following `describeCommitAction` — root-only count, submodule line, disabled when nothing is staged.
8. **The page is not taken away from a reader** whose file stopped changing; it says so and offers `Next`.
9. **Wrap defaults by tier and is its own remembered setting; split exists only at `expanded`.**
10. **A hunk is staged with a `Stage` / `Unstage` button, not a checkbox.** A box over each hunk read as "tick, then press Stage below", and on either side it could only show one state. The button uses the bottom bar's words, appears where the server sent `hunk_ids` and the side has more than one hunk — one hunk is the bottom bar's button already — and is drawn under the hunk's last row, the one slot the diff library keeps in every state, keeping the floor's spacing from the gutter above and the gap row below.
11. **A hunk stays busy after a successful write until a diff read after the write arrives**, and the page asks for that diff softly, keeping the old one on screen, as soon as the write succeeds. A failed write ends the busy state. Hunk writes are deduplicated by path and ID but mark the path busy, and file-level writes make every hunk button busy.
12. **A stale hunk (`-32005`) is said as such, the diff is read again, and nothing retries.**
13. **Lines are selected by their numbers, never by a long press**, and how a press reads follows `pointerType`: click, Shift-click and drag for a mouse; tap, then tap the far end, for touch. The hunk bar's Select button is the keyboard's way in. The gutter's sub-44px rows are a recorded exemption.
14. **The selection bar is docked above the bottom bar, not floating at the selection**, and stays there with the keyboard up, when the bottom bar goes. It is cleared by ✕, by Escape (on `document`, claimed, standing down while the page is covered or the key is already claimed), and by a click outside on non-interactive content (claimed), never by a press on a control. A diff refresh keeps it while its rows are unchanged.
15. **`Ask AI to edit…` writes path, range, version and a `diff` fence through the prefill handoff — in at the composer's caret when the user has placed one — and never sends.** `Copy` copies the side the range is numbered on, without markers. A commit's file diff offers both, with the commit named in the version.
16. **Every control answers one question.** One that answers none is removed, two that answer the same one are merged: hence no `Review` button in the list's bottom bar, no `⋯` in its header and no `View history` on a clean tree.
