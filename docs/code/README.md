# Code Documentation

Index of Pockode code explanation documents. These documents focus on "why it's designed this way" to help understand system architecture and key design decisions.

## Document List

| Document | Description | Modules |
|----------|-------------|---------|
| [WebSocket JSON-RPC](websocket-rpc.md) | Frontend-backend communication protocol design | `server/ws/`, `web/src/lib/wsStore.ts` |
| [AI Agent Integration](agent-integration.md) | Claude/Codex subprocess management | `server/agent/`, `server/process/` |
| [Work/Project Management](work-system.md) | Task decomposition and coordination | `server/work/`, `server/mcp/` |
| [Real-time Subscription System](subscription-system.md) | Watcher architecture and backpressure handling | `server/watch/`, `web/src/hooks/useSubscription.ts` |
| [Frontend State Management](frontend-state.md) | Zustand stores and extension system | `web/src/lib/` |
| [Relay NAT Traversal](relay-system.md) | Mobile access to local PC | `server/relay/` |

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
