---
title: Command-line flags
description: Every flag the pockode server and pockode cluster accept, with their defaults.
weight: 60
---

```sh
pockode -h
pockode cluster -h
```

Flags use a single dash: `-port 9000` or `-port=9000`. Turn a boolean off with `=false`, as in `-relay=false`. Durations are written like `90s`, `30m` or `2h`.

## Server

| Flag | Default | What it does |
|---|---|---|
| `-password` | — | The password for the app. Required, unless the `POCKODE_PASSWORD` environment variable is set; [Security](/security/#authentication) says when to prefer it |
| `-work` | current directory | The project directory Pockode works in |
| `-port` | `9870` | Port to listen on. If it is taken, the next free port is used; the banner shows which |
| `-relay` | `true` | Connect to the relay so the phone can reach the machine from anywhere. `-relay=false` keeps the app on your own network and turns off Port Preview |
| `-data` | `<work>/.pockode` | Where sessions, settings, work items and logs are kept |
| `-log-level` | `info` | `debug`, `info`, `warn` or `error` |
| `-log-format` | `text` | `text` or `json` |
| `-log-file` | `<data>/server.log` | Where the log is written |
| `-idle-timeout` | `5m` | How long an idle session's CLI process is kept for the next message. `0` keeps it |
| `-turn-timeout` | `0` (no limit) | How long one agent turn may run before it is interrupted |
| `-answer-timeout` | `1h` | How long a permission request waits for your decision before it is withdrawn. `0` for no limit |
| `-background-timeout` | `24h` | How long a turn waiting on background work waits before it is ended. `0` for no limit |
| `-version` | — | Print the version and exit |

For running on a server or in a container:

| Flag | Default | What it does |
|---|---|---|
| `-git` | `false` | Clone a repository into `-work` at startup, if it has no `.git` yet. Needs the four flags below |
| `-git-repo-url` | — | The repository to clone |
| `-git-repo-token` | — | The access token used to fetch and push |
| `-git-user-name` | — | The commit author name |
| `-git-user-email` | — | The commit author email |
| `-cloud-url` | `https://cloud.pockode.com` | The relay service to connect to |
| `-relay-frontend-port` | the server's port | The local port the relay forwards app requests to |
| `-dev` | `false` | Development mode, for working on Pockode itself |

## Cluster mode

| Flag | Default | What it does |
|---|---|---|
| `-password` | — | The password for the cluster page; or set `POCKODE_PASSWORD` |
| `-port` | `9871` | Port to listen on |
| `-data` | `~/.pockode-cluster` | Where the node list and logins are kept |
| `-relay` | `true` | Connect to the relay; `-relay=false` keeps the page on your own network |
| `-cloud-url` | `https://cloud.pockode.com` | The relay service to connect to |
| `-relay-frontend-port` | the server's port | The local port the relay forwards page requests to |
| `-dev` | `false` | Development mode, for working on Pockode itself |

See [Cluster mode](/docs/cluster/).
