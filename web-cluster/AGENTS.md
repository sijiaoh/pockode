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
7 处 + 2 处）。要收回时是把这 9 处逐个处理掉，而不是让开关一直关着。

原先还关掉了 `noStaticElementInteractions`，实测零命中，已删除——现在往静态元素
上挂交互处理器会和 `web` 一样被拦下。
