# Pockode 技术架构

## 整体架构

前后端分离，后端调用 AI CLI 工具。

```
┌─────────────────────────────────────────────────────┐
│                   CloudFront                         │
│                (React SPA 静态托管)                   │
└─────────────────────┬───────────────────────────────┘
                      │ WebSocket
                      ▼
┌─────────────────────────────────────────────────────┐
│                  EC2 Docker                          │
│                   Go 服务                            │
└─────────────────────┬───────────────────────────────┘
                      │ spawn + stream-json
                      ▼
┌─────────────────────────────────────────────────────┐
│           AI CLI (claude / gemini / ...)            │
└─────────────────────────────────────────────────────┘
```

## 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| 前端 | React + Vite + Tailwind | CDN 部署，生态成熟，快速开发 |
| 后端 | Go | 单一二进制，轻量，适合小型实例 |
| 通信 | WebSocket | 流式输出 |
| AI 调用 | CLI 子进程 | 不绑定特定 SDK，支持多种 AI 代理 |

## AI 代理调用

通过 CLI 调用，解析 JSON 流输出：

```bash
claude -p "prompt" --output-format stream-json
```

定义统一的事件接口，各 CLI 适配器负责转换：

```
AgentEvent = text | tool_call | tool_result | error | done
```

## Git 初始化（可选）

服务启动时可自动 clone Git 仓库，使 AI 可以执行完整的 git 操作。

### 启用方式

设置 `GIT_ENABLED=true`，并提供必需的环境变量：

| 变量 | 说明 |
|------|------|
| `GIT_ENABLED` | 启用开关，默认 `false` |
| `REPOSITORY_URL` | Git 仓库 URL（必需） |
| `REPOSITORY_TOKEN` | Personal Access Token（必需） |
| `GIT_USER_NAME` | commit 用户名（必需） |
| `GIT_USER_EMAIL` | commit 邮箱（必需） |

### 初始化流程

```
1. git init
2. 配置 local credential helper（.git/.git-credentials）
3. git remote add origin
4. git fetch + checkout 默认分支
5. git config user.name/email
```

### 安全考虑

- Token 仅存于 `.git/.git-credentials`（仓库内部）
- 不污染全局 `~/.git-credentials`
- `.git/config` 中只有干净 URL

## 部署

- **前端**: S3 + CloudFront
- **后端**: EC2 Docker（需包含 AI CLI）
