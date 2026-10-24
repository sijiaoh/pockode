# File

Users browse directories, search, view/edit files, and transfer whole files —
and whole folders — in and out of the workspace. Path traversal is validated on every request.

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

Everything here names a file by a path inside the workspace. Content an agent
delivered in a conversation — the image a tool returned, a file it read from
outside the work directory — is not in this namespace and is deliberately not
served through it; it is addressed by id in the session's own attachment store
([code/agent-integration.md](code/agent-integration.md#why-this-is-not-the-file-namespace)).

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_file.go` | `file.get`, `file.write`, `file.create`, `file.delete`, `file.rename`, `file.move`, `file.search` |
| File operations | `server/contents/contents.go`, `server/contents/move.go`, `server/contents/within.go` | Path validation, read, write (upsert), create, delete, rename, move; opening a directory only where its links lead inside the work directory (`OpenDirWithin`, shared with the folder upload and download) |
| HTTP transfer | `server/filetransfer/filetransfer.go`, `server/filetransfer/folder.go`, `server/filetransfer/folderdownload.go` | Upload / download of whole files, upload of a folder, download of a folder as a zip archive (see [Transfer](#transfer)) |
| Search | `server/search/` | Candidate listing (`list.go`), content grep (`scan.go`) |
| Frontend components | `web/src/components/Files/` | FileTree, FileEditor, FileView, FileTreeNode, FileSearchBar, FileSearchResults, FileEntryMenu, EntryNameDialog, UploadQueue, UploadConflictDialog |
| Entry-action helpers | `web/src/hooks/useTakenNames.ts`, `web/src/lib/fileCache.ts` | Which names a directory has spoken for; the cache work a rename, a move or a delete implies |
| Search UI state | `web/src/hooks/useFileSearch.ts`, `web/src/lib/filesSearchStore.ts` | Debounce + query cache, persisted options |
| RPC actions | `web/src/lib/rpc/file.ts` | `getFile`, `writeFile`, `createFile`, `deleteFile`, `renameFile`, `moveFile`, `searchFiles`, `isAlreadyExistsError`, `fileMoveRefusedReason` |
| HTTP transfer client | `web/src/lib/fileDownload.ts`, `web/src/lib/rawProbe.ts`, `web/src/lib/fileUpload.ts` | Handing a download to the browser and wording its failures, upload (see [Downloading](#downloading), [Uploading](#uploading)) |
| Media playback | `web/src/components/Files/MediaPreview.tsx`, `web/src/components/Media/useMediaPlayback.ts`, `web/src/hooks/useRawMediaSource.ts`, `web/src/components/Media/exclusivePlayback.ts` | Inline audio and video streamed from a raw capability, its recovery, and one sound at a time (see [Playing audio and video](#playing-audio-and-video)) |
| Download action | `web/src/hooks/useFileDownload.ts`, `web/src/components/Files/FileDownloadControls.tsx`, `saveRawFile` / `saveRawFolder` in `web/src/hooks/useRawMediaSource.ts` | The viewer's Download — check, hand-over, cancel, error — shared by `FileView` and `CommitFileView`, and the menu's Download as zip (`useFolderDownload`, the same core); `saveRawFile` is every streamed Save that gets its own capability, `saveRawFolder` a folder's; `prepareDragDownload` / `heldDragDownloadUrl` the capability a row's drag saves from outside the browser (see [Dragging out to download](#dragging-out-to-download)) |
| Upload queue state | `web/src/lib/uploadStore.ts` | Queue, concurrency, retry, worktree scope |
| Reading a folder | `web/src/lib/folderRead.ts` | Walking a dropped folder, a picked folder's paths, the client's file cap (see [Uploading a folder](#dropping-a-folder)) |
| Drag and drop | `web/src/hooks/useFileDragZone.ts`, `web/src/components/Files/useFileDrop.ts`, `web/src/hooks/useFileDropGuard.ts`, `web/src/lib/entryDrag.ts` | What every drop zone shares (`useDragZone`: the depth count, the resets, claiming the drag; file detection and folder splitting on top for files); the tree's drop target resolution, for uploads and moves alike; the window-level drop backstop; what a tree row's drag carries, and whether it can save the row outside the browser (see [Moving](#moving), [Dragging out to download](#dragging-out-to-download)) |

## Operations

**`file.get`** — Read file or list directory.
- Directory → returns `Entry[]` (name, type, path)
- File → returns metadata, and content only when the client can use it

A file result always carries `name`, `type`, `path`, `size` (bytes) and `mime`,
whether or not any content came with it. `encoding` says how to read `content`:

| `encoding` | `content` | When |
|------------|-----------|------|
| `text` | UTF-8 source | The bytes are valid text |
| `http` | Empty; fetch the bytes over HTTP | Media: a raster image, audio or video |
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
`"binary"` (a binary that is not media, which the UI cannot display anyway) or
`"too_large"` (over `contents.MaxFileSize`, **2 MiB**; for a raster image,
over `contents.MaxImageSize`, **20 MiB** — see below). Neither is an error —
the response is a normal result and the client shows a placeholder built from
`size` and `mime`. A `"too_large"` result also carries `limit`, the ceiling in
bytes, so the UI can name the threshold without keeping its own copy of it. A
git diff is held to the same ceiling and refuses in the same fields — see
[git.md](git.md#diffs).

The size ceiling is a transport limit as much as a memory one. The response is
one WebSocket message holding the whole file, and the JSON-RPC connection
carries one message at a time, so a few megabytes stall every other request the
app has in flight on it. Oversized files are therefore never read: only their
first 512 bytes, to name the type.

**Media never travels on that connection, whatever its size.** It is the binary
the client can render and the one most likely to be megabytes — a screenshot, a
photo, a screen recording, a voice memo — so `file.get` describes it and leaves
the bytes to `GET /api/files/download` ([Transfer](#transfer)), which streams
them on a request of their own, or to the raw capability URL (`/api/raw`) a
player loads. Only the first 512 bytes are read, as for an oversized file, and
the 2 MiB ceiling does not apply. A raster image's ceiling is
`contents.MaxImageSize` (**20 MiB**) instead, whether the image is in the
workspace, in a commit or in a chat. That one is a preview limit only — the
client holds the whole image in memory to decode it — and the endpoints still
serve a larger file to anyone downloading it. It is sent to clients as
`max_image_preview_size` in the `auth` reply
([why](code/websocket-rpc.md#authentication-flow)). Audio and video
have **no ceiling**: a player streams them with `Range` requests, starts before
the file has arrived and never holds it whole. The response carries no URL; the
client knows which endpoint to ask from which method described the file.

"Media" means two things together: a `mime` that is a raster image (under
`image/`, other than `image/svg+xml`) or playable (under `audio/` or `video/`),
and binary leading bytes (`contents.IsMedia`). The second matters for the
formats named by extension below — a git-LFS pointer committed as `photo.avif`
or `clip.mov` is text, and is returned as `text` rather than as media nobody can
render. The client's counterpart of the type half is `getPlayableKind` beside
`isImageMime` (`utils/fileView.ts`).

Anything that is neither a directory nor a regular file — a named pipe, a
device node — is rejected with `InvalidParams` from the stat, before it is
opened: opening a fifo blocks until something writes to it, which would hang
the request for good.

`mime` comes from the file's own bytes (`http.DetectContentType`), never from
its extension — a `.svg` holding a PNG is reported as `image/png`. The
extension is consulted only for media no sniffer recognises — the image formats
SVG, AVIF, HEIC and TIFF; a phone's `.mov`; an MP3 without an ID3 tag or an MP4
whose brand Go does not know — and only when sniffing produced nothing more
specific than "some text" or "some bytes". HTML is settled by name both ways,
because `text/html` is what makes the client render a file as a
[page](#html-pages): text named `.html` or `.htm` is `text/html` even when it
opens with prose rather than a tag, and text sniffed as HTML under any other
name — a `.svelte` or `.vue` component opening with `<script>` — is taken as
plain text, which the extension tables may still name (an `.svg` opening with
`<!--` is `image/svg+xml`).

The extension is also consulted inside a container that holds audio as readily
as video, which the sniffer names by the container alone: an iPhone voice memo
sniffs as `video/mp4`, a browser's voice recording as `video/webm`, an Opus
note as `application/ogg`. The type is what decides which player a file gets —
here, in the [media viewer](media-viewer.md) and in a chat attachment's
strip — so a voice note typed by its container would open as a black video
square, or as a plain file with no player at all. Inside one of those
containers the extension picks — `.m4a` is `audio/mp4`, `.weba` `audio/webm`,
`.ogg`/`.oga`/`.opus` `audio/ogg`, `.ogv` `video/ogg` — but only among what the content already is,
so a PNG named `.m4a` is still a PNG and an MP4 named `.ogg` still an MP4. A
browser recording is named `.webm` with or without a picture, so no extension
can say which it is; there the track list in the file's first 512 bytes
decides — those bytes and no more, however much of the file the caller holds,
so a git blob read whole gets the answer a head-only read does — and one that
lists audio and no video is `audio/webm`. A track list past them leaves the
file video, as does an audio-only MP4 named `.mp4`: an MP4 states its tracks
wherever its index sits, often at the end, so only its name could tell, and
`.mp4` names video.

SVG is the one image served as `text`, and so the one still held to the 2 MiB
ceiling: it is source the user can edit, and the UI can render it from the text
just as well. It is also a security boundary rather than a preference — SVG
can carry script, and its bytes fetched into a same-origin Blob would run as
the app if opened on their own, where they can read the login token. Text
rendered through an `<img>` never needs that Blob.

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

**`file.create`** — Create an empty file or an empty directory.
- `type` is `"file"` or `"dir"`, the same `EntryType` a listing returns; anything
  else is `InvalidParams`
- Creates missing parent directories, as `file.write` does
- Rejects an existing path with `InvalidParams` and `"<path> already exists"`

Separate from `file.write` because of that last line, which is the whole point
of the method: a write upserts, and the sidebar's "new file" action must not.
Silently handing back whatever already sits at that name is indistinguishable to
the user from having created it, and for a file it would look like the old
content survived a creation. Whether the name is taken is decided by the creating
syscall itself (`O_EXCL` for files, `os.Mkdir` for directories) rather than by a
stat before it, which an agent writing the same path can overtake. That choice
also decides how it treats a symlink on the name; see [Security](#security).

**`file.delete`** — Remove a file or directory from disk.
- Directories are deleted recursively (all contents removed)
- Returns error if path doesn't exist

**`file.rename`** — Change an entry's name, leaving it where it is.
- `new_name` is a **name, not a path**: a separator is rejected, and so are
  `""`, `.`, `..` and the reserved device names `ValidatePath` rejects — all of
  them as `InvalidParams` and `"invalid path"`, the one message the other file
  methods also flatten a bad path to
- Rejects a name already taken in that directory with `InvalidParams` and
  `"<path> already exists"` — the same sentence `file.create` sends, so a
  client has one thing to match on
- A missing source is `InvalidParams` and `"not found: <path>"`
- Renaming an entry to the name it already has succeeds and does nothing
- Changing only a name's capitalisation works on every platform, including the
  case-insensitive filesystems where the new name looks taken by the entry
  itself

Renaming is not moving, and the missing separator is the whole reason. Allowing
one would fold "move this" and "create the parents on the way" into the same
text field the UI names things in, and its failures — target directory missing,
target is a file, a directory moved into its own subtree, a cross-directory
overwrite — are ones the user cannot see coming while typing a name. Moving
belongs to a gesture that shows the destination ([Moving](#moving)). The naming sheet in the UI
rejects a separator for the same reason, so both halves say one thing about
what a name may be.

It is one `os.Rename`, never a write followed by a delete: that imitation
changes the inode, drops the mode, breaks hard links, costs a full copy of a
large file, and cannot be done to a directory at all. That choice also decides
how it treats a symlink, on the old name and on the new; see
[Security](#security).

Unlike `file.create`, "already exists" here is a check before the syscall rather
than the syscall's own verdict: POSIX `rename(2)` *replaces* an existing
destination silently, and there is no portable way to ask it not to
(`RENAME_NOREPLACE` is Linux-only). So there is a window between the check and
the rename in which another writer could take the name. Losing that race means
an overwrite, which is bad — but the alternative is overwriting every time.

That check cannot be a bare "does anything have this name", because on a
case-insensitive filesystem — APFS and NTFS, so macOS and Windows as shipped —
looking up `readme.md` finds `README.md`, and an entry would be refused as its
own obstacle. Fixing a file's capitalisation would then be impossible anywhere
but Linux, by any route but delete-and-recreate. `os.Rename` performs that
rename correctly on both platforms; only the guard in front of it had to learn
the difference. `os.SameFile` is most of what tells it: if the destination is
not the source, the name is taken and that is the end of it.

Sameness alone is not enough, though, because two directory entries can name
one inode with no case folding involved — `a.txt` and `A.txt` as hard links on a
case-sensitive filesystem. Those are two real names and taking one of them is
refused. The directory listing is what separates the cases: under case folding
the new name is not literally in it, while a hard link sibling is. So the
listing is read, and only in the narrow case where it decides anything. Leaving
it out would not lose data — POSIX makes `rename(2)` a no-op when both names
resolve to the same file — but it would report success for a rename that did
nothing, which is worse than refusing.

**`file.move`** — Put an entry into another directory, keeping its name.

Params `path` (the entry; `""` is refused) and `destination` (an existing
directory; `""` is the work directory, so the field is required — leaving it
out is `invalid params` rather than a move to the root). Result `{ "path": "<new path>" }`,
slash-separated and cleaned (`./out/` becomes `out`), but otherwise spelled as
`destination` was: through a link it is the link's path, not its target's. A
move that changes nothing (below) answers with `path` itself, cleaned, instead.

Every refusal is `InvalidParams` with `data.reason`, which is what a client
branches on (`fileMoveRefusedReason`); the message says the same in prose:

| `data.reason` | Message | When |
|---|---|---|
| `invalid_path` | `invalid path` | Either path escapes the work directory, lexically or through a link |
| `not_found` | `not found: <path>` | No entry at `path` |
| `destination_not_found` | `destination not found: <destination>` | No directory at `destination` |
| `not_a_directory` | `destination is not a directory: <destination>` | `destination` is a file |
| `into_itself` | `cannot move a directory into itself: <path> into <destination>` | `destination` is the directory itself or beneath it |
| `exists` | `<new path> already exists` | The name is taken in `destination` — the sentence `file.create` and `file.rename` send, so `isAlreadyExistsError` holds too |

- Moving an entry into the directory it is already in succeeds and does
  nothing, returning its path — the requested state holds, as with renaming to
  the same name
- The destination is never created on the way: a move's destination is picked
  in the UI, not typed, so a missing one is a stale view to report, not a
  directory to make
- Nothing is ever replaced. The "already exists" check is before the
  `os.Rename`, with the window `file.rename` describes

It is one `os.Rename`, for the reasons `file.rename` gives. Unlike rename, both
directories — the source's parent and the destination — are resolved with
every link followed and must still be inside the work directory
(`contents.OpenDirWithin`, the check the folder upload makes), and the rename
is then given the resolved paths. The source itself is looked up only after
that, through its resolved parent and with `Lstat`, so a symlink is moved as
the link, and nothing is ever looked up through a link that leads out — a
"not found" there would tell which names exist outside. A link that stays in the project, such as a
pnpm workspace's, is a valid destination; one that leads out is refused either
way, so a move can neither hand a project file to a directory outside nor pull
one in. Whether the destination is beneath the source is decided by file
identity up the destination's ancestry rather than by comparing strings, so
neither a link nor a case-insensitive file system's other spelling hides it.

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
is the one file operation that does, besides reading an image's bytes for
display ([above](#operations)) and serving content a browser element loads by
itself (`/api/raw`, the last route below). `file.get`/`file.write` carry the content
inside a single JSON-RPC message: the file is held in memory whole, and that
one write occupies the connection until it drains — which is the reason for the
2 MiB ceiling above. Transferred files are routinely
larger than that, so putting them on the same connection would stall every
request the app has in flight. HTTP keeps them off it, lets the endpoint stream
both directions rather than hold a file in memory, and is what the browser
already speaks for files: `Content-Disposition`
for a download, `multipart/form-data` for an upload, `Range` for reading a large
file in pieces.

Every route here but `/api/raw` sits behind the same bearer middleware as the
rest of `/api` (`Authorization: Bearer <credential>` — a session token from the
app, the password from a script) — they carry no auth of their own, so a
plain `<a href>` or a `<video src>` cannot reach them. `/api/raw` exists for
what cannot send a header — a player, a page's frame, and the link the app's
own Download and Download as zip click ([Downloading](#downloading),
[Downloading a folder](#downloading-a-folder)): its credential is a
capability in the path.

Each but `/api/raw` takes an optional `worktree` query parameter (omitted or
empty = the main worktree), matching the worktree a WebSocket connection binds at auth.

Errors are JSON — `{ "error": "<message>", "code": "<code>" }` — with the code
naming the cause: `invalid_path`, `invalid_request`, `not_found`, `not_a_file`,
`not_a_directory`, `worktree_not_found`, `session_not_found`, `conflict`,
`too_large`, `too_many_entries`, `internal`, and for `/api/raw` alone `capability_not_found` and
`outside_scope`.
Two more fields appear where they mean something: `limit` on `too_large` and
`too_many_entries`, and
`written` on a partly-completed upload.

What follows here is the contract and the two size limits that govern it. What
the clients make of it is the rest of the story, in order:
[Loading image bytes](#loading-image-bytes) for the viewer's images,
[Playing audio and video](#playing-audio-and-video) for its players,
[HTML pages](#html-pages) for a page and the files it links to,
[Downloading](#downloading) for the viewer's action,
[Downloading a folder](#downloading-a-folder) for the menu's,
[Uploading](#uploading) for the Files tab and its queue,
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
session that could read them.

A `Range` request is answered with `206` and `Content-Range`, so a script can
resume an interrupted transfer. The app reads an image's bytes here
([Loading image bytes](#loading-image-bytes)) and saves nothing through it: its
Download goes through `/api/raw`, which a link can reach
([Downloading](#downloading)).

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_path` | Missing `path`, absolute path, or `../` traversal |
| `400` | `not_a_file` | A directory, a fifo, a device node |
| `404` | `not_found` | No such file |
| `404` | `worktree_not_found` | Unknown `worktree` |
| `500` | `internal` | Stat or open failed |

**`GET /api/git/show/file`** — send one file as it stood in a commit.

| Param | Required | Meaning |
|-------|:--------:|---------|
| `hash` | ✓ | Commit |
| `path` | ✓ | Path relative to the repository root |
| `worktree` | | Worktree name |

That version is not in the work directory, so the download endpoint cannot
reach it; this one serves it instead: the bytes `git.show.file` describes but
does not carry for a raster image ([git.md](git.md#historical-file-contents)).
Downloading a commit's file does not come here but goes through `/api/raw`
([Downloading](#downloading)). The headers are the download endpoint's, with a
`Content-Length` and **no `Range`** — the content comes off a `git cat-file`
pipe rather than a seekable file, so answering a range would mean running git
again for every request and discarding everything before it, and an image is
read whole anyway. git is stopped when the request
is cancelled.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_request` | Missing `hash` or `path`, or one malformed (refused before git runs) |
| `400` | `not_a_file` | The path is a directory or a submodule in that commit |
| `404` | `not_found` | The commit does not contain the path |
| `404` | `worktree_not_found` | Unknown `worktree` |
| `500` | `internal` | git failed |

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
upload always lands directly in `path`. A folder goes to
[its own endpoint](#uploading-a-folder) instead.

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
| `400` | `invalid_request` | Not `multipart/form-data`, malformed body, a body cut short — mid-file, or after a whole file but before the closing boundary — an unreadable `overwrite`, or no file parts |
| `400` | `not_a_directory` | `path` names an existing file |
| `404` | `not_found` | Destination directory does not exist |
| `404` | `worktree_not_found` | Unknown `worktree` |
| `409` | `conflict` | A file of that name exists and `overwrite` is not set; or the name is a directory, a symlink, or another non-regular file (never replaced, even with `overwrite`) |
| `413` | `too_large` | Over `filetransfer.MaxUploadSize`, **1 GiB** |
| `500` | `internal` | Write failed (disk full, permissions) |

A connection that dies mid-upload is reported as `invalid_request`, not
`internal`: nothing is wrong on this side, and saying otherwise sends the client
looking for a problem it cannot find. A body that stops just after a part's
boundary is cut short too, though Go's multipart parser reads it as a body that
ended: the server watches for the closing delimiter (`--<boundary>--` at the
start of a line, with the line ending the body's first boundary line used, as
the parser reads it) and refuses a body that never carried it, since otherwise
the files after the cut would simply be missing from a `200`. All three multipart endpoints share that
check (`filetransfer/multipart.go`).

The size limit covers the content of every file in one request together, not
each file, and is refused as soon as the budget is exceeded rather than after
reading what the client is still sending. A `too_large` body also carries
`limit`, the ceiling in bytes, so the UI can name the threshold without keeping
its own copy of it — as a `too_large` `file.get` result does.

The same limit also arrives ahead of time as `max_upload_size` in the `auth`
response, because the client knows each file's size before it sends anything.
The two carry the same number but are not interchangeable, and the difference is
*when* they arrive: `max_upload_size` is there before anything is sent, which is
the only moment at which an oversized file can still be refused cheaply, while
the `413`'s `limit` describes a request the browser has already finished
uploading and is good for phrasing that one failure and nothing else. Neither is
a place for the client to hardcode the number.

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

**`POST /api/files/upload-folder`** — store a whole tree of files as a
folder: a new one, or with `merge`, one that already exists. <a id="uploading-a-folder"></a>

| Param | Required | Meaning |
|-------|:--------:|---------|
| `path` | | Destination **directory**, relative to the work directory; empty means its root. Must exist, as for `/api/files/upload` |
| `name` | ✓ | Name of the folder in it — a name, not a path: the rule `file.rename`'s `new_name` follows |
| `merge` | | `true` writes into an existing folder of that name (see [Merging](#merging-a-folder)); read like `/api/files/upload`'s `overwrite`, so an unreadable value is refused |
| `worktree` | | Worktree name |

There is no `overwrite`: sending one at all is refused, since replacing files is
what `merge` does.

Body is `multipart/form-data`, streamed part by part as `/api/files/upload`'s is.
Two kinds of part count, and any other is refused rather than skipped — a file
part whose `Content-Disposition` did not parse looks just like one, and
skipping it would answer `200` for a folder missing that file:

- **A file part** — any part with a filename. The filename is the file's path
  **relative to the folder**, `/`-separated: `src/lib/a.ts`, not
  `myproject/src/lib/a.ts`. Here, unlike `/api/files/upload`, the directory part
  of the filename is the point, so the server reads it from the
  `Content-Disposition` header itself rather than through Go's `FileName()`,
  which strips it. `FormData.append(field, file, relativePath)` sends exactly
  this; the field name is not significant.
- **A directory part** — a field named `dir` (no filename) whose value is a
  path relative to the folder. It creates that directory, so an empty
  directory survives the upload. A directory that holds files needs no part
  of its own: a file's parents are created on the way, and declaring one that
  already exists, before or after its files, is harmless.

Every component of every path is held to the same rule as `name`: no `""`
(so no leading, trailing or doubled `/`), no `.`, no `..`, no separator of the
platform's (`\` on Windows), no reserved device name on Windows (`CON`,
`NUL.txt`), no NUL, no more than 255
bytes, and no trailing `.` or space; a whole path is at most 4096 bytes. The
trailing `.` and space are refused on every platform, because Windows drops
them — `a.` would be stored as `a`, `...` would name the folder itself — and a
folder should upload the same wherever the server runs. Nothing is cleaned or
rewritten — `a/../b` is refused, not read as `b` — so the paths the client sees
in the response are exactly the ones it sent, under the folder's path.

Success is `200` with
`{ "folder": { "path", "name" }, "files": [{ "path", "name", "size" }] }`, paths
relative to the work directory as for `/api/files/upload`. A request with no
parts at all creates an empty folder.

**Without `merge`, all or nothing.** The folder is created first, with `mkdir`,
and is the request's own: the `mkdir` is what decides the name is free, exactly as `O_EXCL`
decides it for a file, so an agent creating the same name a moment earlier
wins and the upload is refused rather than mixed into it. Every file beneath it
is therefore new, and if anything fails — a bad path, the size limit, a body
cut short, the disk — the folder is removed whole and the error carries no
`written`. If the folder cannot be removed, the message says so and `written`
lists what the request had stored, some or all of which is still on disk, so
a partial result is never silent.

The entry cap exists because the size limit cannot bound what costs no
content — an empty file, a directory — while every entry costs the request
memory to keep track of and a line in the response. It sits far above a folder
anyone drops on purpose, as a backstop: a client is expected to refuse a large
folder itself, before sending, in words of its own.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_path` | `path` escapes the work directory, lexically or through a symlink; `name` is not a name; an entry path breaks the rule above; an entry named twice, or as both a file and a folder (`a` as a file and `a/b.txt`); two entries — files or folders — that this file system holds to be one name (`README.md` and `readme.md`, `Src/` and `src/` on macOS or Windows); a name the file system itself rejects (`<>:"\|?*` on Windows) |
| `400` | `invalid_request` | Not `multipart/form-data`, malformed body, a part that is neither a file nor a `dir` field or whose `Content-Disposition` does not parse, a body cut short (mid-file or before the closing boundary), `overwrite` present, or an unreadable `merge` |
| `400` | `not_a_directory` | `path` names an existing file |
| `404` | `not_found` | Destination directory does not exist |
| `404` | `worktree_not_found` | Unknown `worktree` |
| `409` | `conflict` | Without `merge`: `name` is already taken in the destination — by a folder, a file, or a symlink, dangling or not. With it: `name` is a file or a symlink, or an entry inside is in the way (below). Either way: the name was swapped while the upload opened it |
| `413` | `too_large` | Over `filetransfer.MaxUploadSize`, **1 GiB**, counted over every file of the folder together; `limit` as for `/api/files/upload` |
| `413` | `too_many_entries` | Over `filetransfer.MaxFolderEntries`, **10,000** files and directories in one request; `limit` is that count |
| `500` | `internal` | The work directory cannot be opened; creating, writing or removing on disk failed |

Every `409` names the path in the way, relative to the work directory, and
reads as a sentence the client can show as it is, as `/api/files/upload`'s do;
where the cause is the same (`… is a directory`, `… exists and is not a regular
file …`) so are the words.

**One request per folder**, not per file. A folder is one thing the user asked
for, and only a single request can make it appear whole or not at all; a folder
of a few hundred small files sent one request each would also spend most of its
time on round trips. The cost is the one `/api/files/upload` names for several
files in a request: progress belongs to the request, not to a file in it.

**Per-file parts, not an archive.** A client-built zip would have to be built
in the browser — which has no zip encoder of its own, so a library, and on a
phone the CPU and memory to hold it — and could not be extracted on arrival:
a zip's index is at its end, so the server would have to spool the whole body
to disk first, then extract it, and then answer for every way an archive can
lie (entry paths, symlink entries, sizes that inflate a thousandfold). Multipart
parts arrive as files already, stream straight to their place, and leave
nothing but the paths to validate. The size limit keeps its meaning — bytes of
file content — instead of becoming a limit on compressed bytes.

**Conflicts are decided for the folder as a whole.** A taken `name` is `409`
and nothing happens, whatever the existing entry is: no folder is ever
replaced — that takes its whole subtree — and none is merged into unless the
client asks. The `409` names the two ways on: choose another name
(`assets (1)`, chosen in the client as for a file), or send again with
`merge=true`.

<a id="merging-a-folder"></a>**Merging** is the folder's counterpart of a
single file's `overwrite`, and follows its rules entry by entry:

- `name` must be a folder. A file or a symlink there is `409` — a merge
  through a link would write wherever it points. A `name` that does not exist
  yet is created, and is then the request's own exactly as without `merge`:
  removed whole if the request fails.
- A file whose path is a **regular file** is replaced in place, as `overwrite`
  replaces one (same inode, mode and hard links). Anything else at that path —
  a directory, a symlink, a fifo — is `409` rather than written through
  (decided by an `Lstat` before the open; a link swapped in between can lead
  only within the folder, [below](#uploading-a-folder-symlinks)).
- A directory the upload needs that exists as something other than a
  directory — a file, or a symlink, even one to a directory inside the same
  folder, which would store the file somewhere other than the path it is
  reported under — is `409` naming it. Nothing already there is ever removed.
- **Not a transaction.** A replaced file cannot be restored, so a failure stops
  where it is and the error carries `written`, the files this request stored
  before it — the same shape and meaning as on `/api/files/upload`. A file the
  failure left half-written is removed if the request created it and kept if it
  replaced one, also as there. Directories created on the way stay.
- A retry with `merge=true` can always continue into the folder a failed upload
  left behind: the upload's own earlier files are simply replaced again.
- Two entries of one merge that the file system holds to be one name are
  caught when they differ in letter case, as without `merge`; those it folds by
  other rules — Unicode normalization on macOS (`café` composed and
  decomposed), a Windows 8.3 short name — are not, and the later one replaces
  the earlier. Without `merge` every such pair is caught, since in a new folder
  any name already there is one the request made.

`overwrite` is refused rather than ignored, because a client that sends it
expects files replaced, which only a merge does.

<a id="uploading-a-folder-symlinks"></a>**Symlinks.** The destination is opened
with every link followed and must then lie inside the work directory — a link
that stays in the project (a pnpm workspace's `node_modules/@pockode/shared`, a
junction on Windows) leads where it points, one out of it is `invalid_path`.
Where it leads is read off the opened directory, not the path, by the check
`/api/raw` makes (`contents.ResolvedName`): `filepath.EvalSymlinks` does not resolve a
Windows junction, so a path check would let one pointing out of the project
through. From there every write goes through an `os.Root`: the folder's name is
created in the destination, which refuses a link on the name, and each file is
written through a root opened on the folder, so nothing beneath it can lead out
even if a link were planted inside it while the upload ran — such a link,
swapped in after a merge checked the path, is followed, but only to somewhere
inside the folder. The payload itself carries no links — a multipart part is
bytes — so a link on the user's device arrives as whatever the browser read
through it.

**`GET /api/files/download-folder`** — send one folder as a zip archive.
<a id="folder-archive"></a>

| Param | Required | Meaning |
|-------|:--------:|---------|
| `path` | | Folder path relative to the work directory; empty or omitted means the work directory itself |
| `worktree` | | Worktree name |

The app does not call this route — a link cannot carry its bearer header — but
a folder raw capability (`scope: "folder"`, on `/api/raw`, the last route
below), which serves
the same archive from the same code (`serveFolderArchive`); this one is for
scripts. `HEAD` runs every check the archive would and sends no body.

The response carries the download endpoint's headers — `Content-Type:
application/octet-stream`, `nosniff`, `Cache-Control: no-store` — and
`Content-Disposition: attachment` with `<name>.zip`; through `/api/raw` the
raw endpoint's own headers go on top, its `Cache-Control` replacing this one. `<name>` is the folder's
own name, and for the work directory the work directory's (`pockode.zip`, or
the worktree directory's name); `workspace` where there is none, a work
directory at the root of a file system. Only the server knows that name, which
is why it names the file rather than the client. Every entry sits under one
top-level folder `<name>/`, so unpacking gives back the folder rather than
scattering its contents — the same shape a folder upload takes, whose first
path segment is the folder. There is **no `Content-Length`** and **no
`Range`**: the archive is compressed while it streams, so its size is not known
until it ends and it has no byte offsets to resume from. A browser shows bytes
received with no total, and an interrupted download starts over.

**What is archived** is what is on disk — what the Files tab shows beneath
the folder, nothing left out: `.git`, `.env`, `.github`, Pockode's data
directory, other worktrees nested inside. What a user can open they can
download. A [root raw
capability](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)
withholds a list of names from a page because a page's scripts read whatever
the scope reaches and can send it out; none of that holds here. The download
is the user's own act, from their own app, and lands on their own device, and
every file in it is one they could already open in Files, so a list of
exclusions would only stand between them and their own project. The cost is
accepted and stated: a download of the project root carries the data
directory, whose `server.json` and `relay.json` hold the MCP local token and
the relay token in cleartext
([credentials on disk](code/authentication.md#credentials-on-disk)), and
`.git`, which holds the repository token under `--git` (`.git-credentials`) —
a zip is the user's to look through before handing it on. What shapes the
archive is technical:

- **A symlink is archived as a link and never followed** — its target text, with
  the link mode; on Windows a junction is treated the same. A link out of the
  folder therefore reads nothing outside it, and a link to a folder inside it
  neither duplicates that folder nor loops. unzip on macOS and Linux restores
  it as a link; Windows Explorer extracts it as a small text file. Every entry
  is opened through the folder's own directory handles (`os.Root`), never by a
  joined path, and checked to be what was listed there: one swapped for a link
  mid-walk is refused rather than followed. A link anywhere on the requested
  path itself is followed, only to somewhere inside the work directory — the rule, and
  the code (`openDir`), of a folder upload's destination, so a pnpm package
  under `node_modules` downloads.
- **Fifos, sockets and devices are skipped**: they have no content, and none is
  ever opened in a way that could block. Empty folders are kept, as are the
  executable bit and modification times.
- **Ignored files are not left out either.** `node_modules` and build output
  are on disk and are downloaded; the limits below are the backstop. A download
  never quietly leaves files out — the rule folder upload keeps.

Entries are in name order, so the same folder gives the same archive. Deflate
runs at its fastest level, with compressors pooled across entries: over the
relay the bytes cost more than the CPU, source text shrinks to a fraction at
any level, and media and archives shrink at none.

**Two walks.** The first runs before anything is sent: it counts against the
limits and opens every file once, so a folder that is gone, too large, or holds
a file that cannot be read is a JSON error the app can show rather than a
download that breaks. It opens and nothing more — no header goes out until it
is done, and through the relay this server's proxy gives a local response 30
seconds to start ([relay-system.md](code/relay-system.md#timeouts)). The
headers are flushed the moment it passes, so the browser starts the download
under its name while the first files compress. The second walk writes the
archive, and what changed in between is archived as it then is: a file removed
is left out, one created is taken in, and each holds at most the bytes it had
when opened.

**A failure once the archive has started aborts the connection**
(`http.ErrAbortHandler`) rather than closing the zip: closing would write the
central directory and turn what was sent into a valid archive silently missing
the rest. The browser marks the download failed, and a `fetch` sees its body
fail. That covers a file that fails to read, a client that stops reading, an
entry swapped for something else once the archive has started, and a folder
that grew past either limit between the walks.

The limits are a folder download's own, apart from upload's, because they
guard against something else. Memory is not it: the archive streams, and
nothing per entry outlives its directory. They catch a folder picked by
mistake — a project root with gigabytes of build output — before it streams
for an hour over a phone connection, and sit above a project with its
dependencies installed, which a user downloads on purpose.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_path` | An absolute path or `../` traversal; the folder is a link that resolves out of the work directory; a name beneath it, or the folder's own name (the work directory's, for the root), holds a `\` — zip separates with `/` alone, but an unarchiver on Windows splits there too, so `..\x` would unpack outside the folder; the message names it and says to rename it |
| `400` | `not_a_directory` | The path is a file |
| `404` | `not_found` | No such folder |
| `404` | `worktree_not_found` | Unknown `worktree` |
| `409` | `conflict` | A folder inside was swapped for something else — a link — while the check was reading it; the message says to try again. A file swapped once the archive has started aborts it instead (above) |
| `413` | `too_large` | Over `filetransfer.MaxFolderDownloadSize`, **2 GiB** of file content; `limit` in bytes |
| `413` | `too_many_entries` | Over `filetransfer.MaxFolderDownloadEntries`, **100,000** files, folders and links; `limit` is that count |
| `500` | `internal` | The work directory cannot be opened; a file or directory that cannot be read — a permission, say; the message names it |

**`POST /api/chat/attachments`** — store files a chat message is about to carry.

| Param | Required | Meaning |
|-------|:--------:|---------|
| `session_id` | ✓ | The session the message will be sent to |
| `worktree` | | Worktree name; the session must belong to it |

Not a file-namespace endpoint: the files go into the session's attachment store
(`server/attachments`), not the work directory, because they are part of the
conversation rather than of the project and are deleted with the session. The
body is `multipart/form-data` like `/api/files/upload`'s; every part with a
filename is stored, under an id derived from its content plus the original
extension (the agent's own tools decide by extension whether a file is a PDF or
an image). Success is `200` with `{ "files": [{ "id", "name", "size" }] }`, and
`chat.message` then names the files by `id`
([code/agent-integration.md](code/agent-integration.md#files-the-user-sends)).

Content-addressed, so the same file uploaded twice is one file with one id and
retrying a failed request is always safe — which is also why a failure reports
no `written`. A file uploaded and never sent stays until its session is deleted.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_request` | Missing `session_id`, not `multipart/form-data`, a body cut short (including a client that disconnects mid-file), or no file parts |
| `404` | `worktree_not_found` | Unknown `worktree` |
| `404` | `session_not_found` | The worktree has no such session |
| `413` | `too_large` | Over `attachments.MaxSize`, **512 MiB** of file content per request, or a body more than 1 MiB past that in total; also sent ahead of time as `max_attachment_size` in the `auth` reply |
| `500` | `internal` | Reading the session or storing a file failed |

Each file streams to disk as it arrives (`attachments.Store.PutStream`): it is
written to a temporary file under the session's `attachments/incoming/`,
hashed on the way, fsynced, and only then renamed to its id. So memory per
upload is one copy buffer whatever the file's size, and whatever stops an
upload — the ceiling, a client that disconnects, the disk — removes the
temporary file and hands out no id: nothing partial is ever stored under a name.
`incoming/` is a directory, which the read side and a fork's clone pass
over, and a temporary file a crash left behind goes with the session. Content
that is already stored keeps its file; the identical copy is discarded.

The ceiling is sized for what a phone records — a minute of 4K video or a long
screen recording is a few hundred megabytes — and is half a workspace upload's,
because these files sit in the data directory, out of the user's sight, until
the session is deleted: a mistaken pick of something huge costs space nobody
sees. Nothing on the way bounds the time an upload takes — the server sets no
read timeout, and the relay streams the body as it does a workspace upload's
([code/relay-system.md](code/relay-system.md)) — so at a 10 Mbit/s uplink the
whole ceiling is about seven minutes; the composer shows each file's progress,
and removing a file aborts its request.

It is not the ceiling on showing an image: an attachment past
`contents.MaxImageSize` is stored and handed to the agent all the same, and
described as `too_large` when read back ([above](#operations)), as an image
from the workspace or one an agent's tool returned would be
([code/agent-integration.md](code/agent-integration.md#content-blocks-and-attachments)).

**`GET /api/chat/attachments`** — send one stored attachment.

| Param | Required | Meaning |
|-------|:--------:|---------|
| `session_id` | ✓ | The session holding it |
| `id` | ✓ | Attachment id, as a chat event or `attachment.get` names it |
| `worktree` | | Worktree name; the session must belong to it |

The bytes `attachment.get` and `session_view.attachment` describe but do not
carry for a raster image. Served exactly as the download endpoint serves a file,
headers and `Range` included. The worktree may be one that has been deleted, as
for `session_view.attachment`: its sessions stay readable, images included. The
`id` passes `attachments.Resolve`, the check `attachment.get` applies too
([why one check](code/agent-integration.md#reading-it-back)).

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_request` | Missing `session_id` or `id` |
| `404` | `worktree_not_found` | A `worktree` that cannot be a worktree's name |
| `404` | `session_not_found` | No such session stored under that worktree, including a worktree that never existed |
| `404` | `not_found` | No such attachment, or an id that is not one |
| `500` | `internal` | Reading the session or the attachment failed |

**`GET /api/raw/<capability>/<path>`** — serve content for a browser element to
load by itself: a `<video>`, an `<audio>`, an `<iframe>`.

There are no params and no `Authorization` header. The capability comes from
`raw.capability` ([code/websocket-rpc.md](code/websocket-rpc.md#raw-capabilities)),
which also gives the path to open. It names the origin, which is a work-directory
file, a file in a commit or a chat attachment. It also names the scope, which is
one file, the whole work directory or commit, or a work-directory folder.
`<path>` is the file's own name for a file scope, and the project path for a
root scope. A folder scope has none: the capability's own path, with its
trailing `/`, is the folder's [archive](#folder-archive), served as that route
serves it, `Range` ignored — so a client checks it with `HEAD`, since a `GET`
with `Range: bytes=0-0` would start the whole archive. What a capability
is bound to, how long it lives, why it is in the path, why a page gets the root
and what the root scope withholds, what keeps a symlink from widening its scope
and why any origin may read it are in
[code/authentication.md](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself).

Unlike the download endpoint, the content is served **as what it is**, since the
element has to play or render it — all but a folder scope's archive, which is
always `application/octet-stream` and an attachment. A `download` query parameter
(`filetransfer.RawDownloadParam`, any value) adds `Content-Disposition:
attachment` to any response that reaches the content, for the link that saves
a file rather than an element that shows it ([Downloading](#downloading)). It
names no file: an attachment's URL names it by its id, and a filename in the
header would outrank the one the link gives. It changes nothing else — not the
capability, not the other headers — and being in the URL it is a cache key of
its own, so a player's cached response is never handed to a download.

The type comes from the bytes, as for
`file.get`'s `mime`. Where sniffing gives up, `file.get`'s extension table
names media, and a second one adds what a page loads
(`contents.DetectServedMIME`): a stylesheet or a script sniffs as plain text,
and under `nosniff` a browser refuses to apply either one served that way.
Content sniffed as HTML is served as HTML when neither table names it —
`file.get`'s rule is about which files the app offers as pages, and a page
navigating to a document of its own without an `.html` extension still needs
one. Both
tables are spelled out rather than read from the machine's
registry, which on Windows commonly maps `.js` to `text/plain`. Serving active
content on the app's origin is safe only because of the sandbox and the other
headers every response carries, errors included. The same page lists them and
says why.

**A page loaded into a frame is not served byte for byte.** For a `GET` whose
`Sec-Fetch-Dest` is `iframe` or `frame`, with no `Range` and no `download`, a
UTF-8 HTML file gets the script that tells the app what the page was refused,
after its doctype — whole, with no validators, and `Vary: Sec-Fetch-Dest` on
every HTML response. Save and a page's own `fetch()` are not framed loads, so
they get the file as it is
([page-external-hosts-ui.md](page-external-hosts-ui.md#hearing-what-was-refused)).

**`Range` works for every origin**, a commit's file included — for every scope
but a folder's. A video player
will not play without it. The commit endpoint above declines that cost. Here a
commit's file is a `ReadSeeker` over git's stream: seeking forward discards up
to the offset, and seeking backward runs git again. A player asks for a handful
of ranges, a download for its first byte and then the whole, and the sniffed
head is kept, so reading from the start again costs nothing. Revalidation uses
`Last-Modified` for a file on disk and an `ETag` for a commit's file, whose
content at a path never changes.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_path` | An empty or absolute path, or one that `..` leads out of, encoded or not — the root scope's own trailing-`/` path included (a folder scope's is its archive) |
| `400` | `not_a_file` | A directory, a fifo, a device node, or a directory or submodule in the commit |
| `403` | `outside_scope` | A name other than the file's for a file scope, and any path at all beneath a folder scope. For a root scope, a path with a component named `.git`, `.env`, `.env.*`, `.envrc` or `.envrc.*`, at any depth and in any case — and, for a work-directory file, one whose resolved name has one (through a symlink, or on Windows a short name) or lies inside Pockode's data directory or another registered worktree, or whose name cannot be resolved. Any other dot path is served as any file is. For a work-directory file, a path that leaves the work directory through a symlink, or any other failure to open it — a permission, a link loop. `os.Root` reports a link out of it with an error that cannot be told apart from those, so all of them are answered as out of reach, with the reason in the message |
| `404` | `capability_not_found` | The capability was never issued, has expired, or its session has ended; ask `raw.capability` again |
| `404` | `not_found` | No such file, commit path or attachment, or a commit that no longer exists. A hash git would refuse never gets this far: `raw.capability` resolved it when it issued the capability |
| `404` | `worktree_not_found` / `session_not_found` | As for the endpoints above |
| `405` | `invalid_request` | Any method but `GET`, `HEAD` and `OPTIONS` (a CORS preflight, answered `204`; see [code/authentication.md](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)) |
| `416` | | A `Range` the content cannot satisfy |
| `500` | `internal` | Opening the work directory or an attachment, reading the content, or running git failed |
| `400` / `409` / `413` | the archive's | A folder scope also answers [the archive's](#folder-archive) codes: `not_a_directory`, `conflict`, `too_large`, `too_many_entries`, and `invalid_path` for a name inside it or a link out |

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

The box shares its row with the project root's `…`, and its wrapper is the row's
one `flex-1 min-w-0` element while every sibling is `shrink-0` — the narrow-width
rule in [sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule). Without the
`min-w-0` the wrapper could not shrink below its own icons, which is what made
this the row that visibly broke when the panel was narrowed.

Two chips, shown only while a search is running, expose the options the UI
varies; both persist in `localStorage`. The `.gitignore` chip is left out
outside a git repository, where it would change nothing, and its saved value is
kept for when one appears ([git-ui.md](git-ui.md#projects-without-a-repository)):

| Chip | Key | Default | Effect |
|------|-----|---------|--------|
| `.gitignore` | `files-search-respect-gitignore` | on | Sets `respect_gitignore` |
| `Contents` | `files-search-content` | off | Switches `mode` to `content` |

The chip reads `Contents` rather than `File contents`; the long form stays in
its `title`. Side by side the two chips carry no `overflow-hidden`, so their
floor is their own text — at the long label they needed ~245px and overflowed a
240px panel — and the row wraps (`flex-wrap`) rather than scrolling sideways
inside a panel that narrow.

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
Refreshing the files tab re-runs the current search instead of clearing it.

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
| `page` | `mime` `text/html` where the state would otherwise be `text` or `too-large` (an empty file stays `empty`), so a page past the ceiling still renders | The page, in a sandboxed frame ([below](#html-pages)); its source a toggle away | As its source |
| `binary` | `omitted: "binary"` | Placeholder card | Disabled |
| `too-large` | `omitted: "too_large"` | Placeholder card naming `limit` | Disabled |
| `empty` | `size` is 0 | "Empty file" card | **Enabled** |
| `audio` / `video` | `encoding: "http"` with an `audio/` / `video/` `mime` | Native player, streamed ([below](#playing-audio-and-video)) | Disabled |
| `image` | `encoding: "http"`, or SVG | `<img>` with dimensions and size | Disabled, except SVG |
| `text` | anything else | Highlighted, or plain past the limit | Enabled |

Whether something is media is decided by what the server sent — audio, video
and raster images as `http`, told apart by `mime`; an SVG by its `mime` — and
the client keeps no extension list of its own. Audio and video carry their
`ContentOrigin` rather than a source, since a player loads them through a raw
capability rather than as one fetched Blob. Text typed as media (the git-LFS
pointer above) is shown as text. Formats Go's sniffer cannot name — SVG, AVIF, HEIC,
TIFF — still display, because the server settled what they are before the
response left, and a format added there needs no client change. SVG is the one
image that arrives as `text`, and renders from a percent-encoded data URL; an
`<img>` runs no scripts and loads no external resources, so it is a sandbox for
free and must not become `dangerouslySetInnerHTML`. Being previewable as an
image does not cost SVG its source: what Edit follows is whether the content
arrived as text, not which state renders it.

Once loaded, an image offers full screen — the ⤢ in its corner, or a click on
the image — in the [media viewer](media-viewer.md#files-and-git-imagepreview),
which zooms and pans it and has no Open in Files, since the file is already open.
A video offers it from a ⤢ at the end of its caption line as soon as it has a
source, carrying on from the same second
([why not the corner](media-viewer.md#files-and-git-mediapreview)); audio
plays in place only.

A `.md` file's text is rendered as Markdown, and an image it names by a
relative path is read from the file's own directory, as on GitHub — see
[markdown-images-ui.md](markdown-images-ui.md#where-the-bytes-come-from).

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
[code/websocket-rpc.md](code/websocket-rpc.md#request-timeout). Nor does it
retry a path the server reported not found (`isNotFoundError`): the answer
will not change a second later, and asking again only holds the reader on a
loading state — a Markdown image naming a wrong path would pulse for seconds
before saying so.

A file as it stood in a commit reuses this same `FileViewState` and `FileBody`,
so a historical binary or oversized blob is described by the same card,
Download included — less the footnote naming why Edit is disabled, which only
makes sense beside an Edit button that screen does not have. That screen's
bottom bar tells the same story — no write action, but Download as here — and
adds one control the viewer above does not have: a toggle that drops text to
plain, which is how a reader gets at a rendered Markdown file's source and the
copy button that comes with it, there being no Edit to open it in. For a page
it is the page/source toggle the viewer above has.
See [git-ui.md](git-ui.md#viewing-a-file-from-a-commit).

### Loading image bytes

An `http` image's bytes are read from the endpoint matching the method that
described it — `file.get` → `/api/files/download`, `git.show.file` →
`/api/git/show/file`, `attachment.get` / `session_view.attachment` →
`/api/chat/attachments` (`lib/imageFetch.ts`). The client keeps that origin
beside the description (`ContentOrigin`) because the server sends no URL. Like a
The read carries the bearer header ([Transfer](#transfer)), so it is a `fetch`
turned into an object URL rather than an `<img src>` pointing at the endpoint; a
`401` logs out.

- **Typed from the description, never from the response.** The endpoint answers
  `application/octet-stream`, so the Blob is retyped to the sniffed `mime` — and
  only to a raster one. Anything else, SVG included, stays octet-stream, so even
  a wrong description cannot produce a same-origin SVG object URL
  ([why SVG matters](#operations)).
- **Read when on screen.** `ImagePreview`, the chat's attachment thumbnails and
  a Markdown image hold the read (and a thumbnail or Markdown image its metadata
  RPC too) until the frame is in view (`useInView`). A transcript can carry
  dozens of screenshots; reading the ones nobody scrolled to would spend the
  connection for nothing.
- **Four at a time, newest first.** Reads go through one limiter,
  `IMAGE_FETCH_CONCURRENCY` = 4 (`utils/limiter.ts`). Through the relay every
  request is a stream on one tunnel capped at 64, the WebSocket included
  ([websocket-rpc-design.md](websocket-rpc-design.md#compression)), and a burst of
  thumbnails must not leave nothing for the rest of the app. A few at a time
  also brings pictures in one by one rather than all slowly together. The queue
  is LIFO: what was asked for last is what the user is looking at now. A read
  whose component unmounted while queued is dropped and never takes a slot; one
  in flight is aborted.
- **Cached beside the description.** A workspace file's Blob lives in
  react-query under its description's key plus `"image"`
  (`hooks/useImageSrc.ts`), so whatever invalidates or drops the description —
  an FS-watch change, a worktree switch, a rename or delete — reaches the bytes
  by prefix with nothing extra to keep in step. A commit's file and an
  attachment never change, so their keys only have to tell one from another. A
  thumbnail, the in-place preview, a Markdown image and the
  [media viewer](media-viewer.md) share one entry, so the bytes are read once;
  the object URL is made per component and revoked on unmount.
- **Retry by status.** A `4xx` — an attachment cleaned up, a path the commit
  lacks — would be refused the same way again, so the failure and a Retry
  action show at once (a card on the preview, the chip on a thumbnail). A `5xx`
  or a network failure (a relay tunnel reconnecting) is retried automatically
  first. A decode failure is a separate card, as before.

An image past the preview ceiling never gets here: it arrives as `too_large`
and takes the `too-large` card like any other oversized file, Download
included.

### Playing audio and video

`MediaPreview` (Files tab and a file in a commit, through `FileBody`) plays
audio and video in place with the browser's own controls. The bytes never pass
through the app: the element loads a single-file [raw
capability](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)
URL (`wsActions.rawCapability`) and streams it with Range requests, so playback
starts before the file has arrived, nothing is held whole, and there is no size
ceiling. The machinery is `components/Media/useMediaPlayback.ts` over
`hooks/useRawMediaSource.ts`, and the [media viewer](media-viewer.md)'s video
stage plays through the same code, carrying on from the same second
([Handover](media-viewer.md#handover)). So does a chat attachment — an audio
entry in place, a video thumbnail's poster — with the attachment as the
capability's origin rather than a path
([tool-call-ui.md](tool-call-ui.md#the-body-problems-2-and-3)): a voice note an
agent was sent is no different, once streaming, from one opened in Files.

- **Asked for when on screen, and connected.** As with an image, nothing is
  requested until the frame is in view. While the WebSocket is down the request
  waits with the spinner up instead of failing: a relay reconnect is not
  something to make the user Retry.
- **One capability per file.** The capability is cached in react-query under
  `"raw-capability"`, the worktree, the origin and the scope (a page's root
  capability reaches the whole tree, so every page of a worktree or a commit
  shares one; with a page's hosts too), and stays fresh until five
  minutes before it expires — so the preview and the viewer share one and the
  server's cap of 256 is not spent per mount. It is deliberately *not* under the
  description's key, where an image's bytes live: the description is
  invalidated every time its FS watch is re-established, which is every
  reconnect, and a new capability is a new `src` that would drop a playing
  video's buffer for a file that did not change. For the same reason it is not
  refetched on focus or reconnect. A file's or a commit's capability is bound to
  the worktree the connection was on when it was issued, and the app's worktree
  moves before the connection does, so those are invalidated once a worktree
  switch has landed (`invalidateWorkspaceCapabilities`, from `queryClient.ts`).
  An attachment's is keyed by the worktree its bytes are read from
  (`useAttachmentOrigin`), so it is not among those.
- **A new capability is the same content.** Whoever renewed it — this player
  recovering, another player of the file, a mount after it went stale — the
  element is put back at the second it was at, playing if the user had it
  playing. Playback position is tracked from `timeupdate`, since by the time
  the new `src` is on the element it already reads 0.
- **A rewrite starts over.** A different file, a worktree switch, or a rewrite
  that changes the size or the type remounts the element: back to the start,
  paused, and a video back to its reserved box. A rewrite that keeps the size
  exactly is not noticed until the player next fails.
- **Expiry is not a failure.** A capability dies after four hours, with its
  login session, or on a server restart, and an element's `error` cannot tell
  that 404 from a file it cannot play (`MediaError` carries no status). So the
  first error is answered by a new capability on the **same** element — which
  keeps iOS's permission to play unmuted — sought back to the second it was at
  and played again if the user had it playing. A `play()` the browser refuses
  leaves it paused at that second, which is not reported — and no longer meant
  to be playing, so a later new source does not start it. A failure again within
  a minute (`RECOVERY_WINDOW_MS`), with playback no further than where it
  resumed, is one a new capability did not cure, and only then is one byte of
  it fetched to say why: bytes served mean this browser
  cannot play them ("can't be played", with Download — and for a `.mov`, a word
  on HEVC), unless the element's own error was a network one
  (`MEDIA_ERR_NETWORK`), when bytes served now say only that the connection is
  back ("Couldn't load", with Retry); the server's `not_found` means the file is gone; anything else is
  "Couldn't load" with a Retry that resumes where it was. No proactive renewal
  before expiry: swapping `src` stutters a playing video for nothing in the
  common case.
- **Never hidden until loaded.** Unlike an image, the element shows from the
  moment it has a source: iOS may load nothing before the user presses play
  (Low Power Mode, its own `preload` policy), and a player kept behind a spinner
  until it loaded could never be started. `preload="metadata"` fetches size and
  length only; there is no autoplay.
- **Video reserves its box.** The description carries no dimensions, so until
  metadata arrives the box is 16:9 (a screen recording, a landscape phone clip)
  within the frame and 70vh; then it takes the video's own shape, contained and
  never enlarged, as an image is (`inlineVideoBox`). The one resize happens
  before any frame is shown, top-anchored, on a screen where only the caption is
  below. The URL carries `#t=0.001` so iOS paints the first frame instead of a
  black box, and `playsInline` keeps an iPhone from taking playback full screen.
- **No picture, still sound.** A video whose metadata reports no size — a codec
  this browser cannot decode (HEVC in a Chromium without it plays sound over
  black, with no error) or a file with no video track — is laid out as audio on
  the same element, with a line saying there is no picture.
- **Captioned** `MOV · 1080×1920 · 0:42 · 38.2 MB` (`formatMediaCaption`, the
  image's caption with a length); a length the file does not state, as a
  MediaRecorder `.webm`, is left out.
- **One sound at a time.** Starting any player pauses whichever one was
  sounding — this preview, the viewer's stage, a chat attachment's audio entry
  (`components/Media/exclusivePlayback.ts`, claimed from `useMediaPlayback`'s
  `play` handler, so every player takes part without opting in), and the
  composer's audio entry, which plays a `blob:` outside that hook and claims
  for itself. Two voice notes talking over each other is never what was meant,
  nor one carrying on under a video just opened. What is told to stop is the
  player, not its element, so one caught mid-swap of its capability does not
  start again once the new one loads. A player off screen keeps playing, as in
  any messenger; one that unmounts stops.

There is no `canPlayType` pre-check: Chromium answers `""` for
`video/quicktime` yet plays most H.264 `.mov` files, so the player always tries.

### HTML pages

An `.html` / `.htm` file opens rendered — a coverage report, a prototype —
in the Files tab and in a commit, through `FileBody` (`Files/PagePreview.tsx`
over `Media/usePageFrame.ts`). Diffs and chat attachments still show text.

- **Which files are pages.** The server settles it: text is `text/html`
  exactly when it is named `.html` or `.htm` ([`mime`](#operations)). The
  client reads only `mime`. A page over the `file.get`
  ceiling still renders, since the frame reads it over HTTP; only its source
  side shows the too-large card, and Edit follows the source.
- **Page or source.** A `ToggleIconButton` (`Code`, "Show source" / "Show
  page") in the bottom bar. In the Files tab it sits after Download and before
  Delete, is kept across files for the screen's lifetime and never persisted,
  and applies only to pages: text opened next is highlighted as usual. The
  source is the ordinary text view, highlighted and editable through Edit as
  before. In a commit the same toggle shares the state of its plain-text
  toggle, which it replaces for a page
  ([git-ui.md](git-ui.md#viewing-a-file-from-a-commit)).
- **Layout.** A page bar (`HTML · 18.2 KB`, ↻ Reload page, ⤢ View full
  screen — the [media viewer](media-viewer.md#files-and-git-pagepreview)) over a frame that
  fills the rest down to the bottom bar; nothing scrolls around it, so the
  page's own scroll is the only one. Between them, when the page was refused
  a host, the strip of hosts not loaded. The frame is a
  wrapper holding the page, both `HTML_FRAME_SANDBOX`, the page
  `referrerpolicy="no-referrer"`, white under a light color scheme, as an
  agent's page is. Links within the project navigate inside it, so a
  report or a site can be browsed — and each page opened there is a Back
  entry of the browser's, which Back steps through before it leaves the file.
  A link anywhere else opens in a new tab.
- **External hosts.** The page reaches the project and no other host
  until the reader allows it: what it was refused, a strip above it names and
  offers to load, and the hosts allowed are bound to the capability the page
  is loaded through. The rule, the strip and the security boundary are
  [page-external-hosts-ui.md](page-external-hosts-ui.md).
- **Through the project's root.** The frame loads a [raw
  capability](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)
  for the root of the worktree or the commit, and the page's URL is the
  capability plus its encoded project path, so its relative stylesheets,
  scripts and images, its `../` links and a script's `fetch("data.json")` load
  what they would on disk (`pageRawTarget`, `pageRawUrl`). The page was written
  by the agent working in the project, which can already read all of it, so it
  is not held to its own folder; what the server withholds — `.git`, `.env`,
  `.envrc` and their `.*` variants, other worktrees, Pockode's data — and why
  only those, is in the link above. Any other dot path is an ordinary file,
  so a build output under `docs/.vitepress/dist` or `.output/public` loads
  its own stylesheets, scripts and images, with nothing said above it.
  Whatever the root scope refuses (`403 outside_scope`: a page reached
  through a link out of the project or to something withheld, one in another
  worktree or in Pockode's data folder, and a page that is itself withheld —
  under `.git`, or named `.env.html`) is shown as a failure that says so,
  with no fallback: the page is to be opened from where it really is.
- **Loading.** The capability is asked for once the frame is in view and the
  WebSocket is up, as for video, with a spinner until then. The frame shows as soon as it has a
  URL, not on `load` — a page waiting on one slow asset may be readable
  already. Until the load the app started finishes, ↻ spins, and stays
  pressable: a page stuck on an asset that never arrives is the one to reload.
- **Never reloaded behind the user's back.** The frame keeps the URL it loaded
  with. A capability renewed elsewhere (the shared cache, a stale one renewed
  by another reader) waits for the next load the app starts: ↻, a rewrite,
  Retry, or a remount. The exceptions are a worktree switch, when the
  capability is replaced because it may serve the worktree left, and a Load in
  this frame's own strip, whose hosts take a capability of their own. ↻ starts over from the
  entry page on a capability that will last: a frame's location cannot be read
  across origins, so the page the user navigated to cannot be reloaded.
- **A rewrite reloads it.** When the description refetched after an FS-watch
  change really differs — the text, or for a page too large to send its size —
  the page loads again. The description is invalidated on every reconnect too,
  and reloading then would throw away the user's place for nothing, so an
  identical one does not. A change to an asset alone is not watched; ↻ covers
  it. A commit never changes.
- **Each app load under the same capability is a navigation of the same
  frame.** Reload and a rewrite have the wrapper load its page again — even
  from the URL it already has — so Back steps back through them as through a
  link followed inside the page. Remounting the frame instead would leave
  entries Back steps onto with nothing visible happening
  ([media-viewer.md](media-viewer.md#history)). A new capability is a new
  frame, because the wrapper's `frame-src` names one capability: a renewal
  after `capability_not_found`, a worktree switch, Retry from a failure card,
  the fallback to a capability for the page alone, a Load of hosts, and ↻ or a
  rewrite once the capability on hand is too old for a new load. Each
  leaves the old frame's entries behind as those silent steps.
- **Expiry.** An iframe reports no errors, so after each load the app started
  the page's URL is probed with one byte (`lib/rawProbe.ts`, the probe video
  uses). `capability_not_found` is renewed once, silently; dying again within
  `RECOVERY_WINDOW_MS` shows "Couldn't load page" with Retry, which asks for a
  new capability. `not_found` shows "File not found". The card replaces the
  frame, and ↻ acts as Retry. Loads from navigation inside the page are the
  page's own and are not probed: one that meets a dead capability shows the
  server's JSON error inside the frame, and ↻ is the way out.

### Downloading

Download sits between Edit and Delete and is available in every state.
`binary` and `too-large` also carry the action on their placeholder card. Those
are the files that cannot be previewed at all, which makes them the ones most
likely to be wanted elsewhere, and a bare icon in the bottom bar is easy to miss
under a card that says the file cannot be shown. A file as it stood in a commit
downloads the same way — the same card action, bottom-bar icon, cancel and
banner, shared through `hooks/useFileDownload.ts`.

Every state downloads the real bytes from the server, never the content already
in hand. Reusing the `text` (or the Blob cached for an image) would save a
request, but it would mean two ways of producing a file and would trust
`IsBinary`'s UTF-8 check to keep being the thing that decides which one runs:
the day a non-UTF-8 file reached the `text` branch, the download would quietly
save a corrupted copy.

**The browser streams the file to disk; the app never holds it.**
`saveRawFile` (`hooks/useRawMediaSource.ts`) gets a [raw
capability](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)
for the file — a `file` or `commit` origin, `file` scope — and clicks a link
to it (`saveUrl`, `lib/fileDownload.ts`). A file can be hundreds of
megabytes, more than a phone's tab survives holding, and a link needs no
`Authorization` header, which is why it is `/api/raw` and not
`/api/files/download` or `/api/git/show/file` ([Transfer](#transfer)). The
media viewer's Save for a video and the chat's Save for audio and video use it
too; a page's Save does the same check and hand-over on the URL its stage
already holds (`saveCheckedUrl`,
[media-viewer.md](media-viewer.md#the-html-stage)). Only an image is saved
from a Blob (`saveBlob`), because its bytes are already in memory to be shown.
It works through the relay as the players do, on the same route.

- **Which capability.** The one the players hold for the file, while it has
  more than 30 seconds to live, so a download does not put a new `src` under a
  playing video; otherwise a new one.
- **Checked before it is handed over.** Once the link is clicked the browser
  owns the transfer and reports nothing back, so one byte is asked for first
  (`Range: bytes=0-0`, `lib/rawProbe.ts`, the probe the players use; an empty
  file answers `200`). A dead capability (`capability_not_found` — expired,
  evicted, or its session ended) is renewed once, silently. Any other failure
  — the file gone, not a file, out of scope, the server or relay out of reach
  — is thrown before anything is saved, worded from the response `code` where
  there is one (`readError`) and otherwise from the status or the network
  error, so it is never left to fail out of sight or be saved as an error body
  under the file's name.
- **Asked for as an attachment.** The link names the file with its
  `download` attribute, which works because the URL is same-origin in every
  deployment. It also carries `?download=1`, so the server answers
  `Content-Disposition: attachment` ([the endpoint](#transfer)): a browser that
  ignores the attribute — a dev build pointed elsewhere by
  `VITE_API_BASE_URL`, or a type it would rather preview — still saves rather
  than opens it, named by the URL's last segment.
- **From the worktree it was pressed in.** A capability for a file or a commit
  reads from the connection's worktree, and one asked for during a switch may
  still be bound to the worktree being left; `raw.capability` says which
  ([why](code/websocket-rpc.md#raw-capabilities)). `saveRawFile` notes the
  store's worktree when it starts and uses only a capability bound to it: one
  bound to another is renewed once, and still wrong after that fails with
  "The worktree is still switching. Try again in a moment." A switch made while
  the save is being checked fails it with "The worktree changed before the
  download started." (in the Files tab the switch cancels it first, as
  navigating away does). It never saves the same path from the other worktree
  under this one's name.
- **A link out of the project is not downloaded.** A capability never follows
  a symlink out of the work directory, so such a file is refused with
  `outside_scope`, worded "This file can't be read from here — it may link to
  outside the project, or not be readable". That is the capability's boundary
  ([Security](#security)), kept rather than worked around through the bearer
  routes, which do follow the link.

**Progress and cancelling belong to the browser.** The spinner that replaces
the icon, and "Cancel download" on a second click, cover only getting the
capability and the one-byte check. From the click on, progress, cancelling and
retrying are in the browser's own download UI (iOS Safari asks first). The app
shows no byte progress, deliberately: JS cannot see a transfer it does not
hold, and holding it is what this avoids. A failure after the hand-over — the
connection dropping mid-transfer — is the browser's to show. For the same
reason there is no size confirmation: nothing is held in memory, and an
interrupted download is the browser's to resume or retry: the route serves
`Range` and a validator (`Last-Modified`, or an `ETag` for a commit's file), so
a browser that resumes can, while the capability lives.

Navigating to another file cancels a download still being checked, rather than
letting it reach the browser and save the file the user has left; neither
cancel reports anything, since both are the user's own doing. Failures share
one banner with Delete (`actionError`) rather than stacking a second error bar,
and name the cause from the response `code` — except `internal`, which keeps
the server's technical detail, a fault the user cannot act on being the one
where detail matters most.

The download is one streamed `GET` from a file the server has open, with no
check that the file stayed the same throughout. A save that replaces the file
(write to a temporary file, rename over) leaves the download reading the old
content whole, where an open file can be renamed (Linux and macOS); a rewrite
in place while it runs can save a mixture of the two versions
([Known transfer limits](#known-transfer-limits)).

## Entry actions

Every row of the tree keeps its one obvious gesture — a folder expands or
collapses, a file opens — and everything else hangs off a `…` button at the end
of the row. The project root has no row, so its `…` sits in the search bar; it
stays usable under search, where the tree is hidden but the target is not in
doubt. The one action that is not in the menu is [moving](#moving), which is
the row itself dragged onto a folder, on a desktop only. The same drag let go
outside the browser saves the entry there
([Dragging out to download](#dragging-out-to-download)), in Chromium only — an
addition to the menu's and the viewer's downloads, never the only way to one.

The `…` is a **sibling** of the row button, never nested in it: nested, every
tap on it would also open the file or toggle the folder. That split is why the
row's highlight, hover and indentation live on the wrapping `div` rather than on
the row button — on the button they would stop short of the `…` and leave a
notch out of the active row and the drop target. `data-entry-path` stays one
level further out still, on the node's own wrapper, so a folder answers for its
whole subtree (see [Dropping files onto the
tree](#dropping-files-onto-the-tree)). The button is drawn at all times on a
touch screen, which has no hover to reveal it with; where a pointer can hover
(`pointer-fine:`) only its opacity changes, so the file name beside it never
reflows. That gate used to be `md:` — a viewport width, which says nothing about
hovering, so the button was invisible on a tablet and the menu unreachable
([responsive-ui.md](responsive-ui.md#progressive-disclosure-hover-reveal)).

Both `…` buttons are monochrome inline icon actions — L5 in
[sidebar-ui.md](sidebar-ui.md#visual-weight): 36px of box, grown to a 44px hit
area where a finger might land.

The menu itself is a `Sheet` — a bottom drawer on a phone, a centered modal on a
desktop — and there is exactly one, mounted by `FilesTab` for whichever entry is
current, rather than a portal per row. The project has no popover to build a
dropdown on, and one anchored to a row of a scrolling tree would mean
positioning, flipping and scroll tracking for a menu opened a few times a day; a
sheet is anchored to the viewport instead, so none of that arises. A folder
offers upload, new file, new folder, download as zip, rename and delete, a file
offers rename and delete, and the root offers everything but those last two — it is the work
directory itself rather than an entry of the file namespace, so neither renaming
nor deleting is ever about it. Delete is last, `text-th-error`, and separated by
a rule: everything above it adds to the entry or leaves it where it is, and it
is the one item that takes the entry away.

Focus comes with the sheet. `Sheet` takes focus on open — onto the dialog box
itself, so the title is read before anything else and the close button is not
what a stray Enter presses — cycles Tab within itself, and hands focus back to
the `…` when it closes. None of that is written here: it belongs to every sheet
in the app, so one menu patching it in would be a second implementation to
disagree with the first. `EntryNameDialog` still focuses its own field, which
takes precedence over the box.

The upload item opens the tab's own hidden `<input type="file">`, not one inside
the menu: the sheet unmounts the moment an item is chosen from it. `click()` is
called in the same synchronous stack as the tap, before anything is awaited, or
iOS Safari refuses to open the picker.

### Creating

`EntryNameDialog` names the entry in a sheet rather than inline in the tree. An
inline row means a ghost entry threaded through the recursive tree, its own
indentation and scroll-into-view handling, and on a phone the keyboard tends to
come up over exactly the row being typed into.

**A name already taken is refused twice, and the server is the real defence.**
The client checks the destination's cached listing plus the names queued
uploads have claimed, and disables Create with the reason under the field. That
check is for the immediate answer only: a folder that has never been expanded
has no listing, so the dialog fetches one when it opens and holds Create with a
spinner until it arrives — and even then the listing can be stale. `file.create`
refuses an existing path outright, which is what makes the guarantee.

The server's refusal is shown **inside the dialog, under the field**, with the
typed name still in it, so the user types another and retries; dropped into
the tab's error bar it would arrive with the dialog and the name gone. Only
already-exists is handled that way — any other failure is about the request
rather than the name, and leaves with the dialog for the error bar. Empty
names, `/`, `.` and `..` are refused client-side.

On success the destination's listing is invalidated and the folder is forced
open through `forceOpenPaths`, consumed by the same kind of effect as the drag's
`springOpenPath`. It cannot reuse `expandSignal`, which only opens the ancestors
of the file currently being read. It is a list because a move can need two
folders open at once, and every request is a new array: the effect runs on the
array's identity, so asking for the same folder twice still reopens one the user
collapsed between two creations.
A new file is **not** opened automatically: on a phone that would replace the
sidebar the user is still working in.

### Renaming

The same `EntryNameDialog`, in `mode="rename"`: create and rename ask for one
name under one set of rules, and two components would eventually give two
answers to "is this name legal here" — with the one the user meets second being
the wrong one. What differs is the title, the button, and that the field starts
on the current name with the **stem pre-selected**: `report.final.md` opens with
`report.final` selected, so the common edit costs no aim. A folder, a name with
no extension, and a dotfile (`.gitignore` is a name, not a suffix) are selected
whole. A name left unchanged disables the button and says **nothing** — there is
no error to report in a sheet the user has only just opened.

**Renaming is not moving**: a name with a separator in it is turned down here
exactly as it is for a new entry, by the one rule the shared sheet applies. Why
a name and not a path is the server's reason, written once under
[`file.rename`](#operations).

**Two entry points, deliberately.** The tree row's `…`, and the file viewer's
bottom bar (`Edit → Rename → Download → Delete`, four 44px targets and their
gaps fitting the narrowest phone). The viewer's is not a convenience: a search
result row has no `…`, and a file opened from a chat link has no row at all, so
without it those files could be deleted but not renamed. Search rows are left
without a `…` on purpose — in content mode that slot already holds the match
count, and every result carries a path the rename is about to invalidate
anyway. There is no double-click-to-rename and no F2: the tree has no inline
editing to build on and the app has no shortcut system, so either would be a
second behaviour to maintain that only a mouse could reach.

**A file open in the editor cannot be renamed, nor can any folder above it.**
The row stays in the menu, `aria-disabled` with `Close the editor first.` under
it, because a control that is simply absent teaches nothing. The test is
`isAtOrUnder(activeFilePath, entry.path)` with `activeFileEdit`, threaded from
`AppShell` — deliberately coarse: whether the editor is *on screen*, not whether
it has unsaved text. The dirty flag belongs to the editor, and lifting it
through the shell to gate one menu row would run a state line across the app for
an edge case. **This is knowingly inconsistent with delete**, which closes the
editor instead: there the file really is gone, so closing is the only option,
while a rename takes nothing away and pulling the path out from under a buffer
being written to is a choice we decline to make. It is not an oversight to fix.

On success `applyEntryGone` does the cache work, which is described under
[Deleting](#deleting) because it is the very same work: the cache cannot tell a
rename from a delete, since either way the old name is not there any more.
Nothing is prefetched under the new path, and a renamed file is not opened.

A renamed **folder collapses**: `FileTreeNode` keeps `isExpanded` in component
state and the list is keyed by `entry.path`, so the new name is a new component.
`FilesTab` answers with `forceOpenPaths([newPath])`. Its children's expansion is
still lost, and that is accepted — carrying it across would mean lifting
expansion into a path-keyed store, which is a rework of the tree's state
ownership for an occasional action. A renamed *file* needs nothing: the folder
it is in is open by definition, since the row the rename started from was
visible. None of this reaches the viewer's entry point, which renames a file and
only a file — a folder has no viewer — and leaves the tree's expansion alone,
the user being in an overlay in front of it.

**The viewer is redirected, not closed.** If the file on screen is the one
renamed, or sits under a renamed folder, `FilesTab` calls `onRepointFile` with
the path's prefix replaced, and `FileView` navigates to the new path after its
own rename. Closing is right for a delete and wrong here: nothing was lost, and
closing would say otherwise.

`onRepointFile` is a separate prop from `onSelectFile`, threaded from `AppShell`
alongside `onCloseFile`, and the difference is load-bearing twice over.
`SessionSidebar` wraps its own `onSelectFile` in "and close the drawer", which
is the right answer to a tap on a row — the user asked to read that file — and
the wrong one to a rename, which would take the tree out from under someone who
only asked to change a name. And the navigation **replaces** rather than pushes:
nobody navigated, so a pushed entry would do nothing but point Back at a path
that no longer resolves.

Two consequences are left alone. A download the browser already has keeps
reading the file the server opened, where the system lets an open file be
renamed (Linux and macOS), and is saved under the old name; one still being
checked is cancelled by the repoint, silently, as navigating away cancels it
([Downloading](#downloading)).
Uploads still queued for a renamed folder get `not_found` on their own rows and
can be retried from there, exactly as they would if the folder had been deleted.

Failures split as they do for [a creation](#creating), with one thing added:
the bar the rest of them land in is the one belonging to where the rename
started — `FilesTab`'s or `FileView`'s, never a third one.
`isAlreadyExistsError` is the one place that sentence is matched;
`file.create` sends the same one, so without it a creation and two rename entry
points would each hold their own copy of the phrase to drift apart. It matches
the message as a **suffix**, because "already exists", "not found" and "invalid
path" all arrive as `InvalidParams` and there is nothing but the sentence to
tell them apart.

The client lets `README.md` → `readme.md` through — the new name is not in the
taken set, being a spelling of the entry's own — and the server accepts it, so
nothing is refused for a case change any more. What the client still cannot
answer for itself is a *different* name that only a case-insensitive filesystem
considers taken (`notes.md` while `Notes.md` exists): it does not know which
kind of filesystem it is talking to, and it never learns, so the server's words
in the sheet stay the only honest answer there.

One more thing the client gives up on rather than guesses: a listing that
**fails** to load leaves the taken set empty instead of holding the button
behind its spinner. Null means "still coming", and waiting forever for an answer
that will not arrive would make naming anything in a folder that cannot be
listed impossible. The local check is the immediate answer only; `file.create`
and `file.rename` were the real defence all along, and their refusal lands in
this same sheet under this same field.

### Moving

On a desktop, a tree row is moved by **dragging it onto a folder**, or onto
anywhere that means the project root. There is no menu item for it, so a touch
screen still has no way to move an entry, and neither does a keyboard; a
`Move to…` item with a folder picker would cover both and is left for later.
Until it exists the drag is the only path to a move, which makes it a P1 that a
coarse pointer goes without — an exception to
[responsive-ui.md](responsive-ui.md#what-may-be-hidden-three-levels), where a
drag is only ever a P2 beside a control that stays.

**The drag is aimed exactly as [a file drop](#dropping-files-onto-the-tree)
is**, through the same `useFileDrop`: a folder row or its subtree is that
folder, a file row its parent, anything else the root; hovering a folder for
700 ms opens it; resting at an edge scrolls. The folder under the cursor takes
the same fill, and the docked bar reads `Move <name> to <folder>` with a
`FolderInput` icon instead of `Upload to …`. The panel takes **no ring**: the
ring says "files from outside", and a drag that started in the panel needs
nothing to show where the panel is.

**The source** is the row's highlight `div` in `FileTreeNode` — the same element
that carries the drop fill — so the drag starts anywhere on the row, the name
button and the `…` included. A drag never fires `click`, so a press still opens
the file or toggles the folder; both were checked in Firefox 157 and Chromium
156, Firefox having once refused to start a drag from a `<button>` inside a
draggable element. The row is `draggable` only where `FilesTab` passes
`onEntryDragStart`, which it does only with a fine primary pointer
(`useHasFinePointer`), the same gate as the step reorder handle: on a phone a
long press is a scroll or a menu, and stays one. A row whose
move is still in flight is not draggable, nor is anything inside it, and it
and its subtree stay at half opacity from `dragstart` until the move is
answered; the dimming is applied a task after `dragstart`, because a commit
landing before the browser's snapshot would fade the drag image too. Search
results are not draggable: they have no tree to be dropped into.

`lib/entryDrag.ts` (`writeEntryDrag`) is **the one place what a row's drag
carries is written**: the entry's path and type under
`application/x-pockode-entry`, with `effectAllowed = "move"` — and, in Chromium
with a capability on hand, a `DownloadURL` and `effectAllowed = "copyMove"`
([Dragging out to download](#dragging-out-to-download)). Nothing else: no
`text/plain` and no `text/uri-list`, because with either a row let go over the
chat composer or the search field would type itself in. The tree's own
`dropEffect = "move"` holds whichever `effectAllowed` it is.

**Telling a move from an upload** is by type and by origin. A drag carrying the
row type is never an upload, whatever else is listed beside it: a browser may
list `Files` for the file a `DownloadURL` would save, so `carriesFiles()`
(`hooks/useFileDragZone.ts`) answers no for it, and the tree's upload path and
the chat's drop zone let it pass. `useFileDropGuard` refuses it, as it refuses
files, anywhere no zone claims it, so nothing it lists can be opened over the
app. An outside drag never carries the row type. The tree takes a row drag only
while `FilesTab` holds a **drag source** — recorded at `dragstart`, because
during `dragover` a page can read a drag's `types` and nothing else — so a row dragged from another Pockode window or tab
is nobody's here: nothing claims it, the cursor says not allowed, and letting
go does nothing. The source is kept in a ref beside the state, since the zone
asks about it from drag events that can arrive before the render `dragstart`
set off. It is cleared by the row's own `dragend`, listened for on the row
itself from `dragstart`: a browser sends it there however the drag ends, and
when the row has left the page under the drag — its folder refreshed — it is
still sent there but bubbles nowhere, so a listener on the window would never
hear it (checked in Firefox and Chromium). The zone's own resets do not clear
it, since a drag that leaves the panel may come back.

**What is turned away**, said on the bar in its refusal look, with
`dropEffect = "none"` and no hover-to-open, first reason first:

| Case | Bar |
|---|---|
| The source is the file open in the editor, or a folder above it — wherever it is aimed, by the same rule as [renaming](#renaming) | `Close the editor first` |
| The source or the destination is at or under an entry whose move is still in flight, and so about to be somewhere else | `Wait for the move in progress` |
| A folder onto itself or anything inside it | `Can't move a folder into itself` |
| The folder the entry is already in — for a file, its own row and its sibling files | `Already in src` / `Already in project root` |
| A destination whose listing (or upload queue) already has the name | `src already has a.md` / `Project root already has a.md` |

Whether a drag is taken is asked **per target**, on every `dragover` and again
at the drop, where uploads decide once per drag. The name check reads only
what is already on hand — the cached listing and the upload queue, through the
`useTakenNamesIn` the naming sheets use — so a folder never expanded is left to
the server.

**On a drop** `file.move` is sent with no confirmation and no optimistic
update: a move overwrites nothing and is undone by dragging back. On success
`applyEntryMoved` (`lib/fileCache.ts`) does what `applyEntryGone` does for the
old path and invalidates the destination's listing too, which a rename never
needs. The destination folder is forced open, so a quick drop on a closed folder
does not look like the entry vanished; a moved folder that was open when it was
picked up is reopened at its new path, its top level only, as after a rename. A
file being read at or under the moved path is followed with `onRepointFile`,
exactly as a rename follows it. Uploads still queued for a moved folder get
`not_found` on their rows, as after a rename or a delete. A move answered after
a worktree switch is dropped, success or failure: it is about the other tree,
whose paths may be spelled the same as this one's, and the switch refetches
every listing anyway.

**A failure** lands in the tab's error bar as `Move failed: <server message>`,
and both the source's parent and the destination are **refetched**. Every
refusal — the name taken, either folder gone, a folder into itself — means one
of the two listings was out of date. Refetching both makes the tree agree with
the banner whichever it was, without branching on the reason or matching any
text. There is no Replace
or Keep both: replacing by drag would be destructive and easy to do by
accident, and renaming first is always there.

### Deleting

`ConfirmDialog` (`variant="danger"`) asks first, naming the full path. A
folder's message says "and everything inside it" — `file.delete` is
`os.RemoveAll`, and recursion has to be in the words rather than only in the
handler.

Afterwards `applyEntryGone` invalidates the parent's listing so the row
disappears, **removes** every `contents` query at or under the deleted path
rather than invalidating it — those listings are about something that is gone,
and refetching them would collect one "not found" per folder — and invalidates
the whole file search cache, because every result carries the path it was found
at and a stale list is one that opens nothing.

All of them go through that one function: the tree's delete, the viewer's
delete, [a rename](#renaming), and [a move](#moving), whose `applyEntryMoved` is
this plus the listing it landed in. Splitting the work per action is what let a
rename invalidate the search cache while a delete did not, and what let the
viewer's delete invalidate the *root* listing instead of the folder the file was
actually in — which left the deleted row on screen in every folder but the root.
The cache has no notion of why a path is vacant, so it is asked one question.

If the file being read was the one deleted — or sat inside the deleted folder —
`FilesTab` calls `onCloseFile`, threaded down from `AppShell` through
`SessionSidebar`. `FileView` reads the cache under the file's *own* path, which
invalidating the folder around it does not touch, and the overlay belongs to
`AppShell`; without that call the viewer would go on showing a file that no
longer exists.

A failed delete has no sheet to stay in and no name to be answered by, so all
of them land straight in the Files tab's single error bar (`actionError`,
shared with uploads) — the same bar a creation's other failures leave for.

### Downloading a folder

**Download as zip** (`FolderDown`) is the last row of a folder's group in the
`…` menu — after Upload files, Upload folder, New file and New folder, above
Rename — for every folder and for the project root. It changes nothing, so it
stays above Delete's rule. It is the only way in: search results list only
files, and no viewer or chat surface shows a folder. Unlike Upload folder it is
offered on a touch screen too: it needs no picker and no drag, and a phone can
save a zip. Files get no menu row; they keep the viewer's
[Download](#downloading).

It works as a file's Download does, through a raw capability and a link the
browser streams to disk (`saveRawFolder`, `hooks/useRawMediaSource.ts`), for the
same reasons — an archive can be far larger than a tab survives holding, and a
link carries no header. What differs:

- **A `folder` scope**, asked for afresh each time (`wsActions.rawFolderCapability`,
  `lib/rpc/raw.ts`): `raw.capability` with `{ origin: "file", scope: "folder", path }`,
  `""` for the root. It is an action of its own rather than another
  `RawTarget`, because nothing plays it and Download as zip caches none; with
  no cached one there is nothing to renew either. (A row's drag holds one of
  its own, apart from this —
  [Dragging out to download](#dragging-out-to-download).)
- **Checked with `HEAD`** (`probeArchive`, `lib/rawProbe.ts`), not the one-byte
  probe: the archive ignores `Range`, so that `GET` would make the server build
  the whole of it. A refusal to a `HEAD` has no body, though, so only a refused
  one is asked again with a `GET` (`probeRaw`), whose body names the `code`;
  without it every failure would read as a bare status. A download that
  succeeds never sends that `GET`.
- **Named by the server.** The link's `download` attribute is left empty, so
  the file takes the `Content-Disposition` name (`<folder>.zip`, the work
  directory's own name for the root), which the client does not know.
- **Worded for a folder.** `FOLDER_ERROR_MESSAGES` (`lib/fileDownload.ts`)
  replaces only `not_found` ("Folder not found — it may have been moved or
  deleted") and `worktree_not_found`. Every other code keeps the server's own
  message, which names the folder and the limit: `too_large`,
  `too_many_entries`, `conflict`, `not_a_directory`, and `invalid_path`
  deliberately — its message says which name to rename, or that the folder
  links out of the project, where a file's "Invalid file path" would hide it.
  `internal` stays `Server error: <detail>`, as for a file.
- **The worktree** is held as `saveRawFile` holds it, with the same two
  messages: a capability bound to a worktree a switch is leaving, or a switch
  during the check, fails rather than saving the other worktree's folder.

**Preparing** lasts from the tap to the hand-over, and the sheet stays open for
it: the row's icon becomes a spinner (`MenuRow`'s `busy`), its label **Cancel
download**, its description **Preparing zip…** — the viewer's model, with the
feedback where the user tapped. The download hook (`useFolderDownload`) lives
inside the sheet, so pressing the row again, closing the sheet any way, or a
worktree switch (which closes it) all cancel it, and say nothing, as leaving a
file's download does. A cancelled download reports nothing even if its
`raw.capability` call — which cannot be cancelled — fails afterwards; that
holds for a file's too, through the shared core. The sheet covers the page, so
only one folder can be preparing at a time.

**Handed over**, the sheet closes by itself, with no toast and no progress of
the app's own: from there progress, cancelling and completion are the
browser's, which shows bytes received with no total (iOS Safari asks first). A
failure before the hand-over closes the sheet too and shows in the tab's
`actionError` banner, shared with Delete and upload, prefixed `Download failed:`
like a file's. A failure after it — a dropped connection, a file that fails
mid-read — is the browser's to show, and shows: the server
[aborts the connection](#folder-archive) rather than finish a zip that looks
complete. There is no resume; the retry is pressing Download as zip again.

There is no confirmation, for a file's reason: nothing is held in memory, the
browser lets the user watch and cancel, and a folder that is too large gets a
refusal naming the limit. Downloading the root will often meet that limit —
`node_modules` and build output are included — and that message is the answer.

### Dragging out to download

On a desktop, in a Chromium browser, a tree row dragged **out of the browser**
— onto the desktop, a file manager, another app — is saved there. It is the
[move](#moving) drag, not a second one: the same row, the same `dragstart`, the
same gate (a fine primary pointer), so a touch screen has none of it. It adds
nothing a user needs: a file still has the viewer's [Download](#downloading)
and a folder [Download as zip](#downloading-a-folder), which work in every
browser, so this is a P2 shortcut beside controls that stay
([responsive-ui.md](responsive-ui.md#what-may-be-hidden-three-levels)).

**What is saved** is what the menu's and the viewer's downloads save:

- **A file** — its bytes, under its own name.
- **A folder** — the zip [Download as zip](#downloading-a-folder) builds, named
  `<folder>.zip`, the name the server's `Content-Disposition` gives it.

**How.** Chromium reads a non-standard drag type, `DownloadURL`, as
`<mime>:<file name>:<absolute URL>`, and when the drag is let go outside the
browser it fetches the URL itself and saves the response there.
`writeEntryDrag` adds it beside the row type, with
`application/octet-stream` for a file and `application/zip` for a folder, and
the same [raw capability](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)
URL with `?download=1` (`attachmentUrl`, `lib/fileDownload.ts`) that the
download links click. It widens `effectAllowed` to `copyMove`, since a drop
outside the browser is a copy; inside the tree `dropEffect` still says move. A
row whose name contains `:` gets no `DownloadURL` — Chromium would end the name
at it and take the rest as the URL — so it only moves.

**No new credential.** The URL is a raw capability of the same scope a
download link uses: `{ origin: "file", scope: "file", path }` for a file,
`{ origin: "file", scope: "folder", path }` for a folder. It carries no bearer
or session token, lives 4 hours, and ends with the session that asked for it
([authentication](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)).

**Asked for on the press, because `dragstart` cannot wait.** A drag's data has
to be written before `dragstart` returns, and a capability is an RPC away. So
the row's `pointerdown` — primary button, draggable rows only, not on the
`…` — asks for one (`prepareDragDownload`, `hooks/useRawMediaSource.ts`), and
`dragstart` takes whatever is already on hand (`heldDragDownloadUrl`). Nothing is on hand when
the drag began before the answer came (a quick drag over a slow relay), the
WebSocket was down, or the call failed; that drag only moves, and the next
press on the row has one. The failure is deliberately not reported: the press
may be only a click, and the move works either way. Asking per press, not per
row shown, keeps merely seeing the tree from asking for anything.

**Its own cache entry, trusted for 5 minutes.** A capability for a drag is held
under `["raw-capability", "workspace", <worktree>, "drag", <type>, <path>]` —
beneath the workspace key, so a worktree switch drops it with the rest. It is
apart from the players' entry for a file, so renewing one never swaps a playing
video's `src`. Unlike Download, which probes first, a drag hands its URL over
unchecked — nothing can be asked between `dragstart` and a drop outside the
page — and the server forgets capabilities long before they expire: on a
restart, when its cap evicts the oldest, when the session ends. So a drag
uses one only within 5 minutes of asking for it (`DRAG_TRUST_MS`), bound to the
worktree shown and with more than 30 seconds left to live; a press after that
asks again. That costs at most one capability per pressed row per 5 minutes; a
pressed video can hold two, the player's and the drag's.

**Never an upload when it comes back.** Let go over the tree, the drag is a
move; over the chat, or anywhere else in the app, `useFileDropGuard` refuses it
and nothing opens — whatever the browser lists beside the row type, `Files`
included ([Moving](#moving)).

**Where it works.** In Chromium browsers (Chrome, Edge, Brave, Opera, …) on a
desktop, and nowhere else:

| Browser and platform | Dropping outside the browser |
|---|---|
| Chromium on Windows, macOS | Saves the file there |
| Chromium on Linux, X11 | Saves the file only where the target speaks XdndDirectSave (XDS), which some file managers do |
| Chromium on Linux, Wayland | Unverified |
| Firefox, Safari | Nothing happens; the drag only moves, as before |
| Touch screens | No drag at all |

There is no feature to detect, so the browser is named (`canDragOutDownload`,
`lib/entryDrag.ts`): a `Chromium` brand in `navigator.userAgentData`, or
`Chrome/` in the user agent string where `userAgentData` is missing — outside
a secure context, such as a server reached over plain HTTP by its address.
Elsewhere no capability is asked for on a press and none is put on a drag,
where it would travel along and save nothing.

**Everything after the drop is the browser's.** No spinner, no cancel, no
banner of the app's own: the drop happens outside the page, which hears nothing
about it, and there is no probe first as Download has. Progress shows in the
browser's download list, and so does every failure — a folder that is
`too_large` or has `too_many_entries`, a capability the server forgot, an entry
since moved or deleted — as the browser's generic failed download, with none of
the app's wording. Download and Download as zip are where to go for the reason.

**What it exposes**, accepted as the cost of `DownloadURL`: while the drag is
in progress the capability URL is in its data. A row deliberately dropped onto
another web page can be read there (`getData("DownloadURL")`), as a link
dragged there could; on macOS the system's drag pasteboard may keep it after
the drag ends; and a folder's URL is the whole folder's zip, for as long as the
capability lives. A drop onto the desktop or another app hands over the file
Chromium downloaded, not the URL. Not checked in a real browser yet: an actual
drop onto a desktop or file manager, and whether Chromium lists `Files` on a
drag that carries a `DownloadURL` — the code holds either way.

## Uploading

**The destination is decided at the moment the upload is asked for, and never
before.** There are two ways to ask, and each carries its own answer to "into
which folder":

- **A folder's `…` → Upload files** (the project root's `…` for the top level),
  or **Upload folder** beside it where a folder picker is offered
  ([below](#dropping-a-folder)).
  The destination is the entry the menu was opened from, handed straight to
  `uploadInto`; the picker it opens is the tab's own hidden input, for the
  reasons in [Entry actions](#entry-actions). This is the only entry point a
  touch screen has — there is no HTML5 drag there — and the only one reachable
  from a keyboard or a screen reader anywhere.
- **Dropping files on the tree**, where the destination is whatever the cursor
  was over (see below).

Neither one leaves anything behind. There is no selected folder, no upload
button carrying a target, and nothing in the tree marks a folder as "where
uploads go" — the only accent a row can take during an upload is the drop-target
fill, which lasts exactly as long as the cursor is held over it.

This replaced a `uploadDestPath` that a folder tap set and a button then aimed
at. That state had to be shown (a left bar and an accent icon on the row, a dot
on the button), had to survive a worktree switch and a deleted folder, and still
told the user nothing at the moment it mattered — the destination was chosen far
from the tap that sent the files. A menu item that says `Upload files` inside a
sheet titled with the folder's name answers the same question at the point of
asking, and costs no persistent state, no second row highlight competing with
the file being read, and no icon whose meaning was "look elsewhere for the real
answer".

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
rather than the row itself, so a folder answers for its whole subtree.

The app has two drop zones, this tree and the chat
([agent-chat.md](agent-chat.md#attaching-by-drop-or-paste)), and what they have
in common is one hook, `useDragZone` in `hooks/useFileDragZone.ts`, which the
chat takes as `useFileDragZone`. `useFileDrop` is that hook plus the aiming,
the spring-loading and the edge scrolling below, for files and for
[rows moved within the tree](#moving) alike: the zone is told which drags it
tracks, what letting go would do at each target, and what a drop hands over. Four things
about drag and drop are not optional; the counter and the resets are the shared
hook's, so the chat has them too:

- **A zone tracks a depth counter, not the events.** Each child bubbles a
  `dragenter`/`dragleave` pair of its own as the cursor crosses it, so switching
  on the events themselves flickers on every row.
- **`useFileDropGuard` is mounted on `AppShell`.** A file released anywhere
  outside a drop zone would otherwise be opened by the browser, replacing the
  whole app — not an edge case, but what happens every time someone misses. It
  sits on the root route component and not on `MainContainer`, which only exists
  once a session has resolved: the password screen, the loading screen and the
  "can't reach the server" screen are all droppable too. It runs in the
  **capture phase** so a real drop zone, whose handler runs later on the way
  back up, can still claim the drag — `dropEffect = "copy"` to take it, `"none"`
  to keep it while saying why not; everywhere else, including the sheets the
  chat raises, the cursor keeps the "not allowed" mark.
- **A zone also resets on the window's `drop` and `dragend`**, because a drag
  that ends outside the window never delivers its last `dragleave` and the
  counter alone would leave the zone lit up. The counter can also run one too
  high inside the window: an element removed from under the cursor never
  delivers its `dragleave`, which a streaming transcript does all the time. So a
  `dragleave` whose `relatedTarget` is outside the zone ends the drag whatever
  the count says, and one whose `relatedTarget` is null ends it once a second
  passes with no `dragover` — browsers repeat `dragover` every few hundred
  milliseconds while a drag rests, so a drag still there always answers in time.
  The first check is only for a zone that owns just its own DOM (the chat's
  `ownDomOnly`): the tree treats its portals as part of itself, and they are
  outside its element.
- **The drop bar, the queue and the error banner are `pointer-events-none` while
  a drag is up.** The cursor crossing one would otherwise resolve the
  destination back to the root while the bar still read `Upload to src`.

Two affordances exist because a drag cannot click or scroll. **Hovering a folder
for 700 ms opens it** — otherwise a collapsed folder could never receive a drop
— and it never closes again, since a folder snapping shut under the cursor would
move every row below it. **Resting near the top or bottom edge scrolls the
tree**; the scroller is the tree's own box (`treeScrollerRef`), not the window.

**Three states refuse a drop outright**, saying so on the bar rather than aiming
it somewhere:

- **Search results.** A flat list of matches from everywhere has no answer to
  "into which folder".
- **An open conflict dialog.** It is a portal, and a portal's events still
  travel the React tree, so its overlay stops clicks but not drops. (The chat
  meets the same trap from the other side and answers it with `ownDomOnly`,
  ignoring every drag whose DOM target is outside its element.)
- **A folder still being read** — the same one-slot rule as the dialog
  ([Uploading a folder](#dropping-a-folder)).

**An unanswered dialog turns away every batch, whatever it arrived through.** A
drag has already been turned away on the bar; every other way in is refused
inside `uploadInto` and answered by the banner. There is one place to hold a
batch awaiting an answer, so a second one would take the first's place without a
word and drop the files it was holding. Refusing it where every batch passes
through is what covers the entry points a modal cannot stand in front of: the
root's `…` is behind the overlay, but a few presses of Tab reach it, and the
picker it opens has no overlay in its way at all. The dialog has no focus trap,
and neither does the shared `ConfirmDialog` the rest of the app confirms with,
so escaping a modal by keyboard is long-standing behavior across `web` and
`web-cluster` alike rather than anything this path introduced. It is known and
tracked on its own; what is closed here is what escaping could cost, not the
escaping itself.

The banner says the picked files were not uploaded, since they are gone from the
picker and would otherwise be looked for in a queue they never reached, and it
clears itself the moment the answer arrives — it was an instruction, and one
still standing afterwards would read as an answer that did not register. Only
that one clears: anything else the banner says — a create or a rename that
failed, say — is still true after the dialog is closed.

A dropped folder is uploaded with its structure, below.

Visually the panel takes a **ring**, not a border — a border takes a pixel from
the layout and would nudge the whole tree sideways the moment a drag arrives —
and the folder under the cursor takes an accent *fill*, where the standing
destination takes only its left bar. The difference in kind is the point: the
fill is answering a cursor that is moving right now, the bar is a state that
holds until it is changed.

**One request per file** (`lib/fileUpload.ts`) — a folder is one request of
its own, [below](#dropping-a-folder) — though the endpoint accepts any number of
parts. Progress is reported for a request as a whole and could not be
attributed to a file inside it; `overwrite` applies to a whole request, so a
mixed decision has to be split anyway; and a failure then belongs to the one row
it is shown against. It also makes the non-transactional upload moot in
practice — but a `written` entry naming the file is still read as success, since
a body cut short after that file was stored in full would otherwise ask the user
to send it a second time.

`XMLHttpRequest`, not `fetch`: `fetch` reports nothing while a request body is
going out, and `xhr.upload.onprogress` is what the per-file progress bar is made
of. Authentication is the same `authHeaders()` an image read uses, and a `401`
ends the session the same way.

**Three files at a time** (`uploadStore.ts`). A browser allows six connections
per origin and the tree, the search and every file read compete for them, so
uploads must not take the pool. Three overlaps the round trips, which is the
part worth overlapping. The relay does not change the number: each request gets
its own yamux stream whose body is forwarded as it arrives, so concurrent
uploads behave there as they do locally.

**Size is checked before sending, against the `auth` reply's
`max_upload_size`** — never the `413`'s `limit`, and never a constant. It saves
a slow link the cost of sending a file the endpoint will refuse, and the `413`
stays the backstop on every route, relay included ([Transfer](#transfer)). It is
read from the store at each attempt rather than captured once, so the value in
force is always the one the current connection was told. A file refused this way
is never offered a retry: it cannot get smaller.

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

### Uploading a folder <a id="dropping-a-folder"></a>

A folder is **one thing to the user**: one queue row, one conflict decision, one
outcome — and one request, to [`/api/files/upload-folder`](#uploading-a-folder),
so a new folder appears whole or not at all. There are two ways in:

- **Dropping it on the tree**, alone or among files and other folders. A folder
  appears in `dataTransfer.files` as a zero-byte entry that would be stored as an
  empty file of its name; `webkitGetAsEntry` on the items is what tells the two
  apart (`readDropped`, shared with the chat, which still refuses folders in its
  own words — [agent-chat.md](agent-chat.md#folders)). The entry has to be taken
  while the drop event is dispatched; reading through it can happen later.
- **`…` → Upload folder**, a second hidden input of the tab's with
  `webkitdirectory`, opened the same synchronous way as the file picker. Each
  file's `webkitRelativePath` is its path, the first segment the folder's name
  (`folderFromPicked`). The row is offered only where the input supports the
  attribute **and** the pointer is fine: mobile browsers carry the property while
  their directory picking is missing or opens a plain file picker, and a row that
  opens the wrong picker is worse than none. On a touch screen there is no folder
  upload at all — there is no drag there either. Should a picker hand over files
  with no relative path after all, they are uploaded as files.

**Reading comes first, and is on screen.** Walking a large folder takes seconds,
so each dropped folder gets its row at once — `Reading… 325 files` with a
spinner — before its contents are known (`uploadActions.addFolders`). The walk
calls `readEntries` until it returns an empty batch, since Chromium hands over at
most 100 entries a call and asking once silently loses the rest. Empty
directories are recorded and sent as `dir` parts; a picker never reports them, a
platform limit. A reading row is unfinished like a running one: it lights the
badge, guards a reload, and is cancelled by the header ✕ or a worktree switch
(`Cancelled · Nothing was uploaded`). **While it reads, no other batch is taken**
— the same one-slot rule as the conflict dialog, said on the drop bar (`Wait for
the folder being read`) or in the banner for a picked batch, which takes the
banner back once the reading is over. A walk is raced against its cancellation
rather than only checked between steps, so a browser callback that never comes
cannot hold that gate shut.

**Cancelling a folder cancels its batch.** The header ✕ or a worktree switch
while a folder is read or asked about cancels every unfinished row, and the
loose files dropped beside it — which have no row yet to be cancelled on — are
named in the banner as not uploaded, rather than sent beside a folder the user
just stopped. The batch waiting for an answer is the tab's own state, and the
sidebar remounts the tab across the `lg` breakpoint. A batch read to the end
after that is still sent when it raises no question; one that would have asked
— or was already asking — fails its folders as `Interrupted before it was sent`
instead of leaving them waiting for ever on a question nobody can show. Its
loose files go with the tab unsent, as a file batch waiting on the dialog
always has.

**Then the checks, before anything is sent.** A folder that fails one becomes a
failed row naming why, and nothing of it is sent:

- **A file or directory that cannot be read** fails the whole folder (`Couldn't
  read assets/secret.key`), rather than sending it without that file. Dropping
  it again is the retry.
- **More than `MAX_FOLDER_FILES` (1,000) files** — a `node_modules` or `.git`
  along for the ride, nearly always. The walk stops counting there rather than
  reading the rest. Nothing is excluded automatically: dotfiles and `.git` go up
  like anything else, since quietly leaving files out is what must not happen.
  The server's `too_many_entries` cap is far above this and only a backstop.
- **Size**, against `max_upload_size` as for a file — but the limit is the
  request's, so for a folder it is the **total** (`assets is 1.8 GB (max 1 GB)`).

The 50-files cap stays for loose files, and is still a banner: that batch never
had a row.

**Conflicts are the batch's one question**, asked once every folder in it has
been read. A folder's name is checked against the destination's cached listing
like a file's:

| Incoming | In the way | What happens |
|---|---|---|
| folder | folder | Asked: **Keep both / Merge / Skip** |
| folder | file | Refused before sending; the row offers **Keep both** only |

A folder is never replaced: that would take the subtree already there with it.
**Merge** sends `merge=true` — files at the same path are replaced, nothing else
is removed ([Merging](#merging-a-folder)) — and is the dialog's middle button,
red-outlined like Replace; with files and folders both colliding it reads
`Replace & merge`, and the title and count switch to "items". **Keep both** picks
`assets (1)` the way it does for a file, but without splitting off an extension:
`v1.2` → `v1.2 (1)`. **Skip** takes the folder's row away; skipping is not a
failure.

Where the listing could not say — nothing cached, or the folder appeared since —
the server's `409` is the backstop: without `merge` it refuses a taken name and
writes nothing, and the row offers **Merge** and **Keep both**. A `409` *inside*
a merge (a file where a folder is needed, or the reverse) is final: no choice on
the row gets past it. The one exception is a merge refused because a file holds
the folder's own name — the row then still offers **Keep both**.

**The row.** A folder icon and `assets/`, a byte-weighted bar and a percentage
while it goes. The request is one body, so progress cannot be told per file. A
folder that stops short **always says what it left on disk**, after the reason:

- Without `merge`, a failure removes the folder whole, so `Nothing was uploaded`.
  So does a cancellation: the server takes a body cut short as a failure —
  unless the body had been sent in full, which the server may be storing whole;
  that row says `Files already sent may be in assets`.
- With `merge`, the error's `written` names what was stored: `12 of 120 files
  were uploaded`. A merge cancelled mid-request can say only `Files already sent
  may be in assets` — the server keeps what it wrote, and no response arrives to
  say what that was.
- A request that ends with no `{error, code}` body at all — the connection
  dropped, or a proxy answered — is the same unknown as a cancellation, and the
  row says the same.
- Whenever a row says files may be on disk, the tree refreshes the destination
  and the folder, as it does for a finished upload.

**Retry** sends the files not yet stored, and **always with `merge=true` once
any are**: the folder is then this upload's own, and claiming it afresh would be
refused as a conflict with itself. Stored files are never sent twice. A new name
from Keep both starts over with nothing stored.

## Known transfer limits

Two gaps rather than decisions, collected here because each of them is easy to
rediscover as a bug:

- **A file rewritten in place mid-download is not caught**: the download is
  one streamed response the browser owns, so nothing compares the file's
  versions across it, and the saved file can mix the two. A save by rename is
  unaffected where an open file can be renamed — see
  [Downloading](#downloading). Catching it would mean reading
  in validated pieces again, which is the in-memory download this replaced.
  A folder's archive is the same, per file and across the folder: each file is
  read once as it then is, and nothing makes the archive one moment's
  snapshot of the folder ([Two walks](#folder-archive)).
- **A file upload's destination directory still follows symlinks**, though the
  file being written does not — see [Security](#security). A folder upload's
  may follow one only to somewhere inside the work directory.

Not in this version, and scope rather than limits: resuming an interrupted
transfer, a queue that survives a
reload, and uploading into a worktree the user has left.

## Security

`ValidatePath(workDir, path)` prevents directory traversal lexically: it cleans
the path and checks that the result stays within the workspace root. It performs
no symlink resolution. It rejects:
- Absolute paths
- `../` traversal

An empty path passes: it names the work directory itself, which is what the
file tree lists and what an unscoped search covers. Rejecting it is the job of
the operations for which it makes no sense — `WriteFile`, `Create` and `Delete`
refuse it on their own, so an empty path can never become an operation on the
workspace root.

Search applies the same validation to its `path` scope, and never follows
symlinks (checked with `Lstat`) — following one could return content from
outside the workspace.

The transfer routes inherit that same behavior on the read side —
`/api/files/download` stats with `Stat`, exactly as `file.get` does — but not
on the write side. The raw endpoint is an exception on the read side as well:
it opens a work-directory file through an `os.Root` and refuses a link out of a
capability's scope
([why](code/authentication.md#raw-capabilities-urls-a-browser-element-loads-by-itself)).
The app's Download goes through it, so a file that links out of the project
cannot be downloaded from the app, though it still shows in the viewer
(`file.get` and the image read follow the link; [Downloading](#downloading)). An
upload replaces a **regular file** and nothing else: it checks the destination
name with `Lstat`, so a symlink is the link itself rather than what it points
at, and answers `409` for it even with `overwrite=true`. Following one would
write outside the workspace, and an `O_WRONLY` open of a fifo would block until
something read from it, hanging the request for good.

That covers the file being written, not the directory it goes in: the upload's
`path` is validated lexically and then used, so a symlinked directory is
followed just as `file.write` follows one on the way to its target. It is the
same long-standing trade-off as above, not a new one — closing it belongs with
the decision that closes it for `file.get` and `file.write`. A folder upload is
stricter, because it is new code with no existing behavior to keep: its
destination may follow a link only to somewhere inside the work directory, a
merge refuses a link it finds inside the folder, and nothing it writes can lead
out of the folder ([Uploading a folder](#uploading-a-folder)).

A folder download is new code on the read side, and as strict: it archives a
symlink as a link and never follows one, opens every entry through the folder's
own directory handles, and follows a link only on the requested path itself,
and only to inside the work directory ([the archive](#folder-archive)).
It leaves nothing out beneath the folder — not what a root raw capability
withholds from a page, nor the data directory or other worktrees: it is the
user's own download of what Files already lets them open, and a project root's
carries the data directory's live tokens with it ([why, and the
cost](#folder-archive)).

`file.create` will not create *through* a symlink on the name it is given.
`O_EXCL` and `os.Mkdir` both fail on a name that is already taken, and a
symlink takes the name whether or not it points anywhere — so the same syscall
that makes "already exists" atomic is what keeps a link from being followed out
of the workspace. Nothing stats first; adding a check would not strengthen this,
only add a window. The parents it creates along the way are `MkdirAll`, so a
symlinked *directory* on the path is followed exactly as it is for `file.write`
and for an upload.

`file.rename` treats a symlink as an entry, never as a door: it looks for both
the source and the destination with `Lstat` and hands both names to `os.Rename`,
which renames links rather than following them. So a link inside the workspace
is renamed like any other entry, and one sitting on the destination name blocks
the rename instead of being followed out of the workspace — either way whether
or not it still points anywhere. `Stat` would get both wrong: on the destination
it would call a dangling link's name free and let the rename unlink it, and on
the source it would report a link the tree is plainly showing as not found. The
parent directory is a different matter — it comes from the source path, which is
validated lexically, so a symlinked directory on the way there is followed
exactly as it is for `file.write`.

`file.move` treats the entry it moves the same way, but is stricter about the
directories: it is new code, as the folder upload is, so both the source's
parent and the destination may follow a link only to somewhere inside the work
directory ([`file.move`](#operations)).

`file.get` does follow them: it stats with `Stat`, so a symlink pointing outside
the workspace reads the target. This is long-standing behavior, not a property
anyone designed for. Closing it means resolving the link and re-checking
containment, which is a deliberate change with a real cost — a pnpm workspace
links `packages/shared` into `web/node_modules`, and a blanket rejection would
make such directories unbrowsable. Left as is until that trade-off is decided.
