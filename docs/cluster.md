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
- Embedded SPA frontend

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
| `RELAY_ENABLED` | `true` | Enable relay for remote access |
| `DATA_DIR` | `.pockode` | Data directory for relay config persistence |
| `CLOUD_URL` | `https://cloud.pockode.com` | Relay server URL |
| `DEV_MODE` | `false` | Development mode (disables embedded SPA) |

## Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `/health` | ✓ | Health check (returns "ok") |
| `/ws` | ✓ | WebSocket JSON-RPC endpoint |
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

## Relay Integration

When `RELAY_ENABLED=true` (default), cluster mode registers with the cloud relay server and accepts connections through it. This allows mobile devices to connect without direct network access to the server.

The relay uses the same infrastructure as the main server mode—see [relay.md](relay.md) for details.

## Development

### Frontend

The cluster frontend lives in `web-cluster/`. To build:

```bash
cd web-cluster && pnpm build:release
```

Built files are embedded into the binary via `server/cluster/embed.go`.

### Backend

Cluster mode implementation:
- `server/cluster/cluster.go` — Entry point and server lifecycle
- `server/cluster/handler.go` — HTTP routing
- `server/cluster/ws.go` — WebSocket handler and JSON-RPC methods
- `server/cluster/static.go` — SPA file serving
- `server/cluster/embed.go` — Static file embedding
