---
title: Security
description: What runs on your machine, what crosses the network, what the relay can see, and how to turn it off.
class: facts
---

Pockode gives your phone full read, write and AI-execution access to the machine it runs on. This page says how that access is guarded, and where it is not.

{{< architecture >}}

## What runs where

- **Everything that touches your code runs on your machine.** The Pockode server, your project, and the AI CLI (Claude Code or Codex) all run locally. The CLI uses your own sign-in, keeps it itself and talks to its provider directly; Pockode does not proxy those calls.
- **Your phone is a browser.** It shows the app and sends what you type; your project stays on the machine.
- **The cloud relay only connects the two.** It is on by default, so the phone can reach a machine behind NAT without port forwarding.

## Authentication

- **One password guards everything.** There are no accounts or roles: whoever has the password can do anything you can on that machine. The server refuses to start without one and never generates a default.
- **Generate it; do not reuse one.** Failed logins are not rate-limited or locked out, so the password's strength is the whole defence.
- **On a shared machine, keep it out of the process list.** A `-password` flag is visible to every user on the machine. Set `POCKODE_PASSWORD` in your environment instead, from a file only you can read — a shell profile, for example, once no one else can read it; the server removes it at startup, so the AI CLI and anything it runs do not inherit it. Typed inline, as `POCKODE_PASSWORD=… pockode`, it lands in your shell history just as the flag does.
- **The browser keeps a session, not the password.** Logging in exchanges the password for a random 256-bit session token, stored on the server only as a hash. A session expires after 30 days unused, and changing the password logs every device out.
- **Credentials on disk are private to you.** The data directory that holds them is restricted to your user (and, on Windows, SYSTEM and Administrators).

## The relay

- **TLS on both hops.** Phone to cloud is HTTPS; your machine to cloud is an outbound WSS connection. Nobody on either network can read the traffic.
- **What the relay can see.** It joins the two TLS connections, so the traffic is decrypted inside the relay — including the password when you log in through it. It does not inspect, log or store that content; it does record IP addresses, timestamps and connection data. See the [privacy policy](/privacy/).
- **What it can reach.** The app, and — through [Port Preview](/docs/port-preview/) — any port on your machine, each behind the same password. Pockode's local agent API is refused before it reaches any port.
- **Turn it off** with `-relay=false`. None of your traffic then passes through the cloud; the server still fetches a short announcement from the cloud at startup. The phone must then be on the same network as the machine.

{{< callout title="Direct access on your network is plain HTTP" >}}
Opened at `http://<your machine's IP>:9870` (the default port), **nothing is encrypted**: not the password, not the session, not your code or chat. Anyone who can watch that network can read all of it.

Use direct access only on a network you trust. Anywhere else, go through the relay.
{{< /callout >}}

Found a vulnerability? Report it privately through [GitHub's Security tab](https://github.com/sijiaoh/pockode/security).
