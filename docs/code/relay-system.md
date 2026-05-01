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

### Reconnection Mechanism

```go
// relay.go:114-138
func (m *Manager) runWithReconnect(ctx context.Context, cfg *StoredConfig) {
    backoff := time.Second

    for ctx.Err() == nil {
        start := time.Now()
        err := m.connectAndRun(ctx, cfg)

        // Skip wait if connection was stable (> 1 minute)
        if time.Since(start) > time.Minute {
            backoff = time.Second
            continue
        }

        time.Sleep(backoff)
        backoff = min(backoff*2, 10*time.Second)
    }
}
```

**Exponential Backoff**: After connection failure, wait 1s, 2s, 4s... up to 10s max. However, if the connection was stable for more than 1 minute before disconnecting, treat it as network jitter—retry immediately and reset the backoff time. This distinguishes between "network unreachable" and "temporary interruption" scenarios.

### WebSocket Authentication

After the connection is established, the PC needs to prove its identity to the cloud:

```go
// relay.go:179-200
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

Uses JSON-RPC 2.0 format, consistent with other Pockode communication protocols.

## Multiplexing

A single WebSocket connection carries multiple client connections. Each mobile connection corresponds to a `VirtualStream` on the PC side.

### Signal Format

```go
// multiplexer.go:15-30
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
// multiplexer.go:52-86
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
// multiplexer.go:178-215
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
// multiplexer.go:155-176
func (m *Multiplexer) send(connectionID string, payload interface{}) error {
    // ...
    m.writeMu.Lock()
    defer m.writeMu.Unlock()
    return m.conn.Write(context.Background(), websocket.MessageText, envData)
}
```

Multiple VirtualStreams may write concurrently. `writeMu` ensures WebSocket write operations are atomic, preventing message interleaving at the protocol level.

## HTTP Proxy

HTTP requests from mobile devices accessing development servers are also forwarded through Relay.

### Routing Rules

```go
// http.go:102-104
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

### Body Encoding

```go
// http.go:54-61
if req.Body != "" {
    decoded, err := base64.StdEncoding.DecodeString(req.Body)
    bodyReader = bytes.NewReader(decoded)
}

// http.go:95-99
return &HTTPResponse{
    Body: base64.StdEncoding.EncodeToString(body),
}
```

HTTP body uses base64 encoding. JSON only supports text, but HTTP body can be binary (images, fonts, compressed data). Base64 ensures binary safety.

### Skipping Hop-by-Hop Headers

```go
// http.go:108-115
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
// relay.go:76-82
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
// relay.go:216-218
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
