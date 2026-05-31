# Multi-Workspace System

Pockode's multi-workspace system enables managing multiple projects from a single server instance. This document explains the design decisions and architecture.

## Why Multi-Workspace

Single workspace mode works well when you're focused on one project. But developers often work on multiple projects:

- **Multiple services** — Microservices, frontend/backend splits
- **Context switching** — Jump between projects without restarting
- **Resource efficiency** — One server process instead of many

The multi-workspace system solves this by introducing a Manager process that routes requests to per-workspace Workers.

## Architecture Overview

```
                                        ┌─── Worker (project-a)
                                        │    └── worktree manager
Phone ──► Relay ──► Manager ───────────┼─── Worker (project-b)
                    (router)            │    └── worktree manager
                                        └─── Worker (project-c)
                                             └── worktree manager
```

### Key Components

| Component | Package | Responsibility |
|-----------|---------|----------------|
| Global Config | `globalconfig/` | User-wide config storage (`~/.pockode/`) |
| CLI | `cli/` | Command-line interface |
| Manager | `manager/` | Routes requests, manages worker lifecycle |
| Worker | `manager/` | Isolates workspace resources |
| Router | `manager/` | URL-based request routing |

## Global Configuration

Unlike project-level `.pockode/` directories, global config is shared across all workspaces:

```
~/.pockode/
├── config.json      # Default port, auth token (0600)
├── workspaces.json  # Workspace registry
└── relay.json       # Relay credentials (0600)
```

The `globalconfig` package handles:

1. **Atomic writes** — Write-temp-fsync-rename pattern prevents corruption
2. **Secure permissions** — Sensitive files use 0600
3. **Environment override** — `POCKODE_HOME` for testing

### Workspace Registry

```go
type Workspace struct {
    ID           string
    Name         string
    Path         string
    LastAccessed time.Time
}
```

Workspaces are registered via CLI (`pockode workspace add`) and stored in `workspaces.json`.

## Manager / Worker Pattern

### Manager

The Manager owns:
- **WorkspaceStore** — Access to registered workspaces
- **Worker map** — Running workers keyed by workspace ID
- **Config** — Shared settings (token, version, dev mode)

Workers start lazily on first request and can be stopped when idle.

### Worker

Each Worker encapsulates all resources for one workspace:

```go
type Worker struct {
    workDir string  // Project root
    dataDir string  // .pockode/ directory

    // Stores
    commandStore   *command.Store
    settingsStore  *settings.Store
    workStore      *work.FileStore
    agentRoleStore *agentrole.FileStore

    // Runtime
    agents          *agent.Registry
    worktreeManager *worktree.Manager
    workStarter     *worktree.WorkStarter
    rpcHandler      *ws.RPCHandler  // lazy init
}
```

Why this isolation:

1. **Resource isolation** — Each workspace has its own stores, agents, watchers
2. **Independent lifecycle** — Start/stop workspaces without affecting others
3. **Clean shutdown** — Worker.Stop() releases all resources

### Worker States

```
stopped ──► starting ──► running ──► stopping ──► stopped
                │                        ▲
                ▼                        │
              error ─────────────────────┘
```

- `Start()` is idempotent — calling on running worker is no-op
- `Stop()` waits for graceful shutdown of all components
- Error state clears on next `Start()` attempt

## URL Routing

Manager mode uses URL paths to route requests:

```
/w/:workspace-id/ws      → WebSocket connection
/w/:workspace-id/api/... → API endpoints
/w/:workspace-id/health  → Health check
/w/:workspace-id/...     → Redirect to SPA
/...                     → Non-workspace routes (SPA, manager API)
```

The Router:

1. Parses workspace ID from path
2. Starts worker if not running (lazy start)
3. Forwards request to worker's handler

### Frontend Integration

The frontend detects mode from the URL:

```typescript
// No workspace prefix → single mode or selection page
// /w/:id/ prefix → workspace mode

export function getWorkspaceBasePath(): string {
  const match = location.pathname.match(/^\/w\/([^/]+)/);
  return match ? `/w/${match[1]}` : "";
}
```

WebSocket connects to the appropriate endpoint:

```typescript
export function getWebSocketUrl(workspaceId?: string): string {
  const wsPath = workspaceId ? `/w/${workspaceId}/ws` : "/ws";
  // ...
}
```

## CLI Commands

### Manager Commands

```bash
pockode manager start [--port PORT] [--auth-token TOKEN]
```

Starts the manager server. Config priority: flag > config.json > environment.

### Workspace Commands

```bash
pockode workspace add [PATH] [--name NAME]  # Register workspace
pockode workspace list [-q]                  # List workspaces
pockode workspace remove <ID|PATH>           # Unregister workspace
```

## Mode Detection

```go
type Mode string

const (
    ModeSingle  Mode = "single"   // Traditional single workspace
    ModeManager Mode = "manager"  // Multi-workspace manager
)
```

- No subcommand → Single mode (backward compatible)
- `manager start` → Manager mode
- `workspace` commands → Utility, don't start server

## Backward Compatibility

Single workspace mode remains the default:

```bash
# Same behavior as before
cd /path/to/project
pockode -auth-token XXX
```

The `.pockode/` directory per project is preserved. Manager mode adds new functionality without breaking existing workflows.

### Switching to Manager Mode

No migration required. To use manager mode:

```bash
# 1. Register existing projects
pockode workspace add /path/to/existing-project

# 2. Start manager
pockode manager start --auth-token XXX

# 3. Access via browser - select workspace from the list
```

Each workspace continues using its existing `.pockode/` directory for project-specific data.

## Development Environment

The `scripts/dev.sh` script supports both single and manager modes:

```bash
# Single workspace mode (default)
./scripts/dev.sh

# Manager mode (argument)
./scripts/dev.sh manager

# Manager mode (environment variable)
MODE=manager ./scripts/dev.sh
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODE` | `single` | Startup mode (`single` or `manager`) |
| `AUTH_TOKEN` | `dev-token` | Authentication token |
| `WORK_DIR` | Project root | Working directory (single mode) |
| `SERVER_PORT` | `8080` | Backend server port |
| `WEB_PORT` | `5173` | Frontend dev server port |
| `DEV_MODE` | `true` | Enable development mode |
| `DEBUG` | `true` | Enable debug output |
| `LOG_LEVEL` | `debug` | Log verbosity |
| `RELAY_ENABLED` | `false` | Enable relay connection |
| `CLOUD_URL` | `http://local.pockode.com` | Cloud relay URL |
| `RELAY_FRONTEND_PORT` | `$WEB_PORT` | Frontend port for relay |

### Custom Port Configuration

When running single and manager modes simultaneously, or to avoid port conflicts:

```bash
SERVER_PORT=1214 WEB_PORT=9870 AUTH_TOKEN=your-token ./scripts/dev.sh manager
```

With relay enabled for remote access testing:

```bash
SERVER_PORT=1214 WEB_PORT=9870 AUTH_TOKEN=your-token RELAY_ENABLED=true ./scripts/dev.sh manager
```

### Mode Differences

**Single mode**: Runs `pnpm run dev` which starts both backend and frontend with hot reload.

**Manager mode**: Builds and runs the Go server as `pockode manager start`, then starts the frontend separately with `pnpm run dev:web`. Use this mode when developing or testing multi-workspace features.

## Code Paths

| Component | Path |
|-----------|------|
| Global config | `server/globalconfig/` |
| CLI framework | `server/cli/cli.go` |
| Manager command | `server/cli/manager.go` |
| Workspace command | `server/cli/workspace.go` |
| Mode definitions | `server/cli/mode.go` |
| Manager | `server/manager/manager.go` |
| Worker | `server/manager/worker.go` |
| Router | `server/manager/router.go` |
| Main entry | `server/main.go` |
| Frontend config | `web/src/utils/config.ts` |
| Frontend routing | `web/src/router.tsx` |
| Workspace store | `web/src/lib/workspaceStore.ts` |
