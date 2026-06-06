# Cluster Mode

A lightweight deployment mode for running Pockode on remote servers (VPS, Kubernetes, etc.). Unlike the full server which runs a complete development environment, cluster mode provides minimal infrastructure for remote access via relay.

## Architecture

```
Mobile App  ──►  Relay Server (cloud)  ◀──  Remote Server (cluster mode)
                                                 │
                                            WebSocket + Auth
```

Cluster mode strips away development environment features (worktrees, agents, file watching) and focuses on:
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

The path must point to an existing directory. Duplicate paths are rejected.

**Path expansion:**
- `~` or `~/...` → expanded to user's home directory (e.g., `~/projects/my-app` → `/home/user/projects/my-app`)
- `.` (exactly) → expanded to user's home directory (useful when `cwd` is not a project directory)

## Usage

```bash
# Required: authentication token
AUTH_TOKEN=your-secret-token ./pockode cluster
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | (required) | Authentication token for WebSocket connections |
| `SERVER_PORT` | `9871` | HTTP server port |
| `WEB_PORT` | `5174` | Frontend dev server port (development only) |
| `RELAY_ENABLED` | `true` | Enable relay for remote access |
| `RELAY_FRONTEND_PORT` | (same as SERVER_PORT) | Target port for relay HTTP proxy frontend requests |
| `CLOUD_URL` | `https://cloud.pockode.com` | Relay server URL |
| `DEV_MODE` | `false` | Development mode (disables embedded SPA) |

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

### Available Methods

After authentication:

| Method | Description |
|--------|-------------|
| `ping` | Returns `"pong"` |
| `node.list` | Returns all registered nodes |
| `node.get` | Returns a node by ID (params: `{id}`) |
| `node.create` | Creates a new node (params: `{path, name?}`) |
| `node.update` | Updates a node (params: `{id, path?, name?}`) |
| `node.delete` | Deletes a node (params: `{id}`) |

## Startup Output

When cluster mode starts, it displays the same CLI startup interface as normal mode:

- **Banner**: Logo, version, local URL, remote URL (if relay enabled), and cloud announcements
- **QR Code**: Scannable QR code for the remote URL (when relay is enabled)
- **Footer**: "Press Ctrl+C to stop" instruction

This provides a consistent user experience across both deployment modes.

## Relay Integration

When `RELAY_ENABLED=true` (default), cluster mode registers with the cloud relay server and accepts connections through it. This allows mobile devices to connect without direct network access to the server.

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

# Or with custom ports:
SERVER_PORT=9900 WEB_PORT=5200 ./scripts/dev.sh --cluster
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
- `server/cluster/node/` — Node store implementation
- `server/spa/` — Shared SPA utilities (used by both normal and cluster mode)
