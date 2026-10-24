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
| HTTP API | `Authorization: Bearer <password or session token>`; `/api/raw` takes a capability instead (below) | `server/middleware/auth.go` |
| WebSocket | First RPC must be `auth { password }` or `auth { session_token }`; all other methods are rejected until it succeeds | `server/ws/rpc.go`, `server/cluster/ws.go` |
| Relay | The relay tunnels the same HTTP/WS traffic; no separate app credential | `server/relay/` |
| Port preview | A session cookie, issued by posting the password to `/__pockode/preview/login` on the preview host, or by opening it with a one-time ticket the logged-in app got from `port_preview.ticket`; see [Port Previews](relay-system.md#logging-in) | `server/relay/preview_auth.go`, `server/authsession/ticket.go` |
| Raw content | A capability in the URL's path, `/api/raw/<capability>/<path>`, that the logged-in app got from `raw.capability`; see [Raw capabilities](#raw-capabilities-urls-a-browser-element-loads-by-itself) | `server/filetransfer/raw.go`, `server/authsession/capability.go` |

Both credentials are accepted on HTTP so that `curl` and scripts have something
to send: a browser exchanges the password for a session token and sends that
(see [Sessions](#sessions-what-the-browser-keeps)), while a shell one-liner can
keep sending the password. Every surface checks the password through
`password.Matches`, which uses `crypto/subtle.ConstantTimeCompare` to avoid
leaking it through response timing; session tokens are compared the same way.
The password is supplied by the operator; the server does not generate a
default and refuses to start without one.

A missing `Authorization` header, a malformed one and a wrong credential all get
the same `401 Invalid credentials`: telling an unauthenticated caller which of
the three it got wrong is information it has not earned. The one exception is a
password refused during a lockout, below — that reply has to say how long to
wait.

### Failed password attempts are rate-limited

Behind the password is arbitrary code execution on the host, the relay is on by
default and so puts `/ws` on the public internet, and the password is a
human-chosen one that may be short (see [Trust Model](#trust-model)). So
failed password attempts are slowed down (`server/authguard/`):

- **One global counter per process**, not per client IP. There is a single
  credential, so there is nothing to partition; and on the relay path every
  request arrives from the local relay client, so the remote address says
  nothing about who is guessing. The server builds one guard and shares it
  across every place that checks the password — WebSocket `auth`, HTTP Bearer,
  the port preview login — because separate guards would each grant their own
  round of guesses. The cluster process builds its own, for the same three.
- **The first 5 failures are free**, so typos never lock the owner out. Failure
  6 locks password attempts for 1 s, failure 7 for 2 s, and so on, doubling up to
  a cap of 15 minutes. Once at the cap a guesser gets about four tries an hour.
- **The count resets** on a successful password login, or once an hour has
  passed since the last failure. Attempts refused during a lockout are not
  counted and do not extend that hour.
- **While locked, a password is refused without being checked** — the correct
  one too. Checking it would let a guesser keep guessing straight through the
  lockout and learn the moment one was right. The refusal is immediate,
  not a sleep: a sleep holds a connection open per attempt and is bypassed by
  guessing concurrently. The check, the comparison and the count happen under
  one lock, so concurrent guesses cannot all get past the check before any of
  them is counted.
- **Session tokens, preview tickets and raw capabilities never go through the
  guard.** A device
  already logged in keeps working while someone else is locked out; only a
  fresh password login waits. That is also the cost of the design: anyone who
  can reach the server can keep the *owner's* password login locked, in
  exchange for which the owner's existing sessions are untouched.
- **State is in memory only.** A restart clears it, which is the owner's way out
  of a lockout they cannot wait out.
- **Logging is one Warn when a lockout starts**, with the failure count and the
  lockout length, rather than a line per wrong password.

What a locked password attempt gets back, per entry point:

| Entry point | Reply while locked |
|---|---|
| WebSocket `auth` (server and cluster) | The usual auth refusal with `data.reason` `rate_limited` and `data.retry_after_ms` (integer milliseconds, rounded up), then the connection closes like any other refusal |
| HTTP Bearer | `429` with `Retry-After` in whole seconds, rounded up |
| Port preview login (`POST`) | `429` with `Retry-After`; the login page shows "Too many attempts. Try again in N s." |

The HTTP Bearer credential can be either a session token or the password, and
nothing on the wire says which. So the middleware tries it as a session token
first and only then as a password, through the guard: a valid token never
touches it. The flip side is that an expired or revoked token sent as Bearer is
indistinguishable from a wrong password and counts as one failure. The web app
logs out on its first 401, so a stale device spends only the requests it had
in flight, not the five free failures. A request with no Bearer credential at
all guessed no password and is not counted. On the WebSocket the two credentials are separate fields,
so an invalid `session_token` is never counted.

This slows online guessing; it does not make a weak password strong. Users are
still told to generate the secret rather than choose one.

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
token is the only credential a frontend stores. `server/authsession/` issues and
validates them, on both the server and the cluster, out of
`<dataDir>/sessions.json`.

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
| `rate_limited` | Too many wrong passwords; passwords are refused unchecked — the right one included — for `data.retry_after_ms` more milliseconds (see [Failed password attempts](#failed-password-attempts-are-rate-limited)) | Return to the password screen without a "wrong password" error, count the wait down there and hold submit until it is over; never retry on its own |
| `session_expired` | The stored token is unknown or past its idle window | Drop it silently and ask for the password — the user did nothing wrong |
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
(`createAuthStore`'s `legacyPasswordKey`).

**Each origin holds its own token.** The same server reached over the LAN
(`http://ip:port`) and through the relay (`https://<subdomain>…`) are different
browser origins with separate `localStorage`, so each gets a session of its own.
Each port preview host likewise holds its own session, in a host-only cookie.
That is correct, and it is one reason the cap is 50 rather than 5.

**A preview tab can be logged in by the app.** So that a user already logged in
to the app does not type the password again for each port, the app can ask over
its authenticated WebSocket for a one-time ticket (`port_preview.ticket`) and
open the preview host's login endpoint with it; the host exchanges the ticket
for a session of its own. A ticket is not a credential of a new kind: it can
only be obtained by a connection that already authenticated, and all it buys is
an ordinary session from the same store. It is single-use, lives about 60
seconds (`authsession.TicketTTL`), is held only in memory and only as its
SHA-256, and anything that goes wrong with it falls back to the password page.
A browser that already has a session on that host keeps it. Why it is a
server-held ticket rather than a signed token, and the endpoint's rules, are in
[Port Previews → Logging In](relay-system.md#logging-in).

### Raw capabilities: URLs a browser element loads by itself

A `<video src>`, an `<audio src>`, an `<iframe src>` or an `<a download>` makes
its requests on its own, and none of them can carry an `Authorization` header.
Fetching the bytes into a Blob with the header instead works for an image, and
is what images do
([file.md](../file.md#loading-image-bytes)); for anything else it is the wrong
shape. A video has to download whole before it plays, and sits whole in the
phone's memory while it does; so does a file being saved, which is why the
app's downloads go through a capability too
([file.md](../file.md#downloading)). A page's relative stylesheets, scripts and
images have nowhere to load from at all. So the logged-in app can ask over its
WebSocket for a **capability** (`raw.capability`, see
[WebSocket JSON-RPC](websocket-rpc.md#raw-capabilities)): a URL on this
server that reads one file, or one directory and everything beneath it. The
element loads that URL, `/api/raw/<capability>/<path>`
([the endpoint](../file.md#transfer)), with no header.

Like a preview ticket, a capability is not a credential of a new kind. Only a
connection that has already authenticated can get one. It is bound to the
session that connection authenticated as, and it buys read access to what it
names and nothing else.

| Property | Value | Why |
|---|---|---|
| Token | 32 bytes from `crypto/rand`, base64url | Nothing to guess, and safe as a path segment |
| Stored as | its SHA-256, in memory only | Hashed as a session token is; held in memory as a ticket is, so a restart revokes every capability |
| Lifetime | 4 hours (`authsession.CapabilityTTL`), any number of uses | A video watched to the end or a page left open must not lose its next request partway. A client is expected to ask again when a load fails with `capability_not_found`, so a shorter life would cost only a re-issue, and a longer one is more time for a leaked URL to stay good |
| Bound to | the issuing session, asked on **every** request | A session ends by idling out as much as by anything done to it, and nothing fires when it does, so the session store is asked each time rather than told. Whatever ends the session — idle expiry, eviction, a changed password — ends its capabilities. Using a capability does not count as using the session, so it does not keep the session alive |
| Cap | 256 outstanding, across all sessions; those of ended sessions are dropped first, then the oldest is evicted | Bounds what authenticated clients can make the server hold. A client needs one per file or page it shows, so this is far above normal use, and an evicted capability costs its holder a re-issue |

A connection whose session has already ended is refused with the auth refusal's
`session_expired`. Issuing a capability that is dead on arrival would only hide
the real problem.

Logging out in the app drops the session token on the device; nothing tells the
server. So "dies with its session" means it dies when the session idles out, is
evicted, or the password changes. A capability issued just before a logout
stays good until its own 4 hours are up.

**It lives in the path, not the query.** A page's `./style.css` resolves against
the page's path and drops its query string. With the capability in the path,
every relative URL the page makes carries it, with no rewriting. The cost is
that the path is now a secret. The relay proxy's error log masks it
(`apiroute.LoggablePath`), and `Referrer-Policy: no-referrer` keeps it out of
the `Referer` of anything the page loads from elsewhere.

**A page can read its own URL — and, through CORS (below), what it
reaches.** A previewed page's scripts can read `location` (an agent's page, its
`document.baseURI` or its policy), capability included, and send it
to any host the reader has allowed for the page — or, after any tap in the
page, open a tab anywhere with it
([what a page can reach](../page-external-hosts-ui.md#known-limits)). They can
also fetch every file the capability reaches and send the bytes out the same
way, which matters even where the URL alone would not: a server kept to its
LAN is out of reach of whoever receives the URL, but not of the page running
inside it. So a capability a player or a page holds reaches one of two things:

- **One file** for a video, a sound, or a page the root scope withholds
  (below). A request for any other name is refused with `403 outside_scope`.
- **The whole work directory or commit, withheld names excepted** for an HTML
  page (`scope: "root"`, with no path; `filetransfer.RawScopeRoot`). The page
  is opened at its own path beneath the capability,
  `<capability>/docs/site/index.html`, so its relative stylesheets, scripts and
  images, its `../` links and its `fetch()`es resolve to the project files they
  name ([file.md](../file.md#html-pages)). A page an agent shows with
  `html_render` is drawn from `srcdoc` and has no path, so it gets the same
  capability as its `<base>` instead: its relative URLs resolve from the
  root, and its policy, which the app writes, names the capability's path
  ([tool-call-ui.md](../tool-call-ui.md#project-files)).
- An attachment is always one file. An attachment store is flat, not a tree of
  files that refer to each other.

A third scope, `folder` (`filetransfer.RawScopeFolder`, work-directory origin
only), is no page at all: it serves one folder — `path`, or the work directory
for none — as a zip archive at the capability's own path, for the Files tab's
"Download as zip", which needs a link for the same reason a file's Download
does. Beneath the folder it reaches nothing a root scope does not: the archive
leaves out every dot-prefixed name, the data directory and other worktrees,
and never follows a symlink ([file.md](../file.md#folder-archive)). The folder
named is archived whatever it is — a dot directory, the data directory, another
worktree — as a file there named by itself gets a file scope of its own.

**The root, not the page's folder, because the page is the agent's.** A page
previewed here was written by the agent working in this project, and that agent
can already read every file in it. Holding the page to its own directory kept
nothing from the author that wrote it, and broke every page that reaches
`../shared/style.css` or a sibling folder's data. So the root scope trusts the
page as far as the agent is trusted and keeps the conventional limits instead:
what no web server serves from a tree it publishes, and what is not this
worktree's at all. The session and worktree binding above and the sandbox
below hold as before.

**What the root scope withholds**, each answered `403 outside_scope`:

- **Any path with a dot-prefixed component** — `.env`, `sub/.git/config`,
  `.pockode/…`, `%2eenv` once decoded, and `sub/./x` too, which no browser
  sends. A page usually sits beside the `.env` of the app it belongs to, and
  `.git` or `.pockode` would hand its scripts the repository or Pockode's own
  data.
- **Pockode's data directory, wherever `--data` puts it.** By default it is
  `.pockode` and the dot rule covers it, but `--data ./pockode-data` puts every
  session, `server.json` with the local API token, and the attachments under a
  plain name inside the project.
- **Every other registered worktree inside this one.** A worktrees base
  directory configured inside the project puts another worktree's files under a
  plain name; a worktree's capability reads its own files only. The list of
  worktrees is cached for up to three seconds, so one just added is readable
  for at most that long.

The last two are directories on disk, so they hold for a work-directory file;
a commit's root scope is held to the first.

For a work-directory file each rule is asked again of the name the file system
resolved the open file to (`resolvedName`,
`server/filetransfer/realname_{unix,windows}.go`), because `os.Root` follows a
link that stays inside it, and on Windows a name can be another spelling of a
different one. On darwin and linux every link on the way is followed, so
`site/env -> .env` is `.env` and a link into another worktree is that worktree;
the resolving is by path after the open, and the file found there has to be the
one opened, so a link swapped in between is refused rather than believed. On
Windows the long final path of the open handle is used, which also turns an 8.3
short name such as `ENV~1` or `GIT~1` back into `.env` or `.git`. A name that
cannot be resolved is refused the same way, with the host path kept in the log,
since the error body is readable by the page.

The data directory and the worktrees are matched by identity (`os.SameFile` on
each directory up the resolved path, `inWithheldDir`), not by spelling: a
case-insensitive file system — macOS by default — opens `Worktrees/other` as
`worktrees/other`. Only directories strictly beneath the work directory are
compared, so the main worktree, which a nested one lies inside, never counts
against the nested one's pages. A withheld directory that is gone or cannot be
stat'ed is skipped, logged unless it is simply gone, so that one stale worktree
does not refuse every page.

A dotfile the user opens on purpose still gets a file scope of its own, and a
page whose own path has a dot component gets only that. The price is that such
a page's relative assets do not load — a build output inside a dot directory
(`docs/.vitepress/dist`, `.output/public`) is one. That is accepted; the app
says so above the page ([file.md](../file.md#html-pages)).

**Symlinks cannot widen a scope.** This is stricter than the rest of the file
surface, which [does not resolve symlinks](#accepted-limitations). The
difference is the holder: a capability may be in the hands of a page's script,
not of the developer. A work-directory file is opened through an `os.Root`, so
a link that leads out of the work directory is refused, and a link that stays
inside it lands on a name checked as above: it can lead elsewhere in the
project, never to what the root scope withholds. A file scope is held to the
work directory alone, so a file that is itself a link elsewhere in the project
still opens: that file is what the user opened. A commit needs none of this:
git looks a path up in the tree without following links — a link is a blob
holding its target's name — so the checks on the name asked for are all a
commit's root scope needs.

**Every response carries the same seven headers, errors included:**

| Header | Why |
|---|---|
| `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; <page policy>` | Content is served as what it is (`text/html` included), on the app's own origin. The sandbox gives a document opened from here an opaque origin, whether it is framed or opened top-level, so its scripts cannot reach the app's `localStorage` and the session token in it. `allow-scripts` and `allow-popups` are what a previewed page needs to run and to open its links, and `allow-popups-to-escape-sandbox` lets a link opened in a new tab be a normal page there, as from an agent's page in chat — one that opens `/api/raw` again is sandboxed by its own response; `allow-same-origin` is the one flag that must never be added. The page policy after it is below |
| `X-DNS-Prefetch-Control: off` | A host named in a page is not resolved ahead of a request the policy would refuse — a hostname can carry a secret as well as a path can |
| `X-Content-Type-Options: nosniff` | The browser takes the server's type and does not guess another. Without it, a file the server named harmlessly could be rendered as something else |
| `Referrer-Policy: no-referrer` | The capability is in the URL; see above |
| `Cache-Control: private, no-cache` | The content is the user's, and a work-directory file changes under the same URL whenever the agent edits it. Revalidation is what tells |
| `Access-Control-Allow-Origin: *` | A sandboxed page loads its module scripts, fonts and `fetch()`es in CORS mode from an opaque origin; see below. On errors too, or a page's `fetch()` sees a network failure rather than the status |
| `Access-Control-Expose-Headers: Accept-Ranges, Content-Range, ETag` | What a page's ranged reader (pdf.js, a video or wasm loader) needs to learn a size and revalidate, beyond the safelisted headers |

A response without the sandbox is a document that runs in the app's origin, so
"every response" is enforced in two places rather than trusted to each code
path. The route is answered in `server/main.go` (`newHandler`) ahead of both the
auth middleware and the `ServeMux`, so the mux's own redirects and 404s never
answer it. `/api/raw` without the trailing slash is included
(`apiroute.IsRaw`). A `ResponseWriter` wrapper sets the headers at the moment a
status is written, because `http.ServeContent` clears `Cache-Control` before a
`416`.

The sandbox does not stop a page from making requests; the **page policy**
does. Previewing a page means running its scripts, and what the sandbox ensures
is only that they run as nobody in particular, not as the logged-in app. Beside
it the CSP holds a policy built for each request from the capability
(`pagePolicy`, `server/filetransfer/raw.go`):

```
default-src <base>/api/raw/<capability>/ data: blob: <hosts>;
script-src 'unsafe-inline' 'unsafe-eval' <same>; style-src 'unsafe-inline' <same>;
frame-src <base>/api/raw/<capability>/ data: blob:; object-src 'none';
form-action <base>/api/raw/<capability>/
```

A document served here reaches its own capability and nothing else of this
server's — not `'self'`, which in the opaque origin names nothing it can be
held to — and no other host but those bound to the capability when it was
issued (`raw.capability`'s `hosts`, each over `http`, `https`, `ws` and `wss`;
[websocket-rpc.md](websocket-rpc.md#raw-capabilities)). `<base>` is the
`base_url` the app sent — where it loads the capability from, which a proxy in
between may not pass on as `Host` — or, without one, the request's own `Host`
over both schemes. The hosts are the reader's allowance, made in the app; they
are never read from the URL, which the page can navigate to anything it likes.
A host matching the request's `Host` on any port or with a trailing dot is
dropped when serving, as one matching the `base_url`'s host is refused at
issue, since a request there could carry the app's cookies. An unknown capability's error goes out with
`default-src 'none'`. Why the policy is what it is, the wrapper that keeps the
page from navigating out of its capability, and the script injected into a
framed page are in
[page-external-hosts-ui.md](../page-external-hosts-ui.md#how-it-is-built).

**Any origin may read; none with credentials.** The sandbox's opaque origin (`Origin: null`) is cross-origin even to the server
that served the page, so a page's `<script type="module">`, its `@font-face`
and any `fetch()` of its own assets are CORS requests to its own capability.
Without CORS a page's external module scripts do not load at all. So every response allows any
origin, and none allows credentials: there is no
`Access-Control-Allow-Credentials`, and the endpoint reads no cookie or
`Authorization` header anyway. The capability that authorizes a read is in the
URL, so a caller from any origin can read only what anyone holding the URL
could already fetch with a plain GET. What it does add — the page's script
reading the bytes rather than only the URL — is why the root scope withholds
what it does above.

A **preflight** (`OPTIONS` on any `/api/raw` path) is answered `204` before any
capability check: it reads nothing, so there is nothing for a capability to
authorize, and a dead one is reported by the request that follows. It allows
`GET, HEAD, OPTIONS` (also its `Allow`) and echoes back whatever `Access-Control-Request-Headers` asked for, with
`Vary: Access-Control-Request-Headers` and a one-day `Access-Control-Max-Age`.
Echoing is safe for the same reason: with no credentials and only reads
served, a request header can change nothing but what the page's own library
gets back — a multi-range `Range`, say, which is not safelisted. Any other
method is `405` (`file.md`'s [transfer table](../file.md#transfer)).

In development the Vite dev server's own CORS middleware is off
(`server.cors: false` in `web/vite.config.ts`): it runs ahead of the `/api`
proxy and would answer every preflight itself, so a page's preflighted `fetch()`
would fail in dev alone. Off, the backend owns this policy in dev as on the
relay and in production.

**Rejected alternatives**, recorded so they are not proposed again without a
new argument:

- **A cookie on the app's origin.** A sandboxed frame has an opaque origin, so a
  `SameSite=Lax` cookie is not sent with its requests. `SameSite=None` requires
  `Secure`, and the LAN path is plain HTTP.
- **A Service Worker that adds the header.** It is unreliable for media `Range`
  requests on iOS Safari, which is exactly where video has to work.
- **The port-preview subdomain** for a separate origin. It exists only through
  the relay, and the LAN path has to work too.

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

- **`.pockode` data directory is not path-fenced.** `file.*` / `git.*` RPCs are
  confined to the worktree's work directory, but that directory contains the
  server's own `.pockode` state (work store, setup hooks, sessions, `sessions.json`)
  by default. A credential-holder can therefore read/modify server state through
  file RPCs. Under the single-developer model this is not a privilege escalation —
  the same developer
  already has shell and agent access — and the data directory can be relocated
  with `--data`. The raw endpoint is the exception: a page's script is not the
  credential-holder, so a root scope withholds the data directory wherever it
  is. `sessions.json` adds an *availability* consequence rather than a
  confidentiality one: neither the token hashes nor the password fingerprint can
  be read back into a usable credential, but anything that can write the file —
  including a prompt-injected agent — can log every other browser out. The
  recovery is to log in again with the password, which that writer does not have.
- **Symlinks are not resolved during path validation.** `ValidatePath` rejects
  `..` and absolute paths and re-checks that the joined path stays inside the work
  directory, but it does not resolve symlinks, so a symlink inside a worktree can
  point outside it. Again, this is a defense-in-depth gap, not a boundary crossing,
  for a caller who already holds the one credential. The raw endpoint is the
  exception, for the reason given in
  [Raw capabilities](#raw-capabilities-urls-a-browser-element-loads-by-itself).
- **Traffic on a plaintext LAN deployment is not encrypted.** See
  [The residual risk](#the-residual-risk-plaintext-http-on-a-lan) for why the
  client-side hashing that looks like a fix is not one, and what actually is.

## Code Paths

| Concern | Path |
|---------|------|
| Password source, env scrubbing & comparison | `server/password/` |
| Failed-password lockout | `server/authguard/` |
| Session issue/validate, password fingerprint, one-time preview tickets, raw capabilities | `server/authsession/` |
| HTTP Bearer auth | `server/middleware/auth.go` |
| WebSocket `auth` gate | `server/ws/rpc.go`, `server/cluster/ws.go` |
| Port preview login (password & ticket) & cookie | `server/relay/preview_auth.go` |
| Preview ticket issue | `server/ws/rpc_port_preview.go` |
| Raw capability issue | `server/ws/rpc_raw.go` |
| Raw endpoint: scope, path safety, CORS and response headers | `server/filetransfer/raw.go`; resolved names for what the root scope withholds in `realname_{unix,windows}.go` |
| Raw endpoint routed ahead of auth; capability masked in logs | `server/main.go` (`newHandler`), `server/apiroute/`, `server/relay/proxy.go` |
| Wire types and refusal reasons | `server/rpc/types.go` |
| Frontend credential store | `packages/shared/src/stores/createAuthStore.ts`, `packages/shared/src/utils/auth.ts` |
| MCP local API token | `server/mcp/handler.go`, `server/serverinfo/serverinfo.go` |
| Relay MCP rejection | `server/apiroute/`, `server/relay/proxy.go` |
| Cluster node password delivery | `server/cluster/node/process.go` |
| On-disk restriction of credentials | `server/internal/fsperm/` |
