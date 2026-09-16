## 一致性

web-cluster的实现应该和web保持一定的一致性。
没有特殊要求时，尽量保持和web相同的结构和风格。

## Lint

本项目没有 lint / format 脚本，统一在仓库根目录执行（`pnpm -w run lint` /
`pnpm -w run format`，理由见根 AGENTS.md）。范围含 `vite.config.ts` /
`vitest.config.ts`，不只是 `src`。

`biome.json` 继承根配置（`extends: "//"`），只写与 `web` 真正不同的部分：关掉
`noSvgWithoutTitle` 和 `noAutofocus`。**这不是本项目的特性，是欠的债**——同样两
条规则 `web` 也会命中，但 `web` 是逐处还清的：svg 带 `<title>`，3 处 `autoFocus`
各自写了带理由的 `biome-ignore`。本项目没做这轮逐处梳理，就整体关掉了（现有命中
6 处 + 1 处，弹窗改用共享 `Sheet` 之后各少了一处）。要收回时是把这 7 处逐个处理
掉，而不是让开关一直关着。

原先还关掉了 `noStaticElementInteractions`，实测零命中，已删除——现在往静态元素
上挂交互处理器会和 `web` 一样被拦下。

## 测试

`vitest.config.ts` 与 `web` 同形：`environment: "jsdom"`、`@vitejs/plugin-react`、
一个 `src/test/setup.ts`。原来是 `environment: "node"`，因为当时只有 store 和
工具函数的测试；节点卡片的行为（确认分支、Open 选哪个 URL）只能在 DOM 里表达，
于是按 `web` 的形状补齐，而不是另发明一套。

`setup.ts` 比 `web` 的短：这里没有 `ResizeObserver` / `IntersectionObserver` 的
使用者，只需要 `matchMedia`——共享 `Sheet` 通过 `useIsExpanded` 读宽度阶梯，
jsdom 完全没有这个实现。它一律返回不匹配，也就是每个 sheet 都以抽屉形态渲染，
正是手机拿到的形态。要测居中 modal 的差异时再按 query 分支，不要全局改掉它。

`web` 的 `vitest.setup.ts`（替换 jsdom 的 `Blob`）这里没有对应物：本项目不碰
`Blob`，也没有 Node 类型的测试入口。
