# Relay NAT Traversal System

Pockode needs to allow mobile devices to access development environments on users' PCs, but PCs are typically behind NAT and cannot be reached from the outside. The Relay system solves this: the PC establishes an outbound connection to a cloud relay server, and the mobile device reaches the PC through that server.

## Architecture Overview

```
┌─────────────────┐
│   Mobile App    │
└────────┬────────┘
         │ HTTPS / WSS
         ▼
┌─────────────────────────────────────┐
│  Relay Server (Cloud)               │
│  - Assigns subdomain                │
│  - Authenticates by relay_token     │
│  - ReverseProxy → one yamux stream  │
│    per public request               │
└────────┬────────────────────────────┘
         │ outbound WSS carrying a yamux session
         ▼
┌─────────────────────────────────────┐
│  User PC (behind NAT)               │
│  ┌─────────────────────────────────┐│
│  │ Manager                         ││
│  │ - Register/refresh with cloud   ││
│  │ - Dial + reconnect              ││
│  └────────────────┬────────────────┘│
│  ┌────────────────▼────────────────┐│
│  │ http.Server.Serve(yamuxSession) ││
│  │ (*yamux.Session is a Listener)  ││
│  └────────────────┬────────────────┘│
│  ┌────────────────▼────────────────┐│
│  │ local ReverseProxy              ││
│  │ - /api, /ws, /health → :8080    ││
│  │ - /*                  → :5173   ││
│  └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

**Key design decision 1 — outbound, not inbound.** The PC proactively connects to the cloud, bypassing NAT, firewalls and dynamic IPs.

**Key design decision 2 — a real stream multiplexer, not a hand-rolled one.** The tunnel carries a [yamux](https://github.com/hashicorp/yamux) session, the same choice frp and Consul make (ngrok uses its own muxado, Cloudflare Tunnel uses HTTP/2 then QUIC). Pockode previously multiplexed by hand: every message was a JSON `Envelope` tagged with a `connection_id`, HTTP bodies were base64-encoded and buffered whole, and one WebSocket message carried one whole envelope.

That design had a failure mode that no amount of tuning could fix: a WebSocket message is atomic on the wire, so a large transfer occupied the entire tunnel until it finished. A 39-byte interactive message measured **16.6 s** of queueing behind a 4 MiB download; the same case over yamux measured **0.5 s**. Worse, an oversized response exceeded the peer's WebSocket read limit, which is a fatal protocol error — downloading an 8 MB file killed the tunnel and every client on it.

yamux fixes both structurally: it has per-stream sliding-window flow control and interleaves frames from different streams, so a stalled or slow stream cannot starve the others, and a body streams instead of being buffered.

The full diagnosis lives in the cloud's relay design document.

## Connection Lifecycle

### Startup Flow

```
Manager.Start()
    │
    ├─ Load stored config (relay.json)
    │   │
    │   ├─ nil → Register with cloud
    │   │         └─ Receive subdomain + relay_token
    │   │         └─ Save to relay.json
    │   │
    │   ├─ corrupt → quarantined as relay.json.corrupt, treated as nil
    │   │
    │   └─ exists → Refresh token
    │                └─ Invalid? → Delete config, re-register
    │
    └─ Start background reconnect loop
        └─ Return public URL: https://{subdomain}.{relay_server}
```

On first run the PC registers with the cloud to obtain a unique subdomain and token. Later startups refresh the token to verify it is still valid. Configuration is persisted so a restart does not consume a new subdomain.

A config file damaged by an interrupted write takes the same recovery path as an invalid token: it is set aside and the server registers again. That costs the user their subdomain, which is not free — but the file is unreadable either way, and a relay that comes back at a new address beats one that refuses to start at all. The damaged copy is kept at `relay.json.corrupt` in case the old subdomain is worth recovering by hand.

Note that "register" here means the HTTP call that claims a subdomain, made only when there is no stored config yet. A tunnel does not register: it presents the stored relay token on the upgrade request — see [Authentication](#authentication).

### Reconnection Mechanism

`reconnector` (`server/relay/reconnect.go`) keeps the uplink up for as long as the manager lives.

**Exponential backoff with jitter**: after a failure, wait 1s, 2s, 4s… capped at 10s, each spread by ±20%. Without the jitter every pockode that was connected to a restarting cloud retries in the same millisecond and arrives as one burst.

**A stable connection resets the budget**: if the uplink had lasted over a minute, the drop is a new problem rather than a continuing one — retry at once instead of inheriting a backoff that belonged to an earlier outage.

**There is no attempt limit.** The relay is this server's only route in from outside, so a client that stopped retrying would be indistinguishable from one that had crashed.

**The 10s ceiling is not arbitrary**: it must stay below the cloud's tunnel grace period (30s). A reconnect that lands inside that window reclaims the subdomain's entry, so public requests that arrived during the gap are served instead of answered 503. The two values must move together — the grace period is set by the cloud relay and documented in the cloud's relay design document.

`connectAndRun` returns only when the session ends, so the tunnel's lifetime and one iteration of the reconnect loop are the same thing. It is injected into `reconnector` rather than called directly, which is what lets the backoff be tested by failing the uplink on demand against a fake clock.

### Bounding the Connect Path

The loop only makes progress if `connectAndRun` always returns, and during the handshake there is no keepalive yet to guard it. `http.DefaultTransport` bounds the TCP dial and the TLS handshake, so an unreachable host still fails on its own — but nothing bounds the wait for the 101 response. Against a peer that accepts the connection and then answers nothing, the dial blocks forever, and one stalled attempt parks the loop for good. From the outside that is exactly what "the tunnel never comes back after the network drops" looks like: no reconnect, and no log line after `connecting to relay`.

Two bounds close it:

- **Handshake** — `connectTimeout` (15s), applied through `DialOptions.HTTPClient.Timeout`. The library turns that into a context and cancels it the moment `Dial` returns, so it bounds the wait for the 101 without ever truncating the tunnel that follows — a distinction worth a test (`TestUplinkDialOptionsDoNotTruncateTheTunnel`), because getting it wrong would drop every tunnel on a 15s timer rather than fail visibly. 15s is far above any plausible healthy handshake and the same order as the 10s backoff ceiling, so a stalled peer settles into roughly one attempt every 25s.
- **Teardown** — `CloseNow`, not a graceful `Close`. The tunnel is torn down precisely when the peer has stopped answering, and a close handshake nobody completes costs up to 25s of the library's internal timeouts before the next attempt can start. yamux closes the connection itself when the session ends, so the `net.Conn` it is handed wraps `Close` to hang up rather than negotiate.

### Authentication

The relay token travels on the WebSocket upgrade request:

```go
conn, resp, err := websocket.Dial(ctx, url, uplinkDialOptions(cfg.RelayToken))
```

The cloud verifies it (constant-time) *before* accepting the upgrade, so a bad token costs one 401 instead of a WebSocket handshake plus an application-level round trip. Past the 101 the connection carries nothing but yamux frames — there is no in-band handshake and no second protocol to reason about.

### Compression

The uplink negotiates permessage-deflate with **context takeover** (`tunnelCompression`), matching the cloud relay's `AcceptOptions`. Both ends must ask for the same mode: whichever side offers the weaker one decides the result for both directions.

Context takeover is what makes it worth doing here, and the reason is the transport. Every yamux write is its own WebSocket message — a frame's header and its body are two separate writes — so a stream of chat events crosses the wire as a stream of few-hundred-byte messages. No-context-takeover mode only compresses messages over 512 bytes, so most of those go out verbatim and that mode measures byte-for-byte the same as no compression at all. With a window shared across messages, a relayed JSON-RPC stream drops to 0.40x of its uncompressed size and text HTTP responses to 0.04x, while random binary grows 0.06%.

The price is a `flate.Writer` held for the life of the connection — about 1,176 KiB, whatever the compression level. That is one per pockode process here, so the trade-off does not really bite on this side; the cloud multiplies it by the number of connected servers, and that is where it is accounted for.

Since `/ws` started negotiating its own permessage-deflate
([websocket-rpc-design.md](../websocket-rpc-design.md#compression)), relayed
WebSocket traffic arrives here already deflated and the tunnel's compression is
close to a no-op for it — measured 414 KB against 412 KB for the same recorded
conversation. It stays on because HTTP responses still travel the tunnel
uncompressed.

## Serving the Tunnel

`*yamux.Session` implements `net.Listener`, so the entire PC-side data plane is:

```go
session, err := yamux.Client(conn, yamuxConfig(log))
srv := &http.Server{Handler: handler, ...}
return srv.Serve(session)
```

The cloud opens one stream per public request; each stream is an ordinary HTTP connection served by `net/http`. There is no relay-specific message format, no routing table, and no `connection_id`: **a stream closing *is* the disconnect signal.**

This is why the mobile app's JSON-RPC WebSocket needs no special handling any more. It arrives as a normal `Upgrade: websocket` request on its own stream, is relayed as a normal 101 by both reverse proxies, and terminates at the local `GET /ws` handler — the same handler that serves a browser on localhost.

### Liveness

```go
cfg.KeepAliveInterval = 30 * time.Second
cfg.ConnectionWriteTimeout = 30 * time.Second
```

yamux pings every 30 s and fails the session if a ping goes unanswered within `ConnectionWriteTimeout`. That timeout is also the budget for handing a single frame to the WebSocket, and it is deliberately raised from yamux's 10 s default: on a mobile uplink a ping queues behind the frames already in flight, and 10 s is short enough that a merely *slow* link reads as a *dead* one. Mistaking congestion for death is precisely the bug the previous implementation had.

## Local HTTP Proxy

Every stream is served by a reverse proxy onto this machine's own HTTP servers.

### Routing Rules

```go
// apiroute.IsAPI
return strings.HasPrefix(path, "/api") || path == "/ws" || path == "/health"
```

| Path | Target |
|------|--------|
| `/api/*` | Backend (:8080) |
| `/ws` | Backend (:8080) |
| `/health` | Backend (:8080) |
| `/*` (others) | Frontend (:5173 in dev, `RELAY_FRONTEND_PORT`) |

The split exists for dev mode, where the Vite dev server owns the UI. In production both ports are the same and the split is a no-op.

The predicate lives in `server/apiroute` rather than here because `main.go`'s SPA handler needs exactly the same rule to decide what to serve from the embedded static files. Two copies would silently diverge: add a backend endpoint, forget the relay's list, and the endpoint becomes unreachable through the relay in dev mode only.

`/api/mcp/*` is refused outright, with a 404, before any port is chosen — a [preview](#port-previews)'s port included. It is the local MCP API: it drives this machine's tools on behalf of an agent CLI running here, and it authenticates with a token of its own rather than the user's. Nothing that reaches this machine from outside has a reason to call it. The refusal has to come first because in the default single-port setup `frontendPort == backendPort`, so routing alone would not keep it out of reach. `apiroute.IsLocalOnly` holds the predicate and `mcp.TestAPIPathStaysLocalOnly` pins the endpoint to it.

### Preserving the Public Request

```go
pr.Out.Host = pr.In.Host
```

**The original `Host` must survive both proxy hops** — for the app; [port previews](#port-previews) are the exception. This is not cosmetic: `websocket.Accept` rejects an upgrade whose `Origin` disagrees with `Host`, so rewriting `Host` to `localhost:8080` would make every legitimate mobile WebSocket fail the same-origin check. It also means the SPA sees the URL the browser actually used when building absolute URLs.

The same-origin check is now the *only* origin defence for mobile clients — the cloud no longer terminates their WebSocket, so it cannot inspect their `Origin`. Strict same-origin at this layer is stricter than the wildcard allow-list the cloud used to apply.

`X-Forwarded-For` / `-Host` / `-Proto` are copied from the inbound request, since the cloud already filled them from the public request.

### Port Previews

What a preview looks like to its user — the address, logging in, the limitations — is in [port-preview.md](../port-preview.md). This section is why it works that way.

The cloud also routes `<subdomain>-<port>.<relay server>` to this tunnel, Host unchanged. Such a request is not for this server at all: after the `/api/mcp/*` refusal and before any routing rule above, `newLocalProxy` recognizes the host and hands it to `previewProxy` (`server/relay/preview.go`), which dials `localhost:<port>` and nothing else. The host is matched against this tunnel's own subdomain and relay server, so the port is the only thing read from it.

Here the public request is deliberately *not* preserved. Dev servers check `Host` (Vite's `allowedHosts`) and `Origin` (Next's `allowedDevOrigins`) against an allowlist that knows `localhost` and not the preview host, and answer 403. So the request is made to look as if the browser had opened `localhost:<port>` itself:

| | Rewritten to | When |
|---|---|---|
| `Host` | `localhost:<port>` | always |
| `Origin` | `http://localhost:<port>` | when it names the preview host; anything else that gets this far — `Origin: null` from the preview's own page (see below) — passes unchanged |
| `Location` (response) | the preview URL | only when it points at `localhost:<port>`, with or without a scheme |

Of `X-Forwarded-*` only `-For` is copied. `-Host` and `-Proto` would name the public URL beside a `localhost` `Host` and `Origin`, and frameworks that trust them refuse the mismatch: Next's Server Actions compare `X-Forwarded-Host` with `Origin`, Rails checks it against its host allowlist. The preview session cookie is removed from `Cookie`, so the token never reaches the previewed app; the app's own cookies pass through.

#### Logging In

A previewed server knows nothing of Pockode's credentials, so the preview is guarded by the app's own: the same password, checked by the same `password.Matches` as the WebSocket `auth`, exchanged for a session from the same `authsession` store (see [Authentication](authentication.md#sessions-what-the-browser-keeps)). It cannot be the bearer token the SPA sends: navigations, subresources and a dev server's HMR socket carry no `Authorization` header. So the session lives in a cookie, which in turn means a login over HTTP, since only a response can set an `HttpOnly` cookie.

- A request without a live session is answered 401 and not forwarded. A page load (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` from a browser without fetch metadata) gets a built-in login page in the body, which does not load the SPA.
- The page posts the password (form-encoded `password`) to `/__pockode/preview/login` on the same host: 204 with the cookie, 401 on a wrong password, 429 with `Retry-After` while password attempts are locked out (see [Authentication](authentication.md#failed-password-attempts-are-rate-limited)) — the ticket login below is never locked out. On success the page reloads; the address bar never left the page asked for, so there is no redirect parameter.
- A request that already carries a live session is answered 204 without issuing another, so a second tab does not spend a session slot.

| Cookie | https | http (local development relay) |
|---|---|---|
| Name | `__Host-pockode_preview` | `pockode_preview` |
| Attributes | `Secure; HttpOnly; SameSite=Lax; Path=/` | `HttpOnly; SameSite=Lax; Path=/` |

`Max-Age` is the 400 days browsers cap it at: expiry is the session store's decision, as it is for the app's token. The `__Host-` prefix makes the cookie host-only and stops any other subdomain of the relay domain from planting one of that name; plain http cannot carry it.

##### Ticket Login

The password is not the only way in. A preview host is a different origin from the app, so the app's login never reaches it, and a user already logged in to the app would otherwise type the password again for every port. The logged-in app can instead ask for a one-time ticket over its WebSocket (`port_preview.ticket`, see [WebSocket JSON-RPC](websocket-rpc.md#scope-classification)) and open `/__pockode/preview/login?ticket=<ticket>` on the preview host in a new tab:

- A live ticket is exchanged for the same session cookie the password login sets, from the same store, and the response is `303` to `/`, so the ticket leaves the address bar and the history entry. The target is fixed; nothing in the request can choose it, so this is no open redirect.
- A spent, expired, unknown or missing ticket lands on `/` all the same, which shows the password page to a browser without a session. The failure is logged with the host, never the ticket: a live ticket in a log would be a login.
- A browser that already has a live session on that host keeps it and gets no new one, so no session slot is spent; the ticket is spent anyway, since it is still sitting in the URL.
- Only a top-level document navigation (`Sec-Fetch-Dest` absent or `document`) is taken as a ticket login. The app only ever opens a ticket in a tab, so a same-origin frame or a fetch carrying one gets `405`, as any non-`POST` did before, and does not spend it; a cross-origin frame is refused with 403 before it gets here (see [Other Users' Pages](#other-users-pages)).
- Every answer carries `Cache-Control: no-store` and, as defense in depth, `Referrer-Policy: no-referrer`.

The ticket itself (`authsession.Tickets`) is redeemable once, within 60 seconds (`authsession.TicketTTL`) — enough for the new tab's first request to arrive, and no longer, since anything more is time for a leaked ticket to be used. Tickets live only in this process's memory, keyed by their SHA-256 like session tokens, so the plaintext is never stored; at most 64 are outstanding, the oldest evicted first, so a client asking for tickets it never redeems cannot grow the set. A restart spends every outstanding ticket, which costs the user one password prompt.

It is not a self-contained signed token with an expiry, though that would spare the server its record. A signature lets a verifier trust a token without asking the issuer; here the issuer and the verifier are the same process, so there is nothing for it to save. And single use needs server-side state regardless: a signed token replays until it expires unless the server records it as spent. A signing key would only add one more secret to keep and rotate.

#### Other Users' Pages

Every user's app and previews live under the same relay domain, so they are all **same-site** to one another, and `SameSite=Lax` sends the preview cookie along with requests another user's page makes. Same-site is therefore not good enough; every preview request must be same-origin, with one exception:

- A top-level `GET`/`HEAD` navigation (`Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`) is let through from anywhere, so a link to the preview works — and so does the app opening a ticket login in a new tab: the page it opens is the preview's own, out of reach of the page that linked to it. A frame is not: it stays inside the embedding page, which could overlay it to steer the user's clicks.
- Anything else — frames, fetches, subresources, form posts, WebSocket upgrades, the password login — is refused with 403 unless `Sec-Fetch-Site` is `same-origin` or `none`.
- A browser that sends no `Sec-Fetch-Site` is judged by `Origin` instead, by the rule the app's `/ws` gets from `websocket.Accept`: no `Origin`, or one whose host equals `Host`.

`Sec-Fetch-Site` decides when present, as in Go's `http.CrossOriginProtection`: it covers requests that carry no `Origin` at all, such as a `<script>` tag, and a same-origin request may still carry `Origin: null` (a page with `Referrer-Policy: no-referrer` posting to itself). The check has to happen here, before `Origin` is rewritten to localhost, because whether the previewed server checks it is up to that server.

The cost: one preview cannot call or frame another directly, even on the same tunnel — the two are different origins — and no other page, the app's own included, can embed a preview in a frame. A dev server's own proxy (Vite's `server.proxy`) is unaffected, since that call never leaves the machine.

#### Paths That Stay Local

- `/__pockode/` is reserved for Pockode on every preview host; only the login endpoint answers there.
- `/api/mcp/*` is refused here too, by the same check as for the app's host and before the preview host is even recognized. It is not enough to refuse it on this server's own ports: the previewed port may be another Pockode on the machine — a cluster node, a second server — serving the same local-only API. The cost is that an app of the user's own with routes under `/api/mcp/` cannot have them previewed.

There is no port allowlist: the tunnel is the user's own, and so is everything listening on their machine. A port with nothing listening answers 502 with a message naming the port; a server that is there but fails to answer gets a 502 carrying the error instead, since the advice differs.

### Timeouts

`ResponseHeaderTimeout` bounds how long a local backend may take to *start* answering. There is deliberately no whole-request timeout: the relayed WebSocket and streaming responses are open-ended by design. The old `http.Client{Timeout: 10 * time.Second}` was a total timeout, which would have made both impossible.

## Security Mechanisms

### Token Protection

```go
func (s *Store) Save(cfg *StoredConfig) error {
    if err := fsperm.RestrictDir(filepath.Dir(s.path)); err != nil {
        return err
    }
    // ...
    return filestore.WriteFileAtomic(s.path, data, 0600)
}
```

The relay token is a credential for reaching the user's PC — whoever holds it can register the user's subdomain and receive the requests their phone makes, auth header included — so `relay.json` must not be readable by other local users.

The mode alone does not achieve that. `0600` is owner-only on unix, but on Windows it is inert: Go maps the `perm` argument only to the read-only attribute, and the file takes its access rights from the parent directory's ACL instead. `Save` therefore restricts the **directory** first, which is what actually protects the token there and what survives the atomic rewrite. See [Authentication → Credentials on Disk](authentication.md#credentials-on-disk) for the full reasoning and `server/internal/fsperm/` for the implementation.

### Version Check

```go
if resp.StatusCode == http.StatusForbidden {
    return nil, ErrUpgradeRequired
}
```

The cloud can reject outdated clients, which is what makes it possible to fix a protocol or security problem without waiting for every user to upgrade voluntarily.

### Token Invalidation Handling

```go
if errors.Is(err, ErrInvalidToken) {
    m.log.Warn("stored token is invalid, re-registering")
    m.store.Delete()
    return m.Start(ctx)  // Recursive retry with fresh registration
}
```

Tokens can be invalidated by a cloud reset, expiry, or manual revocation. The client re-registers automatically, transparently to the user.

### Auth Through the Relay

Requests for the app arriving through the tunnel go through the same `middleware.Auth` and the same WebSocket `auth` RPC as local requests; the relay never authorizes them on the app's behalf. Port previews are the exception: the previewed server knows nothing of Pockode's credentials, so the relay checks them itself before forwarding — with the app's password and session store, not a credential of its own (see [Logging In](#logging-in)).

## Code Paths

| Component | Path | Responsibility |
|-----------|------|----------------|
| Manager | `server/relay/relay.go` | Lifecycle, dial + authentication |
| Reconnector | `server/relay/reconnect.go` | Backoff loop keeping the uplink up |
| Client | `server/relay/client.go` | Communication with the cloud HTTP API |
| Tunnel | `server/relay/tunnel.go` | yamux session, serving HTTP over its streams |
| Local proxy | `server/relay/proxy.go` | Reverse proxy onto local backend/frontend |
| Preview proxy | `server/relay/preview.go` | Preview host recognition, same-origin gate, forwarding to `localhost:<port>` |
| Preview auth | `server/relay/preview_auth.go` | Preview login page, password and ticket login, session cookie |
| Store | `server/relay/store.go` | Configuration persistence |
| API path split | `server/apiroute/` | Shared with `main.go`'s SPA handler |
