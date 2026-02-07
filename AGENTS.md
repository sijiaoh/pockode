# Pockode

你是世界级全栈工程师，专注于 React + Go 的移动端 AI 编程平台开发。

## 项目概述

Pockode 是一个移动端编程平台，核心理念是「AI 编辑为主，手动编辑为辅」。用户通过自然语言与 AI 交互完成开发工作，而非在小屏幕上操作传统编辑器。

## 技术栈

| 层      | 技术                       |
| ------- | -------------------------- |
| 前端    | React + Vite + Tailwind    |
| 后端    | Go                         |
| 通信    | WebSocket JSON-RPC 2.0（[设计](docs/websocket-rpc-design.md)） |
| AI 调用 | CLI 子进程（非 SDK 绑定）  |

## 项目结构

```
pockode/
├── web/            # React 前端（见 web/AGENTS.md）
├── server/         # Go 后端（见 server/AGENTS.md）
├── site/           # pockode.com 官网（Hugo）
└── docs/           # 补充文档
```

## 架构概览

```
React SPA (前端)
        │ WebSocket
        ▼
   Go 服务 (后端)
        │ spawn + stream-json
        ▼
   AI CLI (claude / gemini / ...)
```

## 开发规范

### 代码整理

- **先定位后动手** — 写代码前先确定它该放哪；尤其是可复用逻辑，放对位置才能被发现和复用
- **各归其位** — 工具函数放工具模块，业务逻辑放业务模块，遵循项目现有结构

### 代码风格

- 前端：使用 Biome（Linter + Formatter），遵循 React 最佳实践（见 web/AGENTS.md）
- 后端：使用 `gofmt`，遵循 Go 惯用写法
- 运行 linter 和 formatter 后再提交

### 注释规范

- **使用英语** — 所有代码注释、TODO、文档字符串必须使用英语
- **只写代码无法表达的信息** — 函数名、类型、代码结构能说明的事情通常不需要注释
  - ❌ 描述代码做什么（What）— 代码本身已经说明（过度复杂或特殊的逻辑除外）
  - ✅ 解释为什么这样做（Why）— 设计决策、非显而易见的理由
  - ✅ 说明何时使用（When）— 如果使用场景不自明
  - ✅ 记录值的来源（Where）— 魔法数字、外部依赖的关联
- **避免噪音** — 自明注释、类型/函数名的重复描述都是噪音
- **保持同步** — 过时注释比没有更有害；改代码时同步更新注释
- **TODO 要有上下文** — 如 `// TODO: Remove after upstream API supports X`
- **设计文档放 docs/** — 系统级的架构说明不要写在代码注释里

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
- **不要过度防御** — 信任类型系统和内部数据；只在系统边界校验

## AI 助手注意事项

1. **用英语思考，用用户的语言交流** — 内部推理使用英语以获得更好的逻辑性，但与用户交流时使用用户的语言
2. **优先读取现有代码** — 修改前先理解上下文
3. **恰到好处的设计** — 在当前需求范围内做好设计，结构清晰、考虑周全；但不超出需求范围做预测性开发
4. **遵循现有模式** — 与项目现有代码风格保持一致
5. **不重复造轮子** — 复用现有组件和工具函数
6. **安全第一** — 注意 OWASP Top 10，避免引入安全漏洞
7. **禁止直接编辑生成文件** — 如 `pnpm-lock.yaml`、`go.sum` 等 lock 文件，必须通过正规命令（`pnpm install`、`go mod tidy`）生成或更新
8. **DRY 原则** — 遵循《程序员修炼之道》理念，代码、测试、文档均不应有重复；每一处知识在系统中应有唯一、明确的表示
9. **退一步看全局** — 遇到问题不要盲目修复；先思考问题的根源、设计是否合理，再决定行动
10. **遵循最佳实践** — 任何工作都要意识到并遵循行业最佳实践

## 参考资料

**参考项目**（按需克隆到 `./refs/`）：
- [happy-cli](https://github.com/slopus/happy-cli) — schema 及实现参考
- [claude-code-chat](https://github.com/andrepimenta/claude-code-chat) — stream-json 实现参考
- [anthropic-sdk-go](https://github.com/anthropics/anthropic-sdk-go) — API 类型定义参考

**Schema 参考**：[Claude Agent SDK](https://platform.claude.com/docs/en/api/agent-sdk/typescript) — stream-json 消息结构的权威定义
