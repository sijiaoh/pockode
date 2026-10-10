# Port Preview

Open any port on the PC from a phone through the relay — a Vite or Next dev server on 5173, a Storybook on 6006 — HMR included. No port forwarding, no dev server configuration.

This document is what a preview looks like from the outside: the address, logging in, what to expect, and what does not work. Why it is built this way — the rewrites, the cookie, the same-origin rule — is in [code/relay-system.md](code/relay-system.md#port-previews); the relay itself is in [relay.md](relay.md).

## The Address

```
https://<subdomain>-<port>.<relay server>
```

It is the app's own relay address with `-<port>` added to the first label: the app at `https://abc123.cloud.pockode.com` previews port 5173 at `https://abc123-5173.cloud.pockode.com`. A client learns the app's address from `remote_url` in the `auth` reply ([websocket-rpc.md](code/websocket-rpc.md)), which is empty when the relay is disabled — and with it, previews.

The port is written plainly: `-5173`, not `-05173`. Any port from 1 to 65535 can be previewed; there is no allowlist, since the tunnel and everything listening on the machine are the user's own. Only `localhost:<port>` is ever dialed, so a preview cannot reach another machine on the PC's network.

## Opening a Preview from the App

The app's header has a preview button beside Settings, shown only when `remote_url` is set. It asks for a port and opens its preview in a new tab, already logged in (see [Logging In](#logging-in)). Ports opened before are listed under Recent — the five most recent, kept in the browser's local storage and shared by every worktree, since ports belong to the machine. Recent entries are plain links, so they open even when the browser blocks the tab the Open button tries to create; when it does, the sheet says so and the port is already in the list.

Which opens arrive logged in:

| Opened by | Logged in |
|---|---|
| The Open button | Yes |
| A plain click (or tap) on a Recent entry | Yes |
| A middle click, a click with a modifier key, or a long-press / "Open in new tab" on a Recent entry | No — the link's own navigation |
| A plain click on a Recent entry while the browser blocks the app's tab | No — the link's own navigation |
| A copied or shared preview address | No |

The others show the password page, and only on a port this browser has not logged into yet.

The tab is opened blank, synchronously within the click, and sent on once the app has its ticket: a browser lets a page open a tab only during the user's click, and waiting for the server's answer first would get the tab blocked. The blank page normally lasts one round trip to the server, and at worst the app's 30-second request timeout. The app cuts the tab's link back to itself (`window.opener`) before sending it anywhere.

The ticket goes only into that tab's navigation — never into a link's address, which can be copied, shared or long-pressed. That is also why the link's own navigations above stay plain: a preview address someone copies out of the app is not a login. If the app cannot get a ticket — it is disconnected, or the request fails or times out — the tab opens the plain preview address and its password page instead; the sheet has closed by then, so the password page is the only sign of it.

## Logging In

A preview is guarded by the app's own password, not by anything of the previewed server's.

1. The first page load on a preview host shows a small Pockode login page (HTTP 401) instead of the app.
2. Entering the app's password reloads the same page, now forwarded to the local server.
3. The browser keeps the login in a cookie for that one host. Each port is a separate host, so each is logged into once.

A preview the app opens skips the password: the app asks the server for a one-time ticket and sends the new tab to `https://<subdomain>-<port>.<relay server>/__pockode/preview/login?ticket=<ticket>`; the preview host exchanges the ticket for its login cookie and redirects to `/`, so the ticket does not stay in the address bar or the history. A ticket works once, within about 60 seconds, and is forgotten when the server restarts. One that is spent, expired or missing lands on the password page instead, and a tab already logged in on that host keeps its login. Which ways of opening a preview carry a ticket is in [Opening a Preview from the App](#opening-a-preview-from-the-app).

A preview login is an ordinary app session: it expires after 30 days unused, ends when the password changes, and counts toward the session cap — logging into many ports can evict the least recently used session, the app's own included. See [Authentication](code/authentication.md#sessions-what-the-browser-keeps).

## What to Expect

- **Dev servers need no configuration.** The local server sees the request as if the browser had opened `localhost:<port>` itself, so Vite's `allowedHosts` and Next's `allowedDevOrigins` do not have to list the preview host. A redirect to `localhost:<port>` — that exact host, not `127.0.0.1` — lands back on the preview.
- **HMR works.** The dev server's WebSocket is relayed like any other request.
- **The app's own cookies pass through**; Pockode's preview cookie does not, so the previewed server never sees the session.
- **The local server does not see the public URL**: `X-Forwarded-Host` and `-Proto` are not sent, since frameworks that read them (Next's Server Actions, Rails' host check) would refuse a request whose `Host` says `localhost`. The client address is still in `X-Forwarded-For`.
- **`/__pockode/` belongs to Pockode** on every preview host and never reaches the previewed server.
- **`/api/mcp/*` is never forwarded**, on any port: it is Pockode's local-only MCP API, and the port being previewed may be another Pockode on the machine, such as a cluster node. An app of your own with routes under that path cannot have them previewed.

## Limitations

- **Previews cannot call or frame each other.** `-5173` and `-8080` are different origins. A frontend that fetches its API on another port directly is refused (403); route it through the dev server's own proxy instead (Vite's `server.proxy`), which never leaves the machine and is unaffected.
- **No page can embed a preview in a frame**, the Pockode app included. A preview framing itself (a Storybook canvas) is fine.
- **Links into a preview work; requests from other pages do not.** Every user's app and previews share the relay domain, so any request a preview did not make itself — fetches, scripts, images, form posts, WebSockets — is refused, except for plain link navigation.
- **A slow first response is a 502.** The local server has 30 s to start answering. A dev server compiling a route on first request can exceed it; reloading usually succeeds.

## When Something Goes Wrong

| Response | Means |
|---|---|
| 401 with a login page | Not logged in on this host, or the session expired — enter the app's password |
| 401 `Pockode preview: not logged in` | A non-page request without a session; load the page itself to log in |
| 403 `Pockode preview: cross-origin request refused` | The request came from another origin — see [Limitations](#limitations) |
| 404 | A `/__pockode/` path other than the login endpoint, or any `/api/mcp/*` path |
| Password page on a preview the app opened logged in | The app could not get a ticket (it was disconnected, or the request failed), or the ticket was spent, expired (about 60 s) or issued before a server restart — enter the app's password |
| 502 `Pockode preview: nothing is listening on localhost:<port>` | Start the server on the PC, then reload |
| 502 `Pockode preview: localhost:<port> did not answer: …` | The server is there but failed or took over 30 s to answer |

## What the Relay Server Must Do

For anyone running the other side of the tunnel: route `<subdomain>-<port>.<relay server>` to the tunnel registered as `<subdomain>`, with `Host` passed through unchanged. The PC reads the port from `Host` and does all authentication and forwarding itself. Because a preview host is told apart from an app host by its `-<digits>` suffix alone, the relay server must not assign a subdomain ending in `-` followed by digits: `abc-80` would also read as port 80 of `abc`.
