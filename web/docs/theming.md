# Theming Guide

本文档说明 Pockode 的主题系统设计与使用规范。

## 设计原则

### 1. 语义化命名

颜色变量按**用途**命名，而非按视觉属性（如 gray-700）命名。这样在切换主题时，只需修改变量值，无需修改组件代码。

```css
/* Good: 按用途命名 */
--th-bg-primary: #ffffff;

/* Bad: 按视觉命名 */
--gray-100: #f3f4f6;
```

### 2. 统一前缀

所有主题相关的 CSS 变量和 Tailwind 类使用 `th-` 前缀（theme 的缩写），一眼识别哪些是主题覆盖的颜色。

```html
<!-- 一看就知道是主题颜色 -->
<div class="bg-th-bg-primary text-th-text-primary">
```

### 3. 分层设计

颜色分为三层：
- **基础层**：背景、文本、边框等基础 UI 元素
- **交互层**：按钮、链接、输入框等交互元素
- **语义层**：成功、错误、警告等状态颜色

## 颜色分类

### 背景色 (Background)

| Token | 用途 | 示例 |
|-------|------|------|
| `th-bg-primary` | 页面主背景 | 整体页面背景 |
| `th-bg-secondary` | 次级背景/卡片 | 侧边栏、对话框、输入框 |
| `th-bg-tertiary` | 三级背景/悬浮 | hover 状态、下拉菜单 |
| `th-bg-overlay` | 遮罩层 | 模态框背景遮罩 |

### 文本色 (Text)

| Token | 用途 | 示例 |
|-------|------|------|
| `th-text-primary` | 主要文本 | 标题、正文 |
| `th-text-secondary` | 次要文本 | 副标题、描述 |
| `th-text-muted` | 弱化文本 | 时间戳、提示 |
| `th-text-inverse` | 反色文本 | 与背景高对比的文字（亮模式白色，暗模式深色） |

### 边框色 (Border)

| Token | 用途 | 示例 |
|-------|------|------|
| `th-border` | 默认边框 | 分割线、卡片边框 |
| `th-border-focus` | 聚焦边框 | 输入框聚焦状态 |

### 交互色 (Interactive)

| Token | 用途 | 示例 |
|-------|------|------|
| `th-accent` | 主强调色 | 主按钮、链接 |
| `th-accent-hover` | 主强调色悬浮 | 主按钮 hover |
| `th-accent-text` | 主强调色上的文字 | 主按钮文字 |

### 语义色 (Semantic)

| Token | 用途 | 示例 |
|-------|------|------|
| `th-success` | 成功状态 | 连接成功、操作完成 |
| `th-error` | 错误状态 | 错误提示、删除操作 |
| `th-warning` | 警告状态 | 警告提示、断开连接 |

### 特殊用途 (Special)

| Token | 用途 | 示例 |
|-------|------|------|
| `th-code-bg` | 代码块背景 | 代码高亮区域 |
| `th-code-text` | 代码块文字 | 代码文本 |
| `th-user-bubble` | 用户消息气泡 | 用户发送的消息 |
| `th-user-bubble-text` | 用户消息文字 | 用户消息内的文字 |
| `th-ai-bubble` | AI 消息气泡 | AI 回复的消息 |
| `th-ai-bubble-text` | AI 消息文字 | AI 消息内的文字 |

## 使用规范

### Tailwind 类名

```html
<!-- 背景 -->
<div class="bg-th-bg-primary">主背景</div>
<div class="bg-th-bg-secondary">卡片背景</div>

<!-- 文本 -->
<p class="text-th-text-primary">主要文本</p>
<span class="text-th-text-muted">次要文本</span>

<!-- 边框 -->
<div class="border border-th-border">带边框的元素</div>

<!-- 交互 -->
<button class="bg-th-accent text-th-accent-text hover:bg-th-accent-hover">
  按钮
</button>

<!-- 语义 -->
<span class="text-th-success">成功</span>
<span class="text-th-error">错误</span>
```

### 组合规范

**消息气泡**
```html
<!-- 用户消息 -->
<div class="bg-th-user-bubble text-th-user-bubble-text">

<!-- AI 消息 -->
<div class="bg-th-ai-bubble text-th-ai-bubble-text">
```

**按钮**
```html
<!-- 主按钮 -->
<button class="bg-th-accent text-th-accent-text hover:bg-th-accent-hover">

<!-- 次要按钮 -->
<button class="bg-th-bg-tertiary text-th-text-primary hover:opacity-90">

<!-- 危险按钮 -->
<button class="bg-th-error text-th-text-inverse hover:opacity-90">
```

**输入框**
```html
<input class="bg-th-bg-secondary text-th-text-primary border-th-border
              placeholder:text-th-text-muted focus:border-th-border-focus">
```

**状态指示**
```html
<span class="text-th-success">Connected</span>
<span class="text-th-error">Error</span>
<span class="text-th-warning">Disconnected</span>
```

## 添加新主题

### 内置主题

1. 在 `src/index.css` 中添加新的主题类：

```css
.theme-custom {
  --th-bg-primary: #your-color;
  --th-bg-secondary: #your-color;
  /* ... 其他变量 */
}
```

2. 在 `src/lib/registries/themeRegistry.ts` 的 `THEME_NAMES` 和 `THEME_INFO` 中注册。

### 通过扩展注册

扩展可以在运行时注册自定义主题，无需修改核心文件。详见 `src/extensions/README.md` 的 `ctx.theme.register()` 文档。

## 暗色模式适配

使用 `dark:` 前缀处理暗色模式特殊情况：

```html
<!-- prose 组件需要根据主题切换 -->
<div class="prose dark:prose-invert">
```

## 注意事项

1. **不要使用硬编码颜色** - 如 `bg-gray-900`、`text-white` 等
2. **保持一致性** - 相同用途的元素使用相同的 token
3. **测试两种主题** - 添加新 UI 时确保 light/dark 都正常显示
4. **使用语义化 token** - 优先使用语义色（success/error）而非自定义颜色
