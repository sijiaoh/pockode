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

The path must point to a directory. If the directory does not exist, the request is rejected with `invalid node: path does not exist`; the frontend detects this and asks whether to create it, retrying with `create_missing_dir` set (see [Frontend UX](#frontend-ux)). A path that exists but is not a directory (or is otherwise inaccessible, e.g. permission denied) is always rejected and never offered for creation. Duplicate paths are rejected.

**Path expansion:**
- `~` or `~/...` → expanded to user's home directory (e.g., `~/projects/my-app` → `/home/user/projects/my-app`)
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

- **Start**: Spawns a new Pockode process for the node (requires auth token)
- **Stop**: Sends SIGTERM to the process, then SIGKILL after 5 seconds if needed
- **Clean Up**: For stale nodes, removes the orphaned server.json file

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
`server.json` state it can clean up and returns `"node not running"`. The
frontend treats this as a warning, refreshes `node.list`, and continues to show
cleanup guidance if stale state remains.

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
to show which project nodes are running and expose the next useful action:

- Initial connection uses a full-screen loading state.
- Reconnection keeps the last known node list visible and shows an inline
  warning that the status may be stale.
- Node cards show status, shortened path, runtime metadata, and the primary
  action for the current state: Start, Stop, or Clean Up.
- Stale nodes are treated as a recoverable state. The UI explains that the
  process is gone but server info remains, then offers Clean Up.
- Stop requests that return `"node not running"` are shown as warnings, not
  fatal action errors, because the saved process was already gone.
- Action warnings and errors are shown inline above the node list so they do
  not cover mobile controls.
- When adding or editing a node whose path does not exist yet, the form does not
  reject it outright. Instead it asks "Create directory?" in a confirmation
  dialog (confirm label "Create & Add" when adding, "Create & Save" when
  editing). Confirming retries the request with `create_missing_dir` set so the
  backend creates the directory (with parents) and completes the operation in a
  single request; cancelling keeps the form and its entered path and returns
  focus to the path input. Other path errors (not a directory, permission
  denied, duplicate) stay as inline errors with no create option.

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

## Startup Output

When cluster mode starts, it displays the same CLI startup interface as normal mode:

- **Banner**: Logo, version, local URL, remote URL (if relay enabled), and cloud announcements
- **QR Code**: Scannable QR code for the remote URL (when relay is enabled)
- **Footer**: "Press Ctrl+C to stop" instruction

This provides a consistent user experience across both deployment modes.

## Relay Integration

When `--relay` is enabled (default), cluster mode registers with the cloud relay server and accepts connections through it. This allows mobile devices to connect without direct network access to the server.

The relay uses the same infrastructure as the main server mode—see [relay.md](relay.md) for details.

## Development

### Prerequisites

Install dependencies before running development commands:

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
cd web-cluster && pnpm install && pnpm build:release
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
