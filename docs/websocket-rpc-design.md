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

- `auth` - 認証（ネームスペースなし、接続時に最初に呼び出す）
- `chat.*` - チャット関連のメソッド
- `session.*` - セッション管理のメソッド

### Client → Server (リクエスト)

| メソッド | 用途 |
|---------|------|
| `auth` | トークン認証 |
| `chat.messages.subscribe` | チャットメッセージ購読開始（履歴も返す） |
| `chat.messages.unsubscribe` | チャットメッセージ購読解除 |
| `chat.message` | ユーザーメッセージ送信 |
| `chat.interrupt` | AI 処理の中断 |
| `chat.permission_response` | 権限リクエストへの応答 |
| `chat.question_response` | ユーザー質問への応答 |
| `session.list.subscribe` | セッション一覧変更の購読開始 |
| `session.list.unsubscribe` | セッション一覧変更の購読解除 |
| `session.create` | 新規セッション作成 |
| `session.delete` | セッション削除 |
| `session.update_title` | セッションタイトル更新 |

### Server → Client (通知)

| メソッド | 用途 |
|---------|------|
| `chat.text` | AI テキスト出力 |
| `chat.tool_call` | ツール呼び出し開始 |
| `chat.tool_result` | ツール実行結果 |
| `chat.error` | エラー発生 |
| `chat.done` | 応答完了 |
| `chat.interrupted` | 中断完了 |
| `chat.process_ended` | プロセス終了 |
| `chat.permission_request` | 権限リクエスト |
| `chat.request_cancelled` | リクエストキャンセル |
| `chat.ask_user_question` | ユーザーへの質問 |
| `chat.system` | システムメッセージ |

## ライブラリ

| 層 | ライブラリ |
|----|-----------|
| Go | [sourcegraph/jsonrpc2](https://github.com/sourcegraph/jsonrpc2) |
| TypeScript | [json-rpc-2.0](https://github.com/shogowada/json-rpc-2.0) |

## 参考

- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
