# WebSocket RPC Design

All communication uses WebSocket JSON-RPC 2.0. REST APIs are not used.

## Background

Pockode communicates with user PCs behind NAT via a Relay:

```
Mobile App ──WebSocket──▶ Relay Server ──WebSocket──▶ User PC (behind NAT)
```

NAT traversal requires a persistent connection initiated from the PC side, making WebSocket a natural choice.

## Method Naming Convention

Method names use the `namespace.method` format with namespaces.

| Namespace | Scope | Handler |
|-----------|-------|---------|
| `auth` | — | `ws/rpc.go` |
| `chat.*` | worktree | `ws/rpc_chat.go` |
| `session.*` | worktree | `ws/rpc_session.go` |
| `file.*` | worktree | `ws/rpc_file.go` |
| `git.*` | worktree | `ws/rpc_git.go` |
| `fs.*` | worktree | `ws/rpc_fs.go` |
| `worktree.*` | app | `ws/rpc_worktree.go` |
| `command.*` | app | `ws/rpc_command.go` |
| `settings.*` | app | `ws/rpc_settings.go` |
| `work.*` | app | `ws/rpc_work.go` |
| `agent_role.*` | app | `ws/rpc_agent_role.go` |

- **worktree scope**: Methods bound to the current worktree
- **app scope**: Methods independent of any worktree

Subscriptions use the `*.subscribe` / `*.unsubscribe` pattern. Server notifications use the `*.changed` pattern.

## Compression

The `/ws` handler negotiates permessage-deflate with the browser in
`CompressionContextTakeover` mode (`ws/rpc.go`). Browsers offer the extension by
default, so there is nothing to do on the client — the `WebSocket` constructor
has no way to turn it off either.

This is the only compression the phone's own link gets. The relay tunnel
compresses as well, but that hop ends at the cloud, and the edge proxy's own
compression stops at the 101. Everything expensive rides here: chat events,
file contents, git diffs.

Measured against the real handler, a real repository and a recorded session
(710 agent events), counting bytes on the TCP socket, server to client:

| Phase | off | no context takeover | **context takeover** |
|---|---|---|---|
| handshake | 166 | 268 | 212 |
| `auth` | 121 | 123 | 123 |
| app boot (worktree / command / settings / session lists) | 2,885 | 1,451 | 1,310 |
| open a session (`chat.messages.subscribe` history) | 870,964 | 286,407 | 286,120 |
| one conversation (710 streamed `chat.*` notifications) | 915,805 | 506,555 | 370,421 |
| `git.status` | 1,716 | 456 | 470 |
| one file's git diff | 39,045 | 9,538 | 9,581 |
| read one file | 48,919 | 26,055 | 25,711 |
| **total** | **1,879,621** | **830,853 (0.442x)** | **693,948 (0.369x)** |

The client-to-server direction is about 1.1 KB for the whole run, so compressing
it buys nothing either way.

Those figures were taken on `coder/websocket` v1.8.14. From v1.8.15 every column
loses a frame header or two per message, which moves them by well under a
percent and does not reorder them.

The mode matters, but not where one would guess. Opening a session is a single
870 KB message and both modes land on 0.329x — repetition *inside* one message
is available to per-message compression too. The difference is entirely in the
streamed phase: hundreds of few-hundred-byte notifications that resemble each
other (same JSON skeleton, same tool names, paths from the same repository).
Only a shared window sees that: 0.404x against 0.553x.

The threshold is left at the library default of 128 bytes. Dropping it to 1 —
compressing even the shortest notification — moves the streamed phase from
0.2965x to 0.2956x. Raising it is a real regression: streamed events have a
median size of 444 bytes, so a threshold of 512 sends most of them verbatim and
takes that phase from 0.2965x back to 0.379x. `rpc_compression_test.go` pins
this with a 235-byte notification.

Framing is unaffected: a message goes out as one frame whether or not it is
compressed. That needs `coder/websocket` **v1.8.15 or later**, and is the reason
the dependency is pinned no lower. Before it, the compressed path had no buffer
between the deflate writer and the framer, so a frame left every time
`compress/flate` flushed its 240-byte bit writer — an 8 MiB `file.get` response
measured at 3,463 frames of source text, or **52,583** of the base64 a binary
file turns into.

What that cost depends entirely on the receiver, and it was measured rather than
reasoned about. Chromium took the 52,583-fragment message in 4.0 s and showed no
ceiling at all, so browsers — the only real client of `/ws` — were never hurt.
Node's `ws` caps fragments per message at 16,384 and gave up on the same message
with "Too many message fragments" after 230 s, having crawled there at 8 KiB/s.
The upgrade is kept because it is free, saves the per-frame header, and roughly
halves the tunnel's bulk transfer time; not because users were losing anything.
`rpc_compression_test.go` pins the single frame. Measurements, including the
WebKit gap that could not be closed, are in the cloud's relay design document.

Costs:

- **Memory**: a `flate.Writer` on the send side plus a 32 KiB sliding window on
  the receive side, allocated on the first compressed message in each direction
  and held until close. Measured against a browser-shaped client, heap growth is
  linear over 16 / 64 connections at about **1,261 KiB** each (24 KiB with
  compression off). Concurrency is bounded: a relayed mobile WebSocket holds one
  yamux stream and the relay caps a tunnel at 32, so about 40 MB at saturation —
  on a machine that is already running agent subprocesses an order of magnitude
  larger than that. Opening and closing 64 connections leaves 3 KB behind, so the
  state does not accumulate.
- **CPU**: compressing that whole conversation (898 KB over 710 messages) took
  0.17–0.28 s. Decompression happens in the browser.
- **On the phone**: the library's `CompressionMode` is symmetric, so the browser
  keeps deflate state for this connection too. RFC 7692 would allow answering
  with `client_no_context_takeover` alone, but coder/websocket ties the two
  directions together. The client-to-server direction is about 1.1 KB for a whole
  session, so that dictionary is nearly unused; the cost was not measured here.

Every hop was measured with the exact offer a browser sends
(`permessage-deflate; client_max_window_bits`): straight to this handler, through
the relay tunnel, and through the edge proxy configured the way production is.
The header survives all three unchanged. This matters because a server that will
not accept one of the offer's parameters answers with no extension at all and
nothing downstream looks wrong — traffic is simply never compressed again, and
the handshake response is the only place that is visible. The test covers the
four parameter forms real clients send.

A browser that does not offer the extension gets a working, uncompressed
connection; `rpc_compression_test.go` pins that. coder/websocket documents
Safari as not implementing permessage-deflate; asking the engine itself says
otherwise — WebKit and Chromium both offer `permessage-deflate;
client_max_window_bits` and both decompress correctly, so the figures above hold
for iOS as well. That probe lives in the cloud's end-to-end suite.

The relay hop is unaffected: already-deflated frames reach it incompressible, so
the tunnel's own deflate becomes a near no-op for `/ws` traffic (measured 414 KB
to 412 KB for the same conversation) while the phone hop drops 2.45x. Tunnel
compression stays on because HTTP responses still travel through it. Figures for
the whole chain live in the cloud's relay design document.

## Libraries

| Layer | Library |
|-------|---------|
| Go | [sourcegraph/jsonrpc2](https://github.com/sourcegraph/jsonrpc2) |
| TypeScript | [json-rpc-2.0](https://github.com/shogowada/json-rpc-2.0) |

## References

- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [Project API Reference](projects/api.md) — Detailed MCP tools and WebSocket RPC method specifications
