# Server AGENTS.md

Go 后端服务的 AI 编程助手指南。

## 技术栈

- Go 1.25
- 标准库 HTTP 服务器（`net/http`）
- 无外部依赖

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
├── main.go           # 入口 + 路由
├── main_test.go      # 端点测试
├── middleware/
│   ├── auth.go       # Token 认证中间件
│   └── auth_test.go
└── go.mod
```

## 代码风格

- 使用 `gofmt` 格式化
- 错误处理：显式检查，不忽略
- 命名：遵循 Go 惯例（驼峰命名，缩写全大写如 `HTTP`、`URL`）
- 注释：仅在逻辑不明显时添加

### 示例模式

- 中间件模式：见 `middleware/auth.go`
- 表驱动测试：见 `middleware/auth_test.go`

## 测试

- 使用标准库 `testing` + `httptest`
- 表驱动测试优先
- 测试函数命名：`TestXxx` 或 `TestXxx_SubCase`

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
