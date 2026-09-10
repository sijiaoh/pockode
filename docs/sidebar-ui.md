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
(backend, search behaviour, the entry `…` menu and everything that hangs off it,
the upload queue) and [git-ui.md](git-ui.md) owns the Git panel (layout, group
headers, commit bar, amend, the sheets). A rule stated here is referenced from
there, not copied. Nor does it describe how either panel answers the *viewport*:
the width ladder, the pointer gates and the hit-area floors are
[responsive-ui.md](responsive-ui.md)'s. The 240px below is a **container** width,
which is why it lives here.

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
   A standing state **on a row** gets a 2px bar, not a fill — see
   [Visual weight](#visual-weight) for why that clause is load-bearing. A control
   never wears accent merely to announce that it exists.
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
`min-w-0` added and the row's one other element icon-only — today the project
root's `…`, which replaced that button — the floor is ~144px and the field takes
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
| **L3** Group header | `Staged`, `Changes`, `History` | `min-h-[32px] px-3 text-xs uppercase tracking-wide text-th-text-muted`, no hover fill. A header carrying L5 actions grows to their 36px — the touch target wins over the nominal height — and grows again where a finger may land ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)) |
| **L4** List row | Tree node, changed file, commit | `min-h-[44px]`, `text-sm text-th-text-secondary`; active `bg-th-bg-tertiary text-th-text-primary` |
| **L5** Inline icon action | Entry menu, stage, unstage, discard, collapse, dismiss | 36×36, no border and no fill at rest (a hover fill is allowed). Two shapes, by where the control sits: square where it sits inside a **list** row or a group header, over the list itself (`rounded-md text-th-text-secondary`, defined once in `ui/iconButtonClass.ts`), round where it does not — the project root's `…` in the L2 search row, the search field's clear button inside the input (`rounded-full text-th-text-muted hover:bg-th-bg-tertiary`). 36 is the visual size only; the hit area a coarse pointer gets on top of it is [responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)'s |

The two rungs that matter most are L3 and L5, because that is where the panels
had it wrong: the old `▾ Changes` header was L2-weight text on an L2-height row,
so it read as a second panel header stacked under the branch bar; the old upload
button was L1 colour on an L2 height, so the rarest control in the Files panel
was its loudest.

**The rung is one height, and the file tree's `…` is no longer an exception to
it.** It used to be 44×44 where every other L5 was 36, on the reasoning that its
menu was specified to a touch floor — which put two heights on one rung with
nothing but history to tell them apart. The two are different measurements of
one control: 36 is its visual weight, and the larger number was the hit area a
thumb needs and a mouse does not. Every L5 is 36, and every L5 gets a thumb-sized
hit area laid over it or grown behind the coarse-pointer gate —
`iconButtonClass()` states both halves, and the tree's separate `menuButtonClass`
is gone. The floor itself, and which of the two techniques to reach for, are
[responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)'s.

Colour, restated as rules rather than as a list of places:

| Token | Means |
|-------|-------|
| `th-accent` | The one primary action, the active tab, the focus ring, a drag under the cursor right now, a progress bar |
| `th-accent` as a 2px left bar | A row singled out: the selected row in `SidebarListItem` |
| `th-bg-tertiary` | The row you are looking at (selected file, selected commit), and the fill of secondary buttons inside sheets |
| `th-text-muted` | Group headers, metadata, and icons that are not asking to be pressed — decoration, or an action rare enough to sit below the row it lives on (a tree row's `…`) |
| `th-error` / `th-success` | A failure / a completed outcome. Never a state that is merely unusual |

Selection is the bar **and** the `th-bg-tertiary` fill together. The rule is
about **row backgrounds** and only about them, which is the clause to keep in
mind before reading it as a ban on standing accent generally: a pressed search
option chip is `border-th-accent bg-th-accent/10 text-th-accent` and persists
across sessions, and no row rule reaches it, because a chip is not a row and
cannot be mistaken for a selected one.

**On rows, though, neither panel has a standing annotation any more, and that is
the resolution of "accent meant too many things" rather than a gap in it.** The
rule was written for one: "uploads land here", marking the folder a later upload
would go to. It was first demoted from a `bg-th-accent/5` fill — a third kind
of row background, competing with the file the user was reading — to a bar
without a fill, and then removed outright together with the state behind it,
because a destination chosen before it is used answers the question far from the
moment it is asked ([file.md](file.md#uploading)). Principle 3 stands unchanged
for whatever needs it next: a standing state on a row is a bar, never a fill.
The lesson underneath it is the one worth carrying, and it is not about the
bar — before asking which weight a standing accent should take, ask whether the
state it announces should exist.

Tinting an icon *inside* the row is not a row background, and is allowed where
the row's own treatment cannot be read at the row's depth — the bar sits at the
panel's left edge while the row it marks can be four indents away. The tree's
drop target is the one instance left: the folder under the cursor swaps to an
open-folder glyph in accent. It answers a cursor that is moving right now, so it
takes a row fill as well — the allowance above is what lets the icon join in,
not what carries the state alone.

Spacing, so the two panels stop disagreeing: rows are `px-3`, row containers are
`px-2`, the search row is `p-2`, controls within a row are `gap-2`, and a group
header is preceded by `pt-2` so the first group does not butt against the header
row above it.

## Where each panel is described

The rules above are general; each panel's shape is documented with the panel.

| Panel | Document | What it now covers that this file does not |
|-------|----------|--------------------------------------------|
| Files | [file.md](file.md) | The row's [`…` menu](file.md#entry-actions) and the create / delete flows it opens, the [two upload paths](file.md#uploading) and why neither leaves a destination behind. The search row's narrow-width fix and the wrapping option chips |
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
