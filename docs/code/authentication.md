# Authentication & Access Control

Pockode's job is to give a phone full read/write and AI-execution access to a
developer's machine over the internet. That makes the auth token the single
credential standing between a stranger and effectively arbitrary code execution on
the host. This document explains the trust model, where the token lives, and the
deliberate boundaries around it.

## Trust Model

Pockode assumes **one developer, one machine, one static token**. There are no user
accounts, roles, or per-request authorization — a caller either holds the token
(and can do everything the developer can) or does not (and can do nothing). This is
the right shape for a personal dev tool, and it is the assumption every decision
below rests on: hardening focuses on *keeping the one token secret*, not on
partitioning what a token-holder may do.

## Token Surfaces

The user-facing token authenticates three entry points:

| Surface | How the token is presented | Code |
|---------|---------------------------|------|
| HTTP API | `Authorization: Bearer <token>` | `server/middleware/auth.go` |
| WebSocket | First RPC must be `auth { token }`; all other methods are rejected until it succeeds | `server/ws/rpc.go` |
| Relay | The relay tunnels the same HTTP/WS traffic; no separate app token | `server/relay/` |

All comparisons use `crypto/subtle.ConstantTimeCompare` to avoid leaking the token
through response timing. The user-facing token is supplied by the operator (see
[Where the Token Comes From](#where-the-token-comes-from)); the server does not
generate a default.

### The MCP local API uses a *separate* token

The in-process AI agent reaches the server over a loopback HTTP API
(`/api/mcp/tools/call`). This path is authenticated with its **own** token —
a 256-bit hex string from `crypto/rand`, regenerated per server start
(`main.go:generateToken`) and written to `server.json` inside the restricted data
directory (`server/serverinfo/serverinfo.go`, see
[Credentials on Disk](#credentials-on-disk)) — not the user-facing
`--auth-token`. Two guards keep it local-only:

- The auth middleware bypasses the MCP route by **exact match**, so a future
  `/api/mcp/*` route is auth-protected by default rather than silently exposed
  (`server/middleware/auth.go`).
- The relay refuses to forward any `/api/mcp/` path before port selection, so the
  MCP API is never reachable remotely even in the single-port setup
  (`server/relay/http.go`).
- The MCP handler **fails closed** on an empty token — an unset token never
  matches — rather than accepting all callers (`server/mcp/handler.go`).

## Where the Token Comes From

The server resolves its `--auth-token` value through the `authtoken` package
(`server/authtoken/`), which exists to keep the token out of places other local
users can read it.

### `--auth-token` flag vs. `POCKODE_AUTH_TOKEN` env var

`authtoken.Resolve` prefers the explicit flag and falls back to the
`POCKODE_AUTH_TOKEN` environment variable. The env var is not a mere convenience:
on Linux a process's argv is world-readable through `/proc/<pid>/cmdline` and
`ps aux`, so a token passed as a flag is visible to **every local user** on the
host. The environment (`/proc/<pid>/environ`) is readable only by the process owner
and root, so env-var delivery is the safer channel on a shared machine.

This is exactly why **cluster mode passes the token to spawned node servers via
`cmd.Env`, never argv** (`server/cluster/node/process.go`, `nodeEnv`). A cluster
host is explicitly multi-project and potentially multi-user, and each spawned node
enables the relay by default — leaking its token to a co-tenant would hand them
persistent remote control of that project. `nodeEnv` also strips any inherited
`POCKODE_AUTH_TOKEN` so the child sees exactly one, unambiguous value.

### Scrubbing the env before spawning children (`authtoken.Load`)

Using the environment to *receive* the token introduces a second hazard: the server
itself spawns many child processes — AI CLIs (`agent/claude`, `agent/codex`), git,
worktree setup hooks — and they inherit `os.Environ()` by default. If the token
stayed in the environment, AI-generated (and potentially prompt-injected) code
could read `POCKODE_AUTH_TOKEN` and exfiltrate it for durable remote access via the
relay.

`authtoken.Load` closes this at the source: it resolves the token and then
**unconditionally** `os.Unsetenv`s the variable, once, at startup — after flag
parsing and before anything is spawned. The token survives in a normal variable for
the server's own use; every later child inherits an environment that no longer
contains it. The unset is unconditional (even when the token came from the flag) so
a stale value in the parent's environment can never reach a child. This is a single
choke point, which keeps future spawn sites safe by default (DRY). The MCP
subprocess is unaffected — it authenticates with the separate `server.json` token,
not this one.

## Credentials on Disk

Three files hold secrets: `server.json` (the MCP local token), `relay.json` (the
relay token) and, in `--git` mode, `.git/.git-credentials` (a GitHub PAT in
cleartext). They are still written `0600`, but that mode is not what protects
them. It is the right permission attached to the wrong *unit*, and on Windows it
is not a permission at all.

### Why the directory, not the file

Go maps the `perm` argument of `os.WriteFile` to the Windows read-only attribute
and to nothing else — and `0600` has the write bit set, so it does not even do
that. A file on Windows gets whatever ACL it inherits from its parent directory,
and the default ACL below a drive root grants `BUILTIN\Users` read access. A data
directory at `C:\dev\app\.pockode` is therefore readable by **every account on
the machine**, while one under `%USERPROFILE%` is not, because the profile
folder's ACL is protected and names only the user, SYSTEM and Administrators.
Which of the two a user gets is decided by where they keep their projects —
something Pockode has no say in, and Windows developers commonly keep them
outside the profile to avoid long paths and cloud sync.

`server/internal/fsperm` therefore restricts the **directory** — `0700` on unix,
an explicit protected DACL naming the user, SYSTEM and Administrators on
Windows — and lets the files inside inherit it. Two properties follow that
per-file hardening cannot provide:

- **Files created later are covered.** The data directory also accumulates
  session transcripts, `server.log` and the work store, all written `0644`. One
  call at startup covers them; per-file hardening would have to be repeated at
  every write site and would still miss files written by other programs.
- **It survives atomic rewrites.** Both `filestore` and git's `store` credential
  helper replace a file by writing a temp file beside it and renaming over the
  target. The replacement carries the mode and ACL it was *created* with, so a
  per-file restriction is silently undone by the next write. A temp file created
  inside a restricted directory inherits the restriction instead.

The second point is what decides the `.git-credentials` case, which otherwise
looks like it wants per-file treatment. git's `store` helper rewrites that file
on **every successful authentication**, through a lock file it renames over the
target — so a mode or ACL set on the file is gone after the first push. The
helper's own `umask(077)` keeps the rewrite at `0600` on unix, but a umask means
nothing on Windows, where only an inherited ACL survives. So `.git` is restricted
as a directory, and only the one `git.Init` creates itself: `Init` returns early
when `.git` already exists, so a repository Pockode did not make is never
touched.

### Why SYSTEM and Administrators stay in the DACL

An administrator can take ownership of any object and read it regardless, so
excluding them would keep the secret from nobody. It would only break backup,
antivirus and run-as-a-service setups, while leaving the accounts this actually
guards against — ordinary co-tenants, who are in `BUILTIN\Users` but not in
`Administrators` — exactly where they were. This is the same principal set
Win32-OpenSSH accepts on a private key.

### Why a failure to restrict is a warning, not an error

Some filesystems have no permissions to express: FAT and exFAT on a removable
drive, some network mounts. Keeping a project on one is legitimate, and the
server started there before this hardening existed. Refusing to start would turn
a defence-in-depth layer into a new way for Pockode to fail, over something that
is not the control actually guarding the server. `fsperm` logs the path and the
underlying error and continues.

## Connection Lifecycle

Binding a worktree to a WebSocket connection races the connection's teardown when a
client disconnects mid-handshake. The atomic-bind design that prevents leaked
worktree references and orphaned subscriptions is documented in
[WebSocket JSON-RPC → Binding a Worktree vs. Disconnect](websocket-rpc.md#binding-a-worktree-vs-disconnect).

## Accepted Limitations

The following were reviewed and **intentionally left as-is** under the single-token
trust model. They are recorded here so a future change of that model (e.g. multi-user
hosting) revisits them rather than rediscovering them:

- **`.pockode` data directory is not path-fenced.** `file.*` / `git.*` RPCs are
  confined to the worktree's work directory, but that directory contains the
  server's own `.pockode` state (work store, setup hooks, sessions) by default. A
  token-holder can therefore read/modify server state through file RPCs. Under the
  single-developer model this is not a privilege escalation — the same developer
  already has shell and agent access — and the data directory can be relocated with
  `--data`.
- **Symlinks are not resolved during path validation.** `ValidatePath` rejects
  `..` and absolute paths and re-checks that the joined path stays inside the work
  directory, but it does not resolve symlinks, so a symlink inside a worktree can
  point outside it. Again, this is a defense-in-depth gap, not a boundary crossing,
  for a caller who already holds the one token.

## Code Paths

| Concern | Path |
|---------|------|
| Token source & env scrubbing | `server/authtoken/` |
| HTTP Bearer auth | `server/middleware/auth.go` |
| WebSocket `auth` gate | `server/ws/rpc.go` |
| MCP local API token | `server/mcp/handler.go`, `server/serverinfo/serverinfo.go` |
| Relay MCP rejection | `server/relay/http.go` |
| Cluster node token delivery | `server/cluster/node/process.go` |
| On-disk restriction of credentials | `server/internal/fsperm/` |
