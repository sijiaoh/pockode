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
│ ▣ 5 files  +142 −37   [≣|⌸]  ⋯  │  list header — sticky
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
│ [ Review ]  [ Commit 1 file    ] │  bottom bar
└──────────────────────────────────┘
```

### The file row

| Part | Content | Tap |
|---|---|---|
| Left: checkbox | 20px box, its 44×44 hit area the whole left gutter of the row. ☐ nothing staged, ☑ fully staged, ▣ partially staged (staged and unstaged changes both) | Toggles staging (below) |
| Middle, line 1 | File name, `text-sm`, truncated **at the tail** with the extension kept (`very-long-na….tsx`) — the name is what is read, so it is not cut from the head as the old row was. CSS cannot cut in the middle, so the stem and the extension are two spans: the stem `truncate`, the extension `shrink-0` | Opens the review layer at this file |
| Middle, line 2 | Muted `text-xs`: the directory, then ` · ` and a status word where there is one. The directory truncates **from the head** (`…/components/Git`), since the deepest folder is the one that tells files apart | (part of the row) |
| Right | `+a −d` in `text-xs` tabular figures; `Binary` for a binary file; nothing when the server has no counts. Zero sides are dropped (`+9`, `−14`), never `+0` | (part of the row) |
| Far right: `⋯` | L5 button, `More actions for <path>` | Opens the file's action sheet |

The row is the L4 row (`SidebarListItem` with `min-h-[44px]`, here two lines tall), with the usual active treatment while its file is open in the review column at `expanded`. The checkbox and `⋯` are siblings of the row's button, never nested inside it.

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

Mixed goes to checked, not to unchecked: the press is "include this file", and throwing away a partial staging the user (or the agent) made on purpose is the more surprising of the two. Mixed is never produced by tapping — it comes from staging done elsewhere.

**While the write is in flight** the box shows the existing small spinner in place of its mark, the checkbox is `aria-busy="true"` and inert to presses (see Accessibility), and its state does not flip until the refreshed status says so — the workspace's no-optimism rule. A failure goes to the Changes banner as stage/unstage failures do today.

**Accessibility.** A `<button role="checkbox">` with `aria-checked="true" | "false" | "mixed"`, so mixed is a real state and not a third icon. Its name names the property the box holds, `Stage <path>`, and a screen reader adds the state — "Stage docs/git.md, checkbox, partially checked" — as for any checkbox. While its write is queued it is `aria-disabled="true"` and ignores presses rather than taking the `disabled` attribute: `disabled` drops focus, and a keyboard user who pressed Space would be left with focus on nothing. Focus ring as every control. The row's own button is named `Review <path>`; `⋯` is `More actions for <path>`.

### The file's action sheet (`⋯`)

The project's menu shape: a `Sheet` of `MenuRow`s on both layouts, titled with the file's full path (`FileEntryMenu` explains why a sheet and not a dropdown).

| Item | Shown | Does |
|---|---|---|
| `Open file` | Always; **disabled** for a deleted file, with `(deleted)` in its name | The `file` layer, as the diff's title did |
| `Copy path` | Always | Copies the path as the list knows it — relative to the root repository, a submodule file with its submodule prefix. The row reads `Copied` with a check for about a second, then the sheet closes; on failure it reads `Copy failed` and the sheet stays open, the path being in its title (`useCopyToClipboard`'s states) |
| `Discard changes` / `Delete file` (untracked) | Only when the file has unstaged changes — the existing rule that staged-only rows have nothing to discard and are unstaged first | Closes the sheet and opens the existing `ConfirmDialog` with the existing copy. Disabled, with `Wait for the change in progress to finish.`, while the file has a write queued — the queue drops a path it already holds, so a discard let through would report success without running; discard-all in the header's `⋯` waits the same way while any file has one. Destructive styling as `FileEntryMenu`'s delete, and last in the sheet, after a divider |

Order is frequency, and the destructive item comes last behind a divider in `danger` style — the arrangement `FileEntryMenu` already uses for Delete, so the two menus read alike.

### The list header

One row, sticky at the top of the scroll area, `min-h-[44px]`:

```
▣ 5 files  +142 −37            [≣|⌸]  ⋯
```

- **Select all** — the same checkbox as the rows, over every file: checked when every file is fully staged, unchecked when nothing is staged anywhere, mixed otherwise. Tap: not checked → stage everything that has unstaged changes; checked → unstage everything. Its visible label is the count, `5 files`, and its accessible name contains it, `Stage all 5 files` — a voice-control user says what they see. The totals beside it are the sum of the rows' counts (binary files and files without counts add nothing).
- **Flat / Tree** — a two-icon segmented toggle (`List` / `FolderTree`), `aria-label="Flat list"` / `"Folder tree"`, `aria-pressed`. The choice is remembered in `localStorage` (`pockode:gitChangesView`), per browser rather than per worktree: it is a reading preference. Default flat.
- **At narrow widths** the row obeys [the narrow-width rule](sidebar-ui.md#the-narrow-width-rule): the label-and-totals group is the one `flex-1 min-w-0` element, and the totals are what truncate away first (they are also on every row and in the sidebar); the checkbox, the toggle and `⋯` are `shrink-0`. At the 280px left column this is what keeps the row on one line.
- **`⋯`** (`More actions for all changes`, a sheet titled `All changes`) — one item, `Discard all changes…`, which opens the existing "all" confirmation over every file with unstaged changes, with the existing copy. It used to be an icon in the `CHANGES` header; it moves into a menu because the header is now the most-tapped row on the screen (select all) and a one-tap destructive icon beside it is the arrangement this redesign removes. Hidden when nothing is unstaged; with it the `⋯` itself, rather than a menu with nothing in it.

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

The commit bar becomes a two-button bar. It renders on the same condition the commit bar does today — `describeCommitAction` returns non-null — so a clean tree and an unreadable status have no bar.

| Working tree | Left | Right (L1) |
|---|---|---|
| n files staged in the root | `Review` | `Commit n files` (`Commit 1 file`) |
| changes, nothing staged anywhere | `Review` | `Commit` disabled, `sr-only` hint `Check a file to commit` |
| staged only inside a submodule | `Review` | `Commit` disabled, the existing **visible** submodule line above the bar |

- `Review` is a secondary button (`th-bg-tertiary` fill, the sheets' secondary style), at most a third of the width; Commit takes the rest. It opens the review layer at the **first file in list order** (push).
- The sr-only hint was `Stage a file to commit`, naming the stage buttons; with those gone it names the checkboxes. It stays sr-only by git-ui.md's test — the boxes are right above the bar.
- `Commit n files` opens the existing commit sheet. n is the root repository's staged count, as before; the count is in the label because the button no longer sits under a `STAGED n` header that said it.
- The bar and the sheet stay siblings, so a refresh that empties the tree does not unmount a half-written message ([git-ui.md](git-ui.md#commit)).

### Clean, loading, failed

- **Clean**: in place of the header and the list, centred and muted, `No changes`, and under it a text button `View history` that selects the History segment (push, as the segment control does). No bottom bar.
- **Loading**: the spinner, as today. No header, no bar.
- **Status unreadable**: `Failed to load git status` and the reason, as today. No header, no bar.

## The review layer

The review layer is the `diff` layer redesigned: one file at a time, in list order, with "stage and go to the next file" as its primary action.

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
│ @@ −40,7 +40,9 @@                 │
│  40   import { Foo }             │
│  41 − const a = «old»;           │  «» = word-level highlight
│  41 + const a = «new»;           │
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
- Moving between files — `‹ ›`, `Stage & next`, `Next`, discard — **replaces** the history entry rather than pushing. A review is one place: Back leaves it for the list in one step, instead of walking back through every file read. At `expanded`, a row tapped in the list beside an open review moves the review too, replacing as `‹ ›` would; only the tap that opens a review from the list pushes. **Leaving** the review — `←`, a commit made from it, discarding its last file, `Back to changes` — goes *back* to the list when the review was pushed from it, so the history is what it was before the review opened: neither the list twice (a Back that does nothing on screen) nor a list pushed over the review (a Back that reopens it). The push marks its history entry and every move inside carries the mark (`REVIEW_FROM_LIST_STATE` in `lib/navigation.ts`); a review reached any other way — a link, a URL typed in — has no list behind it, and is replaced by the list instead (`hooks/useLeaveReview.ts`).

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

### At `expanded`

```
┌────────────────────────┬─────────────────────────────────────────┐
│ [Changes] History Bra… │ GitTab.tsx                               │  column heading (L2)
│ ▣ 5 files +142 −37 ≣ ⋯ │ ‹ 2 / 5 › web/src/components/Git  ↵ ␣ ⫴ │  review toolbar
├────────────────────────┼─────────────────────────────────────────┤
│ ☑ GitTab.tsx  +12 −3 ⋯ │                                         │
│▌▣ git.md      +88 −20⋯ │   (the diff, unified or split)          │
│ ☐ notes.txt   +9     ⋯ │                                         │
├────────────────────────┼─────────────────────────────────────────┤
│ [Review] [Commit 1 file]│ [ Discard file ]        [ Stage & next ]│
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
3. **Mixed → checked.** The checkbox and select all only ever stage the rest or unstage everything; mixed comes from elsewhere.
4. **Checkbox semantics are `role="checkbox"` with `aria-checked="mixed"`**, named `Stage <path>`, `aria-disabled` and `aria-busy` (not `disabled`) while its write is queued, and never flipped before the status says so.
5. **Discard leaves the row** for the action sheet and the review's bottom bar, where the left button acts on the side on screen; discard-all leaves the header for its `⋯`. Copy and dialog unchanged.
6. **The review is one history entry.** Moves inside it replace; Back and `←` leave it, and so does a commit made from it — back to the list it was pushed from, so the history is as if it had never opened.
7. **The last file stages and stays**; only then does the primary become `Commit n files`, following `describeCommitAction` — root-only count, submodule line, disabled when nothing is staged.
8. **The page is not taken away from a reader** whose file stopped changing; it says so and offers `Next`.
9. **Wrap defaults by tier and is its own remembered setting; split exists only at `expanded`.**
