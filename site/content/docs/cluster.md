---
title: Cluster mode
description: Manage several projects on one machine from a single page, starting and stopping each project's Pockode on demand.
weight: 50
---

```sh
pockode cluster -password YOUR_PASSWORD
```

Cluster mode is one page that lists your projects — **nodes** — and starts or stops a Pockode for each. Run it once per machine, from any directory. It listens on port 9871, keeps its list in `~/.pockode-cluster`, and prints a QR code like the normal server.

## Add a project

Tap **Add node** and enter the project's path (`~/projects/my-app`); the name is optional. A path that does not exist yet is offered for creation.

## Start, open, stop

- **Start** asks for the password that project's Pockode will use. It is separate from the cluster's password so that one leaked node does not open the cluster; tap **Generate** for a random one and **Copy** it. It is asked every time and never stored.
- **Open** goes to the running project's own app, through the relay. Log in there with the node password.
- **Stop**, **Edit** and **Delete** are in the card's menu. Stopping ends the AI sessions running in that project. Deleting a node only removes it from the list; the project directory is untouched.

Nodes keep running when you close the terminal the cluster was started from, or stop the cluster itself. Stop them from the page.

A node whose process died without cleaning up shows under **Needs attention**. **Start** it again, or **Clean up** to clear the leftover state.

## Things the nodes share

Every node runs as your user, so installing Claude Code or Codex, signing them in or out, or updating them, from any project's **Settings → AI CLIs** applies to all of them.

## Flags

`pockode cluster` takes `-password`, `-port`, `-data`, `-relay`, `-relay-frontend-port`, `-cloud-url` and `-dev`; see [Command-line flags](/docs/flags/#cluster-mode). The password can come from `POCKODE_PASSWORD` instead, as for the normal server.
