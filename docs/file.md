# File

Users browse directories and view/edit files in the workspace. Path traversal is validated on every request.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──filesystem──▶ Workspace
                              │
                         contents.go (validate, read, write)
```

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_file.go` | `file.get`, `file.write` |
| File operations | `server/contents/contents.go` | Path validation, read (text/binary), write |
| Frontend components | `web/src/components/Files/` | FileTree, FileEditor, FileView, FileTreeNode |
| RPC actions | `web/src/lib/rpc/file.ts` | `fileGet`, `fileWrite` |

## Operations

**`file.get`** — Read file or list directory.
- Directory → returns `Entry[]` (name, type, path)
- Text file → returns content as UTF-8
- Binary file → returns content as base64

**`file.write`** — Write file content to disk.

## Security

`ValidatePath(workDir, path)` prevents directory traversal by resolving the absolute path and checking it stays within the workspace root.
