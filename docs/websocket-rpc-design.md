# WebSocket RPC 設計

全ての通信を WebSocket JSON-RPC 2.0 で行う。REST API は使用しない。

## 背景

Pockode は Relay を介して NAT 内のユーザー PC と通信する:

```
モバイルアプリ ──WebSocket──▶ Relay Server ──WebSocket──▶ ユーザー PC (NAT内)
```

NAT 越えには PC 側からの常時接続が必須であり、WebSocket が自然な選択となる。

## メソッド命名規則

メソッド名は `namespace.method` 形式でネームスペースを使用する。

| ネームスペース | スコープ | ハンドラ |
|---------------|---------|---------|
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

- **worktree スコープ**: 現在のワークツリーに紐づくメソッド
- **app スコープ**: ワークツリーに依存しないメソッド

購読系は `*.subscribe` / `*.unsubscribe` パターン。サーバーからの通知は `*.changed` パターン。

## ライブラリ

| 層 | ライブラリ |
|----|-----------|
| Go | [sourcegraph/jsonrpc2](https://github.com/sourcegraph/jsonrpc2) |
| TypeScript | [json-rpc-2.0](https://github.com/shogowada/json-rpc-2.0) |

## 参考

- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
