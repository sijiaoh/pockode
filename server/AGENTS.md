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

### 跨平台

Windows 与 darwin/linux 一样是发布目标（产物见 [docs/platforms.md](../docs/platforms.md)）。平台差异一律用构建标签分文件承载，业务代码里不出现 `runtime.GOOS`：平台无关的文件定义类型和调用点，`_unix.go`（`//go:build !windows`）/ `_windows.go` 各提供一份实现。

| 平台无关入口 | 平台实现 |
|------|----------|
| `filestore/lock.go` | `lock_{unix,windows}.go` — `flock(2)` / `LockFileEx` |
| `filestore/rename.go` | `rename_{unix,windows}.go` — Windows 上替换目标可能被临时占用，需重试 |
| `agent/process.go` | `procgroup_{unix,windows}.go` — 进程组 / Job Object，Windows 另加 `CREATE_NO_WINDOW` |
| `agent/command.go` | `command_{unix,windows}.go` — AI CLI 的查找兜底目录 + `.cmd` 包装器的命令行构造 |
| `worktree/setup.go` | `hook_shell_{unix,windows}.go` — setup hook 的解释器（Windows 无 bash，探测 Git for Windows） |
| `internal/pathutil/pathutil.go` | `equal_{unix,windows}.go` — Windows 路径比较大小写不敏感 |
| `internal/fsperm/fsperm.go` | `fsperm_{unix,windows}.go` — 0700/0600 mode 位 / 显式 DACL |
| `cluster/node/process.go` | `process_{unix,windows}.go` — 与终端脱钩（`Setsid` / `DETACHED_PROCESS`）、优雅关闭与强杀的等待方式 |
| `internal/shutdown/shutdown.go` | `request_{unix,windows}.go` — SIGTERM / 命名事件 |

**路径处理统一走 `internal/pathutil`**，不要在各包里重新实现一遍：

| 函数 | 用途 |
|------|------|
| `Equal(a, b)` | 原生路径相等判断（Windows 大小写不敏感）|
| `ChildName(path, dir)` | path 是否在 dir 下，以及其下第一段的名字 |
| `IsAnchored(path)` | 路径是否被 OS 锚定在别处——绝对路径，外加 `filepath.IsAbs` 判为相对的两种 Windows 形式：`\etc`（当前盘）和 `C:etc`（该盘的工作目录）。给「允许有意逃逸、但不能被锚在别处」的场景用（如 `../worktrees` 设置）|
| `TrimTildePrefix(path)` / `ExpandTilde(path)` | `~` 展开。`\` 只在 Windows 上算分隔符；Windows 上没有 shell 替我们展开 `~`，用户输入的 `~\projects` 是原样送达的 |

参数一律是**原生路径**。外部来的值默认不是：git 的输出、手写的设置、我们自己 API 里的路径都用 `/`，进来时 `filepath.FromSlash`，出去时 `filepath.ToSlash`。

**启动 AI CLI 一律走 `agent.Command`**，不要直接 `exec.Command(claude.Binary, …)`。它做两件各自都容易漏掉的事：`lookupBinary` 在 PATH 之外补上安装器的默认目录（Windows 上 PATH 是进程启动时定死的，装在 pockode.exe 启动之后的 CLI 就是看不见的），以及在可执行文件是 npm 装出来的 `.cmd` 时自己构造命令行——Windows 跑批处理文件是把命令行交给 cmd.exe，而 `os/exec` 按 `CommandLineToArgvW` 的规则加引号，两套规则对不上（Go 只在文档里提了一句，没有修，见 `agent/cmdline.go`）。

**存凭据的地方用 `internal/fsperm` 收紧，收紧的对象是目录不是文件**。`os.WriteFile(path, data, 0600)` 在 Windows 上什么也没做——Go 只把 perm 映射到只读属性，实际访问权来自父目录继承来的 ACL，而盘符根下建出来的目录一律继承一条 `BUILTIN\Users` 读权限。收紧目录才有两个逐个收紧文件拿不到的性质：**新建的文件自动继承**（`.pockode` 里的 session 记录、`server.log`、work store 都归它管，不必在每个写入点重复一遍），以及**扛得住 temp+rename**（`filestore` 和 git 的 `store` helper 都是先写临时文件再改名覆盖，改名进来的文件带的是它自己创建时的权限，逐个文件收紧会被下一次写入静默抹掉）。

`RestrictDir(dir) error` 是这个包唯一的入口：建目录并收紧。返回的 error 只来自建目录；权限本身设不上（FAT/exFAT 没有权限可言）只 warn 不失败，这层是纵深防御，不该变成 Pockode 拒绝启动的新理由。

**别加「收紧单个文件」的口子。** `.git/.git-credentials` 看着像是需要它，其实不是：git 的 `store` helper 在每次认证成功后都会重写这个文件（写 `.lock` 再改名覆盖），设在文件上的权限第一次 push 就没了——它自己的 `umask(077)` 在 unix 上兜住了 0600，但 umask 在 Windows 上不代表任何东西。所以收紧的是 `.git` 目录，而且只在 `git.Init` 亲手 `git init` 出来的那个仓库上做（`.git` 已存在时 `Init` 直接返回，不碰用户自己的仓库）。

**退出请求统一走 `internal/shutdown`**：`Listen()` 让本进程知道该退出了，`RequestExit(pid)` 让别的进程退出。别在别处再写一遍 `signal.Notify`。Windows 没有 SIGTERM 可发，官方的替代品 Ctrl+Break 只能送到与**调用方**共享控制台的进程，服务 / 计划任务 / detached 启动的集群一律送不到，所以那边走的是命名事件；等待方和发信方必须对上同一个名字，两半因此放在同一个包里。来龙去脉见 [docs/cluster.md](../docs/cluster.md#asking-a-node-to-exit-on-windows)。

**节点与集群的终端脱钩，两个平台都是**：unix 用 `Setsid`，Windows 用 `DETACHED_PROCESS`——节点要活过启动集群的那个 shell，就不能待在它的终端/控制台上，否则关掉终端窗口会把节点一起带走（Windows 会给控制台上所有进程发 `CTRL_CLOSE_EVENT`）。**这件事和 AI CLI 那边的 `CREATE_NO_WINDOW` 是一对**：没有控制台的进程再去启动控制台程序时，Windows 会给它新分配一个**可见**的控制台窗口，集群模式下每次调 AI CLI 都会闪一个黑窗。改其中一处务必看另一处。

「这个路径必须留在某目录内」用标准库的 **`filepath.IsLocal`**，别自己拼条件：它一并挡掉 `..` 逃逸和 Windows 保留设备名（`NUL`、`COM1`——这类名字解析到设备而不是目录里的文件）。`git.validatePath` 和 `contents.ValidatePath` 都走它，因此二者的判定是结构上一致的，而不是各写一遍碰巧一致。

三条最容易踩错的地方：

- **跑 `GOOS=windows GOARCH=amd64 go vet ./...`，不只是 `go build`** —— `go build` 不编译 `_test.go`，而测试文件里的 `syscall` 和路径假设正是最容易在 Windows 上腐化的部分。CI 的 `windows-cross-compile` job 两步都跑。
- **`git` 的输出永远是正斜杠**，即使在 Windows 上；和原生路径比较前要 `filepath.FromSlash`（见 `worktree/registry.go` 的 `parseWorktreeList`）。反过来，传给 bash 脚本的路径要 `filepath.ToSlash`，因为 bash 里反斜杠是转义符。
- **平台相关的测试 skip 必须写明理由**。CI 的测试步骤会在末尾打印 skip 清单——全靠 skip 变绿的矩阵腿比没有这条腿更糟。装了 Git for Windows 的 Windows runner 上**目前一条都不应出现**，多出来的每一条都要追。能用平台分表（如 `settings_test.go` 的路径用例）就不要 skip；断言本身在两个平台上形状不同时，把它抽成平台分文件的测试辅助（如 `internal/fspermtest`、`internal/termtest`），而不是在 Windows 上 skip 掉——权限测试恰恰在权限有问题的那个平台上 skip，等于什么都没证明。

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

🚫 **Never**: 硬编码密钥 · 忽略错误 · 直接编辑 `go.sum`
