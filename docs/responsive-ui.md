# Responsive UI

A mini pad — a tablet held in portrait, wider than a phone and well short of a
desktop — could not delete a session, could not delete a worktree, and could not
open a file entry's `…` menu. Three separate places had asked how **wide** the
screen was and used the answer to decide what the user could **reach**.

The same screen also lost 288px to a sidebar it could neither drag nor collapse.
That is the other half of the same confusion: a layout threshold picked by
imagining a desktop, and resize code only a mouse could drive.

This document holds the rules that came out of fixing that. It covers the width
ladder, the two pointer gates, hover reveal, hit areas, and which event
primitive to use for which job. It does **not** cover any single panel's shape:
[sidebar-ui.md](sidebar-ui.md) owns what the two sidebar panels share, including
the visual weight rungs this file sizes hit areas against and the narrow-width
rule for what fits **inside** a 240px container.

> **The dividing line with sidebar-ui.md:** if a number is a **viewport** width,
> it belongs here. If it is a **container** width, it belongs to that
> container's own document.

## The two axes

**Width decides where things go. Pointer decides whether they can be reached.**

- Width (`sm:` / `lg:` / `useIsExpanded()`) may decide **only**: layout shape
  (drawer vs. standing column, one column vs. two), spacing, type size, whether
  a label is folded away.
- Pointer (`pointer-fine:` / `pointer-coarse:` / `hasCoarsePointer()`) may decide
  **only**: reachability (whether something is revealed on hover), hit-area size,
  and drag- or hover-shaped interactions.
- **Width may never decide reachability. Pointer may never decide layout.**

### Why width is not a proxy for pointer

It reads like one — small screens are usually touched, large ones usually have a
mouse — and it fails in **both** directions, on devices real users own:

|  | Fine pointer (mouse, trackpad) | Coarse pointer (finger) |
|---|---|---|
| **≥1024** | Desktop browser | Touchscreen all-in-one, iPad in landscape |
| **640–1023** | A desktop window dragged narrow, a split screen | **Mini pad — where this broke** |
| **<640** | A very narrow desktop window | Phone |

A width test gets the whole coarse column above 640 wrong and the whole fine
column below 1024 wrong. A wide touch device is handed hover-only controls it can
never reveal; a narrow desktop window has its keyboard affordances switched off.
Both kinds of device were in real users' hands before anyone noticed, because the
code had no name for either of them.

## The width ladder

Three tiers, two breakpoints. Tailwind ships five rungs; **`md:`, `xl:` and
`2xl:` are retired** — their tokens are set to `initial` in both stylesheets'
`@theme`, so a stray one compiles to nothing at all. Having optional rungs
around is how `md:` and `sm:` came to be mixed in the first place, each author
picking whichever matched the screen in front of them.

| Tier | Range | Prefix | What it means |
|---|---|---|---|
| **compact** | <640 | none | One column. Sidebar is an overlay drawer. Tightest spacing and type. |
| **regular** | 640–1023 | `sm:` | **Still one column, sidebar still a drawer.** Just room to breathe: spacing and type step up one notch. |
| **expanded** | ≥1024 | `lg:` | Two columns side by side. Sidebar becomes a resizable standing column. |

The tiers are named by **what fits**, not by device. A boolean that is true on an
iPad in landscape and is called `isDesktop` is exactly the lie that caused this
outage; `useIsDesktop` is gone and every call site now reads `isExpanded`.

**A mini pad lands in `regular`** — a phone's layout with a tablet's breathing
room, which is what a portrait tablet should be.

### Why the two-column threshold is 1024 and not 768

At 768px the old shell entered its desktop branch and gave the sidebar a
standing 288px column. That left the chat area **480px** — narrower than `sm`
(640). So the shell believed it was on a desktop while every component inside it
was below its own smallest breakpoint and rendered in the tightest tier
available. The shell and its contents reached opposite conclusions about the
same screen. That is not "a bit cramped", it is self-contradiction.

1024 is the smallest number that makes the contradiction go away: with the
sidebar at its [240px minimum](sidebar-ui.md#the-narrow-width-rule), the content
area gets 784px, comfortably above
`sm`. (A user who then drags the sidebar out to 500px has made their own
trade-off; that is not the rule failing.)

Two mini-pad symptoms disappeared with the same change: the sidebar went back to
being a dismissable drawer, so its 288px stopped being unrecoverable, and
`Sheet` stopped turning bottom drawers into centred modals at 768 — on a portrait
tablet the bottom drawer is the thumb-reachable one.

### One source for the numbers

`BREAKPOINTS` in `packages/shared/src/utils/responsive.ts` is the only place the
values are written down. Both `web/src/index.css` and
`web-cluster/src/index.css` restate them in `@theme`, and
`web/tests/responsiveTokens.test.ts` reads both stylesheets as text and asserts
they still match the constants — so they stay *derived from* the source rather
than merely *resembling* it.

**In px, never rem.** Tailwind's defaults are rem, and a rem ladder shifts with
the root font size while `matchMedia` in JS does not. Under a non-default root
size the CSS prefix and the hook would switch at different widths — the same
split this whole module exists to remove. This is not hypothetical: `web-cluster`
was left on Tailwind's default `40rem` for a while and only its default font size
kept the two numbers equal.

**The same decision is never expressed twice.** Never a CSS prefix *and* a JS
hook for one thing. `Sheet` decided drawer-vs-modal with a hook **and** with
`md:items-center`; the hamburger button used `md:hidden` while the
sidebar picked its shape from a hook in another component. Either shape can be
edited alone, and then you have a sidebar with no switch, or a switch with no
sidebar. Where two components must agree, one of them reads the tier and the
other is given the *consequence* — `MainContainer` is simply not handed an
`onOpenSidebar` when there is no drawer to open, so the disagreeing state cannot
be written.

### Only one tier boundary has a JS reader

The JS side is deliberately asymmetric. There is **`useIsExpanded()` and nothing
else** — no `useLayoutTier()`, no `useIsCompact()`. The three tiers exist as CSS
prefixes; only the `expanded` boundary switches layout *shape* — a different
component tree, which a media query cannot swap. Spacing and type differences are
entirely `sm:`. An API for tiers nobody reads is an API nobody keeps correct: the
tier hooks were written, went unused, and were deleted. The tier names and their
reasoning live in the `BREAKPOINTS` jsdoc.

### The ladder is shared with web-cluster

`BREAKPOINTS` lives in `packages/shared`, and `web-cluster` compiles against it
too: its `ResponsivePanel` picks a dropdown or a bottom drawer at the same 1024.
That was a decision, not a side effect — the same reasoning applies, a portrait
tablet wants the bottom drawer.

The **pointer gates are declared in both stylesheets**, and that is not optional
duplication: the two names shadow Tailwind built-ins
([below](#both-names-shadow-a-tailwind-built-in)), so a stylesheet
that has not redeclared them does not drop the classes — it compiles them to a
different query. `web-cluster` declares both even though it reveals nothing on
hover and has no `pointer-fine:` user yet. An unused `@custom-variant` emits
nothing, so the unused half costs zero bytes, while a missing half costs
correctness. `packages/shared` is why the parity matters: it compiles into
*both* stylesheets, so one shared component could otherwise be right in `web`
and wrong in `web-cluster`.

## The two pointer gates

| Gate | Media query | Governs | The question it asks |
|---|---|---|---|
| `pointer-fine:` | `(hover: hover) and (pointer: fine)` | hover reveal | Can the **primary** input device hover? |
| `pointer-coarse:` | `(any-pointer: coarse)` | hit-area size and spacing | Could **any** attached device poke this with a finger? |

### They are deliberately not complements

On a touchscreen laptop **both are true**, and that is correct, not a typo: it
has a trackpad, so hover reveal genuinely works there, and it has a touchscreen,
so thumb-sized targets are the safe direction to be wrong in. Any implementation
that writes these as `pointer-fine` / `not pointer-fine` is wrong.

This is the single most likely thing for a future reader to "correct". It has
been written as complements once already. Don't.

A third query exists: `hasCoarsePointer()` asks `(pointer: coarse)` — the
**primary** pointer only. It is for behaviour that follows the main input mode:
Enter-to-send, whether to show keyboard hints, whether to focus a textarea on
mount (a touchscreen laptop is trackpad-driven and has a physical keyboard, so it
*should* be focused; a tablet should not have its on-screen keyboard eat half the
screen). **It must never be used for hit-area sizing** — that laptop answers
false here while still being poked by fingers.

**A touchscreen laptop is the only device where all three gates give different
answers**, which is why the test that guards them reads all three in one probe:

```ts
`${useHasFinePointer()}/${useMediaQuery(MEDIA_QUERIES.anyCoarsePointer)}/${useHasCoarsePointer()}`
// a touchscreen laptop => "true/true/false"
```

(The middle one is read through `useMediaQuery` because the hit-area gate has no
named hook — every hit-area decision is a CSS variant. `MEDIA_QUERIES.anyCoarsePointer`
is the shared value the variant is pinned to, so reading it here is what a JS
call site would write if one ever appeared.)

On a phone, primary-coarse and any-coarse are both true, so a hook that asks the
wrong one of those two still answers correctly and slips through. Any single-gate
assertion on a phone environment proves nothing about which query it reads.

### Both names shadow a Tailwind built-in

`pointer-fine` and `pointer-coarse` are **Tailwind 4.1's own variant names**:
`(pointer: fine)` and `(pointer: coarse)` — the *primary* pointer, and no
`hover: hover`. The `@custom-variant` lines in the two stylesheets are
deliberate overrides, and the table above is the definition that holds only
because those lines are there.

Remove one and nothing breaks loudly. The classes still compile; they start
meaning the built-in:

- `pointer-coarse:` → `(pointer: coarse)`, the one query this document says must
  never size a hit area. A touchscreen laptop answers false to it, and its hit
  areas stop growing at all.
- `pointer-fine:` → `(pointer: fine)` without the `hover: hover` half, which
  hands hover reveal to a device that may not be able to hover.

Confirmed against built CSS rather than documentation: delete `web-cluster`'s
`@custom-variant pointer-coarse` and rebuild, and `.pointer-coarse\:min-h-11` is
still emitted — wrapped in `@media (pointer: coarse)` instead of
`@media (any-pointer: coarse)`.

Tailwind does ship `any-pointer-coarse:`, which is exactly what `pointer-coarse:`
is redefined as, so the override is a choice. It is made because these two names
are the two *rules* — one per axis of reachability — and because a name declared
here can be pinned to `MEDIA_QUERIES` in `packages/shared`, so the CSS variant
and any JS reader of the same question cannot drift. The fine gate has no
built-in equivalent in any case: nothing built in combines `hover: hover` with
`pointer: fine`.

Two consequences. Every stylesheet compiling a source root that uses these
classes has to redeclare both, which is what `ROOT_STYLESHEETS` in
`web/tests/sourceScan.ts` writes down. And `responsiveTokens.test.ts` pins both
queries in both stylesheets instead of merely asserting the variants exist —
"exists" is satisfied by falling back to the built-in.

**With "they are not complements", this is one of the two things a reader is
most likely to get wrong here**, and it is the quieter of the two: complements
are at least visible in the source, while a missing declaration looks like
nothing at all.

## Progressive disclosure (hover reveal)

### Hover can only ever *add*, never restore

> Any "hide with condition A, bring back on hover" pair is **permanent hiding**
> wherever hovering does not exist.

This is not a probabilistic claim. Tailwind 4.1.18 compiles `hover:` and
`group-hover:` inside `@media (hover: hover)` — confirmed repeatedly against
built CSS, not from documentation — so on a touch screen the restoring half is
not merely never triggered, it is **absent from the stylesheet**. And even
without that wrapper, `:hover` on a touch screen is a sticky state produced only
*after* a tap, and that tap is consumed by the row itself.

`sm:hidden sm:group-hover:flex` is that shape, and it is how sessions and
worktrees became undeletable on every touch device wider than 640px.

### The one authorized form

```
pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100
```

Both halves behind the **same** gate. On a coarse pointer neither applies, so the
control is simply visible — there is no fallback branch to get wrong. Built CSS
confirms the shape works as intended:

```css
@media (hover:hover) and (pointer:fine) {
  .pointer-fine\:opacity-0 { opacity:0 }
  .pointer-fine\:group-focus-within\:opacity-100:is(:where(.group):focus-within *) { opacity:1 }
  @media (hover:hover) {                    /* Tailwind's own wrapper for hover: */
    .pointer-fine\:group-hover\:opacity-100:is(:where(.group):hover *) { opacity:1 }
  }
}
```

Two things to read out of that: all three rules are nested inside the
fine-pointer gate, so a coarse pointer receives none of them and the control is
never hidden in the first place; and **the `group-focus-within` rule sits outside
the inner `hover` media**, which is what makes "fixed for touch without breaking
the keyboard" true at the stylesheet level rather than merely intended.

Two further constraints:

- **Hide with `opacity`, never `display`.** The row does not reflow when the
  control appears, and — more important — the element stays in the tab order and
  the accessibility tree, which is the only reason `group-focus-within` can hand
  it back to a keyboard user. `sm:hidden` removed it outright.
- **A `title` attribute never fires on a touch device**, so `title` may only
  restate something already on screen. Any information that exists *only* in a
  tooltip is unreachable for a finger. `ToggleChip` is the compliant case: its
  `title` expands a visible label (`Contents` → "Search inside file contents"),
  and the chip itself is always visible and pressable, so no operation is lost.

### What may be hidden: three levels

Graded by the consequence of not finding it.

| Level | Definition | The question | Reveal rule |
|---|---|---|---|
| **P0** primary | The reason this row or area exists — open the file, select the session, send | Remove it and is this UI pointless? | **Never hidden, never dimmed, under any pointer.** |
| **P1** necessary secondary | A state change with **no second path on this screen** — delete a session, a file entry's `…` menu | Delete this control from the DOM: can the user still do it **on this screen**? "No" → P1 | Only the paired `pointer-fine:` form above. **No `display` hiding, no width prefix anywhere in it.** |
| **P2** redundant convenience | A shortcut to a path that already exists — drag-to-reorder, the resize handle, a tooltip restating a visible label, keyboard hints | Same question, answer "yes" → P2 | May be **not rendered at all** on a coarse pointer, with no fallback needed |

Two P2s in the codebase show the shape:

- `CommandPalette` renders its keyboard hints only when `!hasCoarsePointer()`.
  They mean nothing to a touch user and no operation is lost. Textbook.
- The step editor's drag handle is gated on `useHasFinePointer()` and simply does
  not exist for a finger — HTML5 drag never fires there anyway, and the
  `touch-none` it needs for a stylus turned those 36px into a dead spot the list
  could not be scrolled from. **`Move up` / `Move down` buttons stand beside it
  permanently** (P1), so reordering is always reachable. That pairing is what P2
  is supposed to look like.

### Where a P1 goes when there is no hover

Pick the highest option that works; picking a lower one requires a written
reason.

1. **Always visible.** The default answer. A list row is already 44px tall and
   fits one icon-only action.
2. **Folded into a `…` menu opening a sheet.** For rows with ≥2 secondary
   actions, where always-visible icons would eat the title's room to truncate.
   [sidebar-ui.md's narrow-width rule](sidebar-ui.md#the-narrow-width-rule)
   decides when: two standing icons are enough to break a 240px row.
3. **A separate entry point** (long-press menu, swipe). **Only ever in addition
   to 1 or 2, never as the only path** — it is invisible, therefore
   undiscoverable.

Explicitly ruled out: rendering a second set of controls for touch (two DOM trees
drift apart — the opposite of DRY), and sniffing the device with `onTouchStart`
(a mouse can be plugged in mid-session; the media query follows, the sniff does
not).

## Hit areas and spacing

**The gate here is `pointer-coarse` (`any-pointer: coarse`), never width.** This
is where the whole rule set lands.

| Pointer | Minimum hit area | Between neighbouring hit areas |
|---|---|---|
| Coarse (a finger might land here) | **44 × 44 CSS px** | **≥ 8px** |
| Fine only | the control's visual rung — 36 × 36 for an inline icon action ([sidebar-ui.md L5](sidebar-ui.md#visual-weight)) | ≥ 4px |

The distinction that unlocks everything:

> **Visual size follows the weight rung. Hit area follows the pointer.**

They are not the same number and never were. An inline icon action is 36px of
visual weight and needs 44px of target under a thumb; those are two facts about
one control, not two competing heights.

### Which controls the floor is asked of

The floor is written against **every** interactive element — `<button>`, `<a>`,
anything with `role="button"` — but only two shapes of control can be held to it
as written, and those are the two the rule covers today:

- **An icon-only control owes a box on both axes.** Nothing else sizes it, so
  stating no box at all is a failure in its own right — that is how the sheet's
  close button stayed at 28px.
- **A control that writes down its own height is held to that number**, whatever
  it renders. `h-9` is 36px, which clears the fine floor and misses the coarse
  one; the send button was caught exactly there. Growing it behind
  `pointer-coarse:` or laying `touch-target` over it both satisfy the rule.

**A control with text that lets padding and a line box decide its height is
outside the rule today.** `px-3 py-1.5` around one line of `text-xs` is 28px,
and neither a reader of the source nor `touchTarget.test.ts` can say so: string
matching produces no pixels, and padding plus a line box only adds up once you
know the computed font size — which is inherited, from an ancestor in another
file. That is the edge of what can be checked, not a claim that a thumb finds
those controls any easier. Sixty-nine controls are in that shape right now, and
of the 38 whose height can be worked out at all, **not one reaches 44px** — the
shortest is 16px. They are inventoried under
[Outside the floor today](#outside-the-floor-today) at the end of this section.

### Which technique, and when

> **Default: grow the box behind `pointer-coarse:`. Use the pseudo-element
> overlay only when the container's height cannot change on a touch device
> either.**

Growing the box is safe precisely because it is gated: the fine-pointer weight
ladder does not move at all, so the old worry about "a bigger box pushing its
container out of its rung" only applies to *unconditional* growth. `GroupHeader`
is `min-h-[32px] pointer-coarse:min-h-11` — 32 under a mouse, 44 under a thumb.

The overlay (`touch-target`, defined in `web/src/index.css`) lays a centred
`::after` over a control without resizing it: **both** floors, 36 always and 44
where a finger may land. It only ever adds, so a box already at its rung is
untouched — the second number is the one it exists for, and the first is what
keeps a box *below* the rung (the code block's 26px copy button) from being left
under the mouse floor by the very utility meant to be its hit area. But it
**reaches outside the box**, so every use has to re-check **two** things:

1. **Horizontally**, 8px to the neighbour — two 36px boxes 4px apart end up with
   overlapping hit areas, and every tap near the seam is a coin flip.
2. **Vertically, whether it reaches into the adjacent row.** A 32px group header
   given a 44px overlay extends 6px into the row below — where the same button
   sits again. That invents a mis-tap band between the two controls a user
   presses most, which is worse than what it fixed.

`Sheet`'s close button is the right use: the header is `py-3` around a 36px box,
which is what makes it 48px, and a 44px box would grow it. The box stays 36, the
overlay does the reaching, and negative margins let it eat into the header's own
padding — which the header is tall enough to give. `DeleteButton` is the same, plus a
precondition: `WorktreeItem`'s row had to be brought up to `min-h-11` first,
because in a 40px row the 44px overlay would have reached into the neighbouring
row's Delete. `ConnectionStatus`'s retry button is a third: the app header is a
fixed `h-11 sm:h-12`, so growing that box would push the header open, while the
overlay reaches the floor inside it. (Below 640 its `Offline` label folds away
and it becomes an icon-only button — on a screen where reconnection has already
given up, so it is the only way out.)

**A box written on an `<a>`, a `<span>` or a `<label>` needs a `display` beside
it.** Those tags are `inline` by default, and CSS drops `height`, `min-height`
and `width` on an inline box — so `min-h-11` there is a number that reads as
44px and renders as nothing. Write `inline-flex` (or `flex` / `block` / `grid`)
with it; `absolute` and `fixed` also count, since an out-of-flow box is
blockified whatever its `display` says. A flex parent blockifies its children
and would make the number true, but that is the parent's doing and can be undone
from another file, so the element states it itself. `<button>` and
`<div role="button">` need nothing extra — `inline-block` and `block` both take
a height. `touchTarget.test.ts` enforces this, and `touch-target` is exempt: its
overlay is an absolutely positioned pseudo-element and reaches its floors from
an inline parent.

### Where the rungs are defined

The shared definitions, so the common cases cannot drift apart:

- `web/src/components/ui/iconButtonClass.ts` — the inline icon action inside a
  list row, a group header or the row under a chat bubble (36 / coarse 44).
  Shared by both sidebar panels and chat; it moved out of `Git/` once the file
  tree stopped writing its own copy.
- `web/src/components/common/MenuRow.tsx`'s `MenuRow` — a full-bleed row of a
  menu sheet (48, clear of the floor for either pointer). Only the file entry
  menu uses it today; the message menu it was extracted for is gone, its one row
  now an icon standing on the bubble's action row
  ([session-fork-ui.md](session-fork-ui.md#entry-point)).
- `web/src/components/ui/ContentView.tsx`'s `actionIconButtonClass` — the
  bordered icon action in the bar under a file or a diff (36 / coarse 44). It was
  32px for everyone, under the floor for *either* pointer.
- `web/src/components/ui/ToggleIconButton.tsx` — the same bar's *sticky* icon
  action, the one that stays on once pressed. `actionIconButtonClass` is not
  reusable here: pressed fills the box with the accent, so border and background
  belong to the state rather than to the shape. It restates the same two
  numbers. It exists because that fill was on its way to a third hand-written
  copy.
- `web/src/components/Project/AgentRoleDetailOverlay.tsx`'s
  `stepActionButtonClass` — the step list's own reorder / delete trio. A local
  definition rather than a shared one, because it is not a sidebar list row; it
  states the same two numbers.
- `web/src/components/common/DeleteButton.tsx`'s `deleteButtonClass` — 36px box
  plus `touch-target`, for every list row's Delete. **Not overridable.** It was a
  prop until the reveal bug was fixed, and the one caller that passed it used the
  opening to reintroduce a hover reveal no touch device could undo. A contract
  that can be swapped out at the call site is not a contract; a row that needs a
  different delete affordance adds a prop *there*, so every caller gets the fix.

A control outside those cases writes its own pair inline —
`size-9 pointer-coarse:size-11` for a box that can grow, `touch-target` for one
that cannot. That is what `web/tests/touchTarget.test.ts`
enforces: the rule is the floor, not the helper, so a button that never reaches
for a helper still has to state a number.

### The one deliberate exemption

The sidebar's resize handle stays **8px** and is not grown to 44. Widening it
would lay a 44px drag strip down the right edge of every row in the list —
exactly where Delete sits — and taps that work today would become drags. Sidebar
width is a preference (P2); Delete is an operation.

> **The floor exists to make operations reachable, not to make a preference
> easier at the cost of an operation.**

This is written down so the next reader does not "fix" it in passing.

### Outside the floor today

The shape the rule does not reach is not hypothetical. Counted with the same
reader `touchTarget.test.ts` uses, over the same three roots, then carried past
the point where the guard stops: **69** interactive elements render text, state
neither a height nor a stretch token, and carry no `touch-target`. (The two that
do stretch are blind spot 5 below, not this list.)

- **28** state both a font size and vertical padding, so their height is exact
  arithmetic. **All 28 land between 20px and 40px** — not one reaches 44.
- **11** state no padding at all. For ten of them the box is a single line box,
  **16–20px** — six say their own font size, and the other four take it from the
  banner or paragraph they sit in, read one by one. The eleventh is the theme
  card in Appearance, which states no height but is sized by a `min-h-12` block
  inside it and is nowhere near the floor.
- **30** inherit their font size from an ancestor in another file, so only a
  range can be given. Nothing in either app sets a root font size and preflight
  sets `line-height: 1.5` on `html`, so the browser default puts the line box at
  24px: the common `p-2` case lands around 40px, `p-1` around 32px, and a `p-3`
  one does clear 44.

The ones that miss even the 36px fine-pointer floor, each read back from the
source:

| Where | Height | What it is |
|---|---|---|
| `Files/UploadQueue.tsx:144/154/166/228` | **20px** | Replace / Keep both / Retry / Retry failed — the only way out of a failed upload |
| `Git/ErrorBanner.tsx:38` | **16px** | the details toggle on a git failure |
| `Project/WorkDetailOverlay.tsx:104` | **16px** | the link up to the parent work |
| `Project/WorkListOverlay.tsx:341` | **16px** | a task title, in a `min-h-[36px]` row |
| `Project/WorkListOverlay.tsx:251`, `WorkDetailOverlay.tsx:699`, `AgentRoleListOverlay.tsx:190` | **20px** | list titles **inside a `min-h-[44px]` row** — the row is 44, the target in it is 20, because `items-center` centres the text rather than stretching it |
| `Project/WorkListOverlay.tsx:418` | **20px** | the labelled Start chip (its icon-only twin above it is 44) |
| `AppShell.tsx:523/530`, `ui/ReconnectBanner.tsx:39` | ~**20px** | Retry and dismiss in the session-error banner, Retry now in the reconnect banner |
| `Worktree/WorktreeCreateSheet.tsx:155` | ~**20px** | the link out of the setup-script note |
| `Chat/ChatPanel.tsx:114` | **24px** | the linked-work pill, in the toolbar row above the input |

One more is worth naming although it clears the fine floor: `ConfirmDialog`'s
Cancel and confirm are **36px** (`px-4 py-2` around `text-sm`), and every
destructive confirmation in both front ends goes through them.

**These are known and deliberately deferred, not a backlog nobody owns.** The
decision, taken in the story that wrote this file: raising this many controls
changes the phone layout in as many places, the phone UI reads well today, and
the outcome cannot be checked without the coarse-pointer walkthrough. That is its
own story — one that picks a batch by P0/P1/P2 rather than raising everything,
and ideally teaches the scan to compute the `padding + line box` shape so the
next such control is caught when it is written, not counted years later.

## Which event primitive

Choose by **what the code is doing**, not by a blanket rule.

- **Gesture tracking** (drag, swipe, resize) → `pointerdown` / `pointermove` /
  `pointerup` plus `setPointerCapture`. Mouse events on a touch screen are
  compatibility emulation the browser withholds while a gesture might still turn
  into a scroll, and they are never sent for a stylus at all. That is how the
  sidebar's resize handle came to be undraggable on a tablet.
- **Activation detection** ("did that land outside me?") → **`click`**.
  `pointerdown` fires the instant a finger touches the glass, before the browser
  knows whether this is a tap or a scroll — using it means **scrolling the page
  dismisses the overlay**. `click` is dispatched only once the gesture resolves
  to an activation, and it covers finger and stylus as well as mouse. The
  document listener must be attached **one task later**: a `click` still
  propagating picks up listeners added on its way, so the very click that opened
  the overlay would close it again.
- **The real exception:** `onMouseDown={e => e.preventDefault()}` to keep focus
  where it is. Pointer events have no equivalent — preventing a `pointerdown`
  does not stop the focus change — and the emulated event does arrive on touch,
  so this path works. `ToggleChip` is the one control that needs it. **Stated
  explicitly because a blanket "always use pointer events" would get focus
  behaviour broken.**

The guard is written around that exception: a JSX `onMouseDown` prop alone is not
flagged, while `onMouseMove` / `onMouseUp` / `onMouseEnter` / `onMouseLeave` and
any `addEventListener` for `mousemove`, `mouseup` or `mousedown` are. A drag
started from an `onMouseDown` is still caught, because it cannot be followed
without the move and the release. Two dialogs also use a bare `onMouseDown` to
stop propagation into what is behind them; that is event isolation, not pointer
tracking, and it is unaffected.

Both activation-detection hazards live once, in
`packages/shared/src/hooks/useOutsideClick.ts`, along with why its callback is
read through a ref. Call sites supply only their own definition of "inside".

## The automated gates

These are more reliable than a checklist and are the real self-check for any PR
that touches layout or reachability. They are source **scans**, not rendering
tests, for a reason worth stating: jsdom applies no Tailwind, so a component with
a class list that never matches renders identically before and after the fix. A
per-component test cannot see any of these bugs. What has to hold is a property
of the source — and it has to hold for components nobody has written yet.

| Test | What it guards |
|---|---|
| `web/tests/responsiveTokens.test.ts` | Both stylesheets' `@theme` values **and** both their `@custom-variant` queries still match `packages/shared`; `md:` / `xl:` / `2xl:` stay retired in both; every scanned source root is mapped to a stylesheet that redeclares the two gates (the mapping is a written claim about the build, not read out of it — a line naming the wrong stylesheet would still pass); and `touch-target` really declares the two floors the scans credit it with |
| `web/tests/widthLadder.test.ts` | No retired rung (`md:` / `xl:` / `2xl:`, stacked or interpolated) appears in source. A retired rung compiles to nothing, which is silent; this makes it loud |
| `web/tests/hoverReveal.test.ts` | Hover-revealed visibility carries no width prefix; both halves share one gate; every reveal pair has a `group-focus-within` twin and does not hide with `display` |
| `web/tests/pointerEvents.test.ts` | Nothing tracks a gesture with mouse events (a bare `onMouseDown` prop is allowed — see the exception above) |
| `web/tests/touchTarget.test.ts` | Every interactive element — `<button>`, `<a>`, or anything with `role="button"` — is held to the floors as far as its source can be read ([scope](#which-controls-the-floor-is-asked-of)): an icon-only one states a box on both axes, one with text is held to whatever height it wrote down itself, and a tag that is inline by default has to blockify or the size it wrote does not count. Neighbouring controls sit ≥8px apart, over that same set of tags, wherever their container states a gap at all |
| `web/src/components/AppShell.test.tsx` | The hamburger and the sidebar's shape come from one source and can never disagree |
| `web/src/components/ui/Sheet.test.tsx` | Drawer sits at the bottom, modal is centred, and both follow the one hook |
| `web/src/test/outsideClick.test.tsx` | A click outside dismisses and one inside does not; touch scrolling does not; the click that opened the overlay does not; the listener survives a host re-render |
| `web/src/test/responsive.test.tsx` | The ladder's absolute numbers; all three pointer gates read together on a touchscreen laptop; and that a gate is subscribed rather than sampled once, so a resize or a mouse plugged in mid-session re-renders |
| `web/tests/sourceScan.test.ts` | Each scanned root still resolves to files, so an absent-violation assertion cannot pass by reading nothing |

Known blind spots, recorded as they are rather than as they should be:

1. **A control with text that never writes down a height is unguarded.** Its
   height is padding plus one line box and the check returns nothing for it,
   which is why the rule itself is scoped around this shape
   ([above](#which-controls-the-floor-is-asked-of)). The moment such a control
   does state a height, that number is read and held to both floors — which is
   where the send button's `h-9` was caught. Only a person reading the rendered
   page catches the other kind, and **69 controls are sitting here today**, the
   shortest at 16px — inventoried in
   [Outside the floor today](#outside-the-floor-today).
2. **The spacing check only looks at containers that state a gap, and only at
   controls written literally inside them.** A row that declares no `gap-` at all
   is never examined, so two 36px buttons touching edge to edge pass — verified
   by mutation on a throwaway component with no gapped ancestor. And
   `SidebarListItem` takes its actions as a prop, so none of those tags appear in
   its own source and its `gap` is unguarded either way: packing it back to
   `gap-1` leaves the suite green. Both kinds have to be read by a person. (A
   gapped *ancestor* catches some of the first kind by accident, measuring the
   inner controls against its own gap — accident, not coverage.)
3. **`sourceScan`'s per-root assertion cannot catch a root being deleted
   outright.** It catches a root pointing at a moved or renamed directory; one
   `it.each` case fewer is not a failure. Only a reviewer catches that.
4. **Only the coarse gap is checked, never the fine 4px one.** Anything clearing
   8px on a coarse pointer clears 4px on a fine one, so the hole is exactly one
   shape: a row that gets its 8px from a `pointer-coarse:` gap while its base gap
   is under 4px. There is no such row today.
5. **`self-stretch` / `h-full` / `inset-0` are believed unconditionally, and the
   parent they defer to is checked by nothing.** The tokens mean "this axis
   belongs to the layout", so the check credits the control with the full 44 and
   stops — but a container is not an interactive element, so no assertion ever
   reads its height. A `self-stretch` button in a 32px row is 32px with the suite
   green. Both of today's uses do hold, read one by one: `GroupHeader`'s row is
   `min-h-[32px] pointer-coarse:min-h-11` and `FileTreeNode`'s is
   `min-h-[44px]`. **No violation today, listed anyway** — the guard is green for
   a reason it cannot verify, and that is worth knowing before the third one is
   written. (`w-full` / `flex-1` are credited the same way on the width axis,
   where a control that fills its row is rarely the one a thumb misses.)

### The manual check that cannot be automated

**The coarse-pointer walkthrough.** Turn on touch emulation in DevTools (or blank
out the `pointer-fine` variant), and go screen by screen asking: **is every P0
and every P1 operation still possible?** One that is not is a bug. This is the
acceptance criterion for anything touching hover or hit areas.

## What went wrong

The twelve faults this document was written from. Kept because each rule above is
an answer to one of them, and because comments in the code refer to them by
number.

| # | Where | What it was | Symptom on a touch device |
|---|---|---|---|
| 1 | `common/DeleteButton` | `sm:hidden sm:group-hover:flex` | Sessions and worktrees **undeletable** above 640px |
| 2 | `Worktree/WorktreeItem` | Overrode #1's class with the same bug again | Same, written twice |
| 3 | `Files/FileTreeNode` | `md:opacity-0 md:group-hover:opacity-100` — intent correct, gate wrong | Entry `…` menu invisible; create / delete / rename all unreachable |
| 4 | `Layout/Sidebar` | Standing 288px column from 768 | Chat area 480px — narrower than `sm`, while its contents believed they were on a wide screen |
| 5 | `Layout/Sidebar` | Resize on `mousedown`/`mousemove`/`mouseup`; no collapse in the desktop branch | Those 288px could be neither dragged nor dismissed |
| 6 | `ui/Sheet` | One decision stated twice: `useIsDesktop()` **and** `md:items-center` | Bottom drawer became a centred modal at 768, out of thumb reach |
| 7 | `Layout/MainContainer` | Hamburger `md:hidden`, sidebar shape from a hook in another component | Edit either and you get a sidebar with no switch, or a switch with no sidebar |
| 8 | `Chat/InputBar` | `if (!isMobile()) textarea.focus()` — 640px standing in for "has a keyboard" | Entering a session raised the on-screen keyboard over half the display |
| 9 | `ui/Sheet` | Close button `p-1` + 20px icon = 28px | Every sheet was hard to close — under the floor for a *mouse*, let alone a thumb |
| 10 | `Project/AgentRoleDetailOverlay` | Three 36px buttons at `gap-0.5` (2px) | Move up / move down / delete packed together; Delete mis-tapped |
| 11 | `Project/AgentRoleDetailOverlay` | HTML5 `draggable` handle with `touch-none` | Could not be dragged *and* blocked scrolling there — a dead spot |
| 12 | `useIsDesktop` (768) vs. `breakpoints.ts` (640) | Two breakpoints that had never met | 640–767 was a nameless band nobody had designed for |

Two more emerged during the fixes and are worth the same billing: switching from
`mousedown` to `pointerdown` for outside-click made touch scrolling dismiss
overlays (hence `click`), and the drawer's open state survived a rotation into
`expanded` and back, so a drawer the user had never opened appeared by itself.

---

**Why this file lives here.** `docs/` holds per-feature design documents,
`docs/code/` explains a *core module*'s code, and `docs/projects/` the
project-management system. A rule set that cuts across every panel in both
front ends is none of those, so it sits beside [sidebar-ui.md](sidebar-ui.md),
which is here for the same reason. It holds only what no other document owns:
the 240px container floor stays in `sidebar-ui.md`, the 36px visual rung stays
in `sidebar-ui.md`, and only the 44px coarse hit-area floor is defined here.
