# Git Diff View 设计方案

## 需求概述

| 维度 | 决策 |
|------|------|
| 使用场景 | 用户主动查看仓库 diff 状态 |
| 展示位置 | 独立全屏视图 |
| 入口 | 侧边栏菜单项 |
| Diff 内容 | Staged + Unstaged（所有未提交变更） |

## UI 设计

### 入口：侧边栏内 Tab

侧边栏顶部添加 `[Sessions] [Diff]` Tab 切换：

```
┌─────────────────────┐
│ ≡  Pockode     [+]  │  ← Header 不变
├─────────────────────┤
│ [Sessions] [Diff]   │  ← 侧边栏内的 Tab
├─────────────────────┤
│ ┌─────────────────┐ │
│ │ Staged (2)      │ │
│ │  └ App.tsx    M │ │
│ │ Unstaged (1)    │ │
│ │  └ main.go    M │ │
│ └─────────────────┘ │
└─────────────────────┘
```

### 文件 Diff 详情视图

点击文件后，主区域显示该文件的 Diff：

```
┌─────────────────────┐
│ ← src/App.tsx       │  ← Header 变成文件名 + 返回键
├─────────────────────┤
│  10   import {...}  │
│  11 - const old     │  ← 红色：删除行
│  11 + const new     │  ← 绿色：新增行
│  12   export...     │
└─────────────────────┘
```

### 设计原则

1. **符合移动端心智模型** — 侧边栏 → 选择 → 详情 → 返回
2. **不侵占主界面** — Header 保持简洁，只在查看 Diff 时临时变化
3. **上下文清晰** — 用户知道自己在 Diff 模式还是 Chat 模式
4. **PC 端也自然** — 侧边栏 Tab 在桌面端同样常见

## 技术方案

### 后端 API

分层获取：先拿文件列表，再按需获取单文件 diff。

```
GET /api/sessions/{session_id}/git/status
GET /api/sessions/{session_id}/git/staged/{path...}
GET /api/sessions/{session_id}/git/unstaged/{path...}
```

Note: Backend must validate path (reject ".." to prevent traversal).

## 状态

- [x] 需求确认
- [x] UI 设计方案
- [x] API 设计
- [ ] 实现
