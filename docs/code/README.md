# Code Documentation

Index of Pockode code explanation documents. These documents focus on "why it's designed this way" to help understand system architecture and key design decisions.

## Document List

| Document | Description | Modules |
|----------|-------------|---------|
| [WebSocket JSON-RPC](websocket-rpc.md) | Frontend-backend communication protocol design | `server/ws/`, `web/src/lib/wsStore.ts` |
| [Authentication & Access Control](authentication.md) | Trust model, credential surfaces, sessions, and hardening | `server/password/`, `server/authsession/`, `server/middleware/`, `server/mcp/` |
| [AI Agent Integration](agent-integration.md) | Claude/Codex subprocess management, content blocks and attachments | `server/agent/`, `server/process/`, `server/attachments/` |
| [Work/Project Management](work-system.md) | Task decomposition and coordination | `server/work/`, `server/mcp/`, `web/src/lib/workStore.ts` |
| [Real-time Subscription System](subscription-system.md) | Who names a subscription, watcher architecture, backpressure handling | `server/watch/`, `web/src/hooks/useSubscription.ts` |
| [Frontend State Management](frontend-state.md) | Zustand stores and extension system | `web/src/lib/` |
| [Relay NAT Traversal](relay-system.md) | Mobile access to local PC, and port previews | `server/relay/` |
| [Cloud Account Linking](cloud-account.md) | `cloud.json`, the device flow behind `pockode login` / `logout` and the UI's `cloud_link.*`, and attaching each relay to the account | `server/cloudcred/`, `server/cloudlogin/`, `server/ws/rpc_cloud_link.go`, `server/relay/account.go` |
| [AI CLI Sign-in](cli-auth.md) | Whether each AI CLI is signed in on the server machine, signing in from a phone, and signing out | `server/cliauth/`, `server/agent/*/auth.go`, `server/agent/*/login.go` |
| [AI CLI Update](cli-update.md) | Whether each AI CLI has a newer release, and updating it from a phone | `server/cliupdate/`, `server/agent/*/update.go` |
| [Self-Restart](self-restart.md) | Replacing a running server or cluster with the executable on disk: what is saved at startup, the check before anything stops, the password hand-over, unix exec and the Windows successor | `server/internal/restart/`, `server/internal/shutdown/`, `server/ws/rpc_server.go` |
| [Self-Update](self-update.md) | Installing a newer release over the running executable from the UI: which releases are offered, what the installer trusts, one install per OS user, and the two renames on Windows | `server/internal/release/`, `server/selfinstall/`, `server/ws/rpc_server_update.go` |
| [Fuzzy Matching](fuzzy-matching.md) | fzf's matching, scoring and query syntax ported in: why a port, the third-party boundary, and wiring it into a search | `server/fuzzy/` |

Two of these — [Agent Integration](agent-integration.md) and
[Work](work-system.md) — build one half each of the same model: how long a
process, a session and a work item live, and which of them owns what. The model
itself is [lifecycle.md](../lifecycle.md), one level up. Read it first when the
question is about state rather than about a CLI.

## Reading Guide

### Beginner's Path

If you're new to Pockode, we recommend reading in this order:

1. **[WebSocket JSON-RPC](websocket-rpc.md)** — Understand how frontend and backend communicate
2. **[AI Agent Integration](agent-integration.md)** — Understand the core feature: AI conversation
3. **[Work/Project Management](work-system.md)** — Understand task coordination mechanisms

### On-Demand Reading

Choose based on the module you're working with:

- **Frontend Development** → [Frontend State Management](frontend-state.md)
- **Real-time Features** → [Real-time Subscription System](subscription-system.md)
- **Mobile Deployment** → [Relay NAT Traversal](relay-system.md)

## Documentation Conventions

These documents follow these principles:

- **Focus on "Why"** — Explain design decisions, not reiterate code
- **Include Code Paths** — Key modules come with file path references
- **Stay DRY** — Avoid duplicating code comments
