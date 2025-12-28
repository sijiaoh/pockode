# Web AGENTS.md

React 前端的 AI 编程助手指南。

## 技术栈

- React 19 + TypeScript
- Vite 7（构建工具）
- Tailwind CSS 4（样式）
- Biome（Linter + Formatter）
- Vitest + Testing Library（测试）

## 命令

```bash
# 安装依赖
npm install

# 开发服务器
npm run dev

# 构建
npm run build

# 类型检查 + 构建
tsc -b && npm run build

# Lint 检查
npm run lint

# 格式化
npm run format

# 测试
npm run test

# 测试（监视模式）
npm run test:watch

# 预览构建结果
npm run preview
```

## 项目结构

```
web/
├── src/
│   ├── components/   # React 组件
│   ├── hooks/        # 自定义 Hooks
│   ├── lib/          # 状态管理（stores）
│   ├── types/        # 类型定义
│   ├── utils/        # 工具函数
│   ├── test/         # 测试配置
│   ├── main.tsx      # 入口
│   ├── App.tsx       # 根组件
│   └── index.css     # Tailwind 导入
├── index.html        # HTML 模板
├── vite.config.ts    # Vite 配置
├── vitest.config.ts  # Vitest 配置
├── biome.json        # Biome 配置
├── tsconfig.json     # TypeScript 配置
├── package.json
├── AGENTS.md         # AI 助手规范（本文件）
└── CLAUDE.md         # Claude Code 入口
```

## 代码风格

### Biome 配置

- 缩进：Tab
- 引号：双引号
- 分号：必须
- 自动整理 import

### 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 组件 | PascalCase | `ChatPanel.tsx` |
| Hook | camelCase + use 前缀 | `useWebSocket.ts` |
| Store | camelCase + Store 后缀 | `wsStore.ts` |
| 工具函数 | camelCase | `formatMessage.ts` |
| 类型/接口 | PascalCase | `Message`, `ChatProps` |
| 常量 | UPPER_SNAKE_CASE | `API_BASE_URL` |

### 组件模式

```tsx
// ✅ 函数组件 + 类型定义
interface Props {
  title: string;
  onClose: () => void;
}

function Dialog({ title, onClose }: Props) {
  return (
    <div className="p-4">
      <h2>{title}</h2>
      <button onClick={onClose}>Close</button>
    </div>
  );
}

export default Dialog;
```

```tsx
// ❌ 避免：类组件、any 类型、内联样式
class Dialog extends React.Component<any> { ... }
```

### Tailwind 使用

- 优先使用 Tailwind 类，避免自定义 CSS
- **Mobile-first** — 默认样式针对移动端，使用 `sm:`, `md:`, `lg:` 前缀适配更大屏幕
- 全屏容器使用 `h-dvh`（动态视口高度，适配移动端 URL 栏）

### 主题系统

项目使用语义化主题 token，详见 [`docs/theming.md`](docs/theming.md)。

**核心规则：**
- 必须使用 `th-` 前缀的语义化颜色
- 禁止硬编码颜色（如 `bg-gray-900`、`text-white`）
- 仅在特殊情况使用 `dark:` 前缀（如 `prose dark:prose-invert`）

## 测试

使用 Vitest + Testing Library 进行测试。

### 测试文件命名

- 组件测试：`ComponentName.test.tsx`
- 工具函数测试：`utilName.test.ts`
- 测试文件放在被测文件同目录

### 测试模式

```tsx
// 组件测试示例
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MyComponent from "./MyComponent";

describe("MyComponent", () => {
  it("renders correctly", () => {
    render(<MyComponent />);
    expect(screen.getByText("expected text")).toBeInTheDocument();
  });

  it("handles user interaction", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<MyComponent onClick={onClick} />);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });
});
```

## Zustand 状态管理

**领域数据**用 Zustand，**UI 状态**用 React。

- 领域数据：与 UI 表现无关的业务数据（即使没有 UI 也存在的数据）
- UI 状态：控制界面行为的状态（sidebar 开关、modal 显隐、选中项）

### 使用规范

- 按领域划分 store，组件只调用 action 不处理业务逻辑
- 使用选择器订阅具体字段，多字段用 `useShallow`
- 禁止 `const store = useStore()` 全量订阅

## 边界

### Always Do

- 运行 `npm run lint` 确认无错误
- 运行 `npm run build` 确认构建成功
- 运行 `npm run test` 确认测试通过
- 使用 TypeScript 严格模式
- 组件使用函数式写法
- Props 必须定义类型
- 为新组件和工具函数编写测试

### Ask First

- 添加新的 npm 依赖
- 修改 Vite 或 TypeScript 配置
- 创建新的全局状态管理
- 修改路由结构

### Never Do

- 使用 `any` 类型（用 `unknown` 或具体类型）
- 使用 `!` 非空断言（用条件检查）
- 直接编辑 `package-lock.json`（使用 `npm install`）
- 在组件中硬编码 API 地址
- 提交 `console.log` 调试代码
- 使用硬编码颜色（如 `bg-gray-900`），必须用 `th-` 前缀的主题 token
