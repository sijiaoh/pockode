# File

Users browse directories, search, view/edit files, and transfer whole files in
and out of the workspace. Path traversal is validated on every request.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──filesystem──▶ Workspace
           ──HTTP──────▶     │
                         contents.go    (validate, read, write, delete)
                         search/        (list candidates, match names/content)
                         filetransfer/  (HTTP upload / download)
```

Browsing and editing go over the WebSocket; upload and download go over HTTP,
for the reasons in [Transfer](#transfer).

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_file.go` | `file.get`, `file.write`, `file.delete`, `file.search` |
| File operations | `server/contents/contents.go` | Path validation, read, write (upsert), delete |
| HTTP transfer | `server/filetransfer/filetransfer.go` | Upload / download of whole files (see [Transfer](#transfer)) |
| Search | `server/search/` | Candidate listing (`list.go`), content grep (`scan.go`) |
| Frontend components | `web/src/components/Files/` | FileTree, FileEditor, FileView, FileTreeNode, FileSearchBar, FileSearchResults, UploadButton, UploadQueue, UploadConflictDialog |
| Search UI state | `web/src/hooks/useFileSearch.ts`, `web/src/lib/filesSearchStore.ts` | Debounce + query cache, persisted options |
| RPC actions | `web/src/lib/rpc/file.ts` | `getFile`, `writeFile`, `deleteFile`, `searchFiles` |
| HTTP transfer client | `web/src/lib/fileDownload.ts`, `web/src/lib/fileUpload.ts` | Authenticated download / upload (see [Downloading](#downloading), [Uploading](#uploading)) |
| Upload queue state | `web/src/lib/uploadStore.ts` | Queue, concurrency, retry, worktree scope |
| Drag and drop | `web/src/components/Files/useFileDrop.ts`, `web/src/hooks/useFileDropGuard.ts` | Drop target resolution and drag state, window-level drop backstop |

## Operations

**`file.get`** — Read file or list directory.
- Directory → returns `Entry[]` (name, type, path)
- File → returns metadata, and content only when the client can use it

A file result always carries `name`, `type`, `path`, `size` (bytes) and `mime`,
whether or not any content came with it. `encoding` says how to read `content`:

| `encoding` | `content` | When |
|------------|-----------|------|
| `text` | UTF-8 source | The bytes are valid text |
| `base64` | Encoded bytes | An image the UI can render |
| `none` | Empty; see `omitted` | Everything else |

"Valid text" means valid UTF-8, checked over the whole file — anything else is
reported as binary, because JSON encoding replaces every invalid byte with
U+FFFD, which both corrupts the content and inflates it threefold. For a
compressed asset that verdict is pure gain. For a file in a legacy encoding
(GBK, Shift-JIS, Latin-1) it is a **deliberate trade-off, not a gap to be
closed**: such a file could be delivered, but only as mojibake the client has no
way to recognise as such, and refusing at least says so. Content search runs the
same test over a probe of the file's head (see
[Search behavior](#search-behavior)), so a legacy-encoded file drops out of
content results too — unless the probe happens to catch only its ASCII.

`omitted` is set only alongside `encoding: "none"` and explains it:
`"binary"` (a non-image binary, which the UI cannot display anyway) or
`"too_large"` (over `contents.MaxFileSize`, **2 MiB**). Neither is an error —
the response is a normal result and the client shows a placeholder built from
`size` and `mime`. A `"too_large"` result also carries `limit`, the ceiling in
bytes, so the UI can name the threshold without keeping its own copy of it.

The size ceiling is a transport limit as much as a memory one. The response is
one WebSocket message holding the whole file — an image inflated by a further
4/3 on its way through base64 — and the JSON-RPC connection carries one message
at a time, so a few megabytes stall every other request the app has in flight on
it. Oversized files are therefore never read: only their first 512 bytes, to
name the type.

Anything that is neither a directory nor a regular file — a named pipe, a
device node — is rejected with `InvalidParams` from the stat, before it is
opened: opening a fifo blocks until something writes to it, which would hang
the request for good.

`mime` comes from the file's own bytes (`http.DetectContentType`), never from
its extension — a `.svg` holding a PNG is reported as `image/png`. The
extension is consulted only for image formats no sniffer recognises (SVG, AVIF,
HEIC, TIFF), and only when sniffing produced nothing more specific than
"some text" or "some bytes". SVG is the one image served as `text`: it is
source the user can edit, and the UI can render it from the text just as well.

**`file.write`** — Write file content to disk with upsert semantics.
- Creates the file if it doesn't exist
- Creates parent directories automatically
- Updates existing files
- Rejects content over `contents.MaxFileSize` (**2 MiB**) with `InvalidParams`

The same ceiling as `file.get`, for the same reason, and one constant rather
than two: the content travels as one JSON-RPC message either way. Reaching it
from the editor takes work — a file it could open was one `file.get` agreed to
read, so it starts under the ceiling and has to be grown past it — but the
write side is where the ceiling has to hold, because there the client is the
one deciding how many bytes to send.

The refusal is a reply. Under it sits a second ceiling that is not: `/ws` caps
a single inbound message at `ws.maxClientMessage` (**16 MiB**), and past that
the WebSocket library closes the connection rather than answering. It is a
backstop, placed so that a write the method would accept can never reach it:
JSON escaping costs at most six bytes per source byte, and 16 MiB clears
6 × 2 MiB. A refused write normally gets its reply too, since ordinary text
escapes to about its own size. It was for a long time coder/websocket's 32 KiB
default, which put the backstop *below* the method's own ceiling — so saving a
moderately large file dropped the connection instead of failing the save.

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
bytes, so invalid bytes further in go unnoticed — and JSON encoding substitutes
U+FFFD for each of them, so on such a line the offsets no longer index the
`text` that arrives. Recomputing the match positions client-side, as the web UI
does, sidesteps this entirely.

`truncated` reports that limits or the timeout cut the search short, so more
matches may exist.

Bad input — a blank or oversized `query`, an unknown `mode`, a `path` that
escapes the work directory or doesn't exist — is rejected with `InvalidParams`.
A missing `path` is reported the same way whichever listing strategy runs, so
the error doesn't depend on whether the repository is a git one.

## Transfer

Uploading and downloading whole files goes over **HTTP**, not the WebSocket, and
is the one file operation that does. `file.get`/`file.write` carry the content
inside a single JSON-RPC message: the file is held in memory whole, base64
inflates it by 4/3, and that one write occupies the connection until it drains —
which is the reason for the 2 MiB ceiling above. Transferred files are routinely
larger than that, so putting them on the same connection would stall every
request the app has in flight. HTTP keeps them off it, lets the endpoint stream
both directions rather than hold a file in memory, and is what the browser
already speaks for files: `Content-Disposition`
for a download, `multipart/form-data` for an upload, `Range` for reading a large
file in pieces.

Both routes sit behind the same bearer-token middleware as the rest of `/api`
(`Authorization: Bearer <token>`) — they carry no auth of their own. A download
therefore cannot be a plain `<a href>`; the client fetches it with the header
and saves the response itself.

Both take an optional `worktree` query parameter (omitted or empty = the main
worktree), matching the worktree a WebSocket connection binds at auth.

Errors are JSON — `{ "error": "<message>", "code": "<code>" }` — with the code
naming the cause: `invalid_path`, `invalid_request`, `not_found`, `not_a_file`,
`not_a_directory`, `worktree_not_found`, `conflict`, `too_large`, `internal`.
Two more fields appear where they mean something: `limit` on `too_large`, and
`written` on a partly-completed upload.

What follows here is the contract and the two size limits that govern it. What
the clients make of it is the rest of the story, in order:
[Downloading](#downloading) for the viewer's action, [Uploading](#uploading) for
the Files tab and its queue,
[Dropping files onto the tree](#dropping-files-onto-the-tree) for the desktop
drag, and [Known transfer limits](#known-transfer-limits) for what this version
leaves open.

**`GET /api/files/download`** — send one file.

| Param | Required | Meaning |
|-------|:--------:|---------|
| `path` | ✓ | File path relative to the work directory |
| `worktree` | | Worktree name |

Streams the file from disk (`http.ServeContent`); it is never read into memory
whole, and there is no size limit on a download. The response carries
`Content-Disposition: attachment` with the file's name (RFC 2231 encoded when it
is not ASCII), `Content-Type: application/octet-stream` with `nosniff` — the
bytes are meant to be saved, and naming a real type would invite a browser to
render a workspace file inside the app's own origin — and
`Accept-Ranges: bytes`. It also carries `Cache-Control: no-store`. Without it
the response has no freshness of its own, and a browser may derive one from
`Last-Modified` — around a tenth of the file's age, so hours for a file edited
yesterday — and answer the next download from its own cache with the content
from before the last edit, which nothing on either side would notice. Refusing
storage also keeps workspace files out of the disk cache, which outlives the
token that could read them.

A `Range` request is answered with `206` and `Content-Range`. That is not just
an extra: on a relay tunnel, pulling a large file in bounded pieces is what
keeps any single response from monopolising the shared connection, and it is
what gives the client a progress indication.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_path` | Missing `path`, absolute path, or `../` traversal |
| `400` | `not_a_file` | A directory, a fifo, a device node |
| `404` | `not_found` | No such file |
| `404` | `worktree_not_found` | Unknown `worktree` |
| `500` | `internal` | Stat or open failed |

**`POST /api/files/upload`** — store files into one directory.

| Param | Required | Default | Meaning |
|-------|:--------:|---------|---------|
| `path` | | `""` | Destination **directory**, relative to the work directory; empty means its root |
| `overwrite` | | `false` | `true` replaces existing files; anything `strconv.ParseBool` cannot read is refused rather than taken as `false` |
| `worktree` | | | Worktree name |

Body is `multipart/form-data`; every part that has a filename is stored, so any
number of files can travel in one request (the field name is not significant,
and parts without a filename are ignored). Parts are streamed to disk one at a
time — nothing is spooled first — and file names never carry directory
information (RFC 7578 §4.2 requires it be dropped, and Go's parser does), so an
upload always lands directly in `path`. A client uploading a folder sends one
request per directory.

The destination directory must already exist: creating it implicitly would turn
a typo into a stray directory in the user's project.

Success is `200` with `{ "files": [{ "path", "name", "size" }] }`, where `path`
is relative to the work directory and can be handed straight back to `file.get`.

An upload is **not a transaction**. Files are written in order, and a failure
part-way through leaves the earlier ones on disk; the error body therefore
carries `written`, the same shape as `files`, listing what was already stored.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_path` | `path` escapes the work directory, or a file name that is not one (`.`, `..`, `/`) |
| `400` | `invalid_request` | Not `multipart/form-data`, malformed body, a body cut short mid-file, an unreadable `overwrite`, or no file parts |
| `400` | `not_a_directory` | `path` names an existing file |
| `404` | `not_found` | Destination directory does not exist |
| `404` | `worktree_not_found` | Unknown `worktree` |
| `409` | `conflict` | A file of that name exists and `overwrite` is not set; or the name is a directory, a symlink, or another non-regular file (never replaced, even with `overwrite`) |
| `413` | `too_large` | Over `filetransfer.MaxUploadSize`, **32 MiB** |
| `500` | `internal` | Write failed (disk full, permissions) |

A connection that dies mid-upload is reported as `invalid_request`, not
`internal`: nothing is wrong on this side, and saying otherwise sends the client
looking for a problem it cannot find.

The size limit covers the content of every file in one request together, not
each file, and is refused as soon as the budget is exceeded rather than after
reading what the client is still sending. A `too_large` body also carries
`limit`, the ceiling in bytes, so the UI can name the threshold without keeping
its own copy of it — as a `too_large` `file.get` result does.

A limit also arrives ahead of time as `max_upload_size` in the `auth` response,
because the client knows each file's size before it sends anything: refusing an
oversized file up front reads better than the `413` backstop, which lands only
after the browser has finished uploading.

The two are not the same number, and which to use is not a preference.
`max_upload_size` is what **this connection** can carry and is what a client
checks a file against before sending; the `413`'s `limit` is what the endpoint
itself refused and is only good for phrasing that particular failure. On a relay
connection `max_upload_size` is deliberately smaller, for the reason at the end
of this section — and that is where the difference matters most, because there
the backstop never fires. Neither is a place for the client to hardcode 32 MiB.

Same-name files are refused rather than replaced: an upload is a bulk action —
a drop of a dozen files — and silently overwriting a source file in the user's
project is not recoverable from the UI. The `409` message names the file and
says to retry with `overwrite=true`, so replacing is one deliberate step away.

A file left half-written by a failure is removed, so a failed upload leaves
nothing to clean up. The exception is an `overwrite` that failed: the user's
file has already been truncated, and deleting it would turn a damaged file into
a missing one.

Writes are plain and in place, not the atomic rename `filestore` uses for server
state, for the reason `contents.WriteFile` gives: these become files in the
user's own project, and replacing one by rename breaks hard links, resets the
mode, swaps the inode under anything watching it, and litters the working tree
with `.tmp` files.

**The relay does not lower the limit.** Its tunnel carries one HTTP request per
yamux stream and forwards the body as it arrives, so a remote upload is bounded
by `MaxUploadSize` and nothing else, exactly like a local one
([code/relay-system.md](code/relay-system.md)). That is a change: the previous
transport packed a whole request into one WebSocket message and capped a remote
upload at 7 MiB, and crossing that cap dropped the tunnel rather than returning
a `413`. `max_upload_size` still travels on the `auth` reply — a client should
not carry its own copy of a server-side number — but it is now the same value on
every route.

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

Binary files are skipped in content mode, likewise without setting `truncated`.
The test is the same one `file.get` applies — sniffing rejects the formats it
knows and byte soup that could not be text, then the UTF-8 check rejects what
sniffing let through, so a compressed asset with no null byte near its start no
longer passes as text — but search asks it of a 512-byte probe
(`contents.IsBinaryProbe`) rather than of the whole file, since reading every
file in full just to decide whether to read it is the cost the probe exists to
avoid.

That is the one difference between the two, and it cuts both ways: a character
straddling the end of the probe is not held against the file, and in exchange
invalid bytes past the probe go unnoticed. `file.get` sees the whole file and so
takes neither liberty (`contents.IsBinary`) — a file it called text is text all
the way through.

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

## Viewer UI

`FileView` derives one state from the `file.get` response and renders nothing
else (`utils/fileView.ts`, priority order):

| State | When | Body | Edit |
|-------|------|------|------|
| `binary` | `omitted: "binary"` | Placeholder card | Disabled |
| `too-large` | `omitted: "too_large"` | Placeholder card naming `limit` | Disabled |
| `empty` | `size` is 0 | "Empty file" card | **Enabled** |
| `image` | `mime` starts `image/` | `<img>` with dimensions and size | Disabled, except SVG |
| `text` | anything else | Highlighted, or plain past the limit | Enabled |

Whether something is an image is decided by `mime` alone; the client keeps no
extension list of its own. Formats Go's sniffer cannot name — SVG, AVIF, HEIC,
TIFF — still display, because the server settled what they are before the
response left, and a format added there needs no client change. SVG is the one
image that arrives as `text`, and renders from a percent-encoded data URL; an
`<img>` runs no scripts and loads no external resources, so it is a sandbox for
free and must not become `dangerouslySetInnerHTML`. Being previewable as an
image does not cost SVG its source: what Edit follows is whether the content
arrived as text, not which state renders it.

Edit is disabled rather than hidden, with the reason in its accessible name, and
`binary`/`too-large` repeat it visibly on the card. **Delete stays available in
every state** — being unable to preview a file is no reason to be unable to
remove it, and it sits last in the bar because a destructive action is the one a
thumb should not reach by accident. The whole bar is hidden only while loading
or after a failure, when there is nothing to act on.

Two ceilings keep syntax highlighting from freezing the main thread. Shiki
tokenizes synchronously — roughly 3 ms/KiB on a desktop and several times that
on a phone — and awaiting it does not help, so oversized input is never handed
to it at all.

| Ceiling | Value | Past it |
|---------|-------|---------|
| `HIGHLIGHT_LIMIT` | 256 KiB | Viewer shows plain text: no shiki, and no Markdown either, since a megabyte of `.md` builds just as unmanageable a DOM |
| `EDITOR_HIGHLIGHT_LIMIT` | 32 KiB | Editor drops colours only; the file stays fully editable |

The editor's is far lower because `react-simple-code-editor` re-highlights the
whole document on every keystroke, turning the viewer's one-off cost into a
per-character one. They are two constants on purpose, not a duplication waiting
to be collapsed: no single number serves both, since the viewer's would put a
second between a keypress and the character appearing, while the editor's would
strip colour from files the viewer highlights comfortably in one pass. The
editor also downgrades silently where the viewer says so — losing highlighting
mid-edit costs nothing but colour, and a banner holding a line of a phone screen
for the whole session would cost more.

Both are measured against `size` in bytes, not `content.length` — UTF-16 code
units would put a file of CJK text at half its real weight. Losing highlighting
is never a reason to refuse an edit: a 2 MiB source file is a legitimate thing to
edit, and only its colours are negotiable.

`useContents` does not retry a request its own clock gave up on
(`isRPCTimeout`): the server is likely still reading, and a retry makes it
re-read, re-encode and re-send the whole file — see
[code/websocket-rpc.md](code/websocket-rpc.md#request-timeout).

### Downloading

Download sits between Edit and Delete and is available in every state, from
`GET /api/files/download` in all of them (`lib/fileDownload.ts`). Reusing the
content already in hand for `text` and `image` would save a request, but it
would mean two ways of producing a file and would trust `IsBinary`'s UTF-8 check
to keep being the thing that decides which one runs: the day a non-UTF-8 file
reached the `text` branch, the download would quietly save a corrupted copy.
There is no size limit on the endpoint and it streams from disk, so one path to
the real bytes costs little and cannot go wrong that way.

`binary` and `too-large` also carry the action on their placeholder card. Those
are the files that cannot be previewed at all, which makes them the ones most
likely to be wanted elsewhere, and a bare icon in the bottom bar is easy to miss
under a card that says the file cannot be shown.

The bearer header is why this cannot be a plain link (see
[Transfer](#transfer)): the response is fetched, assembled into a Blob, and
handed to the browser as an object URL. A `401` ends the session rather than the
download — the token every other request carries has just been refused — so it
logs out instead of showing a banner naming a status code.

**Reads are always chunked**, 4 MiB per `Range` request. What it buys now is a
bound on memory — the assembly holds one chunk at a time rather than a whole
file of unknown size — and a transfer that can be abandoned partway. It began as
a workaround for the old relay transport, which read an unchunked response into
memory whole; that reason is gone, but one extra round trip per 4 MiB is a low
price for the two that remain.

Three details make the assembly honest.

Each chunk after the first carries `If-Unmodified-Since` with the previous
response's `Last-Modified`, so a file rewritten mid-download is refused with a
`412` instead of being spliced into a mixture of two versions. **Not
`If-Range`**, which detects the same thing but answers it by sending the whole
new file — and one unbounded response is precisely what the chunking above
exists to prevent, so the mechanism guarding the download would undo it.
`Last-Modified` is a weak validator (one-second
granularity, and the endpoint sends no `ETag`), so an in-place rewrite that
keeps the file's size and lands in the same second as the previous chunk's mtime
still slips through; closing that would take a strong validator from the server.

Every chunk is appended at the offset its own `Content-Range` claims, never at
the one that was asked for — a chunk that lands anywhere else is refused,
because concatenating it would produce a file that looks whole and is not.

And a response that is not partial content is read for what it is rather than
appended. A `200` means the `Range` went unanswered — by a server that ignored
it, or by something in between that stripped the header — so its body is one
whole, self-consistent file and replaces whatever was collected. A `416`
reporting zero bytes is an empty file, the one case a range cannot be satisfied
with nothing wrong; one reporting any other size is a file that shrank
mid-download; and one reporting no size at all names the offset it refused
instead of guessing which of those it was. An empty file may draw either the
`200` or the `416` — that is the server's choice, not something worth depending
on.

Downloading shows a spinner in place of the icon and cancels on a second click.
Navigating to another file cancels it too, rather than letting a transfer the
user has left behind finish and save itself; neither reports anything, since
both are the user's own doing. Failures share one banner with Delete
(`actionError`) rather than stacking a second error bar, and name the cause from
the response `code` — except `internal`, which keeps the server's technical
detail, a fault the user cannot act on being the one where detail matters most.
Past 200 MiB the download is confirmed first, quoting the size and then what it
costs: the file is assembled whole before any of it is saved, and an
interruption leaves nothing to resume from — the next attempt starts at the
first byte again. It deliberately stops short of saying the browser holds it all
in memory: where a Blob is kept is the browser's own business, and the answer
does not turn on it.

## Uploading

The entry point is a button in the Files tab's search row that doubles as the
destination indicator: it reads `Upload to <folder>` and shows that folder's
name, or nothing when uploads go to the project root. Tapping any folder in the
tree sets it — expanding or collapsing, since either is the nearest thing to a
statement about where the user is working — and that folder carries a faint
accent tint, distinct in hue from the grey of the file being viewed. The button
is not a convenience next to drag and drop: a touch screen has no HTML5 drag,
and drag is unreachable from a keyboard or a screen reader anywhere.

A destination that has since been deleted or renamed falls back to the root
silently, checked against the parent's cached listing at the moment files are
picked. Reporting it only when the user finally presses upload would be too
late to be useful, and the endpoint does not create the folder.

Each stored file invalidates its destination's cached listing. The FS watch
covers a folder only while it is expanded, so a file uploaded into a collapsed
one would otherwise not show up until something else refreshed the tree.

### Dropping files onto the tree

On a desktop, files dropped on the Files tab land in **whichever folder they
were dropped on** (`components/Files/useFileDrop.ts`). Every point in the panel
has an answer and none of it is dead space: a folder row takes the file, a file
row hands it to the folder holding it, anything inside an expanded folder's
subtree — including the spinner while its contents load — belongs to that
folder, and everything else, the search row and the blank tree included, is the
project root. Resolution walks up from whatever the cursor is over to the
nearest `data-entry-path`, which `FileTreeNode` puts on each row's **wrapper**
rather than the row itself, so a folder answers for its whole subtree. A drop
also sets the button's destination, being at least as clear a statement of where
the user is working as tapping a folder.

Three things about drag and drop are not optional:

- **The panel tracks a depth counter, not the events.** Each child bubbles a
  `dragenter`/`dragleave` pair of its own as the cursor crosses it, so switching
  on the events themselves flickers on every row.
- **`useFileDropGuard` is mounted on `AppShell`.** A file released anywhere
  outside a drop zone would otherwise be opened by the browser, replacing the
  whole app — not an edge case, but what happens every time someone misses. It
  sits on the root route component and not on `MainContainer`, which only exists
  once a session has resolved: the token screen, the loading screen and the
  "can't reach the server" screen are all droppable too. It runs in the
  **capture phase** so a real drop zone, whose handler runs later on the way
  back up, can still claim the drag with `dropEffect = "copy"`; everywhere else
  the cursor keeps the "not allowed" mark. The panel additionally resets its own
  drag state on the window's `drop` and `dragend`, because a drag that ends
  outside the window never delivers its last `dragleave` and the counter alone
  would leave the panel lit up.
- **The drop bar, the queue and the error banner are `pointer-events-none` while
  a drag is up.** The cursor crossing one would otherwise resolve the
  destination back to the root while the bar still read `Upload to src`.

Two affordances exist because a drag cannot click or scroll. **Hovering a folder
for 700 ms opens it** — otherwise a collapsed folder could never receive a drop
— and it never closes again, since a folder snapping shut under the cursor would
move every row below it. **Resting near the top or bottom edge scrolls the
tree**; the scroller is the element `PullToRefreshify` renders, not the window,
and since it forwards no ref the tab reaches it as the single child of the
wrapper around `PullToRefresh`.

**Two states refuse a drop outright**, saying so on the bar rather than aiming
it somewhere:

- **Search results.** A flat list of matches from everywhere has no answer to
  "into which folder".
- **An open conflict dialog.** It is a portal, and a portal's events still
  travel the React tree, so its overlay stops clicks but not drops.

Under search the upload button keeps working: it aims at the destination already
chosen, which a list of matches says nothing about. **An unanswered dialog turns
away every batch, whatever it arrived through.** A drag has already been turned
away on the bar; every other way in is refused inside `uploadInto` and answered
by the banner. There is one place to hold a batch awaiting an answer, so a
second one would take the first's place without a word and drop the files it was
holding — and refusing it where every batch passes through covers the entry
points a modal cannot stand in front of. The upload button is one of them: a few
presses of Tab reach it from behind the overlay. The dialog has no focus trap,
and neither does the shared `ConfirmDialog` the rest of the app confirms with,
so escaping a modal by keyboard is long-standing behavior across `web` and
`web-cluster` alike rather than anything this path introduced. It is known and
tracked on its own; what is closed here is what escaping could cost, not the
escaping itself.

The banner says the picked files were not uploaded, since they are gone from the
picker and would otherwise be looked for in a queue they never reached, and it
clears itself the moment the answer arrives — it was an instruction, and one
still standing afterwards would read as an answer that did not register. Only
that one clears: a folder turned away on the way in is still true after the
dialog is closed.

**A dropped folder is refused, not flattened.** This version uploads files, and
a folder also appears in `dataTransfer.files` as a zero-byte entry that would be
stored as an empty file of that name; `webkitGetAsEntry` on the items is what
tells the two apart. Files dropped alongside it are still taken, and the banner
says what was left behind.

Visually the panel takes a **ring**, not a border — a border takes a pixel from
the layout and would nudge the whole tree sideways the moment a drag arrives —
and the folder under the cursor is tinted more strongly than the standing
destination tint, since it is answering a cursor that is moving right now.

**One request per file** (`lib/fileUpload.ts`), though the endpoint accepts any
number of parts. Progress is reported for a request as a whole and could not be
attributed to a file inside it; `overwrite` applies to a whole request, so a
mixed decision has to be split anyway; and a failure then belongs to the one row
it is shown against. It also makes the non-transactional upload moot in
practice — but a `written` entry naming the file is still read as success, since
a body cut short after that file was stored in full would otherwise ask the user
to send it a second time.

`XMLHttpRequest`, not `fetch`: `fetch` reports nothing while a request body is
going out, and `xhr.upload.onprogress` is what the per-file progress bar is made
of. Authentication is the same `authHeaders()` the download uses, and a `401`
ends the session the same way.

**Three files at a time** (`uploadStore.ts`). A browser allows six connections
per origin and the tree, the search and every file read compete for them, so
uploads must not take the pool. Over a relay the number buys nothing at all —
every request shares one tunnel and is buffered whole before being forwarded, so
parallelism there only multiplies the memory in flight. Three overlaps the round
trips, which is the part worth overlapping.

**Size is checked before sending, against the `auth` reply's
`max_upload_size`** — never the `413`'s `limit`, and never a constant. On a
relay connection this check is not a nicety but the whole of the error handling
for that path, since the `413` never fires there ([Transfer](#transfer) says
why). It is re-read from the store on every attempt, because a reconnect can
land on a route with a different ceiling. A file refused this way is never
offered a retry: it cannot get smaller, and retrying over a relay costs the
connection.

**More than 50 files in one go is refused at the banner**, before anything is
queued. A selection that large is a mistaken drop rather than an intent, and
every file is its own request.

Same-name collisions are settled **once, up front**, from the destination's
cached listing, rather than interrupting a transfer already running. One dialog
lists what is taken and offers Keep both / Replace / Skip. **Keep both is the
primary button and the default answer** (`Esc` means Skip): this is a code
workspace, where a stray `logo (1).png` costs far less than a source file
replaced without being read. The endpoint cannot rename, so that second name is
chosen in the client, against both the directory listing and the names other
queued uploads have already claimed — plus, when the collision was the `409`
rather than the listing, the name that just failed. Without that last one a
stale listing would answer "Keep both" with the very same name and fail on every
press. A name that is already a copy counts on from where it left off, so a
second pass gives `logo (2).png` rather than `logo (1) (1).png`.

A name belonging to a **folder never enters that dialog**. The endpoint answers
`409 conflict` for a folder exactly as it does for a file, so the distinction
exists only in the cached listing, and replacing a folder would take its whole
subtree with it. Such a file is refused before anything is sent, with Keep both
as its only inline resolution. Where the listing cannot say — nothing cached, or
a symlink the tree reports as a file — the `409` is the backstop, and the
endpoint refuses to replace a non-regular file even with `overwrite`.

**A `409` is shown in the server's own words**, and is the one known code that
is — every other code the client has phrasing for uses it. The server ran
`Lstat` and this side did not, so it alone can say `logo.png is a directory`;
flattening that to "Already exists" would leave the user pressing Replace on
something it will refuse again for the reason it just gave. The one thing
dropped in the retelling is the trailing `retry with overwrite=true` — a query
parameter is not an action anyone can take from the queue, and the buttons
beside the message already are. A `409` with no message at all still reads
"Already exists".

The queue itself is a bar at the bottom of the Files tab, collapsed to a summary
and expandable into per-file rows. It opens itself the first time something
fails, because the row is where the answers are — Replace, Keep both, Retry —
and a summary reading "1 failed" would hide the only thing to do about it; only
on that first transition, so a panel the user has since collapsed stays closed.
A row that failed on a `409` is offered the first two and not a plain Retry,
which would only be refused the same way. It is not in the sidebar shell, which
would cost every tab a permanent strip of vertical space for something that
happens rarely; the other tabs get a badge on the Files icon instead, lit while
anything is queued, running or failed. A queue where everything succeeded clears
itself after three seconds — a failure or a cancellation stays until it is read.

**A worktree switch cancels every upload that had not finished**, with
`Cancelled — worktree changed` on the row. The worktree travels in the request
and is fixed when the upload is queued, so one that survived the switch would
write into a tree the user has already left. The queue shows only the current
worktree's entries, so switching back is what surfaces those rows. Uploading
into a worktree in the background would need the queue to pin one per request
rather than per app, and is not in this version.

While uploads are running a reload is confirmed first (`beforeunload`): the
queue holds `File` objects and nothing else, so a reload loses the files
themselves and not just their progress.

Selecting a file on a phone leaves the drawer open for as long as something is
**queued or running**, since closing it would take the queue and the tab bar
that badges it off screen together, leaving the upload with nothing to report
to. The file still opens behind the drawer. A failed row is deliberately not
part of this, though the badge is lit for it: a failure has already reported and
then stays until it is dismissed, so waiting on one would be a state with no
natural end — a single failure nobody cleared, and every file tapped from then
on would leave the drawer standing open over it. The badge is how the row is
found again once the file has been read. Choosing a session, a diff file or a
commit still closes it: the queue is invisible from those tabs anyway — which is
the whole reason for the badge — so keeping the drawer open there would only
read as a tap that did nothing.

## Known transfer limits

Two gaps rather than decisions, collected here because each of them is easy to
rediscover as a bug:

- **`Last-Modified` is a weak validator**, so a file rewritten mid-download is
  caught in every case but one: an in-place rewrite that keeps the file's size
  and lands in the same second as the previous chunk's timestamp. Closing that
  needs a strong validator from the endpoint — see [Downloading](#downloading).
- **An upload's destination directory still follows symlinks**, though the file
  being written does not — see [Security](#security).

Not in this version, and scope rather than limits: uploading a folder, moving
files by dragging within the tree, resuming an interrupted transfer, a queue
that survives a reload, uploading into a worktree the user has left, and
downloading a folder as one archive.

## Security

`ValidatePath(workDir, path)` prevents directory traversal lexically: it cleans
the path and checks that the result stays within the workspace root. It performs
no symlink resolution. It rejects:
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

The transfer routes inherit that same behavior on the read side — a download
stats with `Stat`, exactly as `file.get` does — but not on the write side. An
upload replaces a **regular file** and nothing else: it checks the destination
name with `Lstat`, so a symlink is the link itself rather than what it points
at, and answers `409` for it even with `overwrite=true`. Following one would
write outside the workspace, and an `O_WRONLY` open of a fifo would block until
something read from it, hanging the request for good.

That covers the file being written, not the directory it goes in: the upload's
`path` is validated lexically and then used, so a symlinked directory is
followed just as `file.write` follows one on the way to its target. It is the
same long-standing trade-off as above, not a new one — closing it belongs with
the decision that closes it for `file.get` and `file.write`.

`file.get` does follow them: it stats with `Stat`, so a symlink pointing outside
the workspace reads the target. This is long-standing behavior, not a property
anyone designed for. Closing it means resolving the link and re-checking
containment, which is a deliberate change with a real cost — a pnpm workspace
links `packages/shared` into `web/node_modules`, and a blanket rejection would
make such directories unbrowsable. Left as is until that trade-off is decided.
