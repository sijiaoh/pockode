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

The full diagnosis lives in the cloud repository at `docs/design/relay-resilience.md`.

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
    │   └─ exists → Refresh token
    │                └─ Invalid? → Delete config, re-register
    │
    └─ Start background reconnect loop
        └─ Return public URL: https://{subdomain}.{relay_server}
```

On first run the PC registers with the cloud to obtain a unique subdomain and token. Later startups refresh the token to verify it is still valid. Configuration is persisted so a restart does not consume a new subdomain.

### Reconnection Mechanism

`reconnector` (`server/relay/reconnect.go`) keeps the uplink up for as long as the manager lives.

**Exponential backoff with jitter**: after a failure, wait 1s, 2s, 4s… capped at 10s, each spread by ±20%. Without the jitter every pockode that was connected to a restarting cloud retries in the same millisecond and arrives as one burst.

**A stable connection resets the budget**: if the uplink had lasted over a minute, the drop is a new problem rather than a continuing one — retry at once instead of inheriting a backoff that belonged to an earlier outage.

**There is no attempt limit.** The relay is this server's only route in from outside, so a client that stopped retrying would be indistinguishable from one that had crashed.

**The 10s ceiling is not arbitrary**: it must stay below the cloud's tunnel grace period (30s). A reconnect that lands inside that window reclaims the subdomain's hub entry, so public requests that arrived during the gap are served instead of answered 503. The two values must move together — see the cloud repository's `server/relay/hub.go` and its `relay.md`.

`connectAndRun` returns only when the session ends, so the tunnel's lifetime and one iteration of the reconnect loop are the same thing. It is injected into `reconnector` rather than called directly, which is what lets the backoff be tested by failing the uplink on demand against a fake clock.

### Authentication

The relay token travels on the WebSocket upgrade request:

```go
conn, resp, err := websocket.Dial(ctx, url, uplinkDialOptions(cfg.RelayToken))
```

The cloud verifies it (constant-time) *before* accepting the upgrade, so a bad token costs one 401 instead of a WebSocket handshake plus an application-level round trip. Past the 101 the connection carries nothing but yamux frames — there is no in-band handshake and no second protocol to reason about.

### Compression

The uplink negotiates permessage-deflate with **context takeover** (`tunnelCompression`), matching the cloud's `AcceptOptions`. Both ends must ask for the same mode: whichever side offers the weaker one decides the result for both directions.

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

### Preserving the Public Request

```go
pr.Out.Host = pr.In.Host
```

**The original `Host` must survive both proxy hops.** This is not cosmetic: `websocket.Accept` rejects an upgrade whose `Origin` disagrees with `Host`, so rewriting `Host` to `localhost:8080` would make every legitimate mobile WebSocket fail the same-origin check. It also means the SPA sees the URL the browser actually used when building absolute URLs.

The same-origin check is now the *only* origin defence for mobile clients — the cloud no longer terminates their WebSocket, so it cannot inspect their `Origin`. Strict same-origin at this layer is stricter than the wildcard allow-list the cloud used to apply.

`X-Forwarded-For` / `-Host` / `-Proto` are copied from the inbound request, since the cloud already filled them from the public request.

### Timeouts

`ResponseHeaderTimeout` bounds how long a local backend may take to *start* answering. There is deliberately no whole-request timeout: the relayed WebSocket and streaming responses are open-ended by design. The old `http.Client{Timeout: 10 * time.Second}` was a total timeout, which would have made both impossible.

## Security Mechanisms

### Token Protection

```go
func (s *Store) Save(cfg *StoredConfig) error {
    return os.WriteFile(s.path, data, 0600)  // Owner-only access
}
```

The relay token is the credential for reaching the user's PC. Permission 0600 keeps it readable only by its owner.

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

### Auth is Unchanged by the Relay

Requests arriving through the tunnel go through the same `middleware.Auth` and the same WebSocket `auth` RPC as local requests. The relay proxies; it never authorizes on the application's behalf.

## Code Paths

| Component | Path | Responsibility |
|-----------|------|----------------|
| Manager | `server/relay/relay.go` | Lifecycle, dial + authentication |
| Reconnector | `server/relay/reconnect.go` | Backoff loop keeping the uplink up |
| Client | `server/relay/client.go` | Communication with the cloud HTTP API |
| Tunnel | `server/relay/tunnel.go` | yamux session, serving HTTP over its streams |
| Local proxy | `server/relay/proxy.go` | Reverse proxy onto local backend/frontend |
| Store | `server/relay/store.go` | Configuration persistence |
| API path split | `server/apiroute/` | Shared with `main.go`'s SPA handler |
