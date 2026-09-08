# Sidebar UI

The two work panels in the tabbed sidebar — **Files** (`web/src/components/Files/`,
entry `FilesTab`) and **Git** (`web/src/components/Git/`, entry `DiffTab`) — grew
one feature at a time: search, then upload, then branch/commit/sync. Each landed
as an addition to whatever row had space, and the result was a panel whose chrome
competed with its content.

This document holds what the two panels have to agree on: the principles behind
the redesign that fixed that, the visual weight ladder, what `th-accent` is
allowed to mean, and the narrow-width rule every fixed row obeys. It does **not**
describe either panel's own shape — [file.md](file.md) owns the Files panel
(backend, search behaviour, the upload button and destination display, the upload
queue) and [git-ui.md](git-ui.md) owns the Git panel (layout, group headers,
commit bar, amend, the sheets). A rule stated here is referenced from there, not
copied.

## What went wrong, and what it teaches

Both panels had the same three faults, in different clothes. The rules below are
each an answer to one of them.

**Chrome outweighed content.** On a phone the Git panel spent the worktree
switcher (~40px), the tab bar (~44px), the branch bar (44px), a `▾ Changes`
section header (44px), a group header (~36px) and a commit bar (56px) — roughly
265px of a ~640px drawer — before the first changed file appeared. The Files
panel spent less, but its search row carried an upload button sized like a
primary action.

**Accent meant too many things.** `th-accent` marked the active tab, the focus
ring, the primary commit button, a live drop target, the upload button's border
and fill, and the standing upload destination on a folder row. Six meanings for
one colour, three of them on screen at once, and the loudest of them (the filled
upload button) belonged to the rarest action in the panel.

**Fixed rows were not built to be narrow.** The panel is 288px on a phone and
resizes down to 240px on desktop, but rows were composed at whatever width the
author had. Two of them broke; the search row broke visibly.

## Principles

1. **The list is the subject.** Every fixed row above or below it has to earn its
   height in the state the user is actually in. A control that is useful in one
   state does not get to occupy the panel in all of them.
2. **Weight follows frequency, not importance.** Staging a file happens dozens of
   times an hour, uploading a file a few times a week, amending a commit less
   often than that. The ladder in [Visual weight](#visual-weight) assigns pixels
   in that order, and nothing skips a rung because it was implemented last.
3. **Accent is for "the one action" and "right now".** The single primary button,
   the active tab, the focus ring, a drag under the cursor, a progress bar.
   Standing state gets a 2px bar, not a fill. A control never wears accent merely
   to announce that it exists.
4. **One hierarchy level per panel.** Groups have headers; groups do not live
   inside a section that also has a header.
5. **Every fixed row survives 240px.** Stated as a rule in
   [The narrow-width rule](#the-narrow-width-rule), because both width bugs were
   the same bug.
6. **Nothing new is introduced to fix layout.** No new dependency, no new token,
   no new component. Both panels are composed from what the sidebar already
   has: `Sheet`, `ConfirmDialog`, `BottomActionBar`, `SidebarListItem`,
   `PullToRefresh`, `ToggleChip`, the `th-*` tokens and lucide icons.

## How these panels look elsewhere

The user's expectations for a file explorer and a source-control panel are set
long before they open Pockode, and the redesign follows them rather than
inventing:

- **VS Code / Cursor — Explorer.** A tree that fills the panel, a title row whose
  actions are small monochrome icons revealed on hover, and no permanent
  destination indicator: new files are created relative to the current selection,
  which the tree shows. Nothing in the chrome is coloured.
- **VS Code / Cursor — Source Control.** One message box or button at the top,
  then `Staged Changes` / `Changes` as small uppercase group headers with counts
  and icon-only group actions, then the file rows. Exactly one level of grouping.
  History is a separate, collapsed section.
- **GitHub Desktop.** The current branch is a header control at the top of the
  window, distinct in weight from the changes list beneath it. `Amend last commit`
  is not a standing button — it is an action on the most recent commit in the
  History tab.
- **Xcode / JetBrains.** Group headers are small, muted and uppercase; the
  accent colour is spent on selection and on the one primary action, never on
  secondary controls.

Three conclusions carry into both panels: **one level of grouping**,
**icon-only secondary actions in monochrome**, and **amend lives on the commit,
not on the commit button**.

## The narrow-width rule

The sidebar is `w-72` (288px) as a mobile drawer and 240–500px as a resizable
desktop column (`web/src/components/Layout/Sidebar.tsx`). 240px is the design
width; anything wider is slack.

> In a fixed row, **exactly one** element is `flex-1 min-w-0` and truncates.
> Every other element is `shrink-0` and is either icon-only or at most two short
> words of fixed copy. A user-supplied string — a branch name, a folder name, a
> file path — appears only in the `flex-1 min-w-0` element, or in a sheet.

The Files search row broke all three clauses at once, which is why it was the row
that visibly failed. Its field wrapper was `flex-1` without `min-w-0`, so its
floor was the sum of its own icons (~84px); beside it sat an upload button that
was `shrink-0` and carried a folder name up to `max-w-[7rem]` (112px). At 240px
the row's minimum was ~266px: the field was crushed to 84px first, then the row
overflowed the panel and the button left the screen. On the 288px drawer the
field was left ~106px, which is the "the search box disappeared" report. With the
`min-w-0` added and the button icon-only, the floor is ~144px and the field takes
every pixel above it.

The branch bar, by contrast, already obeyed the rule — one truncating branch name,
one icon-only chip — and does not break at any width. The rule is not new
guidance; it is what the rows that work already did.

## Visual weight

Five rungs. Existing Tailwind and `th-*` tokens only; nothing here is a new token.

| Rung | Used for | Classes |
|------|----------|---------|
| **L1** Primary action | At most one per panel, and only while it applies | `min-h-[44px] w-full rounded-lg bg-th-accent text-sm font-medium text-th-accent-text` |
| **L2** Panel header row | Branch bar, search row | `min-h-[44px]`, label `text-sm text-th-text-primary`, icons `text-th-text-muted`, bottom border `border-th-border` where the row is the whole header — the Files search row omits it, since the option chips render directly beneath it and a border would cut the header block in half |
| **L3** Group header | `Staged`, `Changes`, `History` | `min-h-[32px] px-3 text-xs uppercase tracking-wide text-th-text-muted`, no hover fill. A header carrying L5 actions grows to their 36px — the touch target wins over the nominal height |
| **L4** List row | Tree node, changed file, commit | `min-h-[36px]` (tree) / `min-h-[44px]` (file, commit), `text-sm text-th-text-secondary`; active `bg-th-bg-tertiary text-th-text-primary` |
| **L5** Inline icon action | Upload, stage, unstage, discard, collapse, dismiss | 36×36, no border and no fill at rest (a hover fill is allowed). Two shapes, by where the control sits: square inside a list row or group header (`rounded-md text-th-text-secondary`, defined once in `Git/iconButtonClass.ts`), round where it floats over content instead of belonging to a row — the upload button, the search field's clear button (`rounded-full text-th-text-muted hover:bg-th-bg-tertiary`) |

The two rungs that matter most are L3 and L5, because that is where the panels
had it wrong: the old `▾ Changes` header was L2-weight text on an L2-height row,
so it read as a second panel header stacked under the branch bar; the old upload
button was L1 colour on an L2 height, so the rarest control in the Files panel
was its loudest.

Colour, restated as rules rather than as a list of places:

| Token | Means |
|-------|-------|
| `th-accent` | The one primary action, the active tab, the focus ring, a drag under the cursor right now, a progress bar |
| `th-accent` as a 2px left bar | A row singled out: the selected row in `SidebarListItem`, and "uploads land here" on a folder in the tree |
| `th-bg-tertiary` | The row you are looking at (selected file, selected commit), and the fill of secondary buttons inside sheets |
| `th-text-muted` | Group headers, metadata, and icons that are not asking to be pressed — decoration, or an action rare enough to sit below the row it lives on (the upload button) |
| `th-error` / `th-success` | A failure / a completed outcome. Never a state that is merely unusual |

Selection is the bar **and** the `th-bg-tertiary` fill together; a standing
annotation such as the upload destination is the bar **without the fill**. The
row background is what the rule is about, and that is what keeps the destination
from reading as a second selection — it was a `bg-th-accent/5` fill before,
which is to say a third kind of row background competing with the file the user
was actually reading.

Tinting an icon *inside* the row is not a row background and is allowed where
the bar alone cannot be read: the upload destination's folder icon is accent
because the bar sits at the panel's left edge while the row it marks can be four
indents away from it, and the icon is the only cue that lands at the row's own
depth.

Spacing, so the two panels stop disagreeing: rows are `px-3`, row containers are
`px-2`, the search row is `p-2`, controls within a row are `gap-2`, and a group
header is preceded by `pt-2` so the first group does not butt against the header
row above it.

## Where each panel is described

The rules above are general; each panel's shape is documented with the panel.

| Panel | Document | What it now covers that this file does not |
|-------|----------|--------------------------------------------|
| Files | [file.md](file.md) | The L5 upload button, and the three places the destination is shown — the tree row's 2px accent bar, the button's dot, its accessible name. The search row's narrow-width fix and the wrapping option chips |
| Git | [git-ui.md](git-ui.md) | The layout and its L3 group headers (sticky, `Staged` / `Changes` / `History`), the commit bar's render conditions, amend on HEAD's row, History's default, `canPull`, the sync sheet's state-dependent button list, and the branch sheet's overflow root cause |

Two of the redesign's outcomes reach past the panel they were found in, so they
are flagged here rather than left where they were diagnosed:

- **The `Sheet` height cap is not a Git fix.** The branch sheet is where an
  uncapped desktop content box was found, but the cap landed in `ui/Sheet` and
  every sheet in the app benefits — including `WorktreeCreateSheet`, which
  belongs to neither panel. The root cause is written up once, in
  [git-ui.md](git-ui.md#branch).
- **Sticky group headers are still owed a check on a real device.** The
  reasoning behind them is from source and spec, not from a rendered page.
  [git-ui.md](git-ui.md#group-headers) states the check and the one-line
  fallback.

---

**Why this file lives here.** `docs/` holds per-feature design documents;
`docs/code/` explains the code of a *core module*, and `docs/projects/` the
project-management system. A set of rules two feature panels share is none of
those, so it sits beside them as `sidebar-ui.md` — and it holds only what neither
panel document owns, so that no fact here has a second copy there.
