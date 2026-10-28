# Git Changes and Review UI

The Git workspace's **Changes segment** and its **review layer**, the `diff` layer: one list of changed files with a checkbox per file, and a review page that walks those files one by one so that "review → stage → commit" can be done one-handed on a phone.

The list is `ChangesSection` and the components it draws, the review is `DiffView`, and the ordering both walk is `lib/gitChanges.ts`. Everything not mentioned here — the top bar, the segments and their routes, the commit sheet, the discard confirmation copy, feedback and error banners, the write queue, projects without a repository — stays as [git-ui.md](git-ui.md) describes it, and this file refers to it rather than restating it.

Copy below is the UI's English. What is left for later is in [git-ui.md](git-ui.md#out-of-scope).

## Goals and constraints

- **One list, one row per file.** `Staged` / `Changes` were two lists of the same files, so a partially staged file was two rows and staging a file moved it across the screen out from under the thumb. A row now stays where it is; whether it is staged is a property of the row — its checkbox — not a place.
- **Every action is a visible tap.** No swipe and no long press: in a browser they fight iOS's edge-back, page scrolling and system text selection. Everything below has a control you can see.
- **Touch targets.** Rows are at least 44px; every control inside a row or a bar reaches 44×44 on a coarse pointer, by the usual means ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)). The visual sizes below are for a fine pointer.
- **Discard is unchanged in substance.** Same `ConfirmDialog`, same copy table ([git-ui.md](git-ui.md#discard)), no undo. Only where the entry points live changes.
- **Existing rules hold.** Commit records the root repository only and counts only its staged files; submodule files are staged in the submodule's index ([git-ui.md](git-ui.md#submodules)). Nothing is fired optimistically; writes go through `gitWriteStore`'s queue; failures appear where the action started.

## What the list reads from the server

Each `git.status` entry carries its own side's line counts — or `binary`, or nothing when the count is unknown — and a staged rename carries its source; what each case yields is [git.md](git.md#status)'s. The row shows the **sum of the file's two sides**: that is exactly the two diffs the review shows for the file, so the number on the row is the amount there is to read. A line edited on both sides counts twice, which is accepted for that reason. A path without counts is not an error of the status read; the row simply shows none.

A path listed in `conflicted` — a merge, rebase, cherry-pick, revert or stash pop that stopped on it — is one record carrying `conflict` rather than two sides, and its row, its `⋯` sheet, how select all and folders treat it, and what its review draws are [git-conflict-ui.md](git-conflict-ui.md#the-changes-list)'s; everything below is about the files without one.

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
│ ▣ 5 files  +142 −37      [≣|⌸]   │  list header — sticky
├──────────────────────────────────┤
│ ☑  GitTab.tsx          +12 −3  ⋯ │
│    web/src/components/Git        │
│ ▣  git.md              +88 −20 ⋯ │  ▣ = partially staged
│    docs                          │
│ ☐  notes.txt           +9      ⋯ │
│    Untracked                     │
│ ☐  logo.png         Binary     ⋯ │
│    site/static · Renamed from …  │
│ ☐  old.ts               −14    ⋯ │  name struck through
│    server · Deleted              │
├──────────────────────────────────┤
│ [Discard unchecked…] [Commit 1…] │  bottom bar
└──────────────────────────────────┘
```

**Every control answers one question.** A control that answers none is not there, and two that answer the same one are one. That is why the list has no `Review` button (tapping the first row is the same press), no `⋯` in its header (its one item is the bottom bar's `Discard unchecked…` now) and no `View history` on a clean tree (the segmented control's `History` is right above it).

### The file row

| Part | Content | Tap |
|---|---|---|
| Left: checkbox | 20px box, its 44×44 hit area the whole left gutter of the row. ☐ nothing staged, ☑ fully staged, ▣ partially staged (staged and unstaged changes both) | Toggles staging (below) |
| Middle, line 1 | File name, `text-sm`, truncated **at the tail** with the extension kept (`very-long-na….tsx`) — the name is what is read, so it is not cut from the head as the old row was. CSS cannot cut in the middle, so the stem and the extension are two spans: the stem `truncate`, the extension `shrink-0` | Opens the review layer at this file |
| Middle, line 2 | Muted `text-xs`: the directory, then ` · ` and a status word where there is one. The directory truncates **from the head** (`…/components/Git`), since the deepest folder is the one that tells files apart | (part of the row) |
| Right | `+a −d` in `text-xs` tabular figures; `Binary` for a binary file; nothing when the server has no counts. Zero sides are dropped (`+9`, `−14`), never `+0` | (part of the row) |
| Far right: `⋯` | L5 button, `More actions for <path>` | Opens the file's action sheet |

The row is the L4 row (`SidebarListItem` with `min-h-[44px]`, here two lines tall), with the usual active treatment while its file is open in the review column at `expanded`. The checkbox and `⋯` are siblings of the row's button, never nested inside it.

**In a list 600px wide or more** (`@git-row:`, measured on the list's scroll box — the threshold and why are [git-ui.md](git-ui.md#rows-follow-their-columns-width)'s) the row is one line, its details on the name's baseline:

```
☐  name.tsx   …/components/Git · Renamed from x  ……………  +12 −3  ⋯
```

- The name keeps its natural width up to **60% of the text cell**, then its stem truncates as before.
- The details — the same element, so `aria-describedby` still points at it — take the rest, 12px after the name. Inside them nothing changes: the directory still gives way first, from the head, and the status words last. Past their natural width the room is left blank before the counts.
- **The path is not a column.** File names vary too much: a fixed name column would cut long names and leave holes after short ones, and in tree mode the indent already staggers where rows start. What lines up is the right side: the counts stay against the `⋯`, as in the narrow row.
- Unchanged: the 44px checkbox gutter, the tree indent, `min-h-[44px]`, folder rows (already one line) and the `line-through` on a deleted file's name alone.

**`title`s**, in both layouts: the name span carries the file name, the directory span the directory, the status words span the whole words (`Renamed from <old path>`) — each is what that span may cut.

**Status words on line 2** (the status letter column goes; a word says it once, in full):

| File | Line 2 |
|---|---|
| Modified | the directory only |
| Added (staged new file) | `<dir> · Added` |
| Untracked | `<dir> · Untracked` |
| Deleted | `<dir> · Deleted`, and line 1's name `line-through` |
| Renamed | `<dir> · Renamed from <old>` — `<old>` is the old file name when only the name changed, the full old path when the directory changed too |
| Inside a submodule | `<dir> · Submodule` appended after any other word (`vendor/sdk/src · Untracked · Submodule`) |

A file at the root shows its status word alone, or nothing for a modified file. Line 2 is all `th-text-muted`: none of these states is a failure, so none of them earns `th-error` ([sidebar-ui.md](sidebar-ui.md#visual-weight)). For the same reason `+a −d` is not green and red but `th-text-muted` like line 2: colour in this list is reserved for the one primary action, and the diff itself is where green and red mean something.

### The checkbox

**Meaning.** The checkbox answers "will this file's current content be committed": checked when everything about the file is staged, mixed when some of it is, unchecked when none of it is.

| State | Tap | Request |
|---|---|---|
| ☐ unchecked | stage the file | `git.add` |
| ▣ mixed | stage the rest | `git.add` |
| ☑ checked | unstage the file | `git.reset` |

Unchecking a staged rename unstages its source path with it: in the index a rename is the old path deleted and the new one added, and restoring the new path alone would split the row into `Deleted` and `Untracked`.

Mixed goes to checked, not to unchecked: the press is "include this file", and throwing away a partial staging the user (or the agent) made on purpose is the more surprising of the two. The file's own box never produces mixed: it comes from staging a hunk in the review, or from staging done elsewhere.

**While the write is in flight** the box shows the existing small spinner in place of its mark, the checkbox is `aria-busy="true"` and inert to presses (see Accessibility), and its state does not flip until the refreshed status says so — the workspace's no-optimism rule. A failure goes to the Changes banner as stage/unstage failures do today.

**Accessibility.** A `<button role="checkbox">` with `aria-checked="true" | "false" | "mixed"`, so mixed is a real state and not a third icon. Its name names the property the box holds, `Stage <path>`, and a screen reader adds the state — "Stage docs/git.md, checkbox, partially checked" — as for any checkbox. While its write is queued it is `aria-disabled="true"` and ignores presses rather than taking the `disabled` attribute: `disabled` drops focus, and a keyboard user who pressed Space would be left with focus on nothing. Focus ring as every control. The row's own button is named `Review <path>`; `⋯` is `More actions for <path>`.

### The file's action sheet (`⋯`)

The project's menu shape: a `Sheet` of `MenuRow`s on both layouts, titled with the file's full path (`FileEntryMenu` explains why a sheet and not a dropdown).

| Item | Shown | Does |
|---|---|---|
| `Open file` | Always; **disabled** for a deleted file, with `(deleted)` in its name | The `file` layer, as the diff's title did |
| `Copy path` | Always | Copies the path as the list knows it — relative to the root repository, a submodule file with its submodule prefix. The row reads `Copied` with a check for about a second, then the sheet closes; on failure it reads `Copy failed` and the sheet stays open, the path being in its title (`useCopyToClipboard`'s states) |
| `Discard changes` / `Delete file` (untracked) | Only when the file has unstaged changes — the existing rule that staged-only rows have nothing to discard and are unstaged first | Closes the sheet and opens the existing `ConfirmDialog` with the existing copy. Disabled, with `Wait for the change in progress to finish.`, while the file has a write queued — the queue drops a path it already holds, so a discard let through would report success without running; the bottom bar's `Discard unchecked…` waits the same way while any file has one. Destructive styling as `FileEntryMenu`'s delete, and last in the sheet, after a divider |

Order is frequency, and the destructive item comes last behind a divider in `danger` style — the arrangement `FileEntryMenu` already uses for Delete, so the two menus read alike.

### The list header

One row, sticky at the top of the scroll area, `min-h-[44px]`:

```
▣ 5 files  +142 −37            [≣|⌸]
```

- **Select all** — the same checkbox as the rows, over every file: checked when every file is fully staged, unchecked when nothing is staged anywhere, mixed otherwise. Tap: not checked → stage everything that has unstaged changes; checked → unstage everything. Its visible label is the count, `5 files`, and its accessible name contains it, `Stage all 5 files` — a voice-control user says what they see. The totals beside it are the sum of the rows' counts (binary files and files without counts add nothing).
- **Flat / Tree** — a two-icon segmented toggle (`List` / `FolderTree`), `aria-label="Flat list"` / `"Folder tree"`, `aria-pressed`. The choice is remembered in `localStorage` (`pockode:gitChangesView`), per browser rather than per worktree: it is a reading preference. Default flat.
- **At narrow widths** the row obeys [the narrow-width rule](sidebar-ui.md#the-narrow-width-rule): the label-and-totals group is the one `flex-1 min-w-0` element, and the totals are what truncate away first (they are also on every row and in the sidebar); the checkbox and the toggle are `shrink-0`. At the left column's 280px minimum this is what keeps the row on one line.
- **Nothing destructive.** Discarding every file used to be the one item of a `⋯` here; it is the bottom bar's `Discard unchecked…` now ([below](#the-bottom-bar)). The header is the most-tapped row on the screen (select all), and a destructive control beside it is the arrangement this layout removes.

### Flat and tree

**Order is the same rule in both, and it is also the review order** ([Review order](#review-order)):

- **Flat**: by full path, case-insensitively, `/` sorting before any other character, so a directory's files stay together and line 2 reads in runs.
- **Tree**: at each level, folders first, then files, each by name. This is the order a depth-first walk of the tree reads on screen.

**Tree rows.**

```
▣ ▾ web/src/components     +40 −6
    ☑  GitTab.tsx          +12 −3  ⋯
    ☐  BranchBar.tsx       +28 −3  ⋯
☐ ▸ docs                   +88 −20
```

- A folder row is one line, `min-h-[44px]`: its checkbox, a chevron, the folder name, the summed `+a −d`. No `⋯`. Files are indented under it by 16px per level; the checkbox column stays aligned on the left edge so the boxes form one column a thumb can run down.
- **Single-child chains are compacted** into one row (`web/src/components`), as editors do, so a deep change is not five rows of folders above one file.
- **Tapping the folder row** (name or chevron) expands or collapses it; that button carries `aria-expanded`. All folders start expanded; collapse state is per worktree, in memory, and is lost on reload — it is a navigation state of this visit, not a preference.
- **The folder's checkbox** aggregates every file under it, at any depth, by the same rule as select all: checked when all are fully staged, unchecked when none has anything staged, mixed otherwise. Tap: not checked → stage everything under it; checked → unstage everything under it. Name: `Stage folder web/src/components, 2 files`. It is a batch over paths — one queued request, as select all is — never a `git add <dir>`, which would also pick up files the list does not show.
- A collapsed folder's files still count in its checkbox, in the header's total and in the review sequence.

### The bottom bar

`[ Discard unchecked… ]  [ Commit n files ]`. It renders on the same condition the commit bar always has — `describeCommitAction` returns non-null — so a clean tree and an unreadable status have no bar.

| Working tree | Left | Right (L1) |
|---|---|---|
| n files staged in the root, some changes unstaged | `Discard unchecked…` | `Commit n files` (`Commit 1 file`) |
| every change staged | none | `Commit n files` |
| changes, nothing staged anywhere | `Discard unchecked…` | `Commit` disabled, `sr-only` hint `Check a file to commit` |
| staged only inside a submodule | `Discard unchecked…` when something is unstaged | `Commit` disabled, the existing **visible** submodule line above the bar |

**The checkboxes are the ballot.** A checked box says "commit this file", so an unchecked one says "not this". The bar reads the review's bar at the scale of the list: there the left button takes away and the right one keeps, for one file; here the same, for every file at once. It is the AI workflow in two presses — go through what the agent changed, check what is good, discard what is not, commit.

- **`Discard unchecked…`** is a secondary button in the review's `Discard file` style (`th-bg-tertiary` fill, `th-error` text), at most half the width, 12px from Commit as in the review's bar. At the sidebar's default width its label is wider than its half, so it wraps to two lines inside the 44px button rather than truncating (`CommitBar.browser.test.tsx`); only at the sidebar's narrowest does it take three and the bar grows a few pixels. Half rather than the review's 40%, which would cost the third line at the default width too. It opens the existing `ConfirmDialog` with the existing "all" copy ([git-ui.md](git-ui.md#discard)), which counts the files: `Discard all changes?`, `n files will lose their edits and m untracked files will be deleted`, or the single-file wording when the batch is one file.
- **Unchecked means unstaged**, file by file — the set discard-all always took. An unchecked (☐) file loses its unstaged changes, an untracked one is deleted. A partly checked (▣) file loses its unstaged side only: it goes back to what is staged and stays in the list, ☑. A checked (☑) file is untouched. A conflicted file has no unstaged side and is passed over, as its own sheet offers no discard ([git-conflict-ui.md](git-conflict-ui.md#the-changes-list)). Renames and submodule files go through the same `git.discard` as a single file's discard, so what each loses is unchanged.
- **Hidden when nothing is unstaged** — every file checked, or every file conflicted. **Disabled while any file in the list has a write queued**: the write queue drops a path it already holds, so a discard let through then would skip that file and report success.
- A file under review that it discards is done with — a partly checked one included, whose staged part waits in its row — and the review moves on, as for any discard from the list ([When the list changes under the review](#when-the-list-changes-under-the-review)).
- **No separate multi-select mode.** A row already has one kind of "selected", its checkbox. A second kind would give one list two meanings of selected — the confusion merging `Staged` and `Changes` into one list removed.
- The sr-only hint was `Stage a file to commit`, naming the stage buttons; with those gone it names the checkboxes. It stays sr-only by git-ui.md's test — the boxes are right above the bar.
- `Commit n files` opens the existing commit sheet. n is the root repository's staged count, as before; the count is in the label because the button no longer sits under a `STAGED n` header that said it.
- The bar and the sheet stay siblings, so a refresh that empties the tree does not unmount a half-written message ([git-ui.md](git-ui.md#commit)).
- The chat's [review row](agent-handoff-ui.md#25-pressing-review) starts at the first file in list order, through `firstReviewTarget` in `lib/gitChanges.ts` — the file the list's first row opens.

### Clean, loading, failed

- **Clean**: in place of the header and the list, centred and muted, `No changes`, and nothing else: History is one tap away in the segmented control above. No bottom bar.
- **Loading**: the spinner, as today. No header, no bar.
- **Status unreadable**: `Failed to load git status` and the reason, as today. No header, no bar.

## The review layer

The review layer is the `diff` layer redesigned: one file at a time, in list order, with "stage and go to the next file" as its primary action. A conflicted file is reviewed in the same layer and order but draws the conflict view instead, with its own bottom bar ([git-conflict-ui.md](git-conflict-ui.md#viewing-a-conflicted-file)).

### Below `expanded`

```
┌──────────────────────────────────┐
│ ←  GitTab.tsx                    │  app header — file name; tap opens the file
├──────────────────────────────────┤
│ ⑂ feature/git-ui      ↓ Pull 2   │  top bar, as on every layer
├──────────────────────────────────┤
│ ‹  2 / 5  ›  web/src/compo…  ↵ ␣ │  review toolbar
├──────────────────────────────────┤
│ ⚠ Stage failed · Details       ✕ │  the layer's banner
│  40   import { Foo }             │
│  41 − const a = «old»;           │  «» = word-level highlight
│  41 + const a = «new»;           │
│ Lines 40–48 · functi… ⋮≡ [Stage] │  hunk bar (Staging a hunk)
│ ┄┄┄ ⌄ 24 unchanged lines ⌃ ┄┄┄  │  collapsed context, tap to expand
│  66   …                          │
├──────────────────────────────────┤
│ [ Discard file ]  [Stage & next] │  bottom bar
└──────────────────────────────────┘
```

**App header.** The file name as the title, tappable to open the working-tree file (`Open <path>`) as the diff's title is today — except for a deleted file, where it is plain text. `←` goes to the parent, the Changes list (`Back to changes`), the way every way out of the review does ([below](#what-the-two-bottom-buttons-say)).

**Review toolbar**, one row, `min-h-[44px]`, under the top bar:

| Part | Content |
|---|---|
| `‹` `›` | L5 buttons, `Previous file` / `Next file`: move without staging. Disabled at the ends |
| Position | `2 / 5`, tabular figures; `aria-live` off. Its accessible text is `File 2 of 5` |
| Path | The directory, muted, truncated from the head — the full path is the header plus this |
| `↵` wrap | `ToggleIconButton` (`WrapText`), `Wrap lines` / `Don't wrap lines` |
| `␣` whitespace | The existing `ALargeSmall` toggle and store, moved here from the bottom bar |
| Split | `Columns2`, at `expanded` only ([below](#at-expanded)) |

The toggles go in the toolbar rather than the bottom bar because the bottom bar now carries two text buttons and is for deciding about the file; the toolbar is for how to read it. When the row is too narrow, the path is what gives way — it is the row's one `flex-1 min-w-0` element and truncates to nothing before any control moves. At 360px on a coarse pointer the fixed parts are four 44px buttons, `2 / 5` and the 8px gaps between them, about 260px, so they always fit.

**Side row**, only for a partially staged file: a second row under the toolbar, `Partly staged` in muted text and a segmented control `Unstaged | Staged` ([Partially and fully staged files](#partially-and-fully-staged-files)). It is a row of its own rather than a toolbar part because a 140px control beside four buttons and the position would overflow a phone's toolbar, and because it only exists for the one case in which it says something.

**Bottom bar** (`BottomActionBar`): a secondary button on the left, the L1 primary on the right taking the remaining width, with a gap between them so the destructive one is not flush against the one used all day.

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
- **The last file stages and stays** rather than jumping straight into the commit sheet: the reader sees the file go checked and the count become right before being asked to commit, and a stage failure is never hidden behind a sheet.
- **`Commit n files`** opens the existing commit sheet, over the review layer. It follows `describeCommitAction` exactly as the list's bar does: disabled with the visible submodule line when only submodule files are staged; disabled with `Check a file to commit` (sr-only) when nothing is staged — possible when every earlier file was skipped with `›`. The sheet is a sibling of the bottom bar, not inside it, so a refresh that changes the buttons under it does not unmount a half-written message. **A successful commit started here ends the review**: the reader is taken to the Changes list (at `expanded`, the right column's empty state), since what the reader came to do is done; files left unstaged are waiting in the list. This is the one move that leaves the review by itself, and it does so only because the reader asked for it — a change made by somebody else never does ([below](#when-the-list-changes-under-the-review)).
- **`Discard file`** opens the existing `ConfirmDialog` with the existing single-file copy. It discards the unstaged side only, as discard always has. On success the layer moves to the next file — replacing, since the discarded file has no review left to come back to — or to the list when it was the last.
- **`Unstage`** queues `git.reset` and stays on the file, on its unstaged side; the buttons then follow the tables again. A staged side has nothing to discard, so the left slot offers the undo of staging instead — the same rule as the action sheet.
- Moving between files — `‹ ›`, `Stage & next`, `Next`, discard — **replaces** the history entry rather than pushing. A review is one place: Back leaves it for the list in one step, instead of walking back through every file read. At `expanded`, a row tapped in the list beside an open review moves the review too, replacing as `‹ ›` would; only the tap that opens a review from the list pushes. **Leaving** the review — `←`, a commit made from it, discarding its last file, `Back to changes` — goes *back* to the list when the review was pushed from it, so the history is what it was before the review opened: neither the list twice (a Back that does nothing on screen) nor a list pushed over the review (a Back that reopens it). The push marks its history entry and every move inside carries the mark (`REVIEW_FROM_LIST_STATE` in `lib/navigation.ts`); a review reached any other way — a link, a URL typed in, the chat's review row — has no list behind it, and is replaced by the list instead (`hooks/useLeaveReview.ts`).

### Review order

**The sequence is the list, in the order the list is drawn** — flat or tree, as chosen ([Flat and tree](#flat-and-tree)) — over every changed file, staged ones included, collapsed folders included. `2 / 5` is the file's place in that sequence and its length.

- **Fully staged files stay in the sequence.** Leaving them out would make `n / m` jump as the reader stages, and a review that skips files is not a review of what is about to be committed. They cost one tap (`Next`).
- **"Next" is found by position in the order, not by index.** The next file is the first file in the *current* list that sorts after the file on screen. So a file added, removed or re-staged elsewhere while the reader is on the page never makes `Next` skip one or land on the same file twice; and since staging no longer moves a row, staging the file on screen changes nothing about what comes next. Previous is the mirror.
- **The total is live.** If the agent changes another file while the reader is reviewing, `5` becomes `6` and the new file takes its place in the order.

### Partially and fully staged files

The review layer keeps the diff route's two sides — the route still names a path and which side is on screen — but the reader picks a *file*, not a side:

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

A file discarded from the list while it is under review is done with, as the review's own `Discard file` treats it: the review moves on to the next file — replacing, as every move in it does — or to the list when nothing follows. That holds on either side, the staged side of a partly staged file included: the reader decided about the file from the list, and the staged part still waits in its row. `ChangesSection` names the file that follows from the list as it is when the discard answers — which may not have heard of the discard yet, so a file the same discard left with no changes is passed over, and one with something staged is named on its staged side — and `AppShell`'s `handleCloseGitFile` moves only if that review is still the page ([git-ui.md](git-ui.md#discard)).

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
| Range | `Lines 40–48`, from the side's new numbering (`+40,9` in git's header): the working tree's lines on the unstaged side, the index's on the staged side. A hunk of one line reads `Line 40`. A hunk that only removes lines (`-41,3 +40,0`, or a deleted file's `+0,0`) reads `Removed lines 41–43` in the old numbering, the label the selection bar uses for the same case. `text-xs`, tabular figures |
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

**A hunk is busy until a diff read after its write arrives.** The press queues the write, and the button shows the spinner over its label, which keeps its width so nothing beside it moves, and is `aria-busy` / `aria-disabled` — focusable, ignoring presses — exactly as the file's box is while its write runs. After the write **succeeds** it stays that way, until a diff read after the write was answered arrives, or until the side is gone. That diff no longer has the hunk, so in practice the button leaves with it. The write's slot in `gitWriteStore` ends when the write answers. The diff comes back separately, and the server's diff watcher polls every 3 s, so for up to that long the button would sit idle in front of a hunk that is already staged. A second press there would be refused, and the stale message below would be a lie. So that the wait is short, the page asks for the diff again as soon as the write succeeds, rather than waiting for the poll. That refresh is **soft**: the diff on screen stays until the new one replaces it, with no loading state in between, since a spinner in its place would empty the scroll box and throw away the position the next paragraph keeps. `useGitDiffWatch`'s `refresh` resubscribes without the loading flag, which is kept for a new path, side or whitespace setting. A refresh that fails replaces the diff with `Failed to load` and the reason, as a first read that fails does; nothing reads it again on its own, so a spinner left in its place would never end. Only a subscribe reply counts as that diff: a notification already on its way when the write answered may predate it. The hunk leaves the view only with that diff, never before (no optimism). A write that fails ends the busy state with its answer, since nothing was written and the hunk is still there.

**The other hunks stay pressable**, and their writes queue behind it. IDs are content, not positions ([git.md](git.md#staging-hunks)), so a press queued behind an earlier hunk of the same file still names its hunk after the earlier one has moved the numbers. Two hunks with identical lines are told apart by order. Pressing the second while the first is in flight can therefore be refused as stale. That is safe, and rare.

**The busy sets.** `gitWriteStore` drops a path it already holds, so hunk writes are deduplicated on their own set, keyed by path and ID. Keyed by path alone, the second hunk's press would be dropped and still report success. They also mark their path busy, the way a file's write does. So while any hunk of the file is in flight, the file's box in the list shows the spinner, and the review's `Discard file`, `Stage & next` and `Unstage` are disabled, as the file's action sheet already is ("Wait for the change in progress to finish."). The reverse holds too: while a file-level `git.add`, `git.reset` or discard is pending on the path, every hunk button of the file is busy. A hunk pressed behind a whole-file write would only be refused as stale once the write had moved it.

**Where the page goes.** When the hunk leaves, the page keeps the next hunk's bar where the pressed bar was, so a run of presses walks down the file under a still thumb, the way `Stage & next` walks the list. With the bar under its hunk, that leaves the next hunk to decide about directly above the thumb. With no hunk below, the page keeps the previous hunk where it was. The successor is the pressed hunk's neighbour by ID, not by index, so two hunks pressed in a row that leave in one diff still hand the place to the hunk after the second. The side follows the existing rules ([Partially and fully staged files](#partially-and-fully-staged-files)). After staging the first hunk of an unstaged-only file, the file is partly staged and the side row appears, with `Unstaged` still selected. After staging the last unstaged hunk, the layer follows to the staged side, replacing the route. Hunk staging never moves to the next file: `Stage & next` is the one control that advances.

**Focus goes with the place.** A keyboard user who pressed a hunk's button finds focus on the Stage button of the hunk that took its place. When that hunk is the last one left, it has no Stage button ([above](#which-hunks-have-a-stage-button)), and focus lands on its Select button instead.

**Failure** goes to the layer's banner, `Stage failed` / `Unstage failed` with the details, and the button returns to its label. The rule is the one `Stage & next` follows, including the fallback to the Changes banner when the answer comes after the reader left.

**When the file changed under the hunk.** The diff on screen can be older than the file: the agent edits it, or the user saves elsewhere, and the watcher has not polled yet. The server then refuses with `-32005` (`CodeGitHunkStale`), having written nothing. The user sees:

- The banner: `This part of the file changed before it could be staged.` (`unstaged` for the staged side), with no details link, because nothing failed that the user could act on. There is no automatic retry: the hunk the user decided about is gone, and staging whatever now sits in its place is the user's decision to make again.
- The diff asked for again at once, softly, as after a success. The page keeps the bar nearest the refused one where the refused one was.

**Hidden whitespace.** With `Ignore whitespace` on, the hunks on screen come from `-w`, so the server sends no IDs and the bars have no Stage button. One muted line above the diff says `Show whitespace to stage parts of this file`, with the existing `Show whitespace` text button. It is left out when the status already says the file would have no IDs anyway: binary, conflicted, or turned into a symlink or back (`gitChanges.ts`'s `stagesOnlyWhole`). The bottom bar's whole-file actions are unaffected.

**The Changes list needs nothing new.** A file with some hunks staged is in both of `git.status`'s lists, which the list already draws as ▣ ([The checkbox](#the-checkbox)). Pressing it stages the rest, by Decision 3: mixed goes to checked, never to unchecked, because a hunk the user staged on purpose is not thrown away by a press that means "include this file".

**No per-hunk discard.** `Discard file` keeps discarding the side on screen. A one-tap destructive control on every hunk is the kind of control this redesign moved behind a menu.

### Handing lines to the agent

The user selects a range of the diff by its line numbers and gets two actions: `Ask AI to edit…`, which goes through the [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), and `Copy`. Selection exists only for these two. It stages nothing.

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
- **Hit area.** A gutter cell is one line of code tall, under the 44px coarse floor. That is a deliberate exemption, recorded with its reasons and the cells' widths in [responsive-ui.md](responsive-ui.md#the-reviews-line-numbers). The one neighbour that executes something, the hunk bar's Stage button, keeps the floor's spacing (above).
- **Keyboard and screen readers** reach a selection through the hunk bar's Select button, a hunk at a time. One focusable stop per line would put a thousand stops in a long file. Selecting any range by keyboard waits for keyboard navigation of the review as a whole ([git-ui.md](git-ui.md#out-of-scope)).

**The selection is a reading state**, like the expanded gaps, and is cleared when the rows it names may be gone:

- A different file (`‹ ›`, `Stage & next`, a list row at `expanded`), the side switch, or the whitespace or split toggle clears it.
- A refreshed diff for the file keeps it when every selected row is still there, with the same text and the same number on the side the range is named by. The other side's numbers do not count: on the unstaged side the old numbers are the index's, and staging a hunk above the selection moves them while the lines picked are unchanged. A connection being re-established, with no diff for a moment, keeps it too. Otherwise it is cleared, with the polite announcement `Selection cleared — the file changed`. An agent editing elsewhere in the file pushes a new diff every few seconds, and a selection that vanished on each of them could never be used. A hunk staged or unstaged from this page leaves the view, so a selection inside it clears.
- Wrap keeps it, since the same rows are only drawn differently.
- Leaving the page drops it. When the user comes Back from the chat it is not restored: what it named is in the composer by then. This is the one thing the handoff's Back does not bring back ([agent-handoff-ui.md §1.3](agent-handoff-ui.md#13-landing-in-the-chat)).

#### The selection bar

```
│  41 + const a = «new»;           │  selected rows
│  42 + const b = 2;               │
├──────────────────────────────────┤
│ Lines 41–42   [Copy] [✦ Ask AI…] ✕│  selection bar, under the diff's scroll area
├──────────────────────────────────┤
│ [ Discard file ]  [Stage & next] │  bottom bar (unchanged)
└──────────────────────────────────┘
```

- **Where.** Docked at the bottom of the diff area, directly above the review's bottom bar. It is full width below `expanded`. At `expanded` it spans the review column only, above that column's bottom bar, and the list column is untouched. It is a raised strip (`th-bg-secondary`, top border, the sheets' shadow), not a bubble beside the selection: a bubble would have to follow the range as the page scrolls, would cover the code it points at, and on a phone would sit where the thumb is not. It is laid out in the page's column, between the diff's scroll area and the bottom bar, rather than over the diff: while it is up the scroll area simply ends at its top edge, so the last selected line can always be scrolled clear of it. It is not portalled, so it mounts and unmounts with the review page and never floats over a page the user moved to.
- **What it holds.** First the range label, the row's one `flex-1 min-w-0` part: `Lines 41–42`, `Line 41`, `Removed lines 41–43` when every selected row is a removed one, or `Old lines 41–48` for a range made on the old side in split view. Then `Copy`, then `Ask AI to edit…` with the `Sparkles` icon the commit sheet's `Draft` uses. Both are secondary buttons (`th-bg-tertiary`), each with a minimum width that holds its busy and done labels (`Copied`, `Opening chat…`), so a pressed button never moves the one beside it. Last is ✕, an L5 button named `Clear selection`. Every control reaches 44px on a coarse pointer by growing the box, as in the bottom bar. Neither action is L1: the bottom bar's primary is still the page's one primary, and both are on screen at once.
- **For assistive technology** the bar is a `role="group"` named `Selected lines`, with its buttons in tab order. It is not a `toolbar`, which would promise arrow-key focus. A selection made by pointer announces `Lines 41–42 selected` politely, since tapping the gutter moves no focus. One made with the hunk bar's Select button moves focus to `Copy`. When the bar goes while it holds focus (✕, Escape, a refresh), focus returns to the Select button of the hunk the selection was in, or the nearest one left.
- **At 360px on a coarse pointer** the label truncates first. The fixed parts (the two text buttons, ✕, gaps and padding) take roughly 320–330px, so the label keeps only a few dozen pixels and shows the start of its range.
- **`Copy`** copies the code as it stands on the side the range is numbered on. That is the new side's lines from the first to the last selected, verbatim, hidden gap lines included, read from the full content the diff already carries. For a removed-only range, or one made on the old side in split view, it is the old side's lines. No `+` / `-` markers: someone who copies code wants code. A diff for the agent is what the other button is for. Feedback is `useCopyToClipboard`'s: `Copied` with a check for about a second, or `Copy failed`, which stays until the next press so that it cannot flash past a reader who looked away. Both are also said politely. The selection stays, so `Ask AI to edit…` can follow.
- **`Ask AI to edit…`** prefills the text below through `usePrefillComposer`, which resolves the session, writes the draft and pushes the chat ([agent-handoff-ui.md §1](agent-handoff-ui.md#1-prefill-handoff)). The ellipsis is the usual promise that something follows before anything is done: the user writes the instruction there, and nothing is sent. The hook is called by the review page (`DiffView`), not by the bar. The bar unmounts whenever the selection clears, which a diff refresh can do while a new session is still being created, and an unmounted caller loses the hook's error. While a session is being created (`isPending`) the button shows the spinner and `Opening chat…`, and the rest of the bar stays usable. A failure goes to the layer's banner with the hook's own summary and details, and is dismissed with it.

#### How it goes away

The bar has no backdrop, so it follows the shared conventions for overlays without one ([AGENTS.md](../AGENTS.md), `useOutsideClick` and Escape):

- **✕** and **pressing the only selected line again** clear it.
- **Escape** clears it. The bar listens on `document` and claims the key with `preventDefault`. It stands down in two cases, which between them cover everything that can be over the review ([answering-ui.md](answering-ui.md#who-owns-escape)). First, while `useIsPageCovered()` is true. `Sheet` and `ConfirmDialog` count as covering through their scroll lock, and they claim Escape with `stopPropagation`, which does not stop another listener on `document`, so the count is what keeps the bar from clearing under a sheet that is closing. Second, when the press is already `defaultPrevented`, which is how `Sidebar` and `ResponsivePanel` mark theirs. The bar does not call `useCoverPage` itself: it is part of the surface, not a layer over it.
- **A click outside** (`useOutsideClick`, so a scroll on a phone never dismisses) clears it, and is claimed with `stopPropagation`, but only when the click lands on non-interactive content: the code, the empty part of the diff area, the headers. A click on the bar, on a gutter number, or on any control (a hunk's Stage or Select button, a gap row, the toolbar, the bottom bar, a list row at `expanded`) is not a dismissal and passes untouched. Whatever that control does then decides: staging a hunk or moving file changes the rows and clears the selection by the rules above, and opening the commit sheet leaves the selection waiting under it. One press never does two things.

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
| Version | Names the file version the numbers belong to. New-side numbers are `(working tree)` on the unstaged side, the file the agent will open, and `(staged)` on the staged side, where they are the index's. Old-side numbers are `(index)` on the unstaged side, whose old side is the index (which is HEAD's content when nothing is staged), and `(HEAD)` on the staged side. The code is quoted either way, so the agent does not have to reconcile numbers from a version it is not looking at |
| Code | A `diff` fence holding the selected rows with their markers (space, `-`, `+`). Each collapsed gap inside the range is one line, `… 24 unchanged lines …`, in place of lines the user did not read. The fence is one backtick longer than the longest run of backticks in the code, and at least three |
| Too long | Over 200 selected rows (gap lines not counted), the fence is left out and the text is just the path, the range and the version, ending in a period. The agent reads the file itself, and a draft that fills the composer several times over is not something the user can review before sending |

The text is prose plus a fence, never a Pockode command, as the handoff requires. Its last line is the closing fence. The handoff trims what it writes, so the caret lands right after the fence, and the user starts the instruction with one line break. That costs one keystroke. Changing the shared trimming for this one entry would change it for every entry.

**Same press, same text.** Pressing `Ask AI to edit…` twice for one selection adds nothing the second time. That is the handoff's verbatim check, and it holds because the text depends only on the selection and the diff.

**Where it is offered.** In the review layer, on both sides, for every file whose diff has rows, including files whose hunks have no IDs. A commit's file diff shares `DiffContent` but not this. There the agent would be asked to edit lines that are history, and what such a request means is a separate design.

### At `expanded`

```
┌────────────────────────┬─────────────────────────────────────────┐
│ [Changes] History Bra… │ GitTab.tsx                              │  column heading (L2)
│ ▣ 5 files +142 −37   ≣ │ ‹ 2 / 5 › web/src/components/Git  ↵ ␣ ⫴ │  review toolbar
├────────────────────────┼─────────────────────────────────────────┤
│ ☑ GitTab.tsx  +12 −3 ⋯ │                                         │
│▌▣ git.md      +88 −20⋯ │   (the diff, unified or split)          │
│ ☐ notes.txt   +9     ⋯ │                                         │
├────────────────────────┼─────────────────────────────────────────┤
│ [Discard…] [Commit 1…] │ [ Discard file ]        [ Stage & next ]│
└────────────────────────┴─────────────────────────────────────────┘
```

- The review layer is the right column, exactly as the diff is today: the same URL, a column heading instead of the app header's title, no `←` in it, the row on screen lit in the list.
- **Split view**: a `Columns2` toggle in the toolbar, `Side by side` / `Inline`, `aria-pressed`, remembered (`pockode:gitReviewSplit`). Default inline. It is offered only at `expanded` — below it there is no width for two columns — and follows the tier, not the measured width, as the layout does ([git-ui.md](git-ui.md#at-expanded-two-columns)); at 1024 with an open sidebar the column is narrow enough that inline is the better choice, which is why it is the default. Split keeps wrap, word highlight and collapsed context: the separator row carries its label on the old side, and a press on either half expands it — unwrapped, each side is a table of its own and the new side's half of the row is an empty placeholder whose buttons are in the other table (`components/ui/collapsedContext.ts`). Unwrapped, each half also scrolls sideways on its own, in step with the other, rather than handing that to the page as inline view does. A commit's file diff stays inline: the toggle is the review's.
- Checking a box in the list while its file is in the review column changes the review's buttons with it, since both read the same status.
- With nothing chosen, the right column's empty state is unchanged: `Select a file to see its diff`, or `No changes to review` on a clean tree.
- Two primary buttons are on screen at once, one per column. Each column is its own panel with its own bottom bar, as today; on the last file both read `Commit n files` and open the same sheet.

## The sidebar's overview

The Git tab's `Changes` entry carries the totals beside the count: `Changes   5  +142 −37`, the same muted figures as the list header, from the same sums. Its accessible name becomes `Changes, 5 changed files, 142 lines added, 37 removed`. With no counts at all (every file binary or too large) the figures are left out, never `+0 −0`. The tab badge is unchanged — a digit on an icon has no room for a diffstat.

## Decisions not to lose

1. **One row per path; staging is the checkbox.** Rows never move when staged. The list and the review share one ordering function, and "next" is computed by that order from the current path, not by index.
2. **`git.status` carries per-side line counts (with binary marked) and the rename source; the row sums the sides.** Without them neither the row nor the sidebar's totals can be drawn.
3. **Mixed → checked.** The checkbox and select all only ever stage the rest or unstage everything; mixed comes from hunk staging or from elsewhere.
4. **Checkbox semantics are `role="checkbox"` with `aria-checked="mixed"`**, named `Stage <path>`, `aria-disabled` and `aria-busy` (not `disabled`) while its write is queued, and never flipped before the status says so.
5. **Discard leaves the row** for the action sheet and the review's bottom bar, where the left button acts on the side on screen. Discarding many files is the list's bottom bar: the checkboxes are the ballot, and `Discard unchecked…` throws away every unstaged side — left takes away, right keeps, as in the review's bar. No separate multi-select mode: one list, one meaning of selected. Copy and dialog unchanged.
6. **The review is one history entry.** Moves inside it replace; Back and `←` leave it, and so does a commit made from it — back to the list it was pushed from, so the history is as if it had never opened.
7. **The last file stages and stays**; only then does the primary become `Commit n files`, following `describeCommitAction` — root-only count, submodule line, disabled when nothing is staged.
8. **The page is not taken away from a reader** whose file stopped changing; it says so and offers `Next`.
9. **Wrap defaults by tier and is its own remembered setting; split exists only at `expanded`.**
10. **A hunk is staged with a `Stage` / `Unstage` button, not a checkbox.** A box over each hunk read as "tick, then press Stage below", and on either side it could only show one state. The button uses the bottom bar's words, appears where the server sent `hunk_ids` and the side has more than one hunk — one hunk is the bottom bar's button already — and is drawn under the hunk's last row, the one slot the diff library keeps in every state, keeping the floor's spacing from the gutter above and the gap row below.
11. **A hunk stays busy after a successful write until a diff read after the write arrives**, and the page asks for that diff softly, keeping the old one on screen, as soon as the write succeeds. A failed write ends the busy state. Hunk writes are deduplicated by path and ID but mark the path busy, and file-level writes make every hunk button busy.
12. **A stale hunk (`-32005`) is said as such, the diff is read again, and nothing retries.**
13. **Lines are selected by their numbers, never by a long press**, and how a press reads follows `pointerType`: click, Shift-click and drag for a mouse; tap, then tap the far end, for touch. The hunk bar's Select button is the keyboard's way in. The gutter's sub-44px rows are a recorded exemption.
14. **The selection bar is docked above the bottom bar, not floating at the selection.** It is cleared by ✕, by Escape (on `document`, claimed, standing down while the page is covered or the key is already claimed), and by a click outside on non-interactive content (claimed), never by a press on a control. A diff refresh keeps it while its rows are unchanged.
15. **`Ask AI to edit…` writes path, range, version and a `diff` fence through the prefill handoff, and never sends.** `Copy` copies the side the range is numbered on, without markers.
16. **Every control answers one question.** One that answers none is removed, two that answer the same one are merged: hence no `Review` button in the list's bottom bar, no `⋯` in its header and no `View history` on a clean tree.
