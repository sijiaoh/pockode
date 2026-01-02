# Server

你是世界级 Go 后端工程师，负责 API + WebSocket 服务和 AI CLI 集成。

Go 1.25 + net/http + github.com/coder/websocket

## 命令

```bash
# 开发
AUTH_TOKEN=xxx DEV_MODE=true go run .   # 运行（开发模式，不 serve 静态文件）
go test ./...                           # 测试
gofmt -w .                              # 格式化
go vet ./...                            # 静态检查

# 构建（含前端）
cd ../web && npm run build && cp -r dist ../server/static
go build -o server .

# 集成测试（消耗 token）
go test -tags=integration ./agent/claude -v
```

## 结构

```
main.go                 # 入口 + 路由 + graceful shutdown
agent/agent.go          # Agent/Session 接口（小接口原则）
agent/event.go          # 事件类型
agent/claude/           # Claude CLI 实现
api/session.go          # Session REST API
session/store.go        # Session 内存存储
session/types.go        # Session 类型定义
ws/handler.go           # WebSocket 连接处理
ws/message.go           # 消息类型
middleware/auth.go      # Token 认证中间件
logger/logger.go        # 结构化日志 (slog)
git/git.go              # Git 仓库初始化
```

## 风格

- `gofmt` 格式化，Go 命名惯例（缩写全大写：`HTTP`、`URL`）
- 显式错误处理，禁止忽略
- 表驱动测试：见 `middleware/auth_test.go`
- 中间件模式：见 `middleware/auth.go`

### 解析外部输出

解析 CLI JSON 失败时，返回原始内容而非 nil（优雅降级）：
```go
// ✅ 解析失败返回原始内容
if err := json.Unmarshal(data, &parsed); err != nil {
    return []Event{{Type: TypeText, Content: string(data)}}
}
```

## 日志

- 使用 `log/slog`，传递 `*slog.Logger`（通过 `slog.With()` 预设 trace ID）
- 不记录 prompt 内容（隐私）

**Trace ID**: `requestId`(HTTP) → `connId`(WS) → `sessionId`(会话)

## 环境变量

| 变量 | 必需 | 默认 | 说明 |
|------|:----:|------|------|
| `AUTH_TOKEN` | ✓ | — | API 认证令牌 |
| `SERVER_PORT` | | `8080` | 服务端口 |
| `WORK_DIR` | | `/workspace` | 工作目录 |
| `DEV_MODE` | | `false` | 开发模式（true 时不 serve 静态文件） |
| `RELAY_PORT` | | `SERVER_PORT` | Relay 转发目标端口（开发时可设为前端端口） |
| `LOG_FORMAT` | | `text` | `json` / `text` |
| `LOG_LEVEL` | | `info` | `debug`/`info`/`warn`/`error` |
| `LOG_FILE` | | `dataDir/server.log`(生产) | 日志文件路径（开发模式默认输出到 stdout） |
| `GIT_ENABLED` | | `false` | 启用 git |
| `REPOSITORY_URL` | git时 | — | 仓库 URL |
| `REPOSITORY_TOKEN` | git时 | — | PAT |
| `GIT_USER_NAME` | git时 | — | commit 用户名 |
| `GIT_USER_EMAIL` | git时 | — | commit 邮箱 |

## 边界

✅ **Always**: `go test ./...` + `gofmt -w .` + `crypto/subtle.ConstantTimeCompare` 比较敏感数据

⚠️ **Ask First**: 添加外部依赖 · 修改认证逻辑 · 更改 API 路由

🚫 **Never**: 硬编码密钥 · 忽略错误 · 直接编辑 `go.sum`
