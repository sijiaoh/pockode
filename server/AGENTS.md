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
cd ../web && pnpm run build && cp -r dist ../server/static
go build -o server .

# 集成测试（消耗 token）
go test -tags=integration ./agent/claude -v
```

## 结构

```
main.go                 # 入口 + 路由 + graceful shutdown
agent/                  # Agent 抽象（接口, 事件, 进程管理, 注册表）
  claude/               # Claude CLI 实现
  codex/                # Codex CLI 实现
agentrole/              # AgentRole 存储 + 类型定义
chat/                   # Chat 客户端
command/                # 命令存储
contents/               # 文件内容获取
filestore/              # JSON 文件存储基础设施
git/                    # Git 操作
logger/                 # 结构化日志 (slog)
mcp/                    # MCP 服务器（stdio JSON-RPC，供 AI CLI 使用）
middleware/             # Token 认证中间件
process/                # 进程管理器
relay/                  # HTTP 中继 / 多路复用（NAT 穿透）
rpc/                    # RPC 消息类型定义
session/                # Session 存储 + 清理
settings/               # 设置存储
startup/                # 启动横幅
static/                 # 静态文件（构建后的前端资源）
watch/                  # 实时订阅（WebSocket 通知的分发引擎）
work/                   # Work 存储, 状态机, AutoResumer, 提示词构建器
worktree/               # Worktree 管理, WorkStarter, WorkStopper
ws/                     # WebSocket RPC 处理（rpc_*.go 按领域分割）
```

## 风格

- `gofmt` 格式化，Go 命名惯例（缩写全大写：`HTTP`、`URL`）
- 显式错误处理，禁止忽略
- 表驱动测试：见 `middleware/auth_test.go`
- 中间件模式：见 `middleware/auth.go`
- Mutex 命名：不用 `mu`，用明确说明保护对象的名称（如 `requestsMu`、`streamsMu`）

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
