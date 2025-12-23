# Server AGENTS.md

Go 后端服务的 AI 编程助手指南。

## 技术栈

- Go 1.25
- 标准库 HTTP 服务器（`net/http`）
- WebSocket: `github.com/coder/websocket`

## 命令

```bash
# 构建
go build -o server .

# 测试
go test ./...

# 单文件测试（优先使用）
go test -run TestAuth ./middleware
go test -run TestPing .

# 格式化
gofmt -w .

# 静态检查
go vet ./...

# 运行
AUTH_TOKEN=your-token go run .
```

## 项目结构

```
server/
├── main.go              # 入口 + 路由 + graceful shutdown
├── main_test.go         # 端点测试
├── agent/
│   ├── agent.go         # Agent/Session 接口定义
│   ├── event.go         # 事件类型定义
│   └── claude/
│       ├── claude.go    # Claude CLI 实现
│       └── claude_test.go
├── ws/
│   ├── handler.go       # WebSocket 连接处理
│   ├── message.go       # 消息类型定义
│   └── handler_test.go
├── middleware/
│   ├── auth.go          # Token 认证中间件
│   └── auth_test.go
├── logger/
│   └── logger.go        # 日志工具
├── git/
│   ├── git.go           # Git 仓库初始化
│   └── git_test.go
└── go.mod
```

## 代码风格

- 使用 `gofmt` 格式化
- 错误处理：显式检查，不忽略
- 命名：遵循 Go 惯例（驼峰命名，缩写全大写如 `HTTP`、`URL`）
- 注释：仅在逻辑不明显时添加

### 示例模式

- 中间件模式：见 `middleware/auth.go`
- 接口设计：见 `agent/agent.go`（小接口原则，Agent 只有一个方法）
- 表驱动测试：见 `middleware/auth_test.go`、`agent/claude/claude_test.go`

### 解析外部输出的容错原则

解析外部系统输出（如 Claude CLI 的 JSON）时，必须遵循「优雅降级」原则：

```go
// ✅ 正确：解析失败时返回原始内容作为回退
if err := json.Unmarshal(data, &parsed); err != nil {
    logger.Error("parse failed: %v", err)
    return []Event{{Type: TypeText, Content: string(data)}}
}

// ❌ 错误：解析失败时返回 nil，导致用户无法看到任何内容
if err := json.Unmarshal(data, &parsed); err != nil {
    logger.Error("parse failed: %v", err)
    return nil
}
```

**理由**：外部系统的输出格式可能变化，解析失败不应导致用户完全无法使用。即使格式不正确，显示原始内容也比什么都不显示好。

## 测试

- 使用标准库 `testing` + `httptest`
- 表驱动测试优先
- 测试函数命名：`TestXxx` 或 `TestXxx_SubCase`

### 集成测试（消耗 token）

调用真实 Claude CLI 的集成测试，验证事件流和工具调用解析：

```bash
# 手动执行（需要 claude CLI + API 凭证）
go test -tags=integration ./agent/claude -v -run Integration
```

⚠️ 会消耗 API token，仅在以下情况手动执行：
- 修改了 `agent/claude/claude.go` 的解析逻辑
- 升级 Claude CLI 版本后

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | 否 | `8080` | 服务端口 |
| `AUTH_TOKEN` | 是 | — | API 认证令牌 |
| `WORK_DIR` | 否 | `/workspace` | 工作目录 |
| `DEV_MODE` | 否 | `false` | 开发模式 |
| `GIT_ENABLED` | 否 | `false` | 启用 git 初始化 |
| `REPOSITORY_URL` | GIT_ENABLED=true 时必需 | — | Git 仓库 URL |
| `REPOSITORY_TOKEN` | GIT_ENABLED=true 时必需 | — | 仓库的 PAT |
| `GIT_USER_NAME` | GIT_ENABLED=true 时必需 | — | git commit 用户名 |
| `GIT_USER_EMAIL` | GIT_ENABLED=true 时必需 | — | git commit 邮箱 |

## 边界

### Always Do

- 运行 `go test ./...` 确认测试通过
- 运行 `gofmt -w .` 格式化代码
- 使用 `crypto/subtle.ConstantTimeCompare` 比较敏感数据

### Ask First

- 添加新的外部依赖
- 修改认证逻辑
- 更改 API 路由结构

### Never Do

- 硬编码密钥或 token
- 忽略错误返回值
- 直接编辑 `go.sum`（使用 `go mod tidy`）
