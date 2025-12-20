# AGENTS.md

本文件为 AI 编程助手提供项目上下文和开发规范。

## 项目概述

Pockode 是一个移动端编程平台，核心理念是「AI 编辑为主，手动编辑为辅」。用户通过自然语言与 AI 交互完成开发工作，而非在小屏幕上操作传统编辑器。

## 技术栈

| 层      | 技术                       |
| ------- | -------------------------- |
| 前端    | React + Vite + Tailwind    |
| 后端    | Go                         |
| 通信    | WebSocket（流式输出）      |
| AI 调用 | CLI 子进程（非 SDK 绑定）  |
| 部署    | CloudFront (前端) + EC2 Docker (后端) |

## 项目结构

```
pockode/
├── server/         # Go 后端（见 server/AGENTS.md）
├── docs/           # 技术文档
├── README.md       # 项目愿景和功能介绍
├── LICENSE.md      # O'Saasy License
├── CLAUDE.md       # Claude Code 入口（指向 AGENTS.md）
└── AGENTS.md       # AI 助手规范（本文件）
```

## 架构概览

```
CloudFront (React SPA)
        │ WebSocket
        ▼
   EC2 Docker (Go 服务)
        │ spawn + stream-json
        ▼
   AI CLI (claude / gemini / ...)
```

详细架构设计见 [docs/architecture.md](docs/architecture.md)。

## 开发规范

### 代码风格

- 前端：使用 ESLint + Prettier，遵循 React 最佳实践
- 后端：使用 `gofmt`，遵循 Go 惯用写法
- 运行 linter 和 formatter 后再提交

### Git 规范

- 分支命名：`feature/xxx`、`fix/xxx`、`refactor/xxx`
- Commit 信息简洁明了，说明「做了什么」而非「怎么做的」
- 保持 commit 粒度合理，一个 commit 做一件事

### 测试

- 编写有意义的测试，覆盖核心逻辑
- 提交前确保测试通过

## AI 助手注意事项

1. **用英语思考，用中文输出** — 内部推理使用英语以获得更好的逻辑性，但与用户交流时使用中文
2. **优先读取现有代码** — 修改前先理解上下文
3. **保持简洁** — 不做过度工程，只实现当前需求
4. **遵循现有模式** — 与项目现有代码风格保持一致
5. **不重复造轮子** — 复用现有组件和工具函数
6. **安全第一** — 注意 OWASP Top 10，避免引入安全漏洞
7. **禁止直接编辑生成文件** — 如 `package-lock.json`、`go.sum` 等 lock 文件，必须通过正规命令（`npm install`、`go mod tidy`）生成或更新
8. **DRY 原则** — 遵循《程序员修炼之道》理念，代码、测试、文档均不应有重复；每一处知识在系统中应有唯一、明确的表示

## 相关文档

- [README.md](README.md) — 项目愿景和功能介绍
- [docs/architecture.md](docs/architecture.md) — 技术架构详情
- [docs/roadmap.md](docs/roadmap.md) — MVP 开发路线图
- [LICENSE.md](LICENSE.md) — O'Saasy License
