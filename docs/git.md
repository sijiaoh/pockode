# Git

Users view status, diffs, and commit history; and stage/unstage files. All operations shell out to the `git` CLI. Real-time updates are delivered via the watch/subscription system.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──exec──▶ git CLI
                              │
                         watch system (fsnotify on .git/)
```

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_git.go` | `git.status`, `git.add`, `git.reset`, `git.log`, `git.show`, `git.show.diff`, `git.subscribe`, `git.diff.subscribe` |
| Git operations | `server/git/git.go` | Init, Status, Add, Diff, Log, Show, ShowFileDiff, Reset |
| Frontend components | `web/src/components/Git/` | DiffTab, DiffView, CommitView, LogList |
| RPC actions | `web/src/lib/rpc/git.ts` | RPC action creators for all git methods |

## Real-Time Updates

Two watchers deliver live updates via the subscription system:

- **GitWatcher** — Watches `.git/` for status changes. Subscribers receive `git.changed` notifications when status changes (e.g., after `git add`).
- **GitDiffWatcher** — Watches workspace files and recomputes diffs on change. Subscribers to `git.diff.subscribe` receive updated diffs incrementally.

## Configuration

Git is opt-in via `GIT_ENABLED=true`. When enabled, the server initializes the repo with remote config from environment variables (`REPOSITORY_URL`, `REPOSITORY_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`). See `server/AGENTS.md` for the full env var list.
