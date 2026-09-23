# Authentication & Access Control

Pockode's job is to give a phone full read/write and AI-execution access to a
developer's machine over the internet. That makes the password the single
credential standing between a stranger and effectively arbitrary code execution on
the host. This document explains the trust model, where the password lives, what
the browser keeps in its place, and the deliberate boundaries around both.

## Trust Model

Pockode assumes **one developer, one machine, one password**. There are no user
accounts, roles, or per-request authorization — a caller either holds the
credential (and can do everything the developer can) or does not (and can do
nothing). This is the right shape for a personal dev tool, and it is the
assumption every decision below rests on: hardening focuses on *keeping the one
credential secret*, not on partitioning what its holder may do.

It is a **password**, not a token, and the name is load-bearing. The user chooses
it and types it on a phone keyboard, so it may be short, guessable, and — the
part that matters most — reused from somewhere else. Calling it a token invited
the assumptions that go with a high-entropy random string: no expiry needed, safe
to keep in `localStorage` forever. Both of those were made, and both were wrong.
The flag is `--password` for that reason (`--auth-token` is still accepted; see
[Where the Password Comes From](#where-the-password-comes-from)).

What follows from the name: tell users to generate this secret rather than reuse
one. A machine-local secret that also unlocks their email is the one failure mode
this model cannot contain, and no amount of hashing anywhere fixes it.

### The residual risk: plaintext HTTP on a LAN

Reached over the relay, both hops are TLS — phone to cloud, cloud to this
machine — so nobody on either network sees the traffic; the cloud that joins the
two is a trusted hop by construction. Reached directly on a local network,
`http://<LAN-IP>:<port>`, which is the common case at a desk, **nothing is
encrypted**: not the password on the way in, not the session token, not the
source code, chat transcripts and file contents afterwards. Anyone who can
observe that network sees all of it.

This is stated rather than papered over, because the obvious-looking fix does
not work. See [Why the browser does not hash the
password](#why-the-browser-does-not-hash-the-password): hashing in the client
would protect the authentication step, leave the whole session after it in the
clear, and break on exactly the deployments that have no TLS to begin with. The
honest mitigations are to reach the machine through the relay whenever the
network is not trusted, and to treat a LAN as trusted only when it is.

## Credential Surfaces

| Surface | How the credential is presented | Code |
|---------|---------------------------|------|
| HTTP API | `Authorization: Bearer <password or session token>` | `server/middleware/auth.go` |
| WebSocket | First RPC must be `auth { password }` or `auth { session_token }`; all other methods are rejected until it succeeds | `server/ws/rpc.go`, `server/cluster/ws.go` |
| Relay | The relay tunnels the same HTTP/WS traffic; no separate app credential | `server/relay/` |

Both credentials are accepted on HTTP so that `curl` and scripts have something
to send: a browser exchanges the password for a session token and sends that
(see [Sessions](#sessions-what-the-browser-keeps)), while a shell one-liner can
keep sending the password. All comparisons use
`crypto/subtle.ConstantTimeCompare` to avoid leaking either through response
timing. The password is supplied by the operator; the server does not generate a
default and refuses to start without one.

A missing `Authorization` header, a malformed one and a wrong credential all get
the same `401 Invalid credentials`: telling an unauthenticated caller which of
the three it got wrong is information it has not earned.

### The MCP local API uses a *separate* token

The in-process AI agent reaches the server over a loopback HTTP API
(`/api/mcp/tools/call`). This path is authenticated with its **own** token —
a 256-bit hex string from `crypto/rand`, regenerated per server start
(`server/main.go` — `generateToken`) and written to `server.json` inside the
restricted data directory (`server/serverinfo/serverinfo.go`, see
[Credentials on Disk](#credentials-on-disk)) — not the user-facing password.
Two guards keep it local-only:

- The auth middleware bypasses the MCP route by **exact match**, so a future
  `/api/mcp/*` route is auth-protected by default rather than silently exposed
  (`server/middleware/auth.go`).
- The relay refuses to forward any `/api/mcp/` path before port selection, so the
  MCP API is never reachable remotely even in the single-port setup
  (`server/apiroute/` holds the predicate, `server/relay/proxy.go` enforces it).
- The MCP handler **fails closed** on an empty token — an unset token never
  matches — rather than accepting all callers (`server/mcp/handler.go`).

## Where the Password Comes From

The server resolves its `--password` value through the `password` package
(`server/password/`), which exists to keep the password out of places other local
users can read it.

### `--password` flag vs. `POCKODE_PASSWORD` env var

`password.Resolve` prefers the explicit flag and falls back to the
`POCKODE_PASSWORD` environment variable. The env var is not a mere convenience:
on Linux a process's argv is world-readable through `/proc/<pid>/cmdline` and
`ps aux`, so a password passed as a flag is visible to **every local user** on the
host. The environment (`/proc/<pid>/environ`) is readable only by the process owner
and root, so env-var delivery is the safer channel on a shared machine.

This is exactly why **cluster mode passes the password to spawned node servers via
`cmd.Env`, never argv** (`server/cluster/node/process.go` — `nodeEnv`). A cluster
host is explicitly multi-project and potentially multi-user, and each spawned node
enables the relay by default — leaking its password to a co-tenant would hand them
persistent remote control of that project. `nodeEnv` also strips any inherited
password variable, under either spelling, so the child sees exactly one,
unambiguous value.

### The deprecated `--auth-token` / `POCKODE_AUTH_TOKEN`

Both old spellings are still read, so an existing launcher script keeps working
across the rename. Precedence is `--password`, `--auth-token`, `POCKODE_PASSWORD`,
`POCKODE_AUTH_TOKEN`; using a deprecated one logs a warning naming its
replacement and the release that drops it (`password.RemovalVersion`, three minor
releases after the rename).

Setting **both** spellings of a pair to *different* values is refused at startup
rather than resolved by precedence. The two names then disagree about what the
password is, and silently picking one would leave whoever typed the other locked
out with nothing to read. The same values under both names is fine — the warning
still says which one to drop.

### Scrubbing the env before spawning children (`password.Load`)

Using the environment to *receive* the password introduces a second hazard: the
server itself spawns many child processes — AI CLIs (`agent/claude`,
`agent/codex`), git, worktree setup hooks — and they inherit `os.Environ()` by
default. If the password stayed in the environment, AI-generated (and potentially
prompt-injected) code could read it and exfiltrate it for durable remote access
via the relay.

`password.Load` closes this at the source: it resolves the password and then
**unconditionally** `os.Unsetenv`s **both** variable names, once, at startup —
after flag parsing and before anything is spawned. The password survives in a
normal variable for the server's own use; every later child inherits an
environment that no longer contains it. The unset is unconditional (even when the
password came from the flag, even when resolution failed) so a stale value under
either spelling can never reach a child. This is a single choke point, which keeps
future spawn sites safe by default (DRY). The MCP subprocess is unaffected — it
authenticates with the separate `server.json` token, not this one.

## Sessions: what the browser keeps

The password is typed once and exchanged for a **session token**; the session
token is the only credential a frontend may store. `server/authsession/` issues
and validates them, on both the server and the cluster, out of
`<dataDir>/sessions.json`.

**The cluster frontend stores nothing at all.** It still performs the exchange —
the token is what its reconnects use, so the password leaves the browser once —
but it keeps the token in memory only, so every load asks for the password
again. The main frontend is unchanged. That is a UX decision rather than a
security one, and it is argued where it belongs, in
[cluster.md](../cluster.md#session-persistence-frontend).

The reason is what a password in `localStorage` is: unexpirable, unrevocable,
and *the user's own secret*, possibly shared with accounts that have nothing to
do with Pockode. Any XSS takes it, and nothing the server can do afterwards
invalidates it. A session token is 256 bits from `crypto/rand`, means nothing
anywhere else, expires on its own, and dies when the password changes.

| Property | Value | Why |
|---|---|---|
| Token | 32 bytes from `crypto/rand`, base64url, 43 chars | Nothing to guess |
| Stored as | `sha256(token)`, hex | Never the token itself |
| Idle expiry | 30 days since last use | A session in daily use never asks again — the whole point of issuing it |
| Cap | 50 records, least recently *used* evicted | Runaway growth only; normal use holds a handful. By use, not by age: the first token issued may be the phone in daily use |
| `last_used_at` on disk | at most one write per hour | A write per request otherwise; a lost update costs at most an early expiry |

**Plain SHA-256 for tokens, not a slow KDF.** A token is 256 bits of randomness,
so there is nothing on disk to brute-force; a per-request KDF would cost hundreds
of milliseconds to defend against an attack that cannot happen. The password is
the opposite case and gets the opposite treatment — see below.

**The exchange.** `auth` carries exactly one credential. A password issues a new
token and returns it; a valid session token is returned **unchanged**, never
rotated — two concurrent connections from one tab would otherwise invalidate each
other's credential. So a client stores `session_token` unconditionally without
tracking how it logged in. Sending both is refused (`invalid_params`), so a client
cannot end up authenticated by a credential it did not think it was using. The
pre-rename `token` parameter is still accepted as a spelling of `password`,
because a PWA cached on a phone may still be sending it.

The server issues the token only **after** the requested worktree is bound. A
client that keeps asking for a worktree that no longer exists would otherwise burn
a session slot per attempt and, after fifty, start evicting live sessions. The
cluster has no such step after the check and issues immediately.

**Refusals carry a machine-readable reason** in the JSON-RPC error's `data`, and
clients branch on that rather than on the prose message:

| `data.reason` | Means | Client does |
|---|---|---|
| `invalid_password` | The password is wrong | Stay on the password screen, show the error |
| `session_expired` | The token is unknown or past its idle window | Drop it and ask for the password — the user did nothing wrong, so it is never reported as an error |
| `not_authenticated` | Some other method arrived before `auth`; the connection is closed | A client that reaches this has a bug — nothing is sent before `auth` |
| `worktree_not_found` | The credential was fine; the worktree asked for is gone | Fall back to the main worktree and retry once |

`worktree_not_found` exists so that the retry is driven by a reason being
present rather than by the credential reasons being absent. A client that
retried on "a refusal with no reason" would silently stop retrying the day any
unrelated reason was added to this table.

**An install from before this existed is cleaned up.** Each frontend deletes the
`localStorage` key that used to hold the password (`auth_token` in the app,
`cluster_auth_token` in the cluster) on every start, so the plaintext secret does
not sit in a user's browser until they happen to log out. The removal is
unconditional and stays until the rest of the deprecations go
(`createAuthStore`'s `legacyPasswordKey`). The cluster additionally deletes
`cluster_auth_session_token` for the same reason: it no longer writes one, and
not writing does not unwrite what an earlier version left behind.

**Each origin holds its own token.** The same server reached over the LAN
(`http://ip:port`) and through the relay (`https://<subdomain>…`) are different
browser origins with separate `localStorage`, so each gets a session of its own.
That is correct, and it is one reason the cap is 50 rather than 5.

**A cluster tab issues a session per load**, since every load authenticates by
password and the server issues unconditionally. Accepted rather than worked
around: the cap evicts least recently used, no long-lived cluster token exists
any more, so the record evicted is always another dead one. Avoiding it would
mean changing the `auth` contract for no gain.

### The password fingerprint, and what it is *not*

`sessions.json` also holds a fingerprint of the password: PBKDF2-HMAC-SHA256,
600,000 iterations (OWASP's recommendation), a 16-byte random salt, 32-byte
output, with the algorithm and iteration count written into the file so a future
change of KDF does not have to guess how an existing record was computed. A
fingerprint that does not match, or that names an algorithm this build does not
know, drops every session and is rewritten. The iteration count read back from
the file is bounded (ten times the default) for the same reason it is written
there: startup blocks on this derivation, so a count from a corrupted file must
be refused rather than obeyed, and it is refused down the same path — re-derive,
drop the sessions, cost one re-login.

Its **only** job is to notice that the password changed, so that changing it
really does log the old clients out. It is **not** part of any online
authentication check: there the password is in memory, straight from a flag or
the environment, and `ConstantTimeCompare` settles it in microseconds. Deriving
this fingerprint takes a few hundred milliseconds, and it is paid once at
startup; per request it would defend nothing — the expensive hash exists because
something is on disk, and the only thing on disk is this fingerprint.

This is also the honest reading of "the backend only stores a hash". Before
sessions existed the backend stored *nothing*, so hashing was not a
strengthening, it was a new secret on disk. It pays for itself only because it
buys revocation on password change.

### Why the browser does not hash the password

Having the frontend hash the password and send the digest looks like an
improvement and is not. It was considered and rejected:

- **The digest becomes the password.** Whatever is on the wire is what the server
  accepts, so an eavesdropper who captures `H(pw)` logs in by replaying it.
  Against the two threats hashing appears to address — eavesdropping and replay —
  it buys nothing. Only TLS does, and on the relay path TLS is already there.
- **The browser withholds it exactly where it would matter.** `crypto.subtle`
  exists only in a secure context. The relay path is HTTPS and has it; the
  plaintext LAN path — the only deployment without TLS, the only one where
  hashing was supposed to help — does not. The result would be "logs in over the
  relay, cannot log in on the LAN": a half-working authentication path, the worst
  kind of bug this project can ship. (`crypto.getRandomValues` is unrestricted,
  which is why generating a node password in the cluster UI does work there.)
- **A salt would need an unauthenticated endpoint.** Per-user salt must be fetched
  before login, adding a pre-auth attack surface and a round trip across the
  public internet on the relay path. Deriving it from something fixed is the same
  as having none.
- **The real answer would be a PAKE** (SRP, OPAQUE), not a bare digest. But a
  PAKE is worth its complexity only when TLS is not trusted — and on the
  plaintext LAN path everything *after* authentication is still in the clear and
  the session is hijackable anyway. Hardening the handshake while the session
  rides naked is effort in the wrong place.
- **What remains is password reuse**, and that is answered by telling users to
  generate this secret (see [Trust Model](#trust-model)), not by a digest.

For the same reasons there is no `--password-hash` flag. If it took a
client-side digest, that digest would be a login-equivalent secret — no better
than the password it replaced; if it took the stored fingerprint, its salt is
generated by the node itself and no outside caller can compute the value to pass
in. Nodes keep receiving their password through `POCKODE_PASSWORD` in `cmd.Env`.

## Credentials on Disk

Four files hold secrets: `server.json` (the MCP local token), `relay.json` (the
relay token), `sessions.json` (the session hashes and the password fingerprint)
and, in `--git` mode, `.git/.git-credentials` (a GitHub PAT in cleartext). They
are still written `0600`, but that mode is not what protects them. It is the
right permission attached to the wrong *unit*, and on Windows it is not a
permission at all.

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

The following were reviewed and **intentionally left as-is** under the
single-credential trust model. They are recorded here so a future change of that
model (e.g. multi-user hosting) revisits them rather than rediscovering them:

- **Failed authentication is neither counted nor slowed.** Nothing on the
  `auth` RPC or the HTTP Bearer path keeps a failure count, backs off, or locks
  out. A wrong password closes the WebSocket connection, so each guess costs
  one new connection — a cost, not a defence, and one that opening connections
  in parallel removes; on HTTP not even that. The only trace left is a log line
  per wrong password. Behind that door is arbitrary code execution on the host,
  and the entropy of the secret is entirely the user's choice. The whole
  argument for calling it a password (see [Trust Model](#trust-model)) is that
  it is a human-chosen one that may be short and guessable — so the consequence
  of low entropy belongs here rather than left implicit in the new name.
  **Sessions do not help**, and the two are easy to conflate: a session token
  reduces how often the password crosses the network, it does **not** make the
  password harder to guess. Nor is the door hard to reach: the relay is on by
  default — that is the point of it — so a default deployment puts `/ws` on the
  public internet. What is left to accept it on is thin, and worth naming
  rather than dressing up: with one credential, no accounts and nothing to
  enumerate, the whole defence is that secret's entropy, which is why users are
  told to generate it rather than choose one. Any model with more than one
  user, or any sign of guessing in the logs, should revisit this. The fix is a
  single **global** progressive backoff on failures, not a sleep per failed
  attempt, which is bypassed by guessing concurrently. That needs one shared
  "not before" instant serializing attempts across connections: a subsystem of
  its own, which is why it is not a line here.
- **`.pockode` data directory is not path-fenced.** `file.*` / `git.*` RPCs are
  confined to the worktree's work directory, but that directory contains the
  server's own `.pockode` state (work store, setup hooks, sessions, `sessions.json`)
  by default. A credential-holder can therefore read/modify server state through
  file RPCs. Under the single-developer model this is not a privilege escalation —
  the same developer
  already has shell and agent access — and the data directory can be relocated
  with `--data`. `sessions.json` adds an *availability* consequence rather than a
  confidentiality one: neither the token hashes nor the password fingerprint can
  be read back into a usable credential, but anything that can write the file —
  including a prompt-injected agent — can log every other browser out. The
  recovery is to log in again with the password, which that writer does not have.
- **Symlinks are not resolved during path validation.** `ValidatePath` rejects
  `..` and absolute paths and re-checks that the joined path stays inside the work
  directory, but it does not resolve symlinks, so a symlink inside a worktree can
  point outside it. Again, this is a defense-in-depth gap, not a boundary crossing,
  for a caller who already holds the one credential.
- **Traffic on a plaintext LAN deployment is not encrypted.** See
  [The residual risk](#the-residual-risk-plaintext-http-on-a-lan) for why the
  client-side hashing that looks like a fix is not one, and what actually is.

## Code Paths

| Concern | Path |
|---------|------|
| Password source & env scrubbing | `server/password/` |
| Session issue/validate, password fingerprint | `server/authsession/` |
| HTTP Bearer auth | `server/middleware/auth.go` |
| WebSocket `auth` gate | `server/ws/rpc.go`, `server/cluster/ws.go` |
| Wire types and refusal reasons | `server/rpc/types.go` |
| Frontend credential store | `packages/shared/src/stores/createAuthStore.ts`, `packages/shared/src/utils/auth.ts` |
| MCP local API token | `server/mcp/handler.go`, `server/serverinfo/serverinfo.go` |
| Relay MCP rejection | `server/apiroute/`, `server/relay/proxy.go` |
| Cluster node password delivery | `server/cluster/node/process.go` |
| On-disk restriction of credentials | `server/internal/fsperm/` |
