# Sidebar UI

The two work panels in the tabbed sidebar — **Files** (`web/src/components/Files/`,
entry `FilesTab`) and **Git** (`web/src/components/Git/`) — grew
one feature at a time: search, then upload, then branch/commit/sync. Each landed
as an addition to whatever row had space, and the result was a panel whose chrome
competed with its content. Git then moved out of the sidebar into the Git
workspace, a page of the main area, and below `expanded` it is still there,
with the sidebar's Git tab (`GitTab`) an overview and the way in. At
`expanded` the workspace's list came back into the tab, and the main area shows
what a row opens ([The Git tab](#the-git-tab)).

This document holds what the Files panel and the Git surfaces have to agree on:
the principles behind the redesign that fixed that, the visual weight ladder,
what `th-accent` is allowed to mean, the narrow-width rule every fixed row
obeys, the rows at the top of the sidebar that every tab sits under, and the
Git tab's shape. It does **not** describe the Files panel's or the Git
workspace's own shape — [file.md](file.md) owns the Files panel (backend,
search behaviour, the entry `…` menu and everything that hangs off it, the
upload queue) and [git-ui.md](git-ui.md) owns the Git workspace (routes and
segments, the top bar, layout, commit bar, amend, the sheets), with its
Changes list in [git-changes-ui.md](git-changes-ui.md).
A rule stated here is referenced from there, not copied. Nor does it describe how either panel answers the *viewport*:
the width ladder, the pointer gates and the hit-area floors are
[responsive-ui.md](responsive-ui.md)'s. The 280px below is a **container** width,
which is why it lives here.

## What went wrong, and what it teaches

Both panels had the same three faults, in different clothes. The rules below are
each an answer to one of them.

**Chrome outweighed content.** On a phone the old Git panel spent the worktree
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

**Fixed rows were not built to be narrow.** The sidebar was then 288px on a
phone and resized down to 240px on desktop, but rows were composed at whatever
width the author had. Two of them broke; the search row broke visibly.

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
5. **Every fixed row survives 280px.** Stated as a rule in
   [The narrow-width rule](#the-narrow-width-rule), because both width bugs were
   the same bug.
6. **Nothing new is introduced to fix layout.** No new dependency, no new token,
   no new component. Both panels are composed from what the sidebar already
   has: `Sheet`, `ConfirmDialog`, `BottomActionBar`, `SidebarListItem`,
   `ToggleChip`, the `th-*` tokens and lucide icons.

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

The sidebar is a drawer below `expanded` and a resizable, collapsible column
at and above it (`web/src/components/Layout/Sidebar.tsx`; the column's edge is
the [column resize handle](responsive-ui.md#the-column-resize-handle)). Its
widths are one rule for every tab — no tab gets a width of its own, the Git
tab's list at `expanded` included:

| | Width | Why |
|---|---|---|
| Drawer | viewport − 56px, at most 400px | The 56px strip of chat left showing says the panel is a drawer over the chat rather than a page, is where a tap closes it, and shows where that tap goes back to. The 56 is Material Design's mobile navigation drawer, which is the screen width less 56dp, the mobile app bar's height. 400px caps it on a tablet, where the screen less 56 would be far wider than the panel's rows need |
| Column minimum | 280px | The narrowest a column in this app has been built and checked at — the Git tab's list, whose fixed rows are built to this width ([git-ui.md](git-ui.md#at-expanded-the-sidebars-list-and-the-detail)) |
| Column default | 320px | The width the Git list had by default when it was a column of the main area, before it moved into the Git tab ([git-ui.md](git-ui.md#at-expanded-the-sidebars-list-and-the-detail)) |
| Column maximum | 500px | A user who drags it out that far has made their own trade with the chat beside it ([responsive-ui.md](responsive-ui.md#why-the-two-column-threshold-is-1024-and-not-768)) |

A width the user stored is kept as it was and only drawn within the limits, so
a stored width below a raised minimum shows at the minimum — the nearest to the
narrow column they chose — rather than falling back to the default they had
moved away from. `useResizableWidth` holds this.

**280px is the design width**; anything wider is slack. The drawer meets it on a
336px screen and only a narrower phone takes it below — 264px on a 320px
screen. The rule below is what keeps that case honest: a row built to it only
truncates further, it does not break.

> In a fixed row, **exactly one** element is `flex-1 min-w-0` and truncates.
> Every other element is `shrink-0` and is either icon-only or at most two short
> words of fixed copy. A user-supplied string — a branch name, a folder name, a
> file path — appears only in the `flex-1 min-w-0` element, or in a sheet.

The Files search row broke all three clauses at once, which is why it was the row
that visibly failed. Its field wrapper was `flex-1` without `min-w-0`, so its
floor was the sum of its own icons (~84px); beside it sat an upload button that
was `shrink-0` and carried a folder name up to `max-w-[7rem]` (112px). At the
240px minimum the column had then, the row's minimum was ~266px: the field was
crushed to 84px first, then the row overflowed the panel and the button left the
screen. On the 288px drawer of the time the
field was left ~106px, which is the "the search box disappeared" report. With the
`min-w-0` added and the row's one other element icon-only — today the project
root's `…`, which replaced that button — the floor is ~144px and the field takes
every pixel above it.

The branch bar — now the Git workspace's top bar, in the Git tab at `expanded` — by contrast, already obeyed
the rule — one truncating branch name, one chip of fixed copy — and does not
break at any width. The rule is not new
guidance; it is what the rows that work already did.

## Visual weight

Five rungs. Existing Tailwind and `th-*` tokens only; nothing here is a new token.

| Rung | Used for | Classes |
|------|----------|---------|
| **L1** Primary action | At most one per panel, and only while it applies | `min-h-[44px] w-full rounded-lg bg-th-accent text-sm font-medium text-th-accent-text` |
| **L2** Panel header row | The Git workspace's top bar, search row, the worktree switcher | `min-h-[44px]`, label `text-sm text-th-text-primary`, icons `text-th-text-muted`, bottom border `border-th-border` where the row is the whole header — the Files search row omits it, since the option chips render directly beneath it and a border would cut the header block in half. The worktree switcher is the header *control* GitHub Desktop puts above its list: a transparent button, `th-bg-tertiary` only on hover or while open, name `text-sm font-medium`, and 36px rather than 44 under a fine pointer, since it is a control and not a row — see [The top of the sidebar](#the-top-of-the-sidebar) |
| **L3** Group header | The session filter's `Worktrees` / `Deleted` (the Git workspace's `Staged` / `Changes` were these until its list became one, under an L4-height header of its own; its groups came back as `Unstaged` / `Staged`, but with `min-h-[44px]` headers that carry a `Stage all` text button and read in `text-sm` — [git-changes-ui.md](git-changes-ui.md#the-groups)) | `min-h-[32px] px-3 text-xs uppercase tracking-wide text-th-text-muted`, no hover fill. A header carrying L5 actions grows to their 36px — the touch target wins over the nominal height — and grows again where a finger may land ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)) |
| **L4** List row | Tree node, changed file (two lines tall, with its stage button and `⋯` beside the row's button), commit | `min-h-[44px]`, `text-sm text-th-text-secondary`; active `bg-th-bg-tertiary text-th-text-primary` |
| **L5** Inline icon action | Entry menu, a Git file row's stage button and `⋯`, collapse, dismiss | 36×36, no border and no fill at rest (a hover fill is allowed). Two shapes, by where the control sits: square where it sits inside a **list** row or a group header, over the list itself (`rounded-md text-th-text-secondary`, defined once in `ui/iconButtonClass.ts`), round where it does not — the project root's `…` in the L2 search row, the session filter beside New Chat, the search field's clear button inside the input (`rounded-full text-th-text-muted hover:bg-th-bg-tertiary`). The filter is the `…`'s classes with `hover:` and `active:` behind `enabled:` and a `disabled:` dimming added, since it alone is disabled while its list is stale. 36 is the visual size only; the hit area a coarse pointer gets on top of it is [responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)'s |

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
| `th-accent` | The one primary action, the active tab, the focus ring, a drag under the cursor right now, a progress bar, a tab's notification badge (the dot, and the Git tab's change count) — with one exception: the badge that means a person is being waited on is `th-warning`, because it stands for a warning dot inside that tab ([lifecycle-ui.md §4](lifecycle-ui.md#4-attention-dots)) |
| `th-accent` as a 2px left bar | A row singled out: the selected row in `SidebarListItem`. Drawn as a `before:` pseudo-element (`absolute inset-y-2 left-0 w-0.5 rounded-full`), not as `border-l-2`: a border takes 2px of layout, so selecting a row shifted its content sideways, and it followed `rounded-lg` into a crescent at both ends. `inset-y-2` is the 8px radius, so the bar starts where the corner ends and stays on the straight edge |
| `th-bg-tertiary` | The row you are looking at (selected file, selected commit), and the fill of secondary buttons inside sheets |
| `th-text-muted` | Group headers, metadata, and the icon of an action rare enough to sit below the row it lives on (a tree row's `…`). Quieter than the body colour, never quiet enough to stop being read — it owes AA 4.5 over the worst surface it lands on |
| `th-error` / `th-success` | A failure / a completed outcome. Never a state that is merely unusual |
| `th-graph-1` … `th-graph-8` | One line of the History commit graph, told from its neighbours — never text, never a state; what a commit is, its shape says ([git-history-ui.md](git-history-ui.md#line-colours)) |

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
chosen one. That comes to four pairings in `GUARDED_PAIRS`: `th-bg-primary`,
`th-bg-secondary` and `th-bg-tertiary`, plus `th-overlay-hover`
composited onto `th-bg-secondary`. That last one is the worst of the four in
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
— it has the least margin of the four — and deleting a pair is invisible to
every other check in the file, since the remaining three still cover every
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

## The top of the sidebar

Above every tab sit two rows the whole sidebar shares — the worktree switcher
and the tab bar — and the Sessions tab adds a third, New Chat with the session
filter beside it. All three are chrome over a list, so principle 1 applies to
them as much as to either panel: each is as tall as its controls need and no
taller.

- **Worktree switcher** (`Worktree/WorktreeSwitcher.tsx`). L2: it names the
  workspace the list beneath it belongs to, so it reads as a title rather than
  as a field — no border, no resting fill, the name `font-medium` against the
  regular weight of the L4 rows, `▾` directly after the name rather than at the
  far edge, where it would read as an input. The button is as wide as its
  content and truncates inside the row's one `flex-1 min-w-0` shell. Every
  state — the skeleton, the switcher, a load error, and the plain project name
  outside a repository ([git-ui.md](git-ui.md#projects-without-a-repository)) —
  renders in that one shell, `min-h-9 pointer-coarse:min-h-11`, so the tab bar
  does not jump as one state gives way to the next; the shell's floor is the
  button at the row's end, so the row is the same height with or without one.
  That slot is the sidebar's own way off the screen in both tiers — the
  drawer's X, the column's `PanelLeftClose` — one icon-only `shrink-0` button
  with one class, so the worktree name stays the row's only truncating element
  ([responsive-ui.md](responsive-ui.md#at-expanded-the-column-collapses) has
  its semantics). The project name takes the button's type, `text-sm
  font-medium`, because it is the same place showing different content. An
  error may wrap and grow the row. The row is `px-2 py-1`: the inset lines the hover fill up with the
  rows below it and the text with theirs, and the dropdown is positioned inside
  the inset, so on desktop it spans exactly the New Chat row below — New Chat
  and the filter together.
- **Tab bar** (`Layout/TabbedSidebar.tsx`). Each tab is `min-h-11`, which is the
  coarse-pointer floor and not slack — this row is not compressed.
- **New Chat** is L1 (`Session/SessionsTab.tsx`): `min-h-[44px] px-3 text-sm
  font-medium`, `flex-1` instead of `w-full` because the filter shares its row.
  Its focus ring is offset by 2px onto `th-bg-secondary`, the sidebar's surface
  in both the drawer and the desktop column, since an accent ring drawn
  straight onto an accent fill cannot be seen. The row keeps the search row's
  `p-2`, and `gap-2` keeps 8px between the two 44px hit areas on a coarse
  pointer. The filter's dropdown is positioned inside that inset the way the
  worktree switcher's is, so on desktop it too spans exactly the New Chat row.
  A panel of its own width hung off the filter button would outgrow a column at
  its minimum, and the column clips it.

## The Git tab

The Git tab (`Git/GitTab.tsx`) takes one of two shapes, by the tier: at
`expanded` it is the [Git workspace](git-ui.md)'s list, and below it the
workspace's doorplate. Either way **every write appears in one place** — the
sidebar's at `expanded`, the Git page's below it.

### At `expanded`: the list

```
┌──────────────────────────────┐
│ ⑂ feature/git-ui    ↓ Pull 2 │  top bar — branch name and sync chip
│ ⚠ Push failed · Details    ✕ │  top-bar banners
│ ⚠ Rebase stopped on conf…  ⌃ │  operation banner, whole, with its actions
│ [Changes] History  Branches  │  segmented control
│   3 files  +142 −37    [≣|⌸] │  the segment's list
│ Unstaged 2       [Stage all] │
│▌+ git.md          +80 −12  ⋯ │  the open detail's row, lit
├──────────────────────────────┤
│ [Discard unstaged…][Commit…] │  commit bar
└──────────────────────────────┘
```

- **The whole list, nothing else.** What the Git page holds over its list —
  top bar and sync chip, their banners, the operation banner, segments, list,
  commit bar — drawn by the same components (`GitSegmentList` for the segments
  and lists), so the two shapes cannot drift apart. The read-only overview of
  the narrow shape is not drawn: it says what the top bar says, and the top bar
  is pressable. Laid out and navigated as [git-ui.md](git-ui.md#at-expanded-the-sidebars-list-and-the-detail)
  says; the rules the sidebar itself owns are below.
- **Its width is the sidebar's.** No width of its own and no handle of its own:
  280–500px by the column's handle, 320 by default
  ([The narrow-width rule](#the-narrow-width-rule)). A user who wants a wider
  list drags the column.
- **A row opens its detail in the main area**, and the column stays: a press
  here never collapses it.
- **Arriving decides the automatic fetch.** The list coming on screen — the tab
  selected and the column not collapsed — is arriving in the workspace, as
  opening the Git page is ([git-ui.md](git-ui.md#automatic-fetch)).
- **The tab turns to Git when the route arrives at Git** — a list URL, or a
  detail opened from outside a detail — whatever made it arrive, so the list
  and the row it lights are on screen; once, not as a lock, never expanding a
  collapsed column — and the lit row is scrolled into view ([git-ui.md](git-ui.md#at-expanded-the-sidebars-list-and-the-detail)).
  It is `TabbedSidebar`'s `reveal`: a tab selected each time a new request is
  made, and left alone between requests, so a tab the user picks afterwards
  stays picked.
- **Its segment is its own.** Turning it is navigation within the sidebar and
  never changes what the main area shows; the tab follows the route only when
  the route arrives somewhere new, and where the route names no Git layer — a
  session, a file — it stays at the segment and History query it was left at
  ([git-ui.md](git-ui.md#routes-segments-and-back)).

**Why the sidebar may write at `expanded`.** The rule used to be that nothing in
the sidebar writes. Its reasons were the drawer's: a phone's drawer is too
short to hold a list that writes — its groups, its stage buttons and a pinned
commit bar — under the tab bar and the worktree switcher, and the rows had not
been built for its width. Neither holds for the column at `expanded`, which is
the window's height and whose width is the 280px the rows are now built for.
What the rule was protecting is kept as its own statement: a write is on screen
in one place. On a desktop that place is the sidebar, and the main area beside
it shows only details; on a phone it is the Git page, and the drawer holds no
write. A list that only reads fits the drawer, and it has one
([below](#below-expanded-the-doorplate)).

### Below `expanded`: the doorplate

The same shape as the Project tab: something to read, and doors. The changed
files under `Changes` are part of the reading.

```
┌──────────────────────────────┐
│ ⑂ feature/git-workspace      │  overview — read-only
│   2 to pull · ⟳ Pulling…     │
├──────────────────────────────┤
│ ▤  Changes     5 +142 −37  › │  door — L4 row, ProjectTab's style
│    GitTab.tsx        +12 −3  │  ┐ changed files, read-only, the name
│    web/src/components/Git    │  │ in line with "Changes"
│▌   git.md            +88 −20 │  │ the file under review, lit
│    docs                      │  │
│ ⚠  merge.go            +4 −1 │  │ a conflict: ⚠ in the icon column
│    server · Conflict         │  │
│    notes.txt              +9 │  │
│    Untracked                 │  │
│    old.ts                −14 │  ┘ at most five rows
│    server · Deleted          │
│    Show all 14 files         │  expands in place
│ ⏱  History                 › │  door
│ ⑂  Branches                › │  door
└──────────────────────────────┘
```

- **The tab scrolls as one; nothing in it is pinned.** Overview, doors and
  files are one scroller (`Doorplate` in `Git/GitTab.tsx`). Pinning the
  overview and the doors around a scrolling list would spend about 245px of a
  phone's drawer before the first file — the old panel's ~265px
  ([What went wrong](#what-went-wrong-and-what-it-teaches)) again.
- **The overview is read-only.** The branch name — `detached @ <hash>` when
  detached, the shared skeleton while loading and `Branch unavailable` with
  nothing cached (`Git/HeadPlaceholder.tsx`, as in the workspace's top bar) —
  and one line of sync state. That line is `describeSyncStep` of the very
  `SyncStatus` the workspace's sync chip draws (`describeSyncStatus`), so the
  two cannot disagree about what the branch needs; a run in flight appends
  `· ⟳ Fetching…` / `Pulling…` / `Pushing…`, and a failed automatic fetch
  `· ⚠ Automatic fetch failed` in `th-warning`. With no remote or a detached
  HEAD there is no line, by the chip's own `hasSyncStatus`. None of it is a
  button and none of it is drawn like the chip: something that looks pressable
  and does nothing is worse than nothing, and the doors below already go
  everywhere it could. While a merge, rebase, cherry-pick or revert is in
  progress the sync line gives way to what the workspace's banner says
  ([git-conflict-ui.md](git-conflict-ui.md#the-sidebars-git-tab)).
- **Three doors**, `min-h-[44px]`, in the Project tab's row style:
  `Changes`, `History`, `Branches`. Each lands on its segment's **list**, never
  on a detail it remembers — the Stories entry's rule — through the same
  `handleSelectGitSegment` the workspace's own segment control uses, so it is
  pushed and a press on the list already on screen adds nothing. Each ends in a
  muted `ChevronRight`: beside rows that open a file, `›` is what says a row
  opens a page. The Project tab has only doors and does without it.
- **`Changes` carries the tab badge's number** (`useGitChangeCount`, capped by
  `formatBadgeCount`), named `Changes, 5 changed files` through the badge's own
  `describeChangeCount`. A clean tree reads a muted `No changes`, never `0`,
  and no file rows follow — it is not said twice. A status with no answer yet
  shows nothing, like the badge. Beside the number, the lines added and
  removed across every file (`useGitChangeLines`), in the Changes list
  header's muted figures — `5  +142 −37`, named `Changes, 5 changed files, 142
  lines added, 37 removed` — and left out, never `+0 −0`, when nothing could be
  counted ([git-changes-ui.md](git-changes-ui.md#the-sidebars-overview)).
- **Under it, the changed files, read-only.** The Changes list's own row
  (`ChangedFileRow` with `readOnly`): name, directory and status words, line
  counts, its accessible name `Review <path>` (`, conflicted`). No stage
  button, no `⋯`, and the staging state is not drawn — a control that looks
  pressable and does nothing is the overview's sync-chip case again; staging is
  the Git page's. One row per path, not per side as in the list's groups: a
  partly staged file is listed once, as the review walks it. The row's name is in line with the
  doors' text, so it reads as under `Changes`, and a conflicted file puts
  `TriangleAlert` in `th-warning` in that icon column, where the list's
  `StageGutter` would put it. They are a `<ul>` named `Changed files`.
- **In the review's order, always flat.** `useOrderedChanges` — the order the
  Changes list and the review share, in whichever view the list is set to — so
  row k is the review's `k / n`; files in a collapsed folder are listed too,
  since the review walks them. No folder rows, no Flat / Tree toggle, no
  header: a folder row would be a second thing to press that opens nothing.
- **At most five rows**, then `Show all n files`, a muted text button indented
  as the rows, `min-h-[44px]`, that expands the list in place and moves focus
  to the first row it brought. Six files are drawn as six rows rather than a
  button standing in for one. The cap keeps History and Branches near the
  first screen of a phone; the operation banner's conflicted files use the same
  pattern ([git-conflict-ui.md](git-conflict-ui.md#the-banner)). `Show all` reads
  the list here and `Changes ›` goes to where it can be written; it does not
  close the drawer. **Each opening of the drawer starts collapsed**, and so
  does a worktree switch: the tab stays mounted, and an expansion kept would
  push History and Branches away for good. Turning to another tab and back
  keeps it.
- **One thing lit.** With a review open its file's row is lit — the list's
  `isActive`, a 2px accent bar and `aria-current="true"` — and the `Changes`
  door is not; a door is lit, `bg-th-bg-tertiary` and `aria-current="page"`,
  only while the route is that segment's list, and stays pressable as the way
  back to it. A file under review past the cap opens the list expanded, and
  each time the tab comes on screen — the drawer opened on it, or the tab
  turned to — that row is scrolled into view (`useRevealLitRow` over
  `Git/revealRow.ts`), waiting for the status if it has not arrived: the drawer
  is opened from where the reader is. A file under review that has stopped
  changing has no row, and nothing in the tab is lit.
- **A file row opens its review**, by `handleSelectDiffFile`'s history rules
  ([git-changes-ui.md](git-changes-ui.md#what-the-two-bottom-buttons-say)):
  it replaces an open review, and otherwise is pushed as the chat's review row
  is, or as the list's row when the Changes list is under the drawer. It opens
  on the side the list would; the row of the file already under review keeps
  the side being read, so pressing it only closes the drawer.
- **A failed status with nothing cached** reads a muted `Changes unavailable`
  under the door, not pressable — left blank, a list's place would read as a
  clean tree that forgot to say so; the reason and Retry are on the Git page.
  With a status cached, the cached files stay.
- **A door or a file row closes the drawer behind it**, as every pick in the
  sidebar does.
- The tab badge keeps its rule ([git-ui.md](git-ui.md#the-change-count-on-the-tab)),
  and **nothing in the tab writes**: every write appears once, on the Git page.
  No operation banner, no queued-write state on a row.

## No manual refresh

The sidebar has no refresh control — no button, no pull-to-refresh — because
almost everything in it is pushed or re-read without one:

- **Files**: FS watch pushes changes.
- **Git**: the `git.changed` subscription, plus the watcher's poll.
- **Sessions of the current worktree**: a live subscription, which a worktree
  switch rebinds.
- **All three, on top of that**: the sidebar coming on screen (the drawer
  opening, or the desktop column expanding) and clicking a tab — the one already
  open included — fire `refreshSignal`, which the open tab hears through
  `useSidebarRefresh` and answers by re-reading its list. On a phone the sidebar
  is a drawer, so every open is a refresh.

A list that failed to load still offers Retry; that is recovery from an error,
not a refresh.

The one list nothing pushes to is the Sessions list of *other* worktrees
(`session_view.*`). Opening the sidebar, clicking the tab, changing the filter
and deleting a row still re-read it
([cross-worktree-session-ui.md](cross-worktree-session-ui.md#refreshing-and-why-it-is-never-automatic));
between those it can be behind, and that is accepted — it is what desktop,
which never had any other refresh control, always lived with.

Pull-to-refresh used to sit on all three tabs and was removed. Its library
read mouse drags as well as touch, so on desktop pressing a Files row and
dragging it down — to [move it](file.md#moving) or
[drag it out](file.md#dragging-out-to-download) — was taken for
a pull, and an HTML5 drag, which stops `mousemove` / `mouseup`, could leave the
gesture stuck halfway. Disabling it on desktop alone would have kept a control
that only duplicated the refreshes above. The `overscroll-behavior-y: contain`
on `html, body` is a different thing and stays: it stops the *browser's own*
pull-to-refresh from reloading the app
([responsive-ui.md](responsive-ui.md#who-owns-the-scroll-boundary)).

## Where each panel is described

The rules above are general; each surface's shape is documented with it.

| Panel | Document | What it now covers that this file does not |
|-------|----------|--------------------------------------------|
| Files | [file.md](file.md) | The row's [`…` menu](file.md#entry-actions) and the create / delete flows it opens, the [two upload paths](file.md#uploading) and why neither leaves a destination behind. The search row's narrow-width fix and the wrapping option chips |
| Git | [git-ui.md](git-ui.md) | The workspace's routes, segments and Back, the top bar and its sync chip, the automatic fetch, the one-layer layout and the sidebar's list beside the detail at `expanded`, the commit bar's render conditions, amend on HEAD's row, `canPull`, the sync sheet's state-dependent button list, the `Sheet` overflow root cause, and which results outlive the page. Also the [change count on the tab](git-ui.md#the-change-count-on-the-tab) — what it counts, and why the `git.changed` subscription that feeds it sits in the sidebar rather than in the workspace |

Two of the redesign's outcomes reach past the panel they were found in, so they
are flagged here rather than left where they were diagnosed:

- **The `Sheet` height cap is not a Git fix.** The old branch sheet is where an
  uncapped desktop content box was found, but the cap landed in the shared
  `Sheet` and every sheet in the app benefits — including
  `WorktreeCreateSheet`, which belongs to neither panel. The root cause is
  written up once, in [git-ui.md](git-ui.md#branch).
- **The session list pages, and that is written up elsewhere.** It is not a
  Files or Git rule, and it applies to the project screen too, so the session
  sidebar's infinite scroll — and what it does to the live updates the list is
  pushed — lives in [list-paging-ui.md](list-paging-ui.md).
- **The Changes list's sticky header is still owed a check on a real device.**
  The reasoning behind it ([git-changes-ui.md](git-changes-ui.md#the-list-header))
  is from source and spec, not from a rendered page.
- **So is the drawer's five-row cap.** That History and Branches stay roughly
  on the first screen of a 667px-class phone is an estimate — two-line rows of
  about 48px, the rest of the chrome about 330px — not a measurement.

---

**Why this file lives here.** `docs/` holds per-feature design documents;
`docs/code/` explains the code of a *core module*, and `docs/projects/` the
project-management system. A set of rules two feature panels share is none of
those, so it sits beside them as `sidebar-ui.md` — and it holds only what neither
feature document owns, so that no fact here has a second copy there.
