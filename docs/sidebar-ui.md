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
| `th-accent` | The one primary action, the active tab, the focus ring, a drag under the cursor right now, a progress bar, a tab's notification badge (the dot, and the Git tab's change count) |
| `th-accent` as a 2px left bar | A row singled out: the selected row in `SidebarListItem` |
| `th-bg-tertiary` | The row you are looking at (selected file, selected commit), and the fill of secondary buttons inside sheets |
| `th-text-muted` | Group headers, metadata, and the icon of an action rare enough to sit below the row it lives on (a tree row's `…`). Quieter than the body colour, never quiet enough to stop being read — it owes AA 4.5 over the worst surface it lands on |
| `th-error` / `th-success` | A failure / a completed outcome. Never a state that is merely unusual |

**`th-accent-text` on `th-accent` clears WCAG AA's 4.5:1 in every variant, and
`web/tests/contrast.test.ts` holds the line.** The test finds the variants by
reading the stylesheets rather than by listing them, so a theme added tomorrow
is guarded the day it is written. Guarded beside it are the two other fills that
take a foreground a theme pins to them: `th-accent-hover`, which wears
`th-accent-text` too and so owes the same floor the resting fill does, and
`th-user-bubble` / `th-user-bubble-text`. Contrast here is a property of the
token pair and never of a place that uses it — every L1 primary action sits at
one ratio, and the Git tab's count badge
([git-ui.md](git-ui.md#the-change-count-on-the-tab)) only joins them — so a
caller that comes up short fixes nothing by picking a colour of its own: it
leaves the system less consistent and the real problem better hidden. Two light
themes did come up short, at 3.74:1 and 3.68:1, and the fix went into their
token values, where it landed for every caller at once.

**`th-text-muted` is guarded too, and it is the pair that broke the shape the
other three share: no single fill owns it.** The table above reads it as the
quiet rung of the text ladder, not as decoration, and the distinction is what
sets its floor — what it carries is timestamps, paths, counts and diff hunk
headers, all of it `text-xs`, none of it anywhere near the 18pt (24px) regular
or 14pt bold (18.66px) that WCAG's large-text relief starts at. So it owes the
full 4.5, and it owes it on the *worst* surface it lands on rather than on a
chosen one. That comes to five pairings in `GUARDED_PAIRS`: `th-bg-primary`,
`th-bg-secondary` and `th-bg-tertiary`, plus `th-ai-bubble` — Mermaid's
loading and error lines are muted and render inside the assistant bubble,
which is darker than tertiary in void and mint light — plus `th-overlay-hover`
composited onto `th-bg-secondary`. That last one is the worst of the five in
every variant, and it is the one no listing of the stylesheet's own colours
would ever show: Chat's collapsible headers are muted text on
`bg-th-bg-secondary` under `hover:bg-th-overlay-hover`, and the overlay is
black at 6-8% in light and white at 10% in dark, so in both directions it
pushes the backdrop towards the text. Hover is a state a person reads in, not
one they are excused from. Guarding muted against `th-bg-primary` alone — the
most forgiving surface in either mode, being the one furthest from the text —
is how eleven variants sat below AA while looking like seven — or like six to
anyone counting only the ten in `web`. A pair this shape needs a fill the
stylesheet does not hold, which is what `TokenPair`'s `onto` is for; without
it the blend would have to be hard-coded into the test, and a hard-coded blend
stops tracking the overlay the moment a theme changes it. That pair is also
the one a future palette tweak would be tempted to delete rather than satisfy
— it has the least margin of the five — and deleting a pair is invisible to
every other check in the file, since the remaining four still cover every
variant. So the overlays are counted the other way round as well: every
`--th-overlay-*` a stylesheet declares has to appear as a fill in
`GUARDED_PAIRS`, which is a list the stylesheet itself supplies rather than
one the test asserts about itself. `themeRegistry.ts` keeps a second copy of
this token as well as of the accent, for the picker's swatches, and
`web/tests/themeTokens.test.ts` compares the two the same way.

**The text ladder `th-text-muted` → `th-text-secondary` → `th-text-primary`
holds a CIELab ΔL\* of at least 13 at each step, and both steps are the same
constant.** Contrast alone cannot express what "muted" is *for*: every way of
raising a muted colour's ratio against the page moves it towards the body
text, so a check that measured only contrast would wave through — and
eventually invite — a muted pushed all the way onto secondary. Green suite,
and the tier gone. 13 is not picked from the air; it is the tightest step the
shipping themes already hold, ember light having left the factory at 12.9,
mint light at 13.2 and aurora light at 14.8, all three legible today. Rounding
to that keeps the themes that already pass from being repainted to satisfy a
wider number. The reason one `TEXT_TIER_STEP` carries both rungs rather than
one per rung is that 4.5 is WCAG's and 13 is this project's: a floor the
standard sets can be guarded against edits by a test that simply asserts the
number, but asserting `13` is `13` is a tautology that stops nobody. Making
the constant load-bearing twice is what replaces that — lowering it to escape
one rung visibly loosens the other, which is a policy change rather than a
local escape. `web/tests/contrast.ts` holds the constant and
`contrast.test.ts` asserts both rungs.

**Muted retreats towards its own mode's background, so the two modes' values
have no fixed order between them and comparing them proves nothing.** A light
muted lighter than its dark counterpart looks like a swapped pair and is not
one: retreating means lighter in light and darker in dark, both measured
against a different background, so either order can come out. Two of the five
themes shipped that way before these values were last set, and it was twice
read as "only one theme is inverted" — wrong on the count, and wrong that
there was a fault. The check that means something is monotonicity *within* one
mode: `bg → muted → secondary → primary` orders strictly by L\* in all eleven
variants, and did so even while every one of them was below AA.

**Changing an accent means changing the tokens that hold the same value.**
`--th-border-focus` is the accent value in every variant, and
`--th-user-bubble` is in the light ones — the bubble was the same failing pair
under a second name, over a whole message body rather than a button, which is
how it went unnoticed. Edit by line rather than by search-and-replace: two dark
variants happen to carry a light variant's old *hover* colour, and would be
rewritten along with it. `web/src/lib/registries/themeRegistry.ts` keeps a
second copy of each accent for the theme picker's swatches and needs the same
edit. Those copies are previews, never the truth — the stylesheet is — and
`web/tests/themeTokens.test.ts` compares the two every way a copy can drift: a
value that no longer matches, a theme one side has and the other does not, a
token declared outside its theme's rule, and a colour field added to the
registry that nothing maps to a custom property.

**To darken an accent, hold hue and saturation and drop lightness alone.**
Tailwind's next step down (`teal-700` under `teal-600`) desaturates as it
darkens, and it is the saturation it drops, not the darkness it adds, that reads
as muddy. Hue is also the theme's identity — mint's accent is a cyan precisely
to stay apart from its green `th-success` — so a hue that drifts on its way
through a contrast check trades a measurable problem for a quiet one.

Selection is the bar **and** the `th-bg-tertiary` fill together. The rule is
about **row backgrounds** and only about them, which is the clause to keep in
mind before reading it as a ban on standing accent generally: a pressed search
option chip is `border-th-accent bg-th-accent/10 text-th-text-primary` and
persists across sessions, and no row rule reaches it, because a chip is not a
row and cannot be mistaken for a selected one.

**Text on an accent tint is `th-text-primary`, and the tint stops at `/20`.** A
`bg-th-accent/α` is not a colour any theme declares: the compositor makes it
out of the accent, the alpha, and whatever opaque surface the element landed
on, so it is the one accent pairing a token value cannot settle — the fill *is*
the accent, so darkening the accent darkens both sides and the ratio barely
moves. Clearing 4.5:1 with `text-th-accent` would take an accent dark enough to
dull every primary action, for the sake of the smallest labels on screen; in
the four coloured light variants it misses the floor on every surface from
`/10` up, and at `/5` it falls on either side of the line depending on the
surface underneath. Void is the exception that proves the point: its light
accent is a near-black, which clears the floor by being all but the body colour
already. So the foreground goes back to the body colour, where it clears AA
with room to spare over every variant and every surface, and `th-accent`,
`th-accent-hover` and `th-text-muted` are not written on an accent tint —
including where the tint only appears on `hover:`, `focus-visible:` or
`active:`, since a control that is unreadable for the moment it is pressed is
an unreadable control.

Emphasis then moves off the text and onto `border-th-accent`, or onto an accent
icon inside the chip, which is what the alpha ceiling is for: at `/20` a
full-strength accent still holds WCAG's non-text 3:1 against its own composite,
and at `/30` it does not. The border is doing the work the fill cannot — a tint
this light is barely a shade away from the page, so "the background carries the
emphasis" was never true in the light variants. `common/ToggleChip.tsx` and
`Project/StepList.tsx` are the shape to copy. `ui/ActivityBadge.tsx` writes it
for every tone rather than for the accent ones alone, so one row of badges
keeps one shape — though the warning tone still reads faint wherever it is used:
`th-warning` is too pale in the light variants to clear even the non-text floor
as a border, a token-layer fault it carries in every role it takes, and not one
a badge can fix. Its label is legible regardless, which it was not before. `open` and
`closed` are the two with no hue to move: their fill is `th-bg-tertiary` rather
than a tint, and `th-border` on it is under 1.3:1, so the only weight they have
is the label. It is `th-text-secondary` and not the body colour — a status is
the least important thing in a row, and a finished or unstarted one should not
read as loudly as a running one, which is what the `th-text-muted` they used to
carry was saying at 2.23:1.

Four chips take the fill without a border, and the test for them is whether the
border would add the hue or only a box: `Chat/TaskItem.tsx` sits beside an
accent label and an accent icon already, the two in `Chat/QuestionForm.tsx` are
inline and a border would push the line height around, and the upload
destination bar in `Files/FilesTab.tsx` spans the panel, where a border reads as
a frame around the row rather than as a chip.
They are `common/Highlight.tsx`'s shape — tint plus body colour — and none of
them asks the fill to carry meaning its words do not, so nothing is lost by the
border being absent. The upload bar keeps one thing more. The other three sit
beside an accent of their own — a label, an icon — while the bar was refused a
border for spanning the panel rather than for having the hue nearby already,
which leaves it the only one of the four with no hue at all once its label
turns into body colour. That would be cosmetic if the bar had one state, and
it has two: the fill it draws when the drop will be taken and the fill it
draws when it will not measure 1.00:1 against each other in two light variants
and never past 1.34:1 in any of the rest, so with no hue the two read as one.
Its `Upload` icon is `text-th-accent` for that reason, and can be — an icon
owes the non-text floor, which the accent clears on its own tint on every
surface in every variant.

`web/tests/tint.test.ts` holds all three clauses. It reads the tints and their
alphas out of the components rather than from a list, composites each one over
all three page backgrounds in every variant — which of them a chip actually
sits on is decided by an ancestor in another file, so it has to clear the floor
on each — and checks the ratio, the banned foregrounds and the ceiling
separately. The ban is not a shortcut for the arithmetic: `th-accent-hover`
clears 4.5 at `/10` by about a third of a point and at `/15` by seven hundredths
of one, and misses at `/20` — so a check that only computed ratios would wave
through a chip that the next palette tweak turns illegible, and would have no
answer to "why not this one, it passes". The ceiling is not a constant either —
the test derives `/20` from the non-text floor, so raising it turns the suite
red by itself. What it does not cover, it says out loud: a tint whose text
comes from a child element or from inheritance is beyond a text scan and was
checked by eye, and the error, warning and success tints are left out on
purpose — adding them to the scan turns it red at call sites that fail on the
token values rather than on how they are written, which is a palette decision
and not this rule's. Muted is left out for a different reason and no longer a
token-layer one: it clears AA over every surface the app paints and the
non-text floor as a border, and no `bg-th-text-muted` tint carries text any
more — the one that did, the question card's settled chip, is an opaque
`bg-th-bg-tertiary` now (`Chat/QuestionRecordItem.tsx`). What it would still fail is the alpha
ceiling, since the shared `Sheet`'s drag handle is `bg-th-text-muted/30` and no
value of the token can lift it: the extreme token, black or white at 30% over
the sheet's own surface, reaches about 2.1 in the light variants and 2.7 in
the dark ones, both short of the non-text floor. Whether a drag handle is
decoration or an affordance owing 3:1 is the judgement call, and it is now one
call rather than two: `web-cluster` used to answer it the other way with an
opaque handle of its own, and that handle went when its overlay did — both
projects draw this one.

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
| Git | [git-ui.md](git-ui.md) | The layout and its L3 group headers (sticky, `Staged` / `Changes` / `History`), the commit bar's render conditions, amend on HEAD's row, History's default, `canPull`, the sync sheet's state-dependent button list, and the branch sheet's overflow root cause. Also the [change count on the tab](git-ui.md#the-change-count-on-the-tab) — what it counts, and why the `git.changed` subscription that feeds it sits in the sidebar rather than in the panel |

Two of the redesign's outcomes reach past the panel they were found in, so they
are flagged here rather than left where they were diagnosed:

- **The `Sheet` height cap is not a Git fix.** The branch sheet is where an
  uncapped desktop content box was found, but the cap landed in the shared
  `Sheet` and every sheet in the app benefits — including
  `WorktreeCreateSheet`, which belongs to neither panel. The root cause is
  written up once, in [git-ui.md](git-ui.md#branch).
- **The session list pages, and that is written up elsewhere.** It is not a
  Files or Git rule, and it applies to the project screen too, so the session
  sidebar's infinite scroll — and what it does to the live updates the list is
  pushed — lives in [list-paging-ui.md](list-paging-ui.md).
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
