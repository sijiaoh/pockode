# File Actions UI

One layout for the controls of every screen that shows one file: the file
viewer and editor in the Files tab ([file.md](file.md#viewer-ui)), the review
([git-changes-ui.md](git-changes-ui.md#the-review-layer)), a commit's file diff
and a file as a commit left it
([git-ui.md](git-ui.md#viewing-a-file-from-a-commit)). A later screen of that
kind takes the same building blocks rather than laying out a bar of its own.

The building blocks are in `web/src/components/ui`: `detailActions.tsx`
(`ViewToolbar`, `DetailActionBottomBar`, `DetailActions`,
`detailActionsPlacement`, `PrimaryActionButton`, `LeadingTextActionButton`),
`SourceToggle` (with `sourceRenderingOf`, which decides where it is offered),
`ToggleIconButton` / `WrapToggle`, and `ContentView.tsx`'s
`getActionIconButtonClass` / `getDestructiveIconButtonClass`.
`Git/FileSequenceNav.tsx` is the `‹ k / n ›` of the two Git screens that walk a
sequence of files.

## Why one system

The five screens grew their bars one at a time and disagreed on every axis: the
wrap and whitespace toggles were at the top in the review and at the bottom
everywhere else; the destructive action was on the left in the review and last
on the right in the viewer; the review's primary was accent-filled and the
editor's Save was green-outlined; Source had two icons and two sets of words;
the Files screens' bar never moved to the top at `expanded` and never made room
for the composer's keyboard, although the composer is under them too
(`overlayKeepsComposer`). A reader moves between these screens in one motion —
a commit's diff and `View this file at <hash>`, the review and a file's
History, the viewer and its editor — so every difference was something to
relearn on the next screen.

## Two zones

Every control answers one of two questions, and each question has its own row.

| Zone | Answers | Holds | Where |
|---|---|---|---|
| **Toolbar** (`ViewToolbar`) — one row under the app header, `min-h-[44px]`, `border-b` | How am I reading this? | `‹ k / n ›` on the left where the file is one of a sequence; then a `flex-1 min-w-0` spacer; then the view toggles | Top, at every width, never hidden by the keyboard |
| **Actions** (`DetailActions`) | What do I do with it? | The actions group ([below](#the-actions-group)) | By [placement](#placement): the bottom bar on narrow, the toolbar's end at `expanded` |

- **The toggles stay at the top** because how a page is read does not change
  with a keyboard, and the toolbar is where a reader looks before reading. The
  bottom is for deciding about the file, in the thumb's reach.
- **The spacer is what gives way** when the row is short. Nothing else in the
  toolbar shrinks or wraps, so no control moves under a thumb.
- **The toolbar is not drawn when it has nothing to hold at this width.** An
  empty row would cost a line of the page: the viewer showing an image, a
  binary, media, an empty or too-large file, or text past `HIGHLIGHT_LIMIT`
  that is not shown as source has no toggle, and the editor has none, so on
  narrow neither draws the row. A rendered page or rendered Markdown always
  has it: it carries Source.
- **Toggles go in a fixed order: Source · Wrap · Whitespace · Split.** Each is
  absent where it would change nothing, never drawn inert. Wrap follows
  `offersWrap` ([file.md](file.md#wrapped)). Source is only for a page (of any
  size) or for Markdown within `HIGHLIGHT_LIMIT`; a commit's file puts its
  `Type` toggle in the same slot ([below](#the-four-kinds-of-control)).
  Whitespace is not offered for a conflict. Split is only at `expanded`, only
  in the review, and never for a conflict.

## The actions group

Left to right, the same on every screen:

```
[leading]  ──gap-3──  [utility icons…] [primary]
```

| Slot | Holds | Why there |
|---|---|---|
| `leading` | The one action that takes something away or leaves: Delete, Discard file / Delete file, Unstage, a conflict's Ask agent, the editor's View | Farthest from the trailing corner, the one pressed all day, with a wider gap (`gap-3`) so it is never flush against it |
| `utilities` | Icon actions: Rename, Download, History, View at hash, Edit | Between the two, right-aligned on narrow, in the thumb's zone |
| `primary` | At most one `PrimaryActionButton` | Last. On narrow it takes the rest of the row |

- **Without a primary, the trailing corner holds the screen's most-used
  action**: the viewer's Edit stands where the editor's Save stands, so the
  thumb goes to the same place to edit and to save. Edit stays an icon there —
  editing by hand comes second in Pockode — and is not promoted to a primary.
- **The destructive action leads, it does not trail.** The viewer used to put
  Delete last "so a thumb does not reach it by accident"; but the trailing
  corner is exactly where a right thumb rests, and the review already kept
  Discard on the left, away from its primary. One rule for both: what takes
  something away is the farthest from what is pressed all day.
- **A screen writes its actions once.** `ViewToolbar` and
  `DetailActionBottomBar` take the same `DetailActions` object and draw it only
  at their end, and the text buttons read which end they are in from context
  (`PrimaryActionButton`, `LeadingTextActionButton`), so nothing is laid out
  twice.

## The four kinds of control

| Kind | Built from | Look | Members |
|---|---|---|---|
| View toggle | `ToggleIconButton` (`WrapToggle`, `SourceToggle`) | Bordered icon; accent fill and `aria-pressed` when on; the label names what a press will do | Source (`Code`), Wrap (`WrapText`), Whitespace (`ALargeSmall`), Split (`Columns2`) |
| Utility action | `getActionIconButtonClass` | Bordered icon, named by `aria-label` and by a matching `title` for a pointer's tooltip | ‹ ›, Edit, Rename, Download, History, View at hash, the editor's View |
| Primary | `PrimaryActionButton` | Accent-filled text, `rounded-lg text-sm font-medium`; a spinner and a pending label while its action runs, with `aria-busy` | Stage & next, Stage, Next, Commit n files, Mark resolved, Back to changes, Save |
| Destructive | `getDestructiveIconButtonClass` (icon) or `LeadingTextActionButton tone="error"` (text) | Always the error colour, pressable or not; always leading; always confirmed by `ConfirmDialog` first | Delete; Discard file, Delete file |

**Text or icon in the leading slot.** Text when the action changes the
repository or the file, or hands it off, *and* the row has a text primary: it
is the other outcome of the same decision, and reads as one beside it —
Discard file beside Stage & next, Unstage beside Next, Ask agent beside Mark
resolved. Otherwise an icon: the viewer's Delete (the row has no text primary)
and the editor's View (it only goes back to the viewer). Only Delete and
Discard are red; Unstage, Ask agent and View lead in the neutral colour.

**Source has one icon and one set of words** wherever it is: `Code`, `Show
source`, and back with `Show rendered` (Markdown) or `Show page` (a page). The
one other toggle in its slot is a commit file's `Type` (`Show plain text` /
`Show rendered`) for highlighted text that is not Markdown: there it is the
only way to the copy button, a commit having no Edit to open the file in.

## Behaviour

- **Disabled with a reason** for an action the screen has but this file
  cannot use now: it keeps its slot, and says why — Edit (`getEditLabel`) and
  View at hash (`(deleted in this commit)`) in their `aria-label` and `title`,
  the review's Commit in `describeCommitAction`'s hint, which the button names
  with `aria-describedby`.
- **Absent** for a toggle that would change nothing (above), and for an action
  the screen does not have at all: a commit's file has no Edit, since a greyed
  one would read as a bug or a permission problem
  ([git-ui.md](git-ui.md#viewing-a-file-from-a-commit)).
- **Busy** is a spinner in place: the primary's pending label (`Staging…`,
  `Saving…`), Delete's spinner in its icon.
- **While a file loads or fails** a screen has nothing to act on, and its
  actions are absent — except the editor's, whose Save stays drawn and
  disabled until the content is in.

Outside this system, and unchanged by it: the hunk bars (Select, Stage hunk),
the line-selection bar, and buttons inside the content ("Show whitespace", a
card's Download).

## Placement

The composer is under every one of these screens, so the bottom of the screen
is shared, and three bars and a soft keyboard leave a phone no room to read.
Where the actions go is one decision, `detailActionsPlacement(isExpanded,
keyboardUp)`:

| | Placement | Bottom of the screen, top to bottom |
|---|---|---|
| `expanded` | `top` — the actions join the toolbar's end, after a 1px divider when there are toggles | the composer alone, keyboard or not |
| Narrow | `bottom` — `BottomActionBar`, above the composer, in the thumb's reach | (a diff's selection bar), action bar, composer |
| Narrow, keyboard up | `hidden` | (a diff's selection bar), composer, keyboard |

- **The composer stays last**, where it is on the chat page, so the thumb finds
  it in the same place on both.
- **"Keyboard up" is the caret in one of the composer's text fields, on a
  coarse primary pointer.** `ChatPanel` computes it once (`composerTyping &&
  isPrimaryPointerCoarse`) and hands the same `keyboardUp` to `GitWorkspace`,
  `FileView` and `FileEditor`. The field, not the bar: a tap on Send leaves
  focus on the button with the keyboard gone, and the actions must come back
  then. The pointer gate is the answer panel's yield's
  ([answering-ui.md](answering-ui.md)): a fine pointer — a narrow desktop
  window — has no soft keyboard to make room for. It is the composer's field
  only, so typing in the editor itself never hides Save.
- **The toolbar is untouched by the keyboard**: only the actions go.
- The Git diffs' selection bar is never hidden — typing is exactly when the
  user wants a selected piece of code in the draft
  ([git-ui.md](git-ui.md#where-a-details-actions-go)).

## Widths

The tier decides where the actions are; the pointer decides how big each
target is ([responsive-ui.md](responsive-ui.md#the-two-axes)).

- **Narrow is one row.** The viewer's bar is the widest without a primary:
  Delete, Rename, Download, History, Edit — five 44px targets with their gaps
  and the bar's padding are about 280px, under a 320px phone, so the row no
  longer wraps as the old seven-icon bar did. A row with a primary cannot
  overflow: the primary takes what is left (`min-w-0 flex-1`), and a leading
  text action yields at half the row (`max-w-[50%]`).
- **At `expanded` the group keeps whole**, the toolbar's spacer giving way
  first. The widest row checked is the review's — nav, three toggles, the divider,
  `Discard file` / `Delete file` and `Stage & next` — which fits at 480px
  (`DiffView.browser.test.tsx`), under the narrowest main area `expanded` gives
  a detail: about 524px, at 1024 beside the sidebar at its 500px maximum.
- **Hit areas** are the floor's: 36px under a fine pointer, 44px under a coarse
  one, with gaps of 4px and 8px (`gap-1 pointer-coarse:gap-2`). The text
  buttons write their own heights — `min-h-[44px]` at the bottom, `min-h-9
  pointer-coarse:min-h-11` in the toolbar — so `web/tests/touchTarget.test.ts`
  reads them. That is why `textActionButtonClass(...)` is called inside each
  `className` in `detailActions.tsx`: stored in a module-level constant, the
  height would be out of the scanner's reach.

## Per screen

| Screen | Toolbar | Actions (leading · utilities · primary) |
|---|---|---|
| `FileView` | Source, Wrap | Delete · Rename, Download, History (in a git repository), Edit · — |
| `FileEditor` | — (at `expanded`: the actions alone) | View · — · Save |
| `DiffView` (review) | `‹ k / n ›` · Wrap, Whitespace, Split | Discard file / Delete file / Unstage / Ask agent · — · the review's primary ([git-changes-ui.md](git-changes-ui.md#what-the-two-bottom-buttons-say)) |
| `CommitDiffView` | `‹ k / n ›` · Wrap, Whitespace | — · History, View at hash · — |
| `CommitFileView` | Source (or `Type`), Wrap | — · Download · — |

Each screen's header is `FilePageHeader`: the file name as the title, its
folder as the subtitle. The review used to show the folder in its toolbar
instead; it is the header's now, as on every other file screen, and a commit's
hash is the header's and the banner's, no longer repeated in a bar.
