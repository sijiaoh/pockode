# File

Users browse directories, search, and view/edit files in the workspace. Path traversal is validated on every request.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──filesystem──▶ Workspace
                              │
                         contents.go (validate, read, write, delete)
                         search/    (list candidates, match names/content)
```

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_file.go` | `file.get`, `file.write`, `file.delete`, `file.search` |
| File operations | `server/contents/contents.go` | Path validation, read, write (upsert), delete |
| Search | `server/search/` | Candidate listing (`list.go`), content grep (`scan.go`) |
| Frontend components | `web/src/components/Files/` | FileTree, FileEditor, FileView, FileTreeNode, FileSearchBar, FileSearchResults |
| Search UI state | `web/src/hooks/useFileSearch.ts`, `web/src/lib/filesSearchStore.ts` | Debounce + query cache, persisted options |
| RPC actions | `web/src/lib/rpc/file.ts` | `getFile`, `writeFile`, `deleteFile`, `searchFiles` |

## Operations

**`file.get`** — Read file or list directory.
- Directory → returns `Entry[]` (name, type, path)
- Text file → returns content as UTF-8
- Binary file → returns content as base64

**`file.write`** — Write file content to disk with upsert semantics.
- Creates the file if it doesn't exist
- Creates parent directories automatically
- Updates existing files

**`file.delete`** — Remove a file or directory from disk.
- Directories are deleted recursively (all contents removed)
- Returns error if path doesn't exist

**`file.search`** — Find files by name or content.

Params:

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `query` | string | — | Literal substring (not a regex); required, max 1024 bytes |
| `mode` | `"name"` \| `"content"` | `"name"` | Match relative path, or file content |
| `path` | string | `""` | Limit to a subdirectory of the work directory |
| `respect_gitignore` | bool | `true` | Omit ignored files (no effect outside a git repo) |
| `case_sensitive` | bool | `false` | — |
| `max_results` | int | `100` | Max files returned, hard-capped at 500 |

Result: `{ matches: FileMatch[], truncated: boolean }`, where `FileMatch` is
`{ path, name, lines? }` and each line is `{ number, text, ranges }`.
`number` is 1-based; `ranges` are `{ start, end }` **byte** offsets into the
UTF-8 encoding of `text` (end-exclusive). `lines` is present in content mode only.

`ranges` is offered as an optimization, not a guarantee. A file that is not
valid UTF-8 can still be scanned — the binary check only inspects the first 512
bytes — and JSON encoding substitutes U+FFFD for each invalid byte, so on such a
line the offsets no longer index the `text` that arrives. Recomputing the match
positions client-side, as the web UI does, sidesteps this entirely.

`truncated` reports that limits or the timeout cut the search short, so more
matches may exist.

Bad input — a blank or oversized `query`, an unknown `mode`, a `path` that
escapes the work directory or doesn't exist — is rejected with `InvalidParams`.
A missing `path` is reported the same way whichever listing strategy runs, so
the error doesn't depend on whether the repository is a git one.

## Search behavior

Candidate files come from `git ls-files -z --cached --others --exclude-standard`
when `respect_gitignore` is set — git is the only implementation guaranteed to
agree with the repository's own ignore rules (global excludes, nested
`.gitignore`, `.git/info/exclude`). Otherwise (or when git can't answer) the
directory is walked, always skipping `.git` — both the directory and the
gitdir-pointer *file* that a linked worktree or submodule has in its place,
which is the shape Pockode itself runs in. The `-z` is not optional: without
it git escapes non-ASCII and whitespace paths, which then no longer name the
file they came from — see [git.md](git.md#path-encoding).

Name-mode results rank base-name hits above path-only hits, then shorter paths
first. Listed entries that are not readable regular files (submodule gitlinks,
tracked-but-deleted files) are dropped, so every result can actually be opened.

Case-insensitive matching folds **ASCII only** when the query is ASCII, so `"s"`
does not match `"ſ"`. This is deliberate: Go's regexp loses its literal fast path
under `(?i)` and runs ~150x slower, and case-insensitive is the default mode. A
query containing non-ASCII characters uses the regexp instead, keeping its case
folding correct (`"ÉCOLE"` finds `"école"`).

Limits keep large repositories responsive, but they are not all reported the same way:

| Limit | Value | On hit |
|-------|-------|--------|
| Timeout | 10s | Partial results, `truncated` |
| Files listed | 50,000 | `truncated` |
| Files returned | `max_results` | `truncated` |
| Matching lines per file | 20 | `truncated` |
| File size scanned | 1 MiB | File skipped, unreported |
| Match ranges per line | 20 | Further matches on that line unreported |
| Returned line length | 500 bytes | Clipped around the first match |

`truncated` therefore means "results were cut off", not "everything you can see
is complete": a file too large to scan, a clipped line, or matches past the
per-line cap leave no trace in the response.

Binary files (null byte in the first 512 bytes, per `contents.IsBinary`) are
skipped in content mode, likewise without setting `truncated`.

## Search UI

The search box is always present at the top of the files tab. Once the input
holds non-blank text the tree and the results swap places; both stay mounted, so
clearing the query restores the tree's expansion state, scroll position and FS
watch subscriptions untouched. Search mode follows the input alone and never
focus — tapping an option chip blurs the input, which would otherwise flash the
tree back on screen. The box and the result count sit outside the scrolling
list, so they stay visible above the mobile keyboard.

Two chips, shown only while a search is running, expose the options the UI
varies; both persist in `localStorage`:

| Chip | Key | Default | Effect |
|------|-----|---------|--------|
| `.gitignore` | `files-search-respect-gitignore` | on | Sets `respect_gitignore` |
| `File contents` | `files-search-content` | off | Switches `mode` to `content` |

Since respecting `.gitignore` defaults to **on**, an absent entry has to read as
true and only an explicit `"false"` turns it off. `path` and `case_sensitive`
are never sent; `max_results` is pinned to 100 by the client rather than left to
the server default, so how long the rendered list can grow stays a decision of
the code that renders it.

Keyboard and focus are tuned for a phone. Enter only blurs the input, since
results are already live. Escape clears the query — but only when there is
something to clear, so an empty box lets the key through to the sidebar's own
close handler instead of trapping the user in a panel that won't close. Chips
suppress `mousedown` so toggling one keeps focus and the keyboard up, and
picking a result blurs the input first so the keyboard isn't left hanging over
the sidebar's closing animation.

Queries are debounced 300ms and need at least 1 character in name mode, 2 in
content mode. Previous results stay on screen while a new query loads — the
icon in the search box turns into a spinner rather than the list going blank
between keystrokes — but only while the options are unchanged, since name-mode
results have no place in the content-mode layout. The cache holds each result
next to the query that produced it, so highlighting and snippet anchoring keep
describing the rows actually on screen instead of drifting to the query still in
flight — a content search can take seconds. Requests are not retried:
sitting through three attempts before learning a search failed is worse than
seeing the error and a `Retry` button. Nothing is searched while the tab is
hidden, so an invalidation can't quietly re-run a content scan nobody is
looking at.

Name mode renders a flat list of files. Content mode groups by file and shows at
most 3 matching lines each, plus a `+N more` hint counting the lines the server
returned but the list withholds — not every remaining match in the file.
Snippets drop leading indentation and re-anchor on the first match so it stays
visible in a ~250px sidebar row. An empty result offers the two escape hatches
that usually explain it — stop respecting `.gitignore`, or search contents
instead of names — so a dead end is one tap from a wider search rather than a
retyped query.

Matches are highlighted client-side as literal case-insensitive substrings
rather than from the server's `ranges`, which are UTF-8 byte offsets and an easy
way to cut a character in half on the way to JS string indexes. Where
lowercasing changes a string's length (`"İ".toLowerCase()` is two code units)
the text is rendered unhighlighted, because indexes taken from the lowercased
copy no longer line up with the original.

Truncation appends `· more results exist` to the usual counts rather than naming
a fixed limit or replacing them: the server also sets `truncated` on timeout,
where far fewer files came back than were asked for, and a single file over the
per-file line cap flags an otherwise complete result — which is most content
searches, so the counts have to survive the warning. They read as a floor either
way. A truncated search with *no* results gets its own
message instead of the usual "no matches" — the server never established that
nothing matches, only that it ran out of budget — and the escape hatches are
withheld there, since widening a scan that already hit its limits makes it
worse.

Results are cached by react-query under the `file-search` key, registered in
`WORKTREE_DEPENDENT_QUERY_KEYS` so a worktree switch discards them — see
[code/frontend-state.md](code/frontend-state.md#server-cache-vs-store).
Refreshing the files tab re-runs the current search instead of clearing it; only
the tree carries pull-to-refresh, since the gesture would fight with typing.

Known limits: results do not follow FS watch notifications, because rescanning
the repository on every file change is expensive and would reshuffle the list
while it is being read; selecting a match opens the file at the top, as there is
no line anchor to jump to yet; and on iOS the keyboard covers the lower part of
the list, which is left as is — the pinned header keeps the search usable, and
`visualViewport` handling costs more than it returns here.

## Security

`ValidatePath(workDir, path)` prevents directory traversal by resolving the absolute path and checking it stays within the workspace root. It rejects:
- Absolute paths
- `../` traversal

An empty path passes: it names the work directory itself, which is what the
file tree lists and what an unscoped search covers. Rejecting it is the job of
the operations for which it makes no sense — `WriteFile` and `Delete` refuse it
on their own, so an empty path can never become an operation on the workspace
root.

Search applies the same validation to its `path` scope, and never follows
symlinks (checked with `Lstat`) — following one could return content from
outside the workspace.
