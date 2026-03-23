# Relay

NAT traversal for mobile app → user's PC communication. The PC connects *outbound* to a cloud relay server, avoiding the need for port forwarding or a public IP. The relay multiplexes multiple mobile client connections over a single WebSocket.

## Architecture

```
Mobile App
    │ HTTPS
    ▼
Relay Server (cloud)    ◀── outbound WebSocket ──  User PC
    assigns subdomain                                  │
    routes by token                              Multiplexer
                                                   │      │
                                             VirtualStream ...
                                                   │
                                              HTTPHandler
                                               │       │
                                          Backend    Frontend
                                         (:8080)    (:5173)
```

## Key Files

| Path | Role |
|------|------|
| `server/relay/relay.go` | Manager — register/refresh with cloud relay, manage config |
| `server/relay/client.go` | HTTP client — `Register()` and `Refresh()` against cloud relay API |
| `server/relay/multiplexer.go` | Demux envelopes by `connectionID` into virtual streams |
| `server/relay/http.go` | Proxy HTTP requests to local backend/frontend |
| `server/relay/store.go` | Persist relay config (subdomain, token) to `relay-config.json` |

## How It Works

1. PC starts → `relay.Start()` registers with cloud relay, receives subdomain + token
2. PC opens outbound WebSocket to relay (NAT-friendly)
3. Mobile sends HTTPS request to `<subdomain>.relay.example.com`
4. Relay wraps request in an **envelope** `{ connection_id, type, http_request }` and forwards over WebSocket
5. PC's **Multiplexer** routes envelope to correct **VirtualStream** by `connection_id`
6. **HTTPHandler** proxies to local backend (port 8080) or frontend (port 5173, dev mode via `RELAY_PORT`)
7. Response follows the reverse path back to mobile

## Envelope Types

- `http_request` / `http_response` — HTTP request/response forwarding
- `message` — WebSocket message forwarding
- `disconnected` — Client disconnection signal
