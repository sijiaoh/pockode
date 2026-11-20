# Symlinks

How Pockode shows, opens and writes through symbolic links. This document is the
single source: every surface below takes its symlink behaviour from here, and the
server rule in [The boundary](#the-boundary) is what the RPCs enforce.

The short version:

- **A link that stays in the project is followed**, and marked as a link wherever
  it is listed. A file link opens the target's content and a directory link expands
  like a folder.
- **A link that cannot be followed** (broken, a loop, or leading out of the
  project) is still listed and can still be opened. Opening it shows a *link page*
  with the path it points at. That page is an answer, not an error.
- **Nothing reads, writes, creates or deletes outside the work directory through a
  link**, on any route.
- **One file failing never takes the app down.** The failure is shown in the pane
  it happened in, and everything else stays usable.

## What similar products do

| Product | Listing | Opening | Outside the root |
|---|---|---|---|
| VS Code / code-server | Followed. A link arrow decoration and a "Symbolic link" tooltip mark it | File link: target content, edits write through. Dir link: expands in place | Followed. A desktop editor has no boundary, and code-server inherits that (it ships a terminal anyway) |
| JetBrains IDEs | Followed, with an arrow overlay on the icon | Same as VS Code. Recursive links are detected and not descended | Followed |
| GitHub / GitLab / Gitea | A link icon. A dir link is not expandable | A page saying "Symbolic link" with the target path, linked to the target when the target is in the repository | **Never followed.** Only the target path text is shown |
| Web file managers (self-hosted browsers, notebook servers) | Usually followed | Usually followed | The recurring source of path-escape vulnerabilities in this category, fixed after the fact by refusing to leave the root |

Pockode sits between the two groups. It is a live editor like VS Code, so links
inside the project have to work (pnpm links `packages/shared` into
`web/node_modules`, and this repository itself has `.claude/skills ->
../.agent-skills`). But it is also reached remotely, through the relay, from
phones, and by shareable raw capabilities, like GitHub. So it takes VS Code's
behaviour inside the project and GitHub's at the edge: **follow inside, show the
path text at the edge, never the content.**

## Link states

The server classifies every symlink it lists or is asked to open. The client never
works this out itself.

| `state` | Meaning | `type` in listings | Opening it |
|---|---|---|---|
| `ok` | Resolves to a regular file or a directory inside the work directory | `file` or `dir`, the target's | The target's content, or the folder expands |
| `cycle` | A directory link that would lead back into a directory the listed path has already passed through ([rule below](#cycles)). Only a listing reports it; `file.get` on the link's own path serves it as `ok` | `dir` | Not expanded in place. Opening it reveals the target in the tree, under its real path |
| `broken` | The target does not exist (inside the project) | `link` | Link page: "Broken link" |
| `loop` | Resolution never ends (`a -> b`, `b -> a`; `ELOOP`) | `link` | Link page: "Link loop" |
| `outside` | Resolution leaves the work directory, at any step | `link` | Link page: "Link outside the project" |
| `unsupported` | Resolves inside the project, but to something that is neither a file nor a directory (a fifo, a device) | `link` | Link page: "Not a file or folder" |

<a id="why-outside-says-nothing-more"></a>Why `outside` is reported without anything further: the server decides it from
where resolution *leads*, before it looks anything up there. So the answer is the
same whether the outside target exists, is a file, or is a directory. Reporting
`broken` for a missing outside target would turn the listing into a probe of which
paths exist on the host.

### Cycles

Following a cycle in place lets a path nest forever (`self/self/self/…`). Every
level is a new request, a new watch and a new tree row, and none of them shows
anything new. JetBrains also refuses to descend into recursive links.

The rule is decided per listing, because a link's effect depends on the path it is
reached through. When the server lists directory `P`, it already resolves each
prefix of `P` (`""`, `a`, `a/l1`, …) to a real project-relative directory on the
way. A directory link in that listing is `cycle` when its resolved target **is,
or contains, any of those real directories**. Some cases:

- `self -> .` listed at `""`: the target `""` contains everything, so it is `cycle`.
- `a/b/up -> ..`: the target `a` contains the prefix `a/b`, so it is `cycle`.
- Mutual links, `a/l1 -> ../b` and `b/l2 -> ../a`: at `a`, `l1` (to `b`) is `ok`.
  At `a/l1`, whose real prefixes are `""`, `a` and `b`, `l2` (to `a`) is `cycle`.
  Checking only the link's own ancestors would miss this one.
- `web/node_modules/@pockode/shared -> ../../../packages/shared`: `packages/shared`
  contains no prefix of `web/node_modules/@pockode`, so it is `ok`.

A path that already runs through a cycle (typed into the URL) is still served,
because it is finite. The tree just never offers one.

## Wire format

`contents.Entry` (and `web/src/types/contents.ts`) carries an optional `link`,
set on every symlink and absent on everything else:

```jsonc
{
  "name": "skills",
  "type": "dir",                 // "file" | "dir" | "link"
  "path": ".claude/skills",
  "link": {
    "target": "../.agent-skills", // readlink, verbatim
    "state": "ok",                // see Link states
    "resolved": ".agent-skills"   // project-relative real path; only for ok / cycle
  }
}
```

- `type: "link"` is the type of a link that cannot be followed. It is a type of
  its own rather than `file` with a flag, so a client that does not know it (a
  PWA still running an older build) still has a row to draw and never expands
  it.
- `target` is the link's own content, the same string `git diff` and
  `git.show.file` already send for it. It is project data, not host information,
  so it is shown even for `outside`. `resolved` never names anything outside.
- A **file result** for a followed link (`file.get` on a file link) carries the
  same `link` object beside the usual fields, so the viewer can mark it.
- A **link result** is what `file.get` returns for a link that cannot be
  followed: `{ type: "link", link: <Entry> }`, the link's own entry (`type:
  "link"`, with `link` set) and no content. The client reads it as that entry
  (`LinkResult`, `isLinkResult`). It is a normal result, not an error. A broken
  link is an ordinary thing to find in a checkout, and the client renders a page
  for it, not a failure.
- A directory result stays a bare `Entry[]`. A dir link opened by URL arrives
  that way and is handled by the viewer ([below](#viewer)).
- A **name search match** for a link (`FileMatch`) carries the same `link`, and
  beside it the `type` a listing would give the entry, since a path alone cannot
  say whether a followed link is a file or a folder.

## The boundary

**Rule:** a request may follow symlinks only to places inside its own work
directory, which is the worktree the request names. This applies to every
symlink, at every step: the final element and every directory on the way. Every
route resolves its path with the one walk: `contents.Resolve` for a path,
`contents.OpenDirWithin` for a directory to work in.

### How the check is made

1. `ValidatePath` first (lexical: no absolute paths, no `..`).
2. **Walk the path, following each link by hand.** Every component, and every
   link target, is taken one component at a time with `Lstat`/`Readlink`. The
   walk stops as soon as it would leave the work directory (`outside`), and gives
   up after 40 hops (`loop`; a fixed bound of the same order as the kernels' own,
   40 on Linux and 32 on macOS). It never looks anything up past the boundary,
   which is what keeps [`outside`](#why-outside-says-nothing-more) from saying whether the target
   exists. A link on the last component is classified rather than followed, and
   the route decides what to do with it (below). A `..` in a link target,
   absolute or relative, is applied where the OS applies it, so what the walk
   serves through a link is what opening the link reads:
   - **Unix:** after the links before it are followed, as the kernel does. With
     `l` a link out, `/w/l/../secret` and `l/../secret` are `outside`, not the
     project's own `secret`.
   - **Windows:** to the target's text, before any link in it is followed, as
     Windows does: an absolute target is normalized when the link is created
     (`Readlink` already reads back `C:\w\secret`), and a relative one is
     normalized against the link's directory when it is followed. So
     `C:\w\l\..\secret` and `l\..\secret` are the project's own `secret`, `ok`,
     wherever `l` leads. A leading `..` still applies to the link's real
     directory.

   Either way the walk never reaches past the work directory to find out.
3. **Then act on what the walk found through the work directory's `os.Root`.**
   The walk's result is a path with no link left in it, but a link can be
   swapped in after the walk, and the root refuses to follow one out. What is
   read or written (`file.get`, `file.write`, the download, and through
   `OpenDirWithin` `file.move`, the upload and the folder routes) is also checked where the opened handle is, with `ResolvedName` (path resolution
   plus `os.SameFile` on Unix, the handle's final path on Windows), never from
   the string alone; on Windows a string check would also miss junctions, which
   `filepath.EvalSymlinks` does not resolve. `file.create`, `file.delete` and
   `file.rename` go through the root without that check.
4. Absolute link targets are allowed when they lead inside. That is why the
   check is not `os.Root` alone, which refuses every absolute link, and with it
   every Windows junction (pnpm's).
5. "Inside" is matched against the work directory both as it was given and as
   `EvalSymlinks` resolves it. An absolute target may be spelled through
   `/private/var` while the work directory was opened as `/var/…` (macOS), or
   the other way round. That is the same place, and it must not count as
   `outside`.

### Per route

| Route | Link on the final element | Link on a directory on the way |
|---|---|---|
| `file.get` (dir listing) | Each entry is classified as above. Entries are not followed out | Followed only inside, otherwise refused |
| `file.get` (path) | `ok`: the target's content or listing. Otherwise a link result | Followed only inside, otherwise refused (`InvalidParams`) |
| `file.write` | `ok` file: the write goes to the target and the link stays a link. Any other link is refused (`"<path>" is a broken link`, …). The file is truncated only once the opened handle is known to be inside | Followed only inside. Missing parents are created one at a time through the root, never through a link out |
| `file.create` | A name held by a link is `already exists` ([why](file.md#security)) | As `file.write` |
| `file.delete` | **Removes the link itself**, never the target, so broken links are deletable ([why](file.md#security)) | Followed only inside. Deleting `odir/secret.txt` through a link out is refused |
| `file.rename`, `file.move` | Act on the link itself; a link on the destination name blocks the rename | Followed only inside (`move`: both directories, through `OpenDirWithin`) |
| `GET /api/files/download` | `ok` file link: the target. A link that cannot be followed: `400 invalid_path`. A link to a folder: `400 not_a_file`, as for any folder | Followed only inside |
| `POST /api/files/upload` | `409` for a link, even with `overwrite` ([why](file.md#security)) | Followed only inside (`OpenDirWithin`); each part is written through the destination's opened root |
| `fs.watch` subscribe | The watched path must resolve inside. Otherwise refused like `file.get`, so a client cannot learn when files outside change | Followed only inside |
| folder upload / download | A link inside the folder is refused by a merge, and archived as a link by a download ([file.md](file.md#folder-archive)) | Followed only inside (`OpenDirWithin`) |
| `/api/raw` | `os.Root` alone: refuses every link out, and also every absolute link, even one inside ([why](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)) | As the last component |
| search | See [Search](#search) | — |

The refusal is `ErrInvalidPath` (`InvalidParams` over RPC, `400 invalid_path`
over HTTP). On the RPC routes and the file download its message is fixed:
`"<path>" leads outside the project`, or `"<path>" is a link loop` for a loop on
the way. The upload and the folder routes, which open a directory to work in,
say `<what> is outside the work directory or could not be resolved within it:
<path>` instead. **No host path ever reaches the client**, on any of these
routes, `fs.watch` subscribe and `file.search` included: the client gets the
project-relative path and what went wrong (`contents.PublicMessage`), and the
OS error, which is where host paths are, is kept out of the reply and written to
the log (except by `fs.watch` subscribe, which drops a failed resolve's cause).

### Why refuse rather than allow

Following links out was never a design; it was what `os.Stat` and `os.WriteFile`
do. Before this rule, `file.get`, `file.write`, `file.create`, `file.delete` and
the download read, overwrote, created and deleted outside the project through a
link, while `/api/raw`, `file.move` and the folder transfers refused. It was
decided in favour of the boundary:

- **One rule everywhere is the only version that can be reviewed.** With some
  routes refusing and others following, the same outside file could be viewed
  but not downloaded.
- **The server is reached by more than its owner's terminal.** Through a relay
  connection or a stolen session, a malicious repository that commits `notes ->
  ../../.ssh/id_ed25519` (a clone is enough: git writes the link) would otherwise
  let anyone read, overwrite or delete what the server's user can.
- **The cost is small and stays visible.** The links that matter in practice
  (workspaces, monorepo tooling, the skills links) resolve inside. A link out is
  still listed, with its target text, so the user knows what it is. Reading
  outside the project remains possible the deliberate way: by asking the agent,
  which runs as the user under its own permission model.

The link page for `outside` says that last point in one line, so the refusal
explains itself rather than looking like a bug.

## Surfaces

### File tree

- Every followed link row draws its target type's link icon (`FileSymlink` for a
  file link, `FolderSymlink` for a dir link). The tooltip (desktop) and the
  row's accessible name include `skills, link to ../.agent-skills`
  (`linkDescription`, which adds the state for a link that cannot be followed).
- `ok` dir link: expands in place. Children are listed under the link's path
  (`.claude/skills/foo.md`), since that is the path the user and the agent both
  use. The `resolved` path is only offered as "Reveal target".
- `cycle`: the `FolderSymlink` icon and no chevron. Tapping it reveals
  `resolved` in the tree and scrolls to it.
- `broken` / `loop` / `outside` / `unsupported` (`type: "link"`): a generic link
  icon. The name is drawn in the muted text colour, with a trailing status glyph,
  one per state (broken: a warning triangle; outside: an arrow leaving a box;
  loop: a repeat arrow; unsupported: a slashed circle). It is never expandable,
  and tapping it opens the link page.
- The entry menu: links get "Reveal target" (`ok` / `cycle`) and "Copy link
  target", whose description is the target text. Rename, move and delete act on
  the link, and the delete confirmation is titled "Delete link?" and says that
  what it points to is not affected (`deleteLinkMessage` in
  `web/src/lib/symlink.ts`, shared with the viewer's Delete link).
- Drag and drop: a link row drags as the link (a move moves the link). A dir link
  is a drop target only when `ok`; a drop on a `cycle` row lands in its parent.
- The rules for where a row opens (`opensAt`: a `cycle` opens at `resolved`,
  anything else at its own path) and whether it expands in place (`opensInPlace`)
  live in `web/src/lib/symlink.ts`. The tree, the folder listing and search all
  use them; the icons and status glyphs are `Files/EntryIcon.tsx`.

### Viewer

- **File link, `ok`:** the normal viewer, with one line above the content:
  `↪ Link to ../real.txt` and an `Open target` text button that navigates to
  `resolved`. Editing writes through to the target. That is what every editor
  does, and the agent would do the same.
- **Link page** (link result): an empty-state panel in the viewer pane, with
  - a title per state: "Broken link", "Link loop", "Link outside the project",
    "Not a file or folder";
  - the target text in monospace, selectable and copyable;
  - one line of explanation. For `outside`: "Pockode only opens files inside the
    project. Ask the agent if you need what it points to.";
  - the actions that still apply: `Delete link`, `Copy target`.
- **Directory result** (a dir link or any folder opened by URL): instead of a
  blank pane, the folder's entries as a plain list, drawn with the tree's icons
  and link marks (`EntryIcon`). A row opens in the viewer, a folder as another
  listing. There is no separate `Show in tree`: the folder is the open path, so
  the tree already expands to it, highlights it and scrolls it into view, the
  way it does for any path opened from outside it. The type guard decides this
  explicitly: a result that is neither `FileContent` nor a link result is a
  directory, never "nothing".
- A link page is not watched: `fs.watch` refuses a link that cannot be
  followed, as `file.get` does, and a "Not updating" line over an answer would
  read as a failure. The listing around it still watches the link itself.

### Search

- **Name search** lists link entries by their own name (`.claude/skills` is
  findable), with the tree's icon and glyph, opening at the same place
  (`opensAt`). A result never expands, so a dir link opens in the viewer as a
  folder listing. It does not descend into dir links.
- The search **scope** (`path`) is resolved like any route's: a scope through a
  link out is refused, and one through a link inside is searched at its real
  path, where git lists those files too.
- **Content search** still never reads through a link. A target inside the
  project is already searched at its real path, so following would only duplicate
  results, and a target outside must not be read at all. This is ripgrep's
  default. VS Code's opposite default makes sense only without a boundary.
- Every listed path is read and looked up through the work directory's
  `os.Root`, never by host path. git's index keeps `a/b.txt` after `a` is
  replaced by a link out, and a plain open would follow `a` and read, and name,
  the file outside. These rules hold per listed path, whichever listing it came
  from — git's tracked files, its untracked ones ([file.md](file.md#search-behavior)
  lists them in that order), or the walk — so a committed link out is listed as
  `outside` and never read, like an untracked one.
- A search that a newer one has stopped is answered `-32015`, even when its
  scope was refused: its client has already moved on ([file.md](file.md#operations)).

### Git panel (changes, staged, commit diffs)

- A diff is already the link itself (the target path as content,
  [git.md](git.md#diffs)), and that stays. When the patch header has mode
  `120000`, a line above the diff shows a "Symlink" chip (`symlinkChange` in
  `web/src/lib/drawablePatch.ts`). It sits above the diff rather than in the
  page header so that every diff page — changes, staged, commit — gets it from
  the one component they share. An untracked link gets it too
  ([git.md](git.md#diffs)), whether its diff is read on its own or by a
  GitDiffWatcher poll that shares one status between its subscriptions
  ([git.md](git.md#real-time-updates)): both go through the same diff code.
- **Typechange (`T`)**: git emits two file sections for one path, a deletion and
  a creation, and the diff parser reads only one; handed both, it threw while
  rendering and took the app down. The client turns
  them into one file's patch where the data arrives: the old content diffed
  against the new, a link's content being its target (`asOneFileDiff` in
  `web/src/lib/drawablePatch.ts`). Above it, beside the chip, a one-line
  summary read off the patch's mode lines (which the rebuilt patch keeps):
  `Type changed: file → symlink` (or `symlink → file`). The mode lines rather
  than the status letter, because a commit's diff has no status to read.
  Staging it is whole-file only: the server sends no hunk IDs for a `T` entry
  ([git.md](git.md#staging-hunks)).
- `git.show.file` (commit file view) keeps returning the link as plain text, a
  gap [git.md](git.md#historical-file-contents) already accepts. It cannot crash
  and cannot leave the repository, and marking it would need the mode, which that
  result does not carry. Out of scope (see below).

### Chat

- **File paths and links** in messages, tool calls and the turn's changes open the
  Files viewer at that path, so they get exactly the viewer behaviour above. A
  path the agent wrote through a link (`node_modules/@pockode/shared/x.ts`) opens
  as written.
- **File blocks / attachments** (`useAttachmentContent`): its query must never
  read a cache entry as `FileContent` without checking. It shares the
  `["contents", path]` key with `useContents`, so it keeps the shared key and
  stores the entry in `useContents`' shape (`readContents`), then narrows it with
  the viewer's type guards (`isFileContent`, `isLinkResult`). A dir link or link
  result there renders as a chip ("Folder" or "Link", `NotAFileChip`) that opens
  in Files. It is not rendered as file content.
- **Proposed changes** (`ProposedChange`): every patch, Codex's and Claude's Edit
  / MultiEdit alike, reaches `DiffViewer` through `drawablePatch`. A patch it
  cannot draw (no hunk, or more than one file section) is described in words
  instead of being handed to the parser; an edit that changes nothing is left
  out, and a card whose edits all change nothing says "No changes".
- **Markdown images and HTML pages** load through `/api/raw`, which already
  refuses links out (and, being `os.Root`, also absolute links inside). That
  stricter case is accepted. The image shows its usual load-failure chip.

### Live updates (fs watch)

- Watching a directory must not fail because of what one entry in it points to.
  On kqueue (macOS, the BSDs) fsnotify opens every entry of a watched directory,
  which follows links: since v1.10 it skips a broken one, but a loop still fails
  the whole watch, and on every later change it stops re-reading the directory at
  the first entry it cannot open, so names created after a broken link in sort
  order go unreported. So on kqueue every watched directory is also polled by its
  modification time (once a second), and a directory fsnotify refuses is watched
  by polling alone, on any platform. A file still has to be watchable. What the
  poll sees goes through the same per-subscription debounce as fsnotify's events
  ([subscription-system.md](code/subscription-system.md#why-fswatcher-debounces-per-subscription-with-a-cap)),
  so when both see one change inside that window it is one `fs.changed`.
- A watch that does fail is not silent. `useFSWatch` returns the error, and the
  view that stopped following the files says so with `Not updating: <message>`
  and `Retry` (`Files/WatchFailedNotice.tsx`): the tree's root, each expanded
  folder, the viewer, and the conflict view.

## Errors stay local

A typechange diff showed that one render-time throw could take down the whole
app, and keep it down across reloads, because the route was in the URL. The rule
is the same at every level: **a failure is shown where it happened, says what
failed in words a developer can act on, and offers a way forward. Everything
around it keeps working.**

Inputs are made safe where they arrive (`drawablePatch`, `asOneFileDiff`), and
the boundaries are for whatever third-party code still chokes on. They are
nested, so a throw costs the smallest thing that can stand in for it:

| Level | Boundary | What the user sees |
|---|---|---|
| Pane | `ContentErrorBoundary` (`web/src/components/ui/`) around every `DiffViewer`, `FileBody`, `FileContentDisplay`, and each chat message part | That view only: "Couldn't show `a.txt`", the message, `Retry` (and `Show raw` for a diff, which shows the plain patch). The tree, the chat and the other diffs keep working |
| Page | `PageErrorBoundary` (`web/src/components/Layout/`) around every page opened over the chat | The page's place in the frame: a page header with the way back to the chat, and the same card. The sidebar, the tree and the chat stay |
| App | The router's `defaultErrorComponent` (`AppCrashScreen`, on the shared `CrashScreen`) | A whole-page screen in place of the app: "This page couldn't be shown", the message, `Go back` and `Go to project` |
| Load | Query error (not a throw) | Inline "Failed to load" (or "File not found") with the message, sanitised by the server (no host path). Reads are retried automatically first (`useContents`), except after a timeout or a not-found. After that the tree's root and folders offer `Retry`, and the viewer only says it failed |

- **The app level cannot be drawn inside the app frame.** The frame (`AppShell`)
  is the root route, so a throw the router catches has already taken it down.
  That is why the page level exists, and why the app screen carries its own way
  out: `Go to project` is a full load of `/` or `/w/<worktree>/`, worked out from
  the URL alone (`startPathOf`). It works after a reload of the broken URL, and in
  an installed PWA with no address bar, where Back may lead nowhere.
- **A boundary resets when what it shows changes**: a pane on what it draws
  (the file as loaded, so a file changed since it failed gets another try; the
  patch; the content; the message part), a diff also on its file name; a page on
  the page and the worktree (the same path in another worktree is another file). The reset happens during render, so the old
  error is never drawn for the new content. `Retry` draws the same content again.
- **The console has the stack.** React logs every caught error with its
  component stack (`onCaughtError`); the boundaries add no logging of their own.
- **A diff highlighter or grammar that fails to load is not an error** and never
  reaches the pane boundary: the diff is drawn plain
  ([git-changes-ui.md](git-changes-ui.md), *Syntax colours*), so it cannot leave
  "Loading..." up for good.
- **`web-cluster`** has no diff or file views; its root is one `ErrorBoundary`
  with `CrashScreen` and `Reload`, since it has no URL state to escape.
- A link page is not an error and never goes through these boundaries. Neither do
  `broken`, `outside` and the other states: they are answers.

## Out of scope

- Creating symlinks from the UI.
- Marking a link in the commit file view, or showing its target as it was in that
  commit.
- `web-cluster` symlink handling: it lists no files and has no `DiffViewer`.
