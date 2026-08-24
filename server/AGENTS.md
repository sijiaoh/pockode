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
filestore/              # 文件存储基础设施（原子写 / flock / JSONL / 变更监听）
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

### 持久化写入

服务器要长期保存的状态文件一律走 `filestore` 的公共 API，**不要直接 `os.WriteFile`**。裸写会先 truncate 再写，断电、`kill -9`、磁盘写满都会留下一个被截断的文件——session 索引损坏、relay 永久起不来、agent 静默失去全部 MCP 工具，都是这么来的。

| 场景 | API |
|------|-----|
| 整文件重写 | `filestore.WriteFileAtomic(path, data, perm)`（写临时文件 → fsync → rename；含 token 的传 `0600`，替换后的文件不继承旧权限） |
| store 读回自己的状态文件 | `filestore.ReadFileLocked(path)`（共享锁；`filestore.New` 的 `File.Read` 走的就是它） |
| 启动时加载 JSON 状态 | `filestore.ReadJSONOrQuarantine(path, label, v)`——解析失败则隔离为 `<path>.corrupt` 并以空状态启动，**不要**因为一个文件坏了就让服务器起不来 |
| 只追加的流式记录 | `filestore.AppendJSONL` / `filestore.ReadJSONL`（单次 write 系统调用、**不** fsync，读端跳过坏行；绝不能丢尾部的数据请改用整文件重写） |

用 `filestore.New` 建的 `File` 已经内建这套写入方式，直接用即可。

读这一侧记住一句话：**加锁是为「读-改-写」服务的，不是为「读到一个完整文件」服务的**——后者 rename 本身已经保证了。由此有两个容易踩的点：

- **只是想读一眼某个数据目录（比如探测别的项目的 `server.json`），用 `os.ReadFile`，别加锁。** 锁挡不住「读到的是旧版还是新版」（那取决于时序），却会在一个你只想看一眼的目录里凭空建出 `.lock`。`serverinfo.Read` 正是因此从 `ReadFileLocked` 回退成了普通读。
- **`ReadFileLocked` 拿的是共享锁，不能让「读-改-写」变成原子的。** 需要那个语义就得整段持排他锁——`ReadJSONOrQuarantine` 就是这么做的：读和隔离在同一把排他锁内，否则会把两次上锁之间别人刚写好的完好文件给隔离掉。

**故意不用的情况**：用户项目里的源码文件（rename 会断链接、改权限、换 inode，还在工作区留 `.tmp`/`.lock`）、追加型日志、以及锁文件名会和外部工具撞车的文件（`.git-credentials`）。这类例外的理由都不直觉，**必须在调用点写注释**说明为什么不能改；完整清单见 [docs/projects/data-model.md](../docs/projects/data-model.md#atomic-writes)。

## 日志

- 使用 `log/slog`，传递 `*slog.Logger`（通过 `slog.With()` 预设 trace ID）
- 不记录 prompt 内容（隐私）

**Trace ID**: `requestId`(HTTP) → `connId`(WS) → `sessionId`(会话)

## 命令行参数

| 参数 | 必需 | 默认 | 说明 |
|------|:----:|------|------|
| `--auth-token` | ✓ | — | API 认证令牌（未设时回退到环境变量 `POCKODE_AUTH_TOKEN`；env 方式可避免 token 出现在进程 argv 中被同机其他用户读取）|
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

上表为默认（server）模式。此外还有两个子命令（`flag.Parse()` 前分发，见 `main.go`）：

- `pockode cluster` — 多项目节点编排模式，注册并按需启停多个项目，参数与实现见 [docs/cluster.md](../docs/cluster.md)
- `pockode mcp` — MCP stdio 代理，由 AI CLI 内部启动，见下方「MCP 本地 API」

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

MCP 子进程为客户端模式：由 AI CLI 通过 `pockode mcp --data-dir <dir>` 启动，从 `server.json` 读取 `local_url` 和 `token`，将工具调用通过 HTTP（`POST /api/mcp/tools/call`，Bearer token）转发给主服务器执行（`server/mcp/` 的 `Executor`）。子进程不直接读写文件或启动 watcher。`middleware.Auth` 仅对该精确路由放行，由 `APIHandler` 自行校验本地 token；relay 拒绝转发 `/api/mcp/*`，因此该接口实际仅 loopback 可达。

## 边界

✅ **Always**: `go test ./...` + `gofmt -w .` + `crypto/subtle.ConstantTimeCompare` 比较敏感数据

⚠️ **Ask First**: 添加外部依赖 · 修改认证逻辑 · 更改 API 路由

🚫 **Never**: 硬编码密钥 · 忽略错误 · 直接编辑 `go.sum` · 用裸 `os.WriteFile` 写持久化状态文件（见「持久化写入」）
