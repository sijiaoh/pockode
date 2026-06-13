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
- Cookie-based authentication
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
| `POST /api/login` | — | Validate token, set auth Cookie |
| `POST /api/logout` | ✓ | Clear auth Cookie |
| `GET /api/me` | ✓ | Check Cookie validity (200 or 401) |
| `/ws` | ✓ | WebSocket JSON-RPC endpoint |
| `/*` | ✓ | Static SPA files (production mode only) |

## WebSocket Protocol

Uses JSON-RPC 2.0 over WebSocket. Authentication is handled via Cookie during WebSocket handshake—no separate auth RPC is needed.

### Authentication

Cluster mode uses Cookie-based authentication:

1. On startup, frontend calls `GET /api/me` to check existing Cookie validity
2. If Cookie invalid, user enters token via the frontend
3. Frontend sends `POST /api/login { token }`
4. Server validates and sets an HttpOnly Cookie
5. WebSocket handshake includes the Cookie automatically
6. Server validates Cookie during handshake; invalid Cookie results in 401 rejection
7. Connection success = authentication success; ready for RPC immediately

```
Client                              Server
  │                                    │
  │   GET /api/me (Cookie header)      │
  ├───────────────────────────────────▶│   Validate Cookie
  │   200 OK / 401 Unauthorized        │
  │◀───────────────────────────────────┤
  │                                    │
  │   (If 401: show login screen)      │
  │                                    │
  │   POST /api/login { token }        │
  ├───────────────────────────────────▶│   Validate token
  │   Set-Cookie: auth_token=xxx       │   HttpOnly, Secure, SameSite=Strict
  │◀───────────────────────────────────┤
  │                                    │
  │   ws://host/ws                     │
  ├───────────────────────────────────▶│   WebSocket handshake
  │◀───────────────────────────────────┤   Authenticate via Cookie
  │                                    │
  │   (Ready - can send RPC requests)
```

Unlike the main server mode, Cluster mode does not require worktree initialization or version negotiation—connection success means ready to use.

### Session Persistence

Authentication state is maintained via HttpOnly Cookie:

- Automatic session continuity across page reloads
- Cookie security: HttpOnly, Secure (HTTPS), SameSite=Strict
- Tokens are not exposed to JavaScript (XSS protection)

### Available Methods

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
