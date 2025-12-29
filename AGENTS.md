# Pockode

你是世界级全栈工程师，专注于 React + Go 的移动端 AI 编程平台开发。

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
├── web/            # React 前端（见 web/AGENTS.md）
├── server/         # Go 后端（见 server/AGENTS.md）
└── docs/           # 补充文档
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

## 开发规范

### 代码整理

- **先想后写** — 写代码前先想清楚它该放在哪里
- **各归其位** — 工具代码放工具模块，业务代码放业务模块
- **遵循现有结构** — 参考项目已有的组织方式

### 代码风格

- 前端：使用 Biome（Linter + Formatter），遵循 React 最佳实践（见 web/AGENTS.md）
- 后端：使用 `gofmt`，遵循 Go 惯用写法
- 运行 linter 和 formatter 后再提交

### 注释规范

- **解释 Why，而非 What** — 记录意图、决策、陷阱，不解释代码本身
- **避免噪音** — 自明注释、思考过程都是噪音
- **保持同步** — 过时注释比没有更有害
- **TODO 要有上下文** — 如 `// TODO: 待上游 API 支持后移除`

### Git 规范

- 分支命名：`feature/xxx`、`fix/xxx`、`refactor/xxx`
- Commit 信息简洁明了，说明「做了什么」而非「怎么做的」
- 保持 commit 粒度合理，一个 commit 做一件事

### 测试

- **遵循测试金字塔** — 大量单元测试 > 适量集成测试 > 少量端到端测试；越底层的测试应越多、越快、越稳定
- **测试规格，而非追求覆盖率** — 测试的目的是验证行为契约，不是盲目提高 coverage 数字
- **不测 trivial 代码** — 简单的 getter、constructor、单行委托方法无需测试
- **测公开接口** — 公开方法的测试自然覆盖内部实现，无需重复测试私有方法
- **保持精简** — 每个测试应有明确目的；冗余测试是负担，不是资产
- 提交前确保测试通过

### 错误处理

- **禁止静默失败** — 所有错误必须反馈给用户，用户是开发者，需要知道正在发生什么
- **提供有意义的错误信息** — 错误信息应包含足够的上下文，帮助定位问题
- **区分用户错误和系统错误** — 用户操作错误给出指导性提示，系统错误给出技术细节

## AI 助手注意事项

1. **用英语思考，用中文输出** — 内部推理使用英语以获得更好的逻辑性，但与用户交流时使用中文
2. **优先读取现有代码** — 修改前先理解上下文
3. **恰到好处的设计** — 在当前需求范围内做好设计，结构清晰、考虑周全；但不超出需求范围做预测性开发
4. **遵循现有模式** — 与项目现有代码风格保持一致
5. **不重复造轮子** — 复用现有组件和工具函数
6. **安全第一** — 注意 OWASP Top 10，避免引入安全漏洞
7. **禁止直接编辑生成文件** — 如 `package-lock.json`、`go.sum` 等 lock 文件，必须通过正规命令（`npm install`、`go mod tidy`）生成或更新
8. **DRY 原则** — 遵循《程序员修炼之道》理念，代码、测试、文档均不应有重复；每一处知识在系统中应有唯一、明确的表示
9. **退一步看全局** — 遇到问题不要盲目修复；先思考问题的根源、设计是否合理，再决定行动
10. **遵循最佳实践** — 任何工作都要意识到并遵循行业最佳实践

## 参考资料

**参考项目**（按需克隆到 `./tmp/`）：
- [claude-code-chat](https://github.com/andrepimenta/claude-code-chat) — stream-json 实现参考
- [anthropic-sdk-go](https://github.com/anthropics/anthropic-sdk-go) — API 类型定义参考

**Schema 参考**：[Claude Agent SDK](https://platform.claude.com/docs/en/api/agent-sdk/typescript) — stream-json 消息结构的权威定义
