# Web

你是世界级 React 前端工程师，专注于移动端优先的 AI 对话界面开发。

React 19 + TypeScript + Vite 7 + Tailwind 4 + Biome + Vitest

## 命令

```bash
pnpm run dev             # 开发服务器
pnpm run build           # 构建
pnpm run lint            # Lint 检查
pnpm run format          # 格式化
pnpm run test            # 测试
pnpm run test:watch      # 测试（监视模式）
pnpm exec tsc -b         # 类型检查
```

## 结构

```
src/
  components/            # React 组件（Auth, Chat, common, Files, Git, Layout, Project, Session, Settings, Worktree, ui）
  extensions/            # 扩展系统（builtin, ExampleExtension）
  hooks/                 # 自定义 Hooks（useSession, useSubscription, useChatMessages 等）
  lib/                   # 状态管理 + RPC（*Store.ts, rpc/, registries/）
  types/                 # 类型定义
  utils/                 # 工具函数
  test/                  # 测试配置（setup.ts）
  router.tsx             # 路由配置
  main.tsx               # 入口
```

## 风格

**Biome**: Tab 缩进、双引号、必须分号、自动整理 import

| 类型 | 规范 | 示例 |
|------|------|------|
| 组件 | PascalCase | `ChatPanel.tsx` |
| Hook | use 前缀 | `useSession.ts` |
| Store | Store 后缀 | `wsStore.ts` |
| 类型 | PascalCase | `Message` |
| 常量 | UPPER_SNAKE | `API_BASE_URL` |

### 组件模式

```tsx
interface Props {
  title: string;
  onClose: () => void;
}

function Dialog({ title, onClose }: Props) {
  return <div className="p-4">...</div>;
}
export default Dialog;
```

### 组件设计

- **该抽象就抽象** — 重复的 UI 模式、已知会扩展的功能，应及时抽取为共用组件或 Hooks
- **共性与个性分离** — 概念相同的 UI 共用骨架，通过 props/参数注入各自的业务逻辑

### Tailwind

- Mobile-first：默认移动端，`sm:`/`md:`/`lg:` 适配大屏
- 全屏用 `h-dvh`（动态视口高度）
- **主题**：必须用 `th-` 前缀颜色，禁止硬编码（详见 `index.css` 中的主题定义）

### Zustand

**领域数据**用 Zustand，**UI 状态**用 React。

- 按领域划分 store，组件只调用 action 不处理业务逻辑
- 选择器订阅具体字段，多字段用 `useShallow`
- 禁止 `const store = useStore()` 全量订阅

## 测试

测试文件与源文件同目录：`ComponentName.test.tsx`

遵循 [Testing Library 指导原则](https://testing-library.com/docs/guiding-principles)：
- 按用户视角测试，优先 `getByRole` > `getByLabelText` > `getByText` > `getByTestId`
- 不测 state/props/生命周期，只测用户可见行为
- 适度测试，不追求 100% 覆盖

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("MyComponent", () => {
  it("handles click", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<MyComponent onClick={onClick} />);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });
});
```

## 边界

✅ **Always**: `pnpm run lint` + `pnpm run build` + `pnpm run test` · 函数组件 · Props 定义类型

⚠️ **Ask First**: 添加 pnpm 依赖 · 修改 Vite/TS 配置 · 新建全局 store

🚫 **Never**: `any`（用 `unknown`） · `!` 非空断言 · 硬编码颜色/API 地址 · 提交 `console.log` · 编辑 `pnpm-lock.yaml`

## 注释

- Write comments in English
- Use TODO format: `// TODO: <description>`
