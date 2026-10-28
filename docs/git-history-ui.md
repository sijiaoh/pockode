# Git History UI

How the Git workspace's History segment draws the commit graph, how its range, search and file filter work, and what a commit's detail and `⋯` menu offer. The workspace around it — routes, the top bar, the two-column layout at `expanded`, the commit sheet that amend reuses — is [git-ui.md](git-ui.md)'s; what pauses while the repository is mid-merge or mid-rebase is [git-conflict-ui.md](git-conflict-ui.md)'s. This file points to both rather than restating them.

Copy below is the UI's English.

## Goals and constraints

- **Readable on a phone first.** The graph is drawn for 300px and allowed to grow, never drawn for a desktop and squeezed. The subject of a commit is what a row is for; the graph and the ref markers give way before it does.
- **Never by colour alone.** What a dot *is* — a commit, a commit not yet pushed, a merge — is its shape. Colour only helps tell one line from the next, and every colour clears the non-text contrast floor in every theme ([Line colours](#line-colours)).
- **The server gives commits, the client draws lines.** How many lines fit depends on the width of the screen, which only the client knows. The server answers with commits, their parents and the refs on them; the lane layout is a pure function in the frontend, run incrementally page by page so lines carry across a page boundary without being recomputed.
- **A graph is drawn only over a connected history.** A search or a file filter returns commits that are not each other's parents, and lines drawn between them would be lies. With either on, the graph goes and a plain list says why ([Search and file filter](#search-and-file-filter)).
- **Nothing that rewrites history runs from a menu row.** Amend reuses the commit sheet; revert is handed to the agent with the [prefill handoff](agent-handoff-ui.md#1-prefill-handoff), because a revert can stop on a conflict and the agent is what resolves conflicts here.
- **Reuse the vocabulary.** `Sheet` for every menu and picker (on both layouts, as `ChangedFileMenu` and `FileEntryMenu` are), `MenuRow`, `NewBranchSheet`, `GitCommitSheet`, `ConfirmDialog` nowhere new — nothing here is destructive.

## The History segment

### Below `expanded`, 300px wide

```
┌────────────────────────────────┐
│ ⑂ feature/graph       ↑ Push 2 │  top bar (git-ui.md) — unchanged
├────────────────────────────────┤
│  Changes  [History]  Branches  │  segmented control
├────────────────────────────────┤
│ Current + main ▾   ↑3 unpushed🔍│  history header, stays put
├────────────────────────────────┤
│ ○       Add lane layout        ⋯│  ← lane 0: HEAD's line
│ │       [⑂ …/graph] a1b2c3d 2h  │  ref chip on line 2
│ ○       Lay out lanes per page ⋯│  unpushed: hollow
│ │ ●     Merge pull request #41 ⋯│  lane 1: main's tip
│ │ │     [⑂ main☁][+2] 7c8d9e0   │  one chip, two more refs
│ │ ◉─╮   Merge branch 'fix-x' … ⋯│  merge: double ring
│ ├─╯ │   9f8e7d6 colleague, 1d   │
│ ●  +2   Fix the sync chip …    ⋯│  more lines than fit: +2
│ ┆       ⟳ Loading older commits │  next page on the way
└────────────────────────────────┘
```

Every row is one commit, **52px high, fixed** — two text lines (`text-sm` subject, `text-xs` meta, chips no taller than its 16px line) centred in it — because lines must meet edge to edge between rows and a virtual list needs a known height. Rows have **no gap and no rounding**, unlike `SidebarListItem`'s list: a gap would cut every line. The selected row keeps the active treatment (`bg-th-bg-tertiary` and the accent bar), drawn under the lines.

A row from left to right:

| Part | Width | Content |
|---|---|---|
| Padding | 8px | — |
| Graph | `lanes × 14px`, plus an 18px `+N` slot when lines are hidden ([Lane cap](#lane-cap)) | an inline SVG, `aria-hidden` |
| Gap | 8px | — |
| Text | **at least 160px**, takes the rest | line 1: the subject alone, truncated at the tail. Line 2: ref chips ([Ref markers](#ref-markers)), then the short hash in mono, then author and relative time, which is what gives way when the line is short |
| `⋯` | 36px, L5 (`iconButtonClass`); 44px under a coarse pointer, as that class grows it | the commit's menu ([The commit menu](#the-commit-menu)), named `Actions for commit a1b2c3d` |

On a 300px phone that leaves 300 − 8 − (4 × 14 + 18) − 8 − 44 = **166px** of text with four lines and an overflow slot — a subject's first four or five words. The subject has its line to itself because it is what the row is for; the refs, which only a branch tip has, take room from the author and time instead, which the commit's own page repeats.

The whole row (but the `⋯`) is one button opening the commit, named for a screen reader in words, since the graph is hidden from it:

`Commit a1b2c3d: Add lane layout. Not pushed. Merge commit. Detached HEAD. Branches feature/graph, origin/feature/graph. Tag v1.2.`

— each sentence only when it applies.

### At `expanded`

The same list in the left column, the commit in the right ([git-ui.md](git-ui.md#at-expanded-two-columns)). The column has the width every segment shares, not one of History's own: the segmented control above it would move when the segment changes. The lane cap rises to 8 where the column has room for it ([Lane cap](#lane-cap)) — 8 lanes need a list about 340px wide (350 with a coarse pointer's `⋯`), so a column near the 320px smallest default draws fewer.

### The history header

One row, `min-h-[44px]`, above the list's scroll box rather than sticky inside it — it looks the same and stays put, and the virtual list's offsets start at its own top instead of under a header it would have to subtract:

| Part | Content | Press |
|---|---|---|
| Range | `Current + main ▾` — the range's label, truncated at the tail | Opens the range sheet ([Range](#range)) |
| Unpushed count | `↑3 unpushed` with a hollow-dot glyph before it, `text-th-text-secondary`; absent at zero, and absent in a repository without a remote | Not a button. The hollow glyph is the legend for the hollow dots below it |
| Search | `Search` icon, L5 | Opens the search row ([Search and file filter](#search-and-file-filter)) |

**The count is over the whole range, never over the pages loaded** ([list-paging-ui.md §2.1](list-paging-ui.md#21-a-count-is-over-everything-never-over-a-page)): the server returns it with the first page ([git.md](git.md#history) has the test). It is the same test as the hollow dots, and not the sync chip's — so it can differ from that chip's `↑2`. Two numbers for two questions; the header's is labelled `unpushed` so it is not read as the chip's.

## The graph

### Dots

Each dot is centred in its lane and in the row's height; lines are 2px.

| Commit | Shape | Size |
|---|---|---|
| Pushed (reached by a remote-tracking ref) | filled disc | 8px |
| Not pushed | ring, 2px stroke, nothing inside — lines stop at the ring's edge, so the row's own background (selected or not) shows through | 9px |
| Merge, pushed | outer ring 1.5px + filled inner disc | 12px / 5px |
| Merge, not pushed | outer ring 1.5px + inner ring 1.5px | 12px / 6px |

So **fill says pushed, a second ring says merge**, and the two never overload one another. In a repository without a remote, "pushed" means nothing: every dot is filled and the count is 0, so the header shows none — hollow everywhere would say "you have work to push" when there is nowhere to push it.

A commit's dot takes the colour of its **line** — the branch line it sits on, which keeps its lane, and so its colour, from its top commit to where it merges or ends; a lane freed and taken by a later line gives that line a colour of its own. Lines from a commit to its parents take the colour of the line they belong to; a merge's line to its second parent leaves the dot diagonally across one row, as in `git log --graph`, and a fork joins its parent the same way.

### Lane order

Lanes are assigned so the lines the user cares about are the ones that stay visible when the cap cuts the rest:

1. **Lane 0 is HEAD's first-parent line**, always — the current branch is the leftmost line on every screen, at every range. In `All branches`, where newer commits of other branches come above HEAD, lane 0 stays empty in those rows rather than lend itself out: HEAD's line is straight from the moment it starts.
2. Lane 1 is the default branch's first-parent line where it is a line of its own: listed in the range and not in HEAD's history. Where HEAD already contains it — a branch ahead of `main`, or one that merged it — it is part of lane 0's history and no lane is kept for it; a lane held for a line that never comes would be an empty column taking a quarter of a phone's four. The server names those refs in `default_line` ([git.md](git.md#history)), so a fork's branch that only shares the name claims nothing.
3. Every other line takes the lowest free lane as it starts (first fit), and frees it where it ends.

The layout is a pure function from the commits so far, plus the lanes open at the end of the previous page, to rows; the next page continues from that state rather than recomputing. It is covered by unit tests for fork, merge, octopus merge, a line continuing across a page boundary, and more lines than the cap.

### Lane cap

The number of lanes drawn is the smaller of two numbers:

| Limit | Value |
|---|---|
| Tier | 4 below `expanded`, 8 at it (`useIsExpanded`) |
| Width | `floor((listWidth − 8 − 8 − menu − 18 − 160) / 14)`, from the list's measured width, `menu` the `⋯`'s 36 or 44px — what fits beside a 160px text column and the `+N` slot |

…and at least 1. The width limit is what keeps the text from being squeezed: at 280px (the narrowest left column) it gives 3, on a 300px phone 4, at 400px 8.

The graph column is as wide as the **most lanes any loaded row uses**, capped — a straight history has a 14px graph, not 56px of empty gutter. It only grows, when a new page needs more lanes, and never narrows while the list is on screen: a page arriving at the bottom may move the text column right once; a column that also shrank would move under the reader's finger.

**More lines than the cap**: the lanes past it fold into one 18px slot at the right of the graph.

- A row with hidden lines shows `+N` there (`text-[10px]`, `text-th-text-muted`, `tabular-nums`) — `N` the lines running through that row unseen.
- A commit whose own lane is hidden draws its dot in that slot instead of the `+N`, its shape as ever; the row's accessible name adds `On a line not drawn.`
- A line between a visible lane and a hidden one is drawn as far as the slot's edge and stops; it does not reach a dot that is not there.
- The slot is not pressable. Widening the screen or narrowing the range ([Range](#range)) is how to see more lines; a horizontal scroll inside a vertical list would fight the thumb.

### Line colours

Eight colours, given to lines in the order the lines start, cycling past the eighth. The first four are the four most distinct hues, and lines 1 and 2 are HEAD's and the default branch's, so the lines on screen most of the time are the easiest to tell apart. One palette per mode, the same in every theme, as `th-graph-1` … `th-graph-8` (defined once under `:root` and once under `.dark`, beside the theme tokens in `index.css`):

| Token | Light | Dark |
|---|---|---|
| `th-graph-1` | `#1d4ed8` blue | `#60a5fa` |
| `th-graph-2` | `#c2410c` orange | `#fb923c` |
| `th-graph-3` | `#047857` green | `#34d399` |
| `th-graph-4` | `#a21caf` magenta | `#e879f9` |
| `th-graph-5` | `#0369a1` sky | `#38bdf8` |
| `th-graph-6` | `#b45309` amber | `#fbbf24` |
| `th-graph-7` | `#be123c` rose | `#fb7185` |
| `th-graph-8` | `#6d28d9` violet | `#a78bfa` |

**The floor is WCAG 1.4.11's 3:1 for graphical objects**, against each of `th-bg-primary`, `th-bg-secondary` and `th-bg-tertiary` (the selected row) of all five themes in that mode. Measured minimums:

| | Lowest colour | Its worst background | Ratio |
|---|---|---|---|
| Light | `#b45309` amber | aurora `th-bg-tertiary` `#ebe3f3` | 4.02 |
| Light, all eight | — | — | 4.02 – 5.69 |
| Dark | `#a78bfa` violet | mint `th-bg-tertiary` `#1a3328` | 4.98 |
| Dark, all eight | — | — | 4.98 – 8.13 |

Every colour clears 4:1 rather than just 3:1 today, a margin chosen so a 2px line still reads on a dim phone; the test holds the 3:1 floor, so a retint that keeps the margin is the retinter's to check. They are **not** text colours: three of the light ones fall under 4.5:1 on `th-bg-tertiary`, so nothing written uses them — ref chips carry the line's colour as a bar, not as their text. A unit test computes these ratios from `index.css`, so a theme added or retinted later cannot slip under the floor unnoticed.

The palette is not a theme's accent on purpose: a lane in `th-accent` would read as "selected", which the accent means elsewhere ([sidebar-ui.md](sidebar-ui.md)).

## Ref markers

A chip at the start of the row's second line: `text-xs` with `leading-4` and no vertical padding (the line's 16px), `rounded`, `bg-th-bg-tertiary`, `text-th-text-secondary`, truncated at the **head** like branch names everywhere in the workspace — max-width 6rem where the text column is under 240px, 7.5rem otherwise. A 2px bar on its left in the colour of the commit's line ties it to that line. What it names is told by its icon, not its colour:

| Ref | Chip |
|---|---|
| Detached HEAD | `HEAD`, outlined in `th-accent` — first, as "here" is, so a phone's one chip is never the others |
| The current branch | `GitBranch` + name, `text-th-text-primary`, `font-medium`, and a 1px `th-accent` outline — HEAD is "here". The server lists `HEAD` beside it; that ref folds into this chip and is not drawn twice |
| A local branch and a remote branch of the same name (`origin/feature/graph` beside `feature/graph`), on the same commit | one chip, the local name and a `Cloud` icon after it — "this branch, pushed as far as here". The current branch folds the same way |
| Another local branch | `GitBranch` + name |
| A remote-tracking branch alone | `Cloud` + `origin/name` |
| A tag | `Tag` + name |

The merged local-and-remote chip is what keeps the chip limit honest: a branch and its pushed copy on one commit is the common case and would otherwise spend both chips on one fact. It is matched by name, which needs nothing from the server and is right for every upstream set up by a plain push.

- **At most two chips, then `+N`**, in the order above. Where the text column is under 240px — a phone — at most one, then `+N`: two chips at 166px would leave no room for the hash.
- **`+N` is opened by opening the commit.** The whole row is one button, and the chips are inside it: a `+N` of its own would be a button inside a button, which HTML does not allow, and a 24px target beside a 52px row in which any miss opens the commit — far under the 44px floor ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)). So pressing the row is how to see all of them: the commit's page lists every ref, in full, at the top ([The commit](#the-commit)). Under a fine pointer `+N` carries a `title` with the hidden names, which hover may add and never needs ([responsive-ui.md](responsive-ui.md#progressive-disclosure-hover-reveal)); the row's accessible name already lists them all.
- **Every ref on a shown commit is drawn, whatever the range.** The range decides which commits are listed, not which names are told: a branch outside the range that points at a listed commit is still worth knowing — and a branch just created from the menu must appear on the row it was created at.

"Every line's top commit carries its branch" follows from the range: each line's tip *is* a ref in it (HEAD, its upstream, the default branch, a local branch). A line whose branch was deleted after merging starts at a commit with no ref and carries none; there is no name to give it.

## Range

The range picker is a `Sheet` titled `Show`, three `MenuRow`s with a check on the current one; choosing one closes the sheet and reloads the list from the top. What each range lists is `git.log`'s `scope` ([git.md](git.md#history)):

| Label | Description (second line) | URL |
|---|---|---|
| `Current + main` | This branch, its upstream and main | `scope` absent — the default, never written; `scope=current` accepted if typed |
| `All branches` | Every local branch and its upstream | `scope=all` |
| `Mainline only` | This branch's own line — a merge shows as one commit | `scope=mainline` |

`git.log`'s fourth scope, `branch` — one branch's own commits — is not a range here: it needs a branch beside it, and `scope=branch` in the URL would name none. The client asks for it with `useGitLog({ scope: "branch", branch })`, cached per branch, and `GitHistoryScope`, the picker's and the URL's type, leaves it out.

`main` in the label and description is the repository's actual default branch name (`Current + master`). Where HEAD *is* the default branch, the label still says so — `Current + main` on `main` — since that is still what is listed. Where the server names none ([git.md](git.md#history) says when), the range is HEAD and its upstream alone and says so: `Current branch`, `This branch and its upstream`.

Not a segmented control: three labels of this length do not fit beside the count and the search at 300px, and a second segmented control under the workspace's own would read as a second level of segments. Ordering is date order (children before parents, otherwise by date) in every range.

In `Mainline only` the graph is one line: merges are still double rings, with no line to a second parent that is not listed.

## Paging and states

Pages of 100 commits (the server allows up to 200), in a virtualised list — only the rows near the screen are mounted. The next page is asked for when the reader is within a screen's height of the end, and not while any read of the list is in flight: asking for a page would cancel a re-read under way and keep the new commits it was fetching off the screen.

| State | What is shown |
|---|---|
| First page loading | The existing centred spinner |
| First page failed | The existing `Failed to load history` and the reason |
| Next page loading | A last row, 52px: `Loading older commits…` with a spinner; open lines continue into it and fade out |
| Next page failed | That row becomes `Couldn't load older commits.` with the reason, and `Retry` (L4 text button). The rows above stay. `Retry` re-reads from the top rather than resending the cursor: a cursor whose commits were garbage-collected fails the same way every time ([git.md](git.md#history)), and the next page follows on its own while the reader is still near the end |
| Re-read failed | A re-read from the top (`git.changed`, `Retry`) that fails keeps the rows it had, which are no longer current: the last row says `Couldn't refresh history.` with the reason and `Retry`, and no next page is asked for until it succeeds |
| End of history | A last row, muted and centred: `Beginning of history` — the root commits' lines stop at their dots above it |
| End of a shallow clone | `Older history isn't in this clone` instead — the oldest commits' parents are missing, so their lines stop at their dots as well, rather than run into a row that is not there |
| Unborn HEAD | `No commits yet`, as today |

A `git.changed` while the list is on screen re-reads it from the top, as many rows as were loaded, and keeps the reader on the commit that was at the top of the screen when it is still listed. Rewritten history (an amend, a pull) moves rows; a list that kept its old pages would draw lines to commits that no longer exist.

## Search and file filter

### Entering them

- **Search commit messages**: the header's `Search` opens a pinned row under it — a field (`inputClass`, placeholder `Search commit messages`, `type="search"`) and `Cancel`. Matching is case-insensitive substring, not a pattern: a regex is not something to type on a phone. 300ms after the last keystroke the list re-reads. An empty or blank field is no search: the graph is back once the cleared field settles, or at once on `Cancel`. `Cancel` clears it and closes the row, and so does Escape in the field, which claims the key ([answering-ui.md](answering-ui.md#who-owns-escape)). A URL that arrives with `q` opens the row with the text in it, without focusing it — a link is not a request for the keyboard.
- **History of this file** — the file filter has no field of its own; it is reached from where a file already is:

  | From | Where | Entry |
  |---|---|---|
  | `FileView` (the Files tab's file page) | Bottom bar, after Download; absent where the project has no repository ([git-ui.md](git-ui.md#projects-without-a-repository)) | `History` icon, `History of this file` |
  | `CommitDiffView` | Bottom bar, beside `View this file at <hash>` | the same |
  | The Changes segment's file menu (`ChangedFileMenu`) | After `Open file`; absent for an untracked file, which has none | `History of this file` row |

  Each navigates (push) to `/git?segment=history&file=<path>` in the same worktree. Typing a path by hand is not offered: the Files tree and its search are how a file is found. The server filters a directory as readily as a file; a folder's `History of this folder` in the Files tree's menu is left for later.

Both live in the URL — `q=<text>` and `file=<path>` — beside `scope`, which they combine with: a search runs over the chosen range, and so does a file's history. The search text is written with **replace**, so Back does not walk back through what was typed; `History of this file` and the file chip's `✕` push, since each is a step the user took. Each is written onto whichever history layer is up: at `expanded` a commit open beside the list stays open while the list beside it changes, and a search that settles just after a row was pressed lands on that commit's page instead of replacing it with the list. On a phone that leaves the list's own entry, one step back in the browser's history, with the search as it was when the row was pressed; `Back to history` goes to the commit's, the newer one.

### What the list shows

With either on, **no graph**: rows keep their height and text, the graph column narrows to a single 14px lane holding each commit's dot and no lines, and a notice sits under the history header:

```
┌────────────────────────────────┐
│ Current + main ▾               │  header — no unpushed count
│ [ lane layout          ]Cancel │  search row
│ 📄 …/Git/HistorySection.tsx  ✕ │  file chip
│ ⓘ No graph while filtering —    │
│   matching commits aren't each │
│   other's parents, so lines    │
│   between them would be wrong. │
│ ●  Lay out lanes per page     ⋯│
│    c3d4e5f sijiaoh, 1d         │
```

- The file filter is a chip, `FileText` + the path truncated at the head + `✕` (L5, `Clear file filter`). `✕` drops `file` from the URL.
- **The notice** is one muted `text-xs` sentence, with an `Info` icon: `No graph while searching — matching commits aren't each other's parents, so lines between them would be wrong.` (`filtering` for the file filter, `searching and filtering` for both). It is the reason, not an error; it stays as long as the filter does.
- **Dots stay**, in the one lane and without lines, all in `th-text-muted` — no line, so no line colour: pushed, not pushed and merge are still worth knowing per commit. Ref chips stay.
- The unpushed count is not shown: it counts the range, not the matches.
- **No match**: `No commits match "lane layout"` (or `No commits changed HistorySection.tsx`, or with both `No commits changed HistorySection.tsx matching "lane layout"`), and under it, where the range is not `All branches`, a text button `Look in all branches`, which sets `scope=all`.
- Paging is the same; the end row reads `No more matches`.

## The commit

`CommitView`:

```
┌────────────────────────────────┐
│ ← Add lane layout              │  app header
├────────────────────────────────┤
│ Add lane layout                │  subject
│ Lines carry across pages …     │  body
│ [⑂ feature/graph☁] [Tag v1.2]  │  every ref, no +N
│ sijiaoh · Oct 27, 2026 14:02   │
│ a1b2c3d4e5f6…            [⧉]   │  full hash, copy
├────────────────────────────────┤
│ PARENTS (2)                    │
│ 1  9f8e7d6 Fix the sync chip  ›│  first parent — the line merged into
│ 2  4b5c6d7 Draw the +N slot   ›│  merged in
├────────────────────────────────┤
│ CHANGED FILES (3) vs parent 1  │
│ M  web/src/…/HistorySection.tsx│
├────────────────────────────────┤
│ a1b2c3d                      ⋯ │  bottom bar
└────────────────────────────────┘
```

- **Refs**: all of them, chips wrapping onto further lines; no `+N` here, there is room to say everything.
- **Hash**: the full hash in mono with a copy button.
- **Parents**: one `min-h-[44px]` row each — short hash, subject (the subject is a skeleton until known, then `git.show`'s answer for that parent) — opening that commit (push; Back returns here). A merge numbers them, `1` and `2` (and on for an octopus), with the accessible names `First parent` / `Merged-in parent 2`. A root commit says `No parents — this is the first commit.`
- **Files**: the commit's changed files. For a merge the heading says `vs parent 1` — the files are its diff against its first parent, which is what the merge brought into the line.
- **`⋯` in the bottom bar**, at its right end, beside the short hash already there: the same commit menu as the list row's, at the bottom where a thumb reaches it.
- **The refs are live.** The commit never changes but the refs on it do — a branch created here, a push, a fetch — so the page's answer is re-read with the rest of the workspace on `git.changed` and after every write.

At `expanded` all of this is in the right column; the commit's row stays lit in the left one, and the history query (`scope`, `q`, `file`) rides on the commit route so the list beside it is the list it was opened from ([URL](#url)).

## The commit menu

A `Sheet` titled with the short hash and subject, opened by a row's `⋯` or the commit's. Its rows:

| Row | Icon | Offered | Does |
|---|---|---|---|
| `Copy hash` | `Copy` | always | Copies the full hash; the row says `Copied` and the sheet closes a second later (`ChangedFileMenu`'s rule). A failed copy keeps the sheet; the full hash is under its title to copy by hand |
| `Amend this commit` | `PencilLine` | the commit is HEAD, and the status says no operation is in progress (not while it is still being read) | Closes the menu and opens `GitCommitSheet` with Amend on — the existing flow, its force-push warning included ([git-ui.md](git-ui.md#amend)) |
| `Create branch here…` | `GitBranchPlus` | always | Opens `NewBranchSheet` ([below](#create-branch-here)); paused, not absent, during an operation |
| `Ask AI to revert` | `Sparkles` | unless the commit is known **not** to be in HEAD's history | The prefill handoff ([below](#ask-ai-to-revert)) |

**What the absent rows mean.** Amend is **absent, not disabled**, on any commit but HEAD and on HEAD during a merge, rebase, cherry-pick or revert — the rule [git-conflict-ui.md](git-conflict-ui.md#what-stops-while-an-operation-is-in-progress) already set for this entry: a menu entry is not a target the user is on the way to, and the banner's pause sentence says why commits stopped. A commit known to be outside HEAD's history (another branch, in `All branches` or on `main` ahead of this branch) has no revert either: reverting on this branch what this branch never had is not an operation.

**HEAD is a ref, not row 0.** In `All branches` the first row may be another branch's newer commit; the HEAD row is the one carrying the `HEAD` ref, which `git.show` sends as well, so the commit's own page knows it too.

**"In HEAD's history" is known where the graph is drawn.** In date order every commit on a path from HEAD down to a commit comes before it, so the loaded rows hold the whole path and the client computes it over the loaded rows, read again as the list is. The row's menu is read from the list as it is when used, not as it was when opened: a commit made meanwhile moves HEAD. A filtered list has no such path, and the commit's own page does not ask the list — one reached by a link has none, and at `expanded` the page keeps to what it can know by itself, so its `⋯` may offer a revert the row's beside it does not; there the row is offered, and the prompt itself asks the agent to stop if the commit is not on the branch ([below](#ask-ai-to-revert)) — offering an entry that might be refused beats hiding one that might be right.

### Create branch here

`NewBranchSheet`, as for `New branch…` in Branches, with two differences:

- The base line reads `Branches from a1b2c3d · Add lane layout`.
- **It creates the branch and switches to it**, as `New branch…` does — one meaning for "new branch" anywhere in the workspace. The helper box says what that costs here: `Switches to the new branch at this commit. Uncommitted changes come with you unless they clash with it — then git refuses and nothing changes.`

On success the sheet closes onto where it was opened — the list, or the commit's page. The top bar's branch name changes, the list re-reads, and the commit becomes the HEAD row with the new branch's current-branch chip — the whole report, by the workspace's rule that success shows where the user is looking. A refusal stays in the sheet above the field, as today: a name git rejects, one that exists, or uncommitted changes in the way, with git's output listing the files.

During an operation it is paused like `New branch…`: the sheet's `paused` sentence, `Create` disabled ([git-conflict-ui.md](git-conflict-ui.md#what-stops-while-an-operation-is-in-progress)). The menu row stays — the sheet is where the reason is said.

### Ask AI to revert

`usePrefillComposer().prefill(text)`, called from `CommitActions`, which `HistorySection` and `CommitView` keep mounted — so the call outlives the menu row's press, as the hook's contract asks — into the current session or a new one, appended, never sent. The user lands in the chat with:

```
Revert commit a1b2c3d "Add lane layout" on feature/graph with git revert. If that commit is not part of feature/graph's history, say so and stop.
If it stops on conflicts, resolve them keeping the intent of the revert, then continue. If a conflict cannot be resolved safely, stop and explain it instead of guessing.
```

For a merge, a second sentence after the first: `It is a merge commit: revert it against its first parent (-m 1), unless the history shows that is wrong.` On a detached HEAD, `on feature/graph` becomes `on the detached HEAD`. If the branch is not known yet at the press (`git.branches` has not answered), it becomes `on the current branch` — not knowing is not being detached.

- **Built at the press** from the commit and branch then, pure and tested, as `describeOperationPrompt` is.
- **The UI never runs the revert** — a revert can stop mid-way on a conflict, and the agent is what finishes those ([git-conflict-ui.md](git-conflict-ui.md#resolve-with-agent)). If it does stop, the operation banner appears on its own.
- **Not gated** on the agent being busy or an operation in progress, as no handoff is ([agent-handoff-ui.md §1.5](agent-handoff-ui.md#15-the-targets-state-does-not-gate-the-handoff)).

## URL

The History segment's query, beside `segment=history` and `session`:

| Parameter | Values | Default |
|---|---|---|
| `scope` | `current`, `all`, `mainline` | `current`, written as absence |
| `q` | the message search text | none |
| `file` | a path relative to the repository root | none |

They are carried by the history layers — `commit`, `commit-diff`, `commit-file` — as well, unlike the segment, which a layer implies ([git-ui.md](git-ui.md#routes-segments-and-back)): the list beside a commit at `expanded`, and the list `Back to history` returns to, must be the one the commit was picked from. Switching segment drops them; coming back to History is the default range, unfiltered. Switching worktree keeps `scope` and drops `q` and `file` — a path may not exist over there.

## What the server answers

`git.log` — its ranges, cursor, search and path filter, the refs and unpushed mark on each commit, and what only the first page carries — are [git.md](git.md#history)'s, and `git.branch.create`'s start commit is its [Branches](git.md#branches)'; this file relies on them without restating them.

## Decisions not to lose

- **Shape carries the meaning, colour separates lines.** Fill = pushed, second ring = merge; colours clear 3:1 against every theme background (4:1 as chosen) and are never used for text.
- **The text column has a floor, the graph does not.** Lanes are capped by the tier (4 / 8) *and* by what fits beside 160px of text; the rest fold into `+N`.
- **Lane 0 is HEAD's line**, lane 1 the default branch's, so the cap never hides the lines that matter.
- **The graph column only grows** while the list is on screen.
- **No graph over a search or a file filter**, and the list says why in one line.
- **Refs are told over every listed commit whatever the range**; the range picks commits, not names.
- **The unpushed count is over the whole range**, from the server, and labelled so it is not read as the sync chip's.
- **Amend is HEAD-only and absent mid-operation**; HEAD is identified by ref, not by row position.
- **Create branch here creates and switches**, like `New branch…`, and is paused mid-operation like it.
- **Revert is the agent's**, through the prefill handoff, hidden only where the commit is known to be off HEAD's history.
- **Refs sit on the second line**; the subject keeps the first to itself. `+N` is read by opening the commit, not pressed on its own.
- **The history query rides on the history layers**, so the two columns agree and Back restores the list.
