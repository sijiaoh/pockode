# Self-Update

How a running `pockode` (a server or a cluster manager) finds out that a newer
release is published, and puts it on disk in place of its own executable. The
restart into the new file is [self-restart.md](self-restart.md)'s, unchanged:
an update ends once the file has been replaced, and the client then sends the
ordinary `server.restart`.

The screens are [self-update-ui.md](../self-update-ui.md). The wire contract
of `server.update_check` / `server.update` (fields, reasons, the cache, the
budget) is
[websocket-rpc.md](websocket-rpc.md#server-updating-to-a-release). What a user
can and cannot do, and what to do instead, is
[platforms.md](../platforms.md#updating-from-the-app).

| Piece | Where |
|---|---|
| Which releases are newer, and where their files are | `server/internal/release/` — `Checker`, `GitHub` |
| Verifying a download and renaming it over the executable | `server/selfinstall/` (`replace_unix.go`, `replace_windows.go`) |
| The RPCs, shared by both modes | `server/ws/rpc_server_update.go` — `Updater` |
| Patient renames, the per-user lock directory | `server/filestore/` — `RenamePatiently`, `UserLockDir` |
| Wiring | `server/main.go` and `server/cluster/cluster.go` — `ws.NewReleaseUpdater`, `Updater.Close` |

## Install and restart are separate steps

`server.update` replaces the file and does nothing else. Running it into a
restart on the server would have been one round trip shorter. Kept apart,
though, a restart refused after a good install leaves a state the restart path
already handles: a newer file on disk, a version that differs, a Restart
button. Every guarantee of the restart (the probe before anything stops, the
held reply, the password hand-over) applies as it is, because the restart
cannot tell this file was put there by an update.

The file replaced is `restart.Program.Path`, with symlinks followed:
`selfinstall` replaces the real file and leaves the link where it is. Using the
very path the restart will run, saved once at startup (see
[self-restart.md](self-restart.md#what-is-saved-at-startup)), is what makes the
restart land on the new version.

## What the installer trusts

An update runs a file downloaded from the internet, so each step narrows what
that file can be:

- **The URLs are built from the tag, never taken from the API.** The release
  notes, asset and `checksums.txt` addresses are all
  `github.com/sijiaoh/pockode/releases/…/<tag>/…`, and a tag must match
  `vX.Y.Z(-pre)?(+build)?` before it goes into a path. The API is only asked
  whether an asset exists. So the installer can only download from this
  repository's releases, and the API and `releases.atom` paths give the same
  answer.
- **The checksum comes from the same release as the binary.** Both URLs belong
  to one tag. A checksum from another release would prove nothing.
- **The download is run before it is used.** It must answer `--version` with
  exactly the version asked for, through the same `restart.Program.Version`
  the restart's own probe uses. A truncated file, a build for another
  architecture, or a mislabelled release fails here, with the original file
  untouched.
- **The executable is replaced by a rename, never written to.** Linux refuses
  to open a running executable for writing, and macOS kills a running process
  whose code pages stop matching its signature. A rename leaves the running
  process on the old inode. The download is staged in the executable's own
  directory, so the rename never crosses a file system.

## Newer than what, and when it is checked

Two floors apply, owned by different pieces:

- **The running version** is `release.Checker`'s floor. A candidate newer than
  this binary is the only thing it ever offers, so no downgrade is offered.
- **The installed version** is the `Updater`'s floor, read afresh on each
  check like `server.version`. A release already on disk needs a restart, not
  an update.

The installed floor is checked a second time by `selfinstall.Install`, after it
takes the lock (`ErrNotNewer`, which the RPC reports as `release_gone`).
Without this, two installs could race between the check and the lock. A node
could put an alpha on disk, and then the cluster, acting on a check from just
before, could install latest back over it.

A development build (a version that is not a release, `dev` by default from
`scripts/build.sh`) is never compared and never asks GitHub. Its source tree may
be ahead of every release, so "newer than dev" would offer a downgrade as
readily as an update. Skipping the check also keeps a developer's frequent
restarts from spending the rate limit below. The same `release.IsRelease`
decides this for the checker and for the installer, so the two cannot
disagree.

## Asking GitHub rarely

Unauthenticated GitHub API requests share 60 an hour per IP address. That
budget covers every node, the cluster, and anything else on the machine or
behind the same NAT, and nothing coordinates those processes. So the checker
never asks on its own, nor because a client connected or opened a screen: it
asks only on a forced `server.update_check` — a user pressing Check, Check
again or Try again — and then at most once a minute, a failed check included
([websocket-rpc.md](websocket-rpc.md#server-updating-to-a-release)).
That floor is per process and only stops one user's repeated presses; what
keeps several processes inside the shared budget is that none of them checks
unless asked. Concurrent asks, forced or not, join one request. A caller
whose context ends gets the answer as it stood, and the check carries on for
the next caller. Once the API says it is rate-limited, it is not asked again
until the reset. `releases.atom` answers
meanwhile. The feed has no asset list, so a missing asset only shows up as a
404 when downloading. That is why `no_asset` is a possible install failure as
well as a candidate's `unavailable`.

The check and the install both go through Go's default transport, so the usual
proxy environment variables apply.

## One install at a time, and the shutdown

Every Pockode of one OS user shares one lock, `self-install.lock` in
`filestore.UserLockDir`. Two of them may run from the same file, such as a
cluster and its nodes, and two replacements of one file would race. `Busy`
takes the lock for a moment only, to see whether it is free, so a check can
report another process's install. An install's lock attempt retries for a
moment, so a press of Update that arrives while `Busy` or `Cleanup` holds the
lock is not refused for it.

The install belongs to the process, not to the request. It runs under the
`Updater`'s own context, not the request's, with a 5-minute budget counted from
the request's arrival, so a phone losing its connection does not abort a download half done.
What does stop it is the process shutting down. `Updater.Close` runs before the
WebSockets close: it cancels a download, waits for a replacement already
begun, and refuses any replacement after. On Windows that matters, because a
process exiting between the two renames would leave no executable at the path.
It also keeps the shutdown from waiting out its timeout on an install that
ignores its request's context; the reply itself rarely gets out, since the
connections close right after, and the client sees the connection drop.

`Cleanup`, at every startup (`ws.NewReleaseUpdater`), removes what an
interrupted install left in the directory: staged downloads, and on Windows
the `.old` files nothing runs any more.

## Windows

A running `pockode.exe` cannot be overwritten or deleted, but it can be
renamed. So the replacement is two renames: the running file goes to
`pockode.exe.<timestamp>.old`, and the new file takes its name. If the second
rename fails, the first is undone. If undoing it also fails, the result is
`restore_failed`, whose message says where the old file is. That is the one
failure that leaves the path without its executable. Each `.old` name is
unique because an earlier one may still be the running image of a cluster node,
and can be neither replaced nor removed until it exits.

Windows Defender opens a freshly written executable to scan it, often for
seconds, and refuses to let it be moved meanwhile. Waiting for that between
the two renames would leave the path empty for as long as the scan takes. A
restart, or a cluster starting a node, would find nothing to run in that time.
So the new file is first renamed to another staged name, and that rename is
the one that waits (`RenamePatiently`). The two renames that leave the gap
then run back to back. Each rename gets its own 30 s budget, in case a scanner
opens the file again in between.

This is why an update from the UI reaches a Windows server while the install
script cannot ([self-restart.md](self-restart.md#windows-a-successor)).

## Known edges

- **Between install and restart**, anything that starts the executable at
  its path anew runs the new version. That includes a node the cluster starts,
  and on macOS and Linux the `pockode mcp` proxy an AI CLI launches for a new
  session (its command is built from `os.Executable()`, which there still
  names the replaced path). Each is a separate process speaking to the old
  server, and versions that close together work.
- **A package manager's install** is replaced in place like any other file.
  The package manager no longer knows the version on disk.
- **A different `XDG_CACHE_HOME`** (Linux) between two Pockodes of one user gives
  them different lock directories, so they do not see each other's installs:
  both can pass the re-check under their own lock, and the slower rename wins,
  which can put an older release over a newer one.
