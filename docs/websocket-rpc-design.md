# WebSocket RPC Design

All communication uses WebSocket JSON-RPC 2.0. REST APIs are not used.

## Background

Pockode communicates with user PCs behind NAT via a Relay:

```
Mobile App ──WebSocket──▶ Relay Server ──WebSocket──▶ User PC (behind NAT)
```

NAT traversal requires a persistent connection initiated from the PC side, making WebSocket a natural choice.

## Method Naming Convention

Method names use the `namespace.method` format with namespaces.

| Namespace | Scope | Handler |
|-----------|-------|---------|
| `auth` | — | `ws/rpc.go` |
| `chat.*` | worktree | `ws/rpc_chat.go` |
| `session.*` | worktree | `ws/rpc_session.go` |
| `file.*` | worktree | `ws/rpc_file.go` |
| `git.*` | worktree | `ws/rpc_git.go` |
| `fs.*` | worktree | `ws/rpc_fs.go` |
| `worktree.*` | app | `ws/rpc_worktree.go` |
| `command.*` | app | `ws/rpc_command.go` |
| `settings.*` | app | `ws/rpc_settings.go` |
| `work.*` | app | `ws/rpc_work.go` |
| `agent_role.*` | app | `ws/rpc_agent_role.go` |

- **worktree scope**: Methods bound to the current worktree
- **app scope**: Methods independent of any worktree

Subscriptions use the `*.subscribe` / `*.unsubscribe` pattern. Server notifications use the `*.changed` pattern.

## Libraries

| Layer | Library |
|-------|---------|
| Go | [sourcegraph/jsonrpc2](https://github.com/sourcegraph/jsonrpc2) |
| TypeScript | [json-rpc-2.0](https://github.com/shogowada/json-rpc-2.0) |

## References

- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
