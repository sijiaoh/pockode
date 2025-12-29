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
├── web/            # React 前端（见 web/AGENTS.md）
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

### 代码整理

- **先想后写** — 写代码前先想清楚它该放在哪里
- **各归其位** — 工具代码放工具模块，业务代码放业务模块
- **遵循现有结构** — 参考项目已有的组织方式

### 代码风格

- 前端：使用 Biome（Linter + Formatter），遵循 React 最佳实践（见 web/AGENTS.md）
- 后端：使用 `gofmt`，遵循 Go 惯用写法
- 运行 linter 和 formatter 后再提交

### 注释规范

- **解释 Why，而非 What** — 代码本身说明做什么，注释解释为什么这样做
- **避免自明注释** — `i++; // increment i` 这类注释是噪音，不是价值
- **记录意图和决策** — 说明设计选择、权衡取舍、业务背景
- **标注陷阱和边界** — 警告非显而易见的副作用、性能考量、边界条件
- **不记录思考过程** — 注释是给读者的指引，不是作者的草稿纸
- **保持同步更新** — 过时的注释比没有注释更有害；修改代码时同步更新注释
- **TODO 要有上下文** — 写明原因和条件，如 `// TODO: 待上游 API 支持后移除此 workaround`

### Git 规范

- 分支命名：`feature/xxx`、`fix/xxx`、`refactor/xxx`
- Commit 信息简洁明了，说明「做了什么」而非「怎么做的」
- 保持 commit 粒度合理，一个 commit 做一件事

### 测试

- **测试规格，而非追求覆盖率** — 测试的目的是验证行为契约，不是盲目提高 coverage 数字
- **不测 trivial 代码** — 简单的 getter、constructor、单行委托方法无需测试
- **测公开接口** — 公开方法的测试自然覆盖内部实现，无需重复测试私有方法
- **保持精简** — 每个测试应有明确目的；冗余测试是负担，不是资产
- 提交前确保测试通过

### 错误处理

- **禁止静默失败** — 所有错误必须反馈给用户，用户是开发者，需要知道正在发生什么
- **提供有意义的错误信息** — 错误信息应包含足够的上下文，帮助定位问题
- **区分用户错误和系统错误** — 用户操作错误给出指导性提示，系统错误给出技术细节

### 前端 UI 测试

遵循 [Testing Library 指导原则](https://testing-library.com/docs/guiding-principles)：

- **按用户视角测试** — 测试用户能看到和交互的内容，而非实现细节
- **优先使用可访问性查询** — 按优先级：`getByRole` > `getByLabelText` > `getByText` > `getByTestId`
- **避免测试实现细节** — 不测 state、props、生命周期；只测用户可见的行为
- **适度测试** — 只为有意义的交互和边界情况编写测试，不追求 100% 覆盖

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

## 参考项目

以下项目可作为 schema 和实现的参考，按需克隆到项目根目录下的 `./tmp/`：

```bash
# stream-json schema 和 chat 实现参考
git clone --depth 1 https://github.com/andrepimenta/claude-code-chat.git ./tmp/claude-code-chat

# stream-json schema 间接参考（通过 API 类型定义了解消息结构）
git clone --depth 1 https://github.com/anthropics/anthropic-sdk-go.git ./tmp/anthropic-sdk-go
```

## 官方文档

- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/api/agent-sdk/typescript) — SDK 类型定义，可作为 stream-json schema 的间接参考

## 相关文档

- [README.md](README.md) — 项目愿景和功能介绍
- [docs/architecture.md](docs/architecture.md) — 技术架构详情
- [docs/roadmap.md](docs/roadmap.md) — MVP 开发路线图
- [LICENSE.md](LICENSE.md) — O'Saasy License
