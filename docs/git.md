# Git

Users view status, diffs, and commit history; and stage/unstage files. All operations shell out to the `git` CLI. Real-time updates are delivered via the watch/subscription system.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──exec──▶ git CLI
                              │
                         watch system (3s polling)
```

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_git.go` | `git.status`, `git.add`, `git.reset`, `git.log`, `git.show`, `git.show.diff`, `git.subscribe`, `git.diff.subscribe` |
| Git operations | `server/git/git.go` | Init, Status, Add, Diff, Log, Show, ShowFileDiff, Reset |
| Frontend components | `web/src/components/Git/` | DiffTab, DiffView, CommitView, LogList |
| RPC actions | `web/src/lib/rpc/git.ts` | RPC action creators for all git methods |

## Path Encoding

Paths the server reports are sent straight back by the frontend as arguments to follow-up commands — `git.status` output feeds `git.add` / `git.reset` / `git.diff.subscribe` verbatim. A path that is merely *displayable* is therefore not enough; it has to match the file again as a pathspec. When it doesn't, `git diff` reports no changes and `git add` fails outright with `did not match any files`.

Two separate git behaviours get in the way, and each has its own countermeasure:

- **Machine-parsed path lists use `-z`.** In the whitespace-delimited list formats (`status --porcelain`, `--name-status`, `config --get-regexp`) a path containing non-ASCII bytes, spaces or control characters is quoted and C-escaped (`中文.md` → `"\344\270\255\346\226\207.md"`), and `status --porcelain=v1` renders a rename as `old -> new`, which is ambiguous for a file genuinely named `a -> b`. Turning `core.quotePath` off is not sufficient here: it only governs the non-ASCII case, while spaces and control characters keep the path quoted whatever it is set to, and the rename ambiguity is not a quoting problem at all. With `-z` each path is instead a verbatim NUL-terminated field and the rename source is a field of its own.
- **Human-readable output disables `core.quotePath`.** Diff bodies embed paths in their headers (`diff --git a/中文.md`) and have no `-z` form, so those commands run with `-c core.quotePath=false` to keep the header readable. Header quoting is looser than the list formats' — the `a/` `b/` prefixes disambiguate spaces, so only quotes, backslashes and control characters force quoting there. `gitCommand` applies the flag to every command it builds; it is simply redundant under `-z`.

Neither trick helps when a filename is not valid UTF-8 (e.g. latin-1 byte sequences), since `encoding/json` replaces the invalid bytes on the way to the frontend.

## Merge Commits

`git.show` and `git.show.diff` present a merge as an ordinary diff against its **first parent** (`-m --first-parent`, a no-op on ordinary commits). The `old_content` returned with a diff comes from `hash^`, which is that same parent.

Both must agree on this. Plain `git show` on a merge produces a *combined* diff, which by definition only keeps hunks differing from **every** parent — so a file identical to one side of the merge, the common case, yields nothing. Using it for the file contents while listing files against the first parent is what makes the list offer files that open blank.

`git.log` is not first-parent filtered; history lists merge commits alongside the rest.

## Real-Time Updates

Two watchers deliver live updates via the subscription system. Both poll every 3 seconds and only while they have subscribers — see [watcher.md](watcher.md) for the watcher inventory and [code/subscription-system.md](code/subscription-system.md) for why git polls instead of using fsnotify.

- **GitWatcher** — Polls `git rev-parse HEAD` + `git status` and compares the result against the previous one. Subscribers receive `git.changed` notifications when it differs (e.g., after `git add`).
- **GitDiffWatcher** — Recomputes the diff behind each `git.diff.subscribe` subscription and sends `git.diff.changed` to that subscriber when the result changes. Each notification carries the full diff and file contents, not a delta.

## Configuration

Git is opt-in via `--git` flag. When enabled, the server initializes the repo with remote config from command line arguments (`--git-repo-url`, `--git-repo-token`, `--git-user-name`, `--git-user-email`). See `server/AGENTS.md` for the full argument list.
