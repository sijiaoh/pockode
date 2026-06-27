# Server

你是世界级 Go 后端工程师，负责 API + WebSocket 服务和 AI CLI 集成。

Go 1.25 + net/http + github.com/coder/websocket

## 命令

```bash
# 开发
go run . --auth-token=xxx --dev          # 运行（开发模式，不 serve 静态文件）
go test ./...                            # 测试
gofmt -w .                               # 格式化
go vet ./...                             # 静态检查

# 构建（含前端）
cd ../web && pnpm run build && cp -r dist ../server/static
go build -o server .

# Docker 镜像（从仓库根目录执行，build context 需要包含 web/ 和 site/static/images/logo.svg）
docker build -f server/Dockerfile -t pockode:local .

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
mcp/                    # MCP：stdio 代理客户端 + 服务端 Executor/APIHandler
middleware/             # Token 认证中间件
process/                # 进程管理器
relay/                  # HTTP 中继 / 多路复用（NAT 穿透）
serverinfo/             # 服务器运行时信息（server.json）
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

## 命令行参数

| 参数 | 必需 | 默认 | 说明 |
|------|:----:|------|------|
| `--auth-token` | ✓ | — | API 认证令牌 |
| `--port` | | `9870` | 服务端口 |
| `--work` | | `.` | 工作目录 |
| `--data` | | `<work>/.pockode` | 数据目录 |
| `--dev` | | `false` | 开发模式（启用时不 serve 静态文件） |
| `--idle-timeout` | | `8h` | 空闲超时时间 |
| `--relay` | | `true` | 启用 relay 远程访问（`-relay=false` 禁用） |
| `--relay-frontend-port` | | 同 server port | Relay 转发前端请求的目标端口 |
| `--cloud-url` | | `https://cloud.pockode.com` | 云服务器 URL |
| `--log-level` | | `info` | 日志级别：`debug`/`info`/`warn`/`error` |
| `--log-format` | | `text` | 日志格式：`text`/`json` |
| `--log-file` | | `dataDir/server.log`(生产) | 日志文件路径（开发模式默认输出到 stdout） |
| `--git` | | `false` | 启用 git 集成 |
| `--git-repo-url` | git时 | — | 仓库 URL |
| `--git-repo-token` | git时 | — | PAT |
| `--git-user-name` | git时 | — | commit 用户名 |
| `--git-user-email` | git时 | — | commit 邮箱 |
| `--version` | | — | 输出版本号并退出 |

## 运行时文件

### server.json

服务器启动时在 `{dataDir}/server.json` 创建，优雅关闭时删除。供编排程序发现运行中的服务器，也供 MCP 子进程（客户端模式）连接本地 API。

```json
{
  "pid": 12345,
  "port": 9870,
  "started_at": "2025-05-31T10:00:00Z",
  "local_url": "http://localhost:9870",
  "token": "<random hex>"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `pid` | int | 服务器进程 ID |
| `port` | int | 服务器监听端口 |
| `started_at` | string | 启动时间（RFC3339 格式） |
| `local_url` | string | 本地访问 URL（可选） |
| `remote_url` | string | Relay 远程访问 URL（可选） |
| `token` | string | 本地 API（MCP）认证 token，每次启动随机生成，区别于用户的 `--auth-token`，不写入磁盘外的任何位置 |

生命周期：启动时写入 → 运行期间保持 → 优雅关闭时删除

### MCP 本地 API

MCP 子进程为客户端模式：由 AI CLI 通过 `pockode mcp --data-dir <dir>` 启动，从 `server.json` 读取 `local_url` 和 `token`，将工具调用通过 HTTP（`POST /api/mcp/tools/call`，Bearer token）转发给主服务器执行（`server/mcp/` 的 `Executor`）。子进程不再直接读写文件或启动 watcher。`middleware.Auth` 仅对该精确路由放行，由 `APIHandler` 自行校验本地 token；relay 拒绝转发 `/api/mcp/*`，因此该接口实际仅 loopback 可达。

## 边界

✅ **Always**: `go test ./...` + `gofmt -w .` + `crypto/subtle.ConstantTimeCompare` 比较敏感数据

⚠️ **Ask First**: 添加外部依赖 · 修改认证逻辑 · 更改 API 路由

🚫 **Never**: 硬编码密钥 · 忽略错误 · 直接编辑 `go.sum`
