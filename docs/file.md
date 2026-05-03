# File

Users browse directories and view/edit files in the workspace. Path traversal is validated on every request.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──filesystem──▶ Workspace
                              │
                         contents.go (validate, read, write, delete)
```

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_file.go` | `file.get`, `file.write`, `file.delete` |
| File operations | `server/contents/contents.go` | Path validation, read, write (upsert), delete |
| Frontend components | `web/src/components/Files/` | FileTree, FileEditor, FileView, FileTreeNode |
| RPC actions | `web/src/lib/rpc/file.ts` | `getFile`, `writeFile`, `deleteFile` |

## Operations

**`file.get`** — Read file or list directory.
- Directory → returns `Entry[]` (name, type, path)
- Text file → returns content as UTF-8
- Binary file → returns content as base64

**`file.write`** — Write file content to disk with upsert semantics.
- Creates the file if it doesn't exist
- Creates parent directories automatically
- Updates existing files

**`file.delete`** — Remove a file or directory from disk.
- Directories are deleted recursively (all contents removed)
- Returns error if path doesn't exist

## Security

`ValidatePath(workDir, path)` prevents directory traversal by resolving the absolute path and checking it stays within the workspace root. Additional protections:
- Empty path rejection (prevents accidental root operations)
- Absolute path rejection
- `../` traversal detection
