# Relay NAT Traversal System

Pockode needs to allow mobile devices to access development environments on users' PCs, but PCs are typically behind NAT and cannot be accessed directly from the outside. The Relay system solves this problem: the PC establishes an outbound connection to a cloud relay server, and the mobile device forwards requests to the PC through the relay server.

## Architecture Overview

```
┌─────────────────┐
│   Mobile App    │
│   (WebSocket)   │
└────────┬────────┘
         │ HTTPS
         ▼
┌─────────────────────────────────────┐
│  Relay Server (Cloud)               │
│  - Assigns subdomain                │
│  - Routes by token                  │
│  - Forwards over WebSocket          │
└────────┬────────────────────────────┘
         │ outbound WebSocket
         ▼
┌─────────────────────────────────────┐
│  User PC (behind NAT)               │
│  ┌─────────────────────────────────┐│
│  │ Manager                         ││
│  │ - Register/refresh with cloud   ││
│  └────────────────┬────────────────┘│
│  ┌────────────────▼────────────────┐│
│  │ Multiplexer                     ││
│  │ - Demux by connectionID         ││
│  │ - Manage VirtualStream          ││
│  └────────┬──────────┬─────────────┘│
│           │          │              │
│  ┌────────▼──┐  ┌────▼───────────┐ │
│  │Virtual    │  │ HTTPHandler    │ │
│  │Stream × N │  │ - /api → :8080 │ │
│  └───────────┘  │ - /*   → :5173 │ │
│                 └────────────────┘ │
└─────────────────────────────────────┘
```

**Key Design Decision**: Use outbound WebSocket instead of inbound connections. The PC proactively connects to the cloud, bypassing NAT, firewalls, and dynamic IP issues.

## Connection Lifecycle

### Startup Flow

```
Manager.Start()
    │
    ├─ Load stored config (relay.json)
    │   │
    │   ├─ nil → Register with cloud
    │   │         └─ Receive subdomain + token
    │   │         └─ Save to relay.json
    │   │
    │   └─ exists → Refresh token
    │                └─ Invalid? → Delete config, re-register
    │
    └─ Start background reconnect loop
        └─ Return public URL: https://{subdomain}.{relay_server}
```

On first run, register with the cloud to obtain a unique subdomain and authentication token. Subsequent startups refresh the token to verify validity. Configuration is persisted locally to avoid re-registering every time.

### Registering a Tunnel

Two different things are called "register" here. The one above is an HTTP call, made only when there is no stored config yet, that claims a subdomain. This one is a WebSocket message sent on *every* tunnel: a fresh connection carries no identity, so before it can be used it must present the stored relay token.

```go
// relay.go:211 — register
func (m *Manager) register(ctx context.Context, conn *websocket.Conn, relayToken string) error {
    req := registerRequest{
        JSONRPC: "2.0",
        Method:  "register",
        Params:  map[string]string{"relay_token": relayToken},
        ID:      1,
    }
    wsjson.Write(ctx, conn, req)

    var resp registerResponse
    wsjson.Read(ctx, conn, &resp)
    // ...
}
```

It reuses JSON-RPC 2.0 for consistency with Pockode's other protocols. Because it repeats on every reconnect, it is one of the two places a reconnect attempt can hang — see [Bounding the Connect Path](#bounding-the-connect-path).

### Reconnection Mechanism

```go
// relay.go:126 — runWithReconnect
func (m *Manager) runWithReconnect(ctx context.Context, url, relayToken string) {
    backoff := time.Second
    attempt := 0

    for ctx.Err() == nil {
        start := time.Now()
        attempt++
        err := m.connectAndRun(ctx, url, relayToken, attempt)
        // ... log the disconnect

        // Skip the wait if the connection was stable (> 1 minute)
        if time.Since(start) > time.Minute {
            backoff = time.Second
            continue
        }

        select {
        case <-time.After(backoff):
        case <-ctx.Done():
            return
        }
        backoff = min(backoff*2, 10*time.Second)
    }
}
```

**Exponential Backoff**: After connection failure, wait 1s, 2s, 4s... up to 10s max. However, if the connection was stable for more than 1 minute before disconnecting, treat it as network jitter—retry immediately and reset the backoff time. This distinguishes between "network unreachable" and "temporary interruption" scenarios.

**Why the URL and token are parameters, not a `*StoredConfig`**: the loop's only real input is where to connect and what to send, which keeps it testable against a stub relay without fabricating a subdomain that DNS would have to resolve.

### Bounding the Connect Path

The reconnect loop can only make progress if `connectAndRun` always returns, and the keepalive that guards the established tunnel does not exist yet during the handshake and the register round-trip. `http.DefaultTransport` bounds the TCP dial and the TLS handshake, so an unreachable host still fails on its own — but nothing bounds the wait for the 101 response, nor the wait for the register reply. Against a peer that accepts the connection and then answers nothing, both block forever.

That failure mode is not exotic here. A blackholed network produces it, and a cloud still holding the previous registration would too — the latter is only a hypothesis, since the cloud is not in this repository, but it is the one that would make a *reconnect* fail where the first connect succeeded. One stalled attempt parks the loop for good, and from the outside that is exactly what "the tunnel never comes back after the network drops" looks like: no reconnect, and no log line after `connecting to relay`.

The timeouts do not depend on which of the two it is; they only guarantee the loop keeps turning. Which one it actually is shows up in the log: a repeated `register: ... context deadline exceeded` points at the cloud, not at the network.

So every stage of the connect path is bounded by `connectTimeout` (15s):

- **Handshake** — via `DialOptions.HTTPClient.Timeout`, which the library clears once the connection is up, so it never truncates the tunnel itself.
- **Register** — its own `context.WithTimeout`, cancelled as soon as the round-trip finishes. Cancelling afterwards is safe: the library disarms a read/write's context hook when the operation completes.
- **Teardown** — `CloseNow` instead of a graceful `Close`. This path is reached precisely when the peer is unresponsive, so waiting on a close handshake that will never be answered only delays the next attempt.

15s is far above any plausible healthy handshake, and the same order as the 10s backoff ceiling, so a stalled peer settles into roughly one attempt every 25s — neither hammering the cloud nor going quiet for minutes at a time.

### Disconnect Visibility

Users are developers: a dead tunnel must be legible from the log alone. Three lines tell the whole story — `connecting to relay`, `relay connected`, and `relay disconnected, reconnecting` (carrying `error` and `retryIn`). Each event keeps a single message string and puts the varying part in structured fields, so `attempt` is what distinguishes a reconnect from the first connect, and `retryIn=0` marks the stable-connection fast path. A loop stuck mid-connect then shows up as an `attempt` that stops advancing.

### Liveness Detection (Keepalive)

`runWithReconnect` only retries after `connectAndRun` returns, which depends on `Multiplexer.Run` unblocking. But when the host machine sleeps and wakes, the connection is often left **half-open**: the peer is gone, yet `m.conn.Read` never errors and blocks forever. Without active probing, the reconnect loop would never fire and the tunnel would stay silently dead.

```go
// multiplexer.go:126 — keepAlive
func (m *Multiplexer) keepAlive(ctx context.Context, cancel context.CancelFunc) {
    // ping every pingInterval; on failure, cancel the read context
}
```

**Why application-layer ping, not TCP keepalive**: OS TCP keepalive defaults to interval on the order of hours, and its half-open detection across sleep/wake is unreliable. An explicit WebSocket ping (`conn.Ping`) is controllable and predictable. Ping must run concurrently with `Run`'s read loop, because that loop is what reads the returning pong.

**Why cancel the context, not `Close`**: a dead peer never completes the WebSocket close handshake, so a graceful `Close` cannot unblock `Read`. Canceling the read context closes the underlying connection, forcing `Read` to return so `Run` exits and `runWithReconnect` re-establishes the tunnel.

**Parameter choice**: `pingInterval = 10s`, `pingTimeout = 10s`. Worst-case detection latency is roughly their sum (~20s). Both are `Multiplexer` fields so tests can inject small values.

**Why `pingTimeout` is not shrunk to speed up detection**: the library holds its frame lock for a whole message payload, so an in-flight write blocks the ping until that write completes. `pingTimeout` is therefore also a cap on how long a single message may take to transmit — halving it to halve detection latency would equally halve the largest response the relay can push over a slow uplink, turning a large asset into a reconnect loop. Two smaller reasons point the same way: even a loopback pong occasionally takes ~100ms (delayed ACK), and over a real link a tight bound turns ordinary latency spikes into false disconnects. Lowering it safely would first require chunking large messages so a ping can interleave.

**Why writes carry no deadline**: for the same reason. A deadline on `send` would abort a legitimately slow large response — and take the connection down with it, since the library closes the connection when a write context expires. A genuinely stuck write is already bounded: the keepalive ping cannot get out either, so it tears the connection down and the write returns.

### Recovering, End to End

Reconnecting the tunnel is only half the job. What the user cares about is that the page they had open keeps working afterwards, and that requires both ends to let go of the dead connection and rebuild on the new one.

**Server side — the EOF has to reach the top.** The cloud assigns fresh connection IDs after a reconnect, so every `VirtualStream` of a dead tunnel is unusable; `Run` closes them all on return. That matters less for the streams themselves than for what closing them unwinds: `ReadObject` returns `io.EOF` → jsonrpc2's read loop closes the connection → `DisconnectNotify` fires → `HandleStream` runs `state.cleanup`, which unsubscribes every watcher the connection held and releases its worktree reference. Break the chain anywhere and every outage strands a jsonrpc2 connection blocked forever on a channel nobody can send to again, and leaks with it a worktree — plus the processes and watchers it owns — which is then only reclaimed when the process exits. A flaky network accumulates them. `ws.TestHandleStream_ReleasesResourcesWhenRelayTunnelDies` pins it by killing a real multiplexer and asserting the worktree's subscriber count returns to its baseline across several outages; without `closeAllStreams` it hangs.

**Why the relay forces handlers to wait for connection state.** `jsonrpc2.NewConn` starts its read loop before it returns, so a request can be dispatched before `HandleStream` has finished wiring the connection state. On a local WebSocket that race is theoretical; over the relay it is the normal case, because the cloud's first message is usually already buffered in the `VirtualStream` by the time `HandleStream` is called. The `state.ready` gate that closes the window is a ws-layer mechanism — see [Handlers Wait for Connection State](websocket-rpc.md#handlers-wait-for-connection-state).

**Client side — the browser must outlast the server's blind spot.** The server needs up to ~20s (`pingInterval + pingTimeout`) to even notice the tunnel is dead, then reconnects on its own backoff. A browser that retries a fixed handful of times a few seconds apart is therefore *guaranteed* to have given up before the tunnel is back, landing on a terminal error state that only a manual refresh clears — the tunnel recovers and the page stays dead. So `wsStore` retries indefinitely with exponential backoff (1s doubling to a 30s cap): a brief blip recovers in about a second, and a multi-hour outage costs two attempts a minute. Once the socket is back and `auth` succeeds, `useSubscription` resubscribes on the `connected` transition, so data flows again without a reload.

Staying in `reconnecting` is also what makes the existing "keep the data during a reconnect" behaviour pay off: `useSubscription` deliberately skips `onReset` for that status, which the old fixed budget undid the moment it flipped to `error` and wiped everything anyway.

**A silent `auth` is the relay's other signature failure.** The cloud can accept the browser's WebSocket while the tunnel behind it is dead — the browser reaches the cloud, but nothing reaches the PC — so `auth` goes out and no answer ever comes. Read as bad credentials, that ends in the terminal `auth_failed` state, which for a purely transient fault also logs the user out and discards their selected worktree. The client therefore separates a real rejection from a timeout before treating anything as an auth failure; see [Auto-Reconnect](websocket-rpc.md#auto-reconnect) for how.

**A socket that has been replaced must stay out of the way.** Both of the above open a new socket while an old one may still be closing, and a close handshake against a dead relay takes seconds — far longer than the 100ms `reconnectWebSocket()` waits before opening the replacement. A stale `onclose` that still cleared the shared state would tear down the connection that replaced it, so both clients ignore a close from a socket that is no longer the current one; `web-cluster` additionally drops any in-flight socket when a connect supersedes it, because its "Cluster unreachable" screen keeps a Retry button live for the whole reconnect. See [Auto-Reconnect](websocket-rpc.md#auto-reconnect).

`web-cluster` carries the same client-side behaviours for the same reasons; its client is a smaller copy of the same design.

## Multiplexing

A single WebSocket connection carries multiple client connections. Each mobile connection corresponds to a `VirtualStream` on the PC side.

### Signal Format

```go
// multiplexer.go:41-47
type Envelope struct {
    ConnectionID string          `json:"connection_id"`
    Type         EnvelopeType    `json:"type,omitempty"`
    Payload      json.RawMessage `json:"payload,omitempty"`
    HTTPRequest  *HTTPRequest    `json:"http_request,omitempty"`
    HTTPResponse *HTTPResponse   `json:"http_response,omitempty"`
}
```

`ConnectionID` is the key for routing: the cloud assigns a unique ID to each mobile connection, and the PC side routes messages to the corresponding VirtualStream based on the ID.

Four signal types:

| Type | Direction | Purpose |
|------|-----------|---------|
| `message` | Cloud → PC | WebSocket message forwarding |
| `disconnected` | Cloud → PC | Client disconnection notification |
| `http_request` | Cloud → PC | HTTP request forwarding |
| `http_response` | PC → Cloud | HTTP response return |

### Message Routing

```go
// multiplexer.go:74 — Run (keepAlive goroutine started at entry)
func (m *Multiplexer) Run(ctx context.Context) error {
    for {
        _, data, err := m.conn.Read(ctx)
        var env Envelope
        json.Unmarshal(data, &env)

        switch env.Type {
        case EnvelopeTypeMessage:
            stream, isNew := m.getOrCreateStream(env.ConnectionID)
            if isNew {
                m.newStreamCh <- stream  // Notify upper layer
            }
            stream.deliver(env.Payload)

        case EnvelopeTypeDisconnected:
            m.closeStream(env.ConnectionID)

        case EnvelopeTypeHTTPRequest:
            go m.handleHTTPRequest(ctx, env.ConnectionID, env.HTTPRequest)
        }
    }
}
```

- **Message**: Delivered to the VirtualStream's buffer, read by the upper-layer JSON-RPC handler
- **HTTP Request**: Handled asynchronously to avoid blocking the main loop
- **Disconnected**: Closes the corresponding VirtualStream

### VirtualStream

VirtualStream implements the `jsonrpc2.ObjectStream` interface, making Relay connections transparent to the upper layer compared to direct WebSocket connections:

```go
// multiplexer.go:257-284
type VirtualStream struct {
    connectionID string
    incoming     chan json.RawMessage  // buffer size: 16
    multiplexer  *Multiplexer
}

func (s *VirtualStream) ReadObject(v interface{}) error {
    msg, ok := <-s.incoming
    if !ok {
        return io.EOF
    }
    return json.Unmarshal(msg, v)
}

func (s *VirtualStream) WriteObject(v interface{}) error {
    return s.multiplexer.send(s.connectionID, v)
}
```

**Buffer Design**: Capacity of 16 is a tradeoff. Too small would frequently block the sender, too large wastes memory. When the buffer is full, `deliver()` returns false, triggering stream closure—this is a backpressure signal indicating the consumer cannot keep up with the producer.

### Write Lock Protection

```go
// multiplexer.go:230-255
func (m *Multiplexer) send(connectionID string, payload interface{}) error {
    // ...
    m.writeMu.Lock()
    defer m.writeMu.Unlock()
    return m.conn.Write(context.Background(), websocket.MessageText, envData)
}
```

Multiple VirtualStreams may write concurrently. `writeMu` ensures WebSocket write operations are atomic, preventing message interleaving at the protocol level.

The `context.Background()` is deliberate, not an oversight — see [why writes carry no deadline](#liveness-detection-keepalive). Note also that `writeMu` is held for the whole write, so one stream's slow response delays every other stream on the tunnel. That delay has the same ceiling as everything else here: past `pingTimeout` the keepalive ping cannot get out either, and the tunnel is torn down.

## HTTP Proxy

HTTP requests from mobile devices accessing development servers are also forwarded through Relay.

### Routing Rules

```go
// http.go:109-111
func (h *HTTPHandler) isBackendPath(path string) bool {
    return strings.HasPrefix(path, "/api") || path == "/ws" || path == "/health"
}
```

| Path | Target |
|------|--------|
| `/api/*` | Backend (:8080) |
| `/ws` | Backend (:8080) |
| `/health` | Backend (:8080) |
| `/*` (others) | Frontend (:5173) |

This reflects Pockode's architecture: Go backend handles API and WebSocket, Vite frontend handles UI.

`/api/mcp/*` is the one exception: `Handle` rejects it with 404 before any port selection, keeping the MCP local API loopback-only. The check has to come first because in the default single-port setup `frontendPort == backendPort`, so routing alone would not keep it out of reach.

### Body Encoding

```go
// http.go:61-68
if req.Body != "" {
    decoded, err := base64.StdEncoding.DecodeString(req.Body)
    bodyReader = bytes.NewReader(decoded)
}

// http.go:102-106
return &HTTPResponse{
    Body: base64.StdEncoding.EncodeToString(body),
}
```

HTTP body uses base64 encoding. JSON only supports text, but HTTP body can be binary (images, fonts, compressed data). Base64 ensures binary safety.

### Skipping Hop-by-Hop Headers

```go
// http.go:115-122
func isHopByHopHeader(header string) bool {
    switch http.CanonicalHeaderKey(header) {
    case "Connection", "Keep-Alive", "Proxy-Authenticate",
         "Proxy-Authorization", "Te", "Trailer",
         "Transfer-Encoding", "Upgrade":
        return true
    }
    return false
}
```

These headers are only valid for the current connection and should not be forwarded by proxies. For example, `Transfer-Encoding: chunked` has different meanings between the original response and the proxied response.

## Security Mechanisms

### Token Protection

```go
// store.go:45-56
func (s *Store) Save(cfg *StoredConfig) error {
    // ...
    return os.WriteFile(s.path, data, 0600)  // Owner-only access
}
```

The Relay token is the credential for accessing the user's PC and must be strictly protected. File permission 0600 ensures only the file owner can read and write.

### Version Check

```go
// client.go:52-54
if resp.StatusCode == http.StatusForbidden {
    return nil, ErrUpgradeRequired
}
```

The cloud can reject outdated client versions. This allows forced upgrades to fix security vulnerabilities or protocol incompatibilities.

### Token Invalidation Handling

```go
// relay.go:88-94
if errors.Is(err, ErrInvalidToken) {
    m.log.Warn("stored token is invalid, re-registering")
    m.store.Delete()
    return m.Start(ctx)  // Recursive retry with fresh registration
}
```

Tokens may become invalid for various reasons (cloud reset, expiration, manual revocation). Upon detecting invalidation, automatically re-register—transparent to the user.

## Integration with Upper Layers

### New Connection Notification

```go
// relay.go:248-250
func (m *Manager) NewStreams() <-chan *VirtualStream {
    return m.newStreamCh
}
```

The upper layer receives new VirtualStreams through this channel, then handles them just like direct WebSocket connections:

```go
// server/main.go (illustrative)
for stream := range relayManager.NewStreams() {
    go wsHandler.HandleStream(ctx, stream, stream.ConnectionID())
}
```

**Adapter Pattern**: VirtualStream implements the `jsonrpc2.ObjectStream` interface, making Relay connections transparent to the business layer. The same RPC handler handles both direct and Relay connections.

## Code Paths

| Component | Path | Responsibility |
|-----------|------|----------------|
| Manager | `server/relay/relay.go` | Lifecycle management, authentication, reconnection |
| Client | `server/relay/client.go` | Communication with cloud HTTP API |
| Multiplexer | `server/relay/multiplexer.go` | Signal routing, stream management |
| HTTPHandler | `server/relay/http.go` | HTTP request proxying |
| Store | `server/relay/store.go` | Configuration persistence |

Outage and recovery behaviour is pinned by `server/relay/reconnect_test.go` (stalled
connect, reconnect after an outage, stream teardown) and `server/ws/rpc_relay_test.go`
(resource release and resubscription across a real tunnel). The former's stub cloud
can be switched into a "stalled" state — accepting connections but never answering —
because that, not a refused connection, is the shape of failure the connect-path
timeouts exist for; a stub that merely refuses passes even without them.
