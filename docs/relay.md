# Relay

NAT traversal for mobile app → user's PC communication. The PC connects *outbound* to a cloud relay server, avoiding the need for port forwarding or a public IP. That single WebSocket carries a [yamux](https://github.com/hashicorp/yamux) session, so many mobile requests ride it as independent streams.

See [docs/code/relay-system.md](code/relay-system.md) for the design rationale. The same tunnel also serves [port previews](port-preview.md): any port on the PC, opened from the phone.

## Architecture

```
Mobile App
    │ HTTPS / WSS
    ▼
Relay Server (cloud)    ◀── outbound WSS (yamux) ──  User PC
    assigns subdomain                                     │
    authenticates relay_token                    http.Server.Serve(session)
    ReverseProxy, one stream per request                  │
                                                   local ReverseProxy
                                                     │         │         │
                                                 Backend   Frontend   Preview
                                                 (:8080)    (:5173)  (any port)
```

## Key Files

| Path | Role |
|------|------|
| `server/relay/relay.go` | Manager — register/refresh with cloud relay, dial, compression mode |
| `server/relay/reconnect.go` | Backoff loop that keeps the uplink up; never gives up |
| `server/relay/client.go` | HTTP client — `Register()` and `Refresh()` against cloud relay API |
| `server/relay/tunnel.go` | yamux session over the relay WebSocket, served as a `net.Listener` |
| `server/relay/proxy.go` | Reverse proxy from a stream to the local backend/frontend |
| `server/relay/preview.go` | Port preview: host recognition, same-origin gate, forwarding to `localhost:<port>` |
| `server/relay/preview_auth.go` | Port preview login page, login endpoint and session cookie |
| `server/relay/store.go` | Persist relay config (subdomain, token) to `relay.json` |

## How It Works

1. PC starts → `relay.Start()` registers with the cloud relay, receives subdomain + relay_token
2. PC opens an outbound WebSocket to `wss://<subdomain>.<relay_server>/relay` (NAT-friendly), carrying `Authorization: Bearer <relay_token>`. The cloud verifies the token before accepting the upgrade
3. Past the 101 the connection is nothing but a yamux session. The PC runs `http.Server.Serve(session)` — `*yamux.Session` is a `net.Listener`
4. Mobile sends an HTTPS request to `<subdomain>.relay.example.com`
5. The cloud's reverse proxy opens **one yamux stream** for that request and forwards it
6. The PC serves the stream as an ordinary HTTP connection and reverse-proxies it to the local backend (`/api`, `/ws`, `/health`) or frontend (everything else, `RELAY_FRONTEND_PORT` in dev). A request for a preview host `<subdomain>-<port>.<relay_server>` goes to `localhost:<port>` instead, once logged in
7. The response streams back over the same stream

The mobile app's JSON-RPC WebSocket is not a special case: it is an `Upgrade: websocket` request on its own stream, relayed as a plain 101 and terminated by the local `GET /ws` handler.

## Properties Worth Knowing

- **No message size limit.** Bodies stream, back-pressured by yamux's per-stream window. There is no envelope to overflow.
- **One large transfer cannot block the rest.** Streams are flow-controlled independently and their frames interleave.
- **`Host` is preserved end to end** for the app. `websocket.Accept` rejects an upgrade whose `Origin` disagrees with `Host`, so rewriting it would break every relayed WebSocket. Port previews are the deliberate exception: they rewrite `Host` to `localhost:<port>`, since dev servers refuse hosts they do not know.
- **A stream closing is the disconnect signal.** There is no `connection_id` and no disconnect message.
- **`/api/mcp/*` is never forwarded.** The local MCP API drives this machine's tools for an agent CLI running here; the proxy answers 404 for it before choosing a port, since in the default single-port setup routing alone would not keep it out of reach. That includes [port previews](port-preview.md), whose port may be another Pockode such as a cluster node.
- **The uplink reconnects forever.** Exponential backoff from 1 s to 10 s with ±20% jitter and no attempt cap. The ceiling is deliberately under the cloud's 30 s grace period, so a reconnect still reclaims the subdomain's entry and public requests waiting in the gap get served instead of a 503.
- **The tunnel is compressed.** permessage-deflate with context takeover, negotiated on the upgrade; both ends must ask for the same mode or the weaker offer wins. Interactive JSON-RPC traffic drops to ~0.4x and text responses to ~0.04x; random binary grows 0.06%, so no payload is treated specially. Relayed WebSocket traffic is the exception since `/ws` gained its own end-to-end compression — it arrives here already deflated, and the tunnel's own pass barely moves it.
