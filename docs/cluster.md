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
- Token-based authentication
- Relay connectivity for NAT traversal
- Node management (project directories)
- Embedded SPA frontend

## Nodes

A **Node** represents a project directory that can run Pockode. Cluster mode provides a registry of nodes, allowing users to manage multiple projects from a single cluster instance.

```go
type Node struct {
    ID        string    `json:"id"`         // UUID
    Path      string    `json:"path"`       // Absolute path to project directory
    Name      string    `json:"name"`       // Display name (inferred from path if not provided)
    CreatedAt time.Time `json:"created_at"`
    UpdatedAt time.Time `json:"updated_at"`
}
```

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

**server.json file:**

When a node starts, Pockode writes runtime information to `{node.path}/.pockode/server.json`:

```json
{
  "pid": 12345,
  "port": 9870,
  "started_at": "2025-01-15T10:30:00Z",
  "local_url": "http://localhost:9870",
  "remote_url": "https://abc123.cloud.pockode.com"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pid` | int | Yes | Process ID of the running server |
| `port` | int | Yes | Server port number |
| `started_at` | string | Yes | ISO 8601 timestamp of server start |
| `local_url` | string | Yes | URL for local access |
| `remote_url` | string | No | URL for remote access via relay (only present when relay is enabled) |

This file is used to:
- Track which process is running for a node
- Detect stale state (file exists but process is dead)
- Provide port, URL, and start time information

The file is deleted when the server shuts down gracefully.

**Operations:**

- **Start**: Spawns a new Pockode process for the node (requires auth token).
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

**How the spawned node receives its token:** the cluster passes the auth token to
each node server through the `POCKODE_AUTH_TOKEN` environment variable, never as a
`--auth-token` command-line flag. On Linux a process's argv is world-readable via
`/proc/<pid>/cmdline` and `ps`, so any local user on a shared cluster host could
otherwise read the token — and because spawned nodes enable the relay by default,
that token grants full remote read/write and AI execution over the project. The
environment (`/proc/<pid>/environ`) is readable only by the owner and root. See
[Authentication](code/authentication.md) for the full model. Implemented in
`server/cluster/node/process.go` (`nodeEnv`) and `server/authtoken/`.

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
need to: those have no console at all, and every one of them publishes the event.

Both halves live in `server/internal/shutdown` — the waiting side and the
signalling side have to agree on the name, so they are kept in one place. Server
mode and cluster mode both listen; `pockode mcp` does not, being a stdio proxy
that the AI CLI owns and ends by closing its input.

**Nodes no longer die with the terminal.** Nodes are started detached on every
platform, and on Windows that now means with no console at all — the counterpart
of the `setsid` unix has always used. Previously a node inherited the cluster's
console, so closing that terminal window sent it a close event and took it down;
now it survives, which is what unix already did. Stop a node from the UI instead.
Shutting the cluster down has never stopped nodes either, so the two platforms
finally agree.

## Usage

```bash
# Required: authentication token
./pockode cluster --auth-token=your-secret-token
```

## Command Line Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--auth-token` | (required) | Authentication token for WebSocket connections (falls back to the `POCKODE_AUTH_TOKEN` environment variable when the flag is unset) |
| `--port` | `9871` | HTTP server port |
| `--data` | `~/.pockode-cluster` | Data directory |
| `--relay` | `true` | Enable relay for remote access (`-relay=false` to disable) |
| `--relay-frontend-port` | (same as server port) | Target port for relay HTTP proxy frontend requests |
| `--cloud-url` | `https://cloud.pockode.com` | Relay server URL |
| `--dev` | `false` | Development mode (disables embedded SPA) |

Data is stored in `~/.pockode-cluster/` (created automatically if it doesn't exist):

| File | Content |
|------|---------|
| `nodes/index.json` | Node registry |

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
// Request
{"jsonrpc": "2.0", "method": "auth", "params": {"token": "your-secret-token"}, "id": 1}

// Success response
{"jsonrpc": "2.0", "result": {"version": "1.0.0"}, "id": 1}

// Failure response
{"jsonrpc": "2.0", "error": {"code": -32600, "message": "invalid token"}, "id": 1}
```

Unauthenticated requests receive `"not authenticated"` error and the connection is closed.

### Token Persistence (Frontend)

The cluster frontend persists the auth token to `localStorage` under `cluster_auth_token`. This enables:

- Automatic reconnection on page reload
- Session continuity without re-entering token

The key differs from main mode (`auth_token`) to avoid conflicts when both modes share the same browser origin.

### Frontend UX

The cluster frontend is a mobile-first operations dashboard. Its primary job is
to show which project nodes are running and expose the next useful action. This
section describes what it does; the reasoning behind that shape, and the
alternatives that were rejected on the way to it, are in
[cluster-ui.md](cluster-ui.md).

- **Token screen.** The field can be revealed, and says where the token comes
  from (the `--auth-token` the cluster was started with). A cluster token is
  long and random and usually typed on a phone keyboard; typing it blind and
  being turned away is the worst way to learn a character was wrong. A token the
  cluster rejects leads to an "Authentication failed" screen carrying the
  server's own message; its Try Again is what discards the stored token and
  returns here, so a token that failed for a reason other than being wrong is
  not thrown away on the user's behalf.
- **Connecting** uses a full-screen loading state, held back 300 ms so a connect
  that is about to succeed says nothing at all. If it never succeeds the screen
  changes to "Cluster unreachable" with a Retry, because retries run for as long
  as the tab is open and an indefinite spinner would explain nothing.
  `version === null` is the test for "never authenticated", since the status
  alone cannot tell a first connect from a reconnect.
- **Reconnecting** after a successful connect keeps the last known node list
  visible. The header's status line switches from "Connected" to
  "Reconnecting...", and a banner above the list escalates: "Reconnecting..."
  for the first few attempts, then "Can't reach the server. Still trying..."
  with a **Retry now** button once the backoff is long enough that skipping the
  wait is worth offering (the threshold and the copy are shared with `web` — see
  [code/websocket-rpc.md](code/websocket-rpc.md)). Retry now skips the wait, not
  the backoff: the attempt count carries on where it was, so repeated taps
  cannot walk the delay back to one second.
- **The list is grouped, not filtered**: **Needs attention** (stale) →
  **Running** → **Stopped**, each header sticky and carrying its own count,
  empty sections not drawn, and nodes sorted by name inside one. When more than
  one node is stale the attention header offers **Clean up all** — leftovers
  arrive in batches, since one reboot orphans every node on the machine.
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
  says so rather than offering a button that leads nowhere. Stop (running only),
  *Start with a different token…* (on a stopped or stale node, once a token is
  remembered), Edit and Delete live in the card's overflow menu.
- **Stale nodes are a recoverable state**: the card says the server exited
  without cleaning up and that nothing is running, and offers **Start** (which
  clears the leftover itself) alongside **Clean up**.
- **Only Stop and Delete ask for confirmation**; Clean Up runs on tap, since it
  removes a file describing a process that is already gone. Stop's confirmation
  names the actual cost (AI sessions in that project end).
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
- **The cluster version** is printed after the last card rather than pinned to
  the viewport corner, where it floated over whatever scrolled underneath it.
- **Start's token is remembered for the session, in memory only.** It is the
  token the *spawned node server* uses for its own auth, not the cluster token,
  so it is never defaulted from `cluster_auth_token`: one leaked node must not
  hand over the cluster. The first Start of a session opens a sheet offering
  **Generate** (32 random characters) and **Copy** — and if the clipboard is
  unavailable, as it is outside a secure context, the token is shown in full so
  it can be written down rather than lost; every later Start is one tap, and the
  card says "Using the saved node token" while it runs. The overflow menu keeps
  **Start with a different token…** as the way back to the sheet. A token is
  remembered only once it has actually started something, and a failed start
  leaves the sheet, the typed token and the reason on screen. A reload asks once
  more — the price of not making a second secret durable in browser storage.

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
| `node.start` | Starts a node's server (params: `{id, token}`) |
| `node.stop` | Stops a node's server (params: `{id}`) |
| `node.cleanup` | Removes a stale node's leftover `server.json` (params: `{id}`); returns the node's status |

## Startup Output

When cluster mode starts, it displays the same CLI startup interface as normal mode:

- **Banner**: Logo, version, local URL, remote URL (if relay enabled), cloud announcements, and which AI CLIs were found. Cluster mode does not run an AI CLI itself, but a node is this same executable and inherits this environment, so it searches the same PATH and the same install directories — and a node's own banner is never seen, because nodes are started detached with their output going to a log file
- **QR Code**: Scannable QR code for the remote URL (when relay is enabled)
- **Footer**: "Press Ctrl+C to stop" instruction

This provides a consistent user experience across both deployment modes.

## Relay Integration

When `--relay` is enabled (default), cluster mode registers with the cloud relay server and accepts connections through it. This allows mobile devices to connect without direct network access to the server.

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
