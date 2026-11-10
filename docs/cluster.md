# Cluster Mode

An orchestration mode that manages multiple Pockode project nodes from a single instance. It registers project directories and starts/stops their servers on demand.

## Architecture

```
Mobile App  ──►  Relay Server (cloud)  ◀──  Host (cluster mode)
                                                 │
                                            WebSocket + Auth
```

Cluster mode focuses on:
- WebSocket JSON-RPC endpoint
- Password authentication, exchanged for a session token
- Relay connectivity for NAT traversal
- Node management (project directories)
- Embedded SPA frontend

## Nodes

A **Node** represents a project directory that can run Pockode. Cluster mode provides a registry of nodes, allowing users to manage multiple projects from a single cluster instance.

```go
type Node struct {
    ID         string    `json:"id"`           // UUID
    Path       string    `json:"path"`         // Absolute path to project directory
    Name       string    `json:"name"`         // Display name (inferred from path if not provided)
    CreatedAt  time.Time `json:"created_at"`
    UpdatedAt  time.Time `json:"updated_at"`   // Record last modified (only when a field actually changes)
    LastUsedAt time.Time `json:"last_used_at"` // Last edited or started
}
```

`LastUsedAt` is the key the node list is sorted on ([Frontend UX](#frontend-ux)
has the order it produces), so that a node nobody has touched in months does not
hold the top of the list on the strength of its name. It is set when the node is
registered and moves whenever the user acts on it afterwards: `node.start`, and
`node.update` **even when the form was saved without altering a field**, since
going to a node on purpose is a use of it. `UpdatedAt` moves in neither of those
cases, which is why the two are separate fields: `UpdatedAt` means "the stored
record changed", and neither a start nor an unchanged save changes one — folding
them in would make that name lie about a node whose fields are exactly what they
were. Records written before `LastUsedAt` existed are given `UpdatedAt` as their
sort key when the store loads them, so nothing is sorted on a zero time.

Opening a running node is deliberately *not* counted: it is a link the frontend
follows, and the cluster never hears about it.

The path must point to a directory. If the directory does not exist, the request is rejected with `invalid node: path does not exist`; the frontend detects this and offers to create it in place, retrying with `create_missing_dir` set (see [Frontend UX](#frontend-ux)). A path that exists but is not a directory (or is otherwise inaccessible, e.g. permission denied) is always rejected and never offered for creation. Duplicate paths are rejected.

**Path expansion:**
- `~` or `~/...` → expanded to user's home directory (e.g., `~/projects/my-app` → `/home/user/projects/my-app`); `~\...` works the same on Windows (see [Paths on Windows](platforms.md#paths-on-windows))
- `.` (exactly) → expanded to user's home directory (useful when `cwd` is not a project directory)

### Node Lifecycle

Each node has a lifecycle status indicating whether a Pockode server is running in that directory.

**Status values:**

| Status | Description |
|--------|-------------|
| `running` | Server is active (server.json exists and process is alive) |
| `stopped` | Server is not running (no server.json file) |
| `stale` | Server.json exists but the process is dead (needs cleanup) |
| `restarting` | The cluster asked the node to restart and its successor has not written `server.json` yet, for at most 60 s — the cluster's own state, whatever the files say in the meantime (see [Restarting from the cluster](#restarting-from-the-cluster)) |

A node's `status` carries, beside `status`: `port`, `started_at`, `local_url`,
`remote_url` and `version` (the running version from `server.json`; absent on
an older node) while it is `running`; `restart_requested_at` while it is
`restarting`; and `restart_requested_at` with `restart_error` — why the last
restart did not come back, in English, to be shown as it is — after one that
did not.

**server.json file:**

When a node starts, Pockode writes runtime information to `{node.path}/.pockode/server.json`:

```json
{
  "pid": 12345,
  "port": 9870,
  "started_at": "2025-01-15T10:30:00Z",
  "local_url": "http://localhost:9870",
  "remote_url": "https://abc123.cloud.pockode.com",
  "version": "0.21.0"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pid` | int | Yes | Process ID of the running server |
| `port` | int | Yes | Server port number |
| `started_at` | string | Yes | ISO 8601 timestamp of server start |
| `local_url` | string | Yes | URL for local access |
| `remote_url` | string | No | URL for remote access via relay (only present when relay is enabled; can change, or disappear, while the node runs) |
| `version` | string | No | Version the node is running — what its executable's `--version` printed, minus `pockode `, so it compares as a plain string with the installed version (`restart.Program.Version`). Absent only in a file written by a build that predates it, which also cannot be asked to restart (see [Restarting and upgrading](#restarting-and-upgrading)) |

This file is used to:
- Track which process is running for a node
- Detect stale state (file exists but process is dead)
- Provide port, URL, and start time information

The file is deleted when the server shuts down gracefully — except across a unix restart, which keeps the PID: the file is kept until the new program rewrites it, so the node never reads as stopped in between (see [Restarting and upgrading](#restarting-and-upgrading)). `remote_url` can be rewritten while the node runs (see [server.json](../server/AGENTS.md#serverjson)); the cluster reads the file on every status check, so it always reports the current URL.

**Operations:**

- **Start**: Spawns a new Pockode process for the node (requires the node's password).
  A stale `server.json` is removed before the process is spawned: the wait for
  the node to come up is a wait for that file to appear, and a leftover one
  would answer it on the first read — reporting a node started that never was
- **Stop**: Asks the node to exit, then force-kills it after a 5 second grace
  period. Either way the node is gone and its `server.json` removed before the
  operation reports success, so stopping a node never leaves stale state behind.
  The polite step is platform-specific — SIGTERM on unix, a named event on
  Windows (see [Asking a node to exit on Windows](#asking-a-node-to-exit-on-windows))
- **Clean Up**: Removes the orphaned `server.json` a stale node left behind, and
  nothing else — the project directory is not this operation's business. It is
  idempotent (a node with no `server.json` is already where Clean Up is trying
  to get it) and refuses a node whose process is alive, because that file is how
  the rest of the system reaches a running server

**How the spawned node receives its password:** the cluster passes it to each
node server through the `POCKODE_PASSWORD` environment variable, never as a
`-password` command-line flag. On Linux a process's argv is world-readable via
`/proc/<pid>/cmdline` and `ps`, so any local user on a shared cluster host could
otherwise read it — and because spawned nodes enable the relay by default, that
password grants full remote read/write and AI execution over the project. The
environment (`/proc/<pid>/environ`) is readable only by the owner and root. See
[Authentication](code/authentication.md) for the full model. Implemented in
`server/password/` (`WithEnv`), which a restarting server uses too.

Beside the password, the node's environment (`nodeEnv` in `server/cluster/node/process.go`) carries `POCKODE_CLUSTER_NODE`, which is how a node knows to list itself as a `node` in a linked cloud account, and still does after it [restarts itself](#restarting-and-upgrading); the cluster itself is listed under its data directory. See [Cloud Account Linking](code/cloud-account.md#what-an-instance-reports).

If `node.stop` cannot find the saved process, the backend removes any stale
`server.json` state it can clean up and returns `"node not running"` — stopping
what is already gone is a failed stop, not a success. Removing stale state on
purpose is `node.cleanup`, which says so in its name and reports the node's
status like every other node call.

### Asking a node to exit on Windows

Windows has no SIGTERM to send another process. Its documented stand-in is a
Ctrl+Break console event, and that only reaches processes sharing the *caller's*
console — which rules out every way of running a cluster in the background:
a Windows service, Task Scheduler with "run whether user is logged on or not",
or any other detached launch. Exactly the setups an always-on machine is likely
to use would have gone straight to the forced kill, and the node would never
have run its shutdown: no chance to finish in-flight requests, close its AI CLI
sessions in order, or remove its own `server.json`.

So a node publishes a named kernel event instead, `Local\pockode-shutdown-<pid>`,
and the cluster signals it. Nothing about that depends on a console. The name is
in the session-local namespace, which is the right reach: a cluster only stops
nodes it started itself, so both are always in the same session, and no other
session can reach in. The console event survives only as a fallback for a node
started by a build that predates the event and still running while the cluster
is upgraded and restarted around it — and only while that older node still shares
the cluster's console. It cannot reach a node this version started, and does not
need to: none of those shares the cluster's console, and every one of them
publishes the event.

Both halves live in `server/internal/shutdown` — the waiting side and the
signalling side have to agree on the name, so they are kept in one place. Server
mode and cluster mode both listen; `pockode mcp` does not, being a stdio proxy
that the AI CLI owns and ends by closing its input.

**Nodes no longer die with the terminal.** Nodes are started detached on every
platform, and on Windows that now means on a console of the node's own, one with
no window — the counterpart of the `setsid` unix has always used. Previously a
node inherited the cluster's console, so closing that terminal window sent it a
close event and took it down; now it survives, which is what unix already did.
Stop a node from the UI instead. Shutting the cluster down has never stopped
nodes either, so the two platforms finally agree.

**Nodes no longer flash console windows.** The console being the node's own and
windowless is the other half of the fix. A process with no console at all gets a
fresh, visible console for every console program it starts, and a node starts
them constantly — git for every status poll, the shell for a worktree hook, and
whatever those start in turn. An earlier build started nodes that way, and the
result was a black window flashing over the user's desktop again and again. Now
all of those inherit the node's hidden console instead, short of a program that
deliberately asks Windows for a console of its own. (The AI CLI was never among
them: it has always been started on a hidden console of its own.) A node
started by an earlier build keeps its old console arrangement until it is
restarted.

### Restarting and upgrading

Upgrading has two steps. First the new executable is installed over the old
one, either with the install script ([platforms.md](platforms.md)) or from the
panel's version button, which installs a newer release for the cluster manager
([platforms.md](platforms.md#updating-from-the-app),
[self-update-ui.md](self-update-ui.md#web-cluster-the-header)). Then each
process that runs it is restarted. Nodes are started from the same file, so
one install updates the file for all of them. But the cluster manager and each
node are restarted separately, and neither touches the other:

- **The cluster manager** restarts from the version button in the panel's
  header ([restart-ui.md](restart-ui.md#web-cluster-the-header)), or with
  `kill -USR1 <pid>` on unix (it writes no `server.json`; `pgrep -f 'pockode cluster'`
  finds it). Nodes keep running and stay reachable at their own
  addresses; only the panel's connection drops, and it reconnects (and reloads,
  if the version changed) by itself.
- **A node** restarts from the cluster panel ([below](#restarting-from-the-cluster)),
  from Settings → Pockode in that node's own UI, or with `kill -USR1 <pid>` (the
  PID in its `server.json`). It comes back with its own password and options.
  On unix the PID is kept; on Windows it changes, the old `server.json` is
  removed and the successor writes its own. A restart the cluster asked for
  reads `restarting` throughout; one asked for elsewhere reads running on unix,
  and on Windows stopped for a moment — do not press Start in that moment.

#### Restarting from the cluster

`node.restart` restarts a node **without its password**: the cluster asks the
node, and the node restarts itself ([code/self-restart.md](code/self-restart.md)).
It is `ProcessManager.Restart` in `server/cluster/node`, over
`shutdown.RequestRestart(pid)`: SIGUSR1 on unix, and on Windows the named event
`Local\pockode-restart-<pid>`, which a node publishes beside its shutdown event
(see [Asking a node to exit on Windows](#asking-a-node-to-exit-on-windows);
unlike that one there is no console fallback, Ctrl+Break meaning exit).

It returns once the node has been asked, not once it is back. Before asking,
it checks, in this order, and sends nothing if any fails:

| Refusal (`data.reason` of `CodeRestartRefused`, `-32011`) | When |
|---|---|
| `already_restarting` | A restart this cluster asked for is still under way, or another request for the node is being made. Asking twice is not merely redundant: on unix there is a moment after the node has exec'd and before the new program catches SIGUSR1, in which a second one would terminate it. The cluster knows only of restarts it asked for itself |
| `not_running` | No `server.json`, or its process is gone. Nothing is cleaned up |
| `older_node` | The node runs a build that predates restarts: its `server.json` has no `version`. On unix SIGUSR1 would terminate such a node and leave its `server.json` stale, so only stopping and starting it upgrades it. On Windows a node with a `version` but no restart event (it failed to publish one, and logged that) is refused the same way |
| `not_runnable` | The installed executable — the one nodes are started from — does not run `--version`. The node would refuse the restart for it too, but a node asked by a signal or an event cannot answer, so its refusal would only ever show as the timeout below |

Any other failure (reading `server.json`, sending the request) is an ordinary
error with the reason in its message.

**What the cluster tracks.** An accepted request is recorded in the cluster's
memory with the time and the `server.json` `token` it was sent to — the token
is per start, and never leaves the cluster. Every status read compares the
node's `server.json`, read afresh, with that record:

| Found | Status |
|---|---|
| A `server.json` with another `token` and a live process | The successor: the record ends and the node is `running` — also when it turns up after the timeout, which then clears the error |
| Anything else, within 60 s of the request | `restarting`, with `restart_requested_at` — through the Windows gap with no `server.json`, and through the unix exec with the old one |
| Anything else, later | What the files say (`running` for the old start still up, otherwise `stopped` or `stale`), with `restart_requested_at` and a `restart_error` naming the node's `server.log` |

`started_at` is not what tells a new start apart: it has one-second resolution,
and a unix restart with the relay off can finish inside the same second. 60 s
is the frontends' `RESTART_NOT_BACK_MS`, for the same reason: a node publishes
`server.json` only once its relay tunnel is up again.

While a node is `restarting`, `node.start` is refused ("This node is
restarting."), so the Windows gap cannot put a second server on the project. A
successful `node.start`, `node.stop` or `node.cleanup` drops the record and its
error. `node.restart` does not move `last_used_at`: it is upkeep, like a stop.
A cluster that restarts itself forgets its records; the node then reads what
its files say — on Windows, a node caught in its gap reads `stopped` until its
successor writes `server.json`, and `node.start` is not refused meanwhile.

A restart first runs the installed executable with `--version` and refuses,
changing nothing, if it does not run. What it cannot check is whether the new
version accepts the old command line. Nodes are started with no arguments, so
this concerns the cluster manager's own flags: if a release drops one it was
started with, the restart is accepted and the new program exits on start (the
reason on its stderr). The nodes keep running; start the cluster again without
the flag. On Windows a running `pockode.exe` cannot be overwritten, so the
install script asks for Pockode to be stopped first. An update from the panel
renames the running file aside instead, so the restarts that follow it deliver
the new version
([platforms.md](platforms.md#updating-from-the-app)).

How it works is [code/self-restart.md](code/self-restart.md).

## Usage

```bash
# Required: the password the cluster UI asks for
./pockode cluster -password=your-secret-password
```

## Command Line Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `-password` | (required) | Password for the cluster UI (falls back to the `POCKODE_PASSWORD` environment variable when the flag is unset; `-auth-token` / `POCKODE_AUTH_TOKEN` are deprecated aliases — see [Authentication](code/authentication.md#where-the-password-comes-from)) |
| `-port` | `9871` | HTTP server port |
| `-data` | `~/.pockode-cluster` | Data directory |
| `-relay` | `true` | Enable relay for remote access (`-relay=false` to disable) |
| `-relay-frontend-port` | (same as server port) | Target port for relay HTTP proxy frontend requests |
| `-cloud-url` | `https://cloud.pockode.com` | Relay server URL |
| `-dev` | `false` | Development mode (disables embedded SPA) |

Data is stored in `~/.pockode-cluster/` (created automatically if it doesn't exist):

| File | Content |
|------|---------|
| `nodes/index.json` | Node registry |
| `sessions.json` | Live login sessions and the password fingerprint that expires them when the password changes ([Authentication](code/authentication.md#sessions-what-the-browser-keeps)) |

## Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `/health` | — | Health check (returns "ok") |
| `/ws` | — | WebSocket JSON-RPC endpoint (handles own auth) |
| `/*` | ✓ | Static SPA files (production mode only) |

## WebSocket Protocol

Uses JSON-RPC 2.0 over WebSocket. All connections must authenticate before calling other methods.

### Authentication

```json
// Request — exactly one of password / session_token
{"jsonrpc": "2.0", "method": "auth", "params": {"password": "your-secret-password"}, "id": 1}
{"jsonrpc": "2.0", "method": "auth", "params": {"session_token": "<43 chars>"}, "id": 1}

// Success response
{"jsonrpc": "2.0", "result": {"version": "1.0.0", "session_token": "<43 chars>"}, "id": 1}

// Failure response
{"jsonrpc": "2.0", "error": {"code": -32600, "message": "invalid password",
                             "data": {"reason": "invalid_password"}}, "id": 1}
```

The cluster speaks the same `auth` exchange as a node server, refusal reasons
included — password in, session token back, the same token returned unchanged
when it is what was sent. It is described once, in
[Authentication → Sessions](code/authentication.md#sessions-what-the-browser-keeps).

A request that arrives before `auth` is refused with reason
`not_authenticated` and the connection is closed.

### Session Persistence (Frontend)

The cluster frontend keeps the **session token** the cluster issued in
`localStorage` under `cluster_auth_session_token`; the password itself is held in
memory only, until that token replaces it. This is what survives a reload and
lets the tab reconnect without asking again.

The key differs from main mode (`auth_session_token`) to avoid conflicts when
both modes share the same browser origin. The pre-rename key that held the
password itself (`cluster_auth_token`) is deleted on start — each frontend
clears its own, and only its own; see
[Authentication → Sessions](code/authentication.md#sessions-what-the-browser-keeps).

### Frontend UX

The cluster frontend is a mobile-first operations dashboard. Its primary job is
to show which project nodes are running and expose the next useful action. This
section describes what it does; the reasoning behind that shape, and the
alternatives that were rejected on the way to it, are in
[cluster-ui.md](cluster-ui.md).

- **Password screen.** The field can be revealed, and says where the password
  comes from (the `-password` the cluster was started with). It is usually
  typed on a phone keyboard; typing it blind and being turned away is the worst
  way to learn a character was wrong. A password the cluster rejects leads to an
  "Authentication failed" screen carrying the server's own message; its Try
  Again clears the stored credential and returns here. A stored session token
  the cluster no longer knows is a different case and is handled silently: it is
  dropped and the password screen comes back with nothing to apologise for,
  because the user did nothing wrong. This field is the only place the password
  is ever supplied; one carried in the URL was rejected, for reasons in
  [cluster-ui.md](cluster-ui.md#what-was-rejected-and-why).
- **Connecting** uses a full-screen loading state, held back 300 ms so a connect
  that is about to succeed says nothing at all. If it never succeeds the screen
  changes to "Cluster unreachable" with a Retry, because retries run for as long
  as the tab is open and an indefinite spinner would explain nothing.
  `version === null` is the test for "never authenticated", since the status
  alone cannot tell a first connect from a reconnect.
- **Reconnecting** after a successful connect keeps the last known node list
  visible — also when the drop catches a poll in flight, whose "Connection
  lost" is the banner's to report, not an error page's; the list is refetched
  once reconnected. The header's status line switches from "Connected" to
  "Reconnecting...", and a banner above the list escalates: "Reconnecting..."
  for the first few attempts, then "Can't reach the server. Still trying..."
  with a **Retry now** button once the backoff is long enough that skipping the
  wait is worth offering (the threshold and the copy are shared with `web` — see
  [code/websocket-rpc.md](code/websocket-rpc.md)). Retry now skips the wait, not
  the backoff: the attempt count carries on where it was, so repeated taps
  cannot walk the delay back to one second.
- **The list is grouped, not filtered**: **Needs attention** (stale) →
  **Running** (which also holds the nodes that are *restarting*, at their
  place) → **Stopped**, each header sticky and carrying its own count,
  empty sections not drawn, and nodes sorted by `last_used_at` inside one —
  most recently used first, name breaking ties. When more than one node is
  stale the attention header offers **Clean up all** — leftovers arrive in
  batches, since one reboot orphans every node on the machine.
- **A cluster with no nodes registered** shows neither groups nor an empty
  list but an explanation and an Add node button, which is the only thing there
  is to do next.
- **The polling that keeps the list fresh** stops while the tab is in the
  background and catches up the moment it returns. Each poll asks the host about
  every registered project directory, and nobody is reading a hidden tab.
- **A node card's primary button** is **Open** for a running node, **Start** for
  a stopped or stale one. Open goes to `remote_url` when the cluster has one,
  since a phone on mobile data cannot reach `localhost`; `Local` appears beside
  it only when both URLs exist. A running node that reported no address at all
  says so rather than offering a button that leads nowhere. Restart and Stop
  (running only), Edit and Delete live in the card's overflow menu.
- **Stale nodes are a recoverable state**: the card says the server exited
  without cleaning up and that nothing is running, and offers **Start** (which
  clears the leftover itself) alongside **Clean up**.
- **Only Restart, Stop and Delete ask for confirmation**; Clean Up runs on tap,
  since it removes a file describing a process that is already gone. Restart's
  and Stop's confirmations name the actual cost (AI turns in that project are
  stopped; Restart keeps their sessions).
  Delete confirms, naming what it does *not* touch (the project directory), and
  for a running node offers Stop and delete / Delete anyway / Cancel, because
  `node.delete` leaves the server running and unmanageable.
- **Every confirmation the card raises is asked inside the sheet that raised
  it**, replacing its contents rather than stacking on it. No overlay in the
  cluster frontend opens on top of another.
- **An error belonging to one node is shown in that node's card**, not above a
  list the user may have scrolled away from; a failure to load the list at all
  replaces the list with its own message and a Retry. Neither expires on a timer
  — a notice reporting something the user must act on should not vanish while it
  is being read — and a node's error clears when the next action on that node
  succeeds.
- **When adding or editing a node whose path does not exist yet**, the form does
  not reject it outright and does not raise a dialog. A notice appears under the
  path field saying the directory will be created, and the submit button
  relabels to **Create & Add** / **Create & Save**; the next press retries with
  `create_missing_dir` set, so the backend creates the directory (with parents)
  and completes the operation in a single request. Editing the path withdraws
  the offer, which keeps correcting a typo as cheap as accepting. Other path
  errors (not a directory, permission denied, could not create) are shown as the
  backend worded them, with no create option — creating is not what would fix
  them.
- **The cluster version** is a button in the header. It is marked when the
  executable installed on the host is a different version, and gets a dot when
  a check has found a newer latest release (none for an alpha). It opens the
  **Pockode cluster** sheet, which shows both versions, checks GitHub for newer
  releases only when the user asks it to, offers what it
  finds with **Update**, and restarts the cluster manager (nodes keep
  running). The panel reloads itself when a reconnect finds the cluster running
  another version than the page was built for. The screens and their copy are
  [restart-ui.md](restart-ui.md#web-cluster-the-header) and
  [self-update-ui.md](self-update-ui.md#web-cluster-the-header).
- **Nodes restart without their password.** A running node whose `version`
  differs from the cluster's *installed* one — the file it would be started
  from — is outdated: its card gains a version line and a **Restart** beside
  Open, and from two outdated nodes up a strip above the list offers **Restart
  all outdated (N)**, each refusal landing on its own card. Every running
  node's menu offers Restart too, except while the installed file does not run.
  Restart sends `node.restart`; the card then reads *Restarting...* with a
  running clock, offers no Open, no Start and no menu, and stays where it was
  until the cluster sees the successor or gives up and reports
  `restart_error` on the card. A node started by a build from before restarts
  (no `version`, or refused as `older_node`) is an *older* node: its Restart is
  one sheet asking for its password that stops and starts it, and the strip
  leaves it out by name. The installed version is read once for the whole
  panel — on connect, on returning to the tab, when a sheet opens — and shared
  by the header and the cards. The screens and their copy are
  [restart-ui.md](restart-ui.md#web-cluster-restarting-nodes).
- **Start asks for the node password every time.** It is the password the
  *spawned node server* uses for its own auth, not the cluster's own, so it is
  never defaulted from the cluster credential: one leaked node must not hand
  over the cluster. Every Start opens a sheet offering **Generate** (32 random
  characters) and **Copy** — and when the copy fails, as it does outside a
  secure context where the browser withholds the clipboard, the password is
  shown in full so it can be written down rather than lost. A failed start
  leaves the sheet, the typed password and the reason on screen. Nothing in the
  frontend keeps the password between starts, in storage or in memory.
- **No AI CLI sign-in.** Every node on one machine shares the CLIs'
  credentials, so signing Claude or Codex in or out from any node's Pockode
  (Settings → AI CLIs) does it for all of them; the cluster frontend has
  no screen of its own for it ([cli-login-ui.md](cli-login-ui.md#cluster)).
  They share because every node inherits the manager's environment, and
  Pockode sets neither `CLAUDE_CONFIG_DIR` nor `CODEX_HOME`, so each CLI finds
  the same stored credentials. Sessions that are already running pick up the
  new credentials on their next message, with no restart. A Pockode started
  outside the cluster as another OS user, or with either variable set
  differently, has credentials of its own and needs its own sign-in. Each node
  still runs its own sign-in flows, so two nodes can sign the same CLI in at
  once; the one that finishes last wins
  ([cli-auth.md](code/cli-auth.md#one-per-cli-owned-by-the-server)).
- **No AI CLI install or update.** The nodes share each CLI's install the same
  way, so installing or updating it from any node's Pockode (Settings → AI
  CLIs) does it for all of them ([cli-update-ui.md](cli-update-ui.md#cluster)).
  Unlike a sign-in, two nodes cannot install or update the same CLI at once: a
  lock shared by every Pockode of the OS user refuses the second
  ([cli-update.md](code/cli-update.md#one-update-per-cli-per-os-user)).

### Available Methods

After authentication:

| Method | Description |
|--------|-------------|
| `ping` | Returns `"pong"` |
| `node.list` | Returns all registered nodes (includes `status` field) |
| `node.get` | Returns a node by ID (params: `{id}`), includes `status` field |
| `node.create` | Creates a new node (params: `{path, name?, create_missing_dir?}`) |
| `node.update` | Updates a node (params: `{id, path?, name?, create_missing_dir?}`) |
| `node.delete` | Deletes a node (params: `{id}`) |
| `node.status` | Returns node status (params: `{id}`) |
| `node.start` | Starts a node's server (params: `{id, password}`; the pre-rename `token` is still accepted); refused while the node is `restarting` |
| `node.stop` | Stops a node's server (params: `{id}`) |
| `node.cleanup` | Removes a stale node's leftover `server.json` (params: `{id}`); returns the node's status |
| `node.restart` | Asks a running node to restart itself into the installed executable (params: `{id}`); returns the node's status — `restarting` — once it has been asked. Refusals and the status it reports meanwhile: [Restarting from the cluster](#restarting-from-the-cluster) |
| `cloud_link.*` | Links this machine to a cloud account, or unlinks it, with the cluster running the device flow against its own `-cloud-url` — the same methods and handler as the main server ([Cloud Account Linking](code/cloud-account.md#the-cloud_link-rpc)). `cloud_link.subscribe` is the one subscription a cluster connection holds; it is given back when the connection closes |

## Startup Output

When cluster mode starts, it displays the same CLI startup interface as normal mode:

- **Banner**: Logo, version, local URL, remote URL (if relay enabled), the [cloud account](code/cloud-account.md#attaching-the-relay) (when this machine is linked: its email, or a warning that the relay could not be attached to it), cloud announcements, and which AI CLIs were found. Cluster mode does not run an AI CLI itself, but a node is this same executable and inherits this environment, so it searches the same PATH and the same install directories — and a node's own banner is never seen, because nodes are started detached with their output going to a log file
- **QR Code**: Scannable QR code for the remote URL (when relay is enabled)
- **Footer**: "Press Ctrl+C to stop" instruction

This provides a consistent user experience across both deployment modes.

## Relay Integration

When `-relay` is enabled (default), cluster mode registers with the cloud relay server and accepts connections through it. This allows mobile devices to connect without direct network access to the server.

The relay uses the same infrastructure as the main server mode—see [relay.md](relay.md) for the design, and [code/relay-system.md](code/relay-system.md) for how the tunnel detects a dead connection and recovers from one. The cluster frontend's reconnect behaviour mirrors the main web client for the same reasons described there.

## Development

### Prerequisites

Install dependencies before running development commands. `web`, `web-cluster` and `packages/*` are one pnpm workspace with a single lockfile, so this is run once from the repo root and covers all of them:

```bash
pnpm install
```

### Running Locally

```bash
# Start cluster dev environment (backend port 9871, frontend port 5174)
./scripts/dev.sh --cluster
```

This runs both the Go backend (`go run . cluster`) and the React frontend (`web-cluster`) with hot reload.

### Frontend

The cluster frontend lives in `web-cluster/`. To build:

```bash
pnpm --filter ./web-cluster run build:release
```

Built files are embedded into the binary via `server/cluster/embed.go`.

### Backend

Cluster mode implementation:
- `server/cluster/cluster.go` — Entry point and server lifecycle
- `server/cluster/handler.go` — HTTP routing
- `server/cluster/ws.go` — WebSocket handler and JSON-RPC methods
- `server/cluster/static.go` — SPA file serving
- `server/cluster/embed.go` — Static file embedding
- `server/cluster/node/` — Node store and process management
- `server/serverinfo/` — Runtime info (server.json) handling
- `server/spa/` — Shared SPA utilities (used by both normal and cluster mode)
