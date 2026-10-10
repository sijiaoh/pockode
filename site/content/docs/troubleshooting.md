---
title: Troubleshooting
description: What Pockode's errors mean and how to get past them, from startup to a stopped story.
weight: 70
---

```sh
pockode -password YOUR_PASSWORD -log-level debug
```

The log is in `.pockode/server.log` in your project. Start with `-log-level debug` for more detail.

## `a password is required`

Pass `-password`, or set the `POCKODE_PASSWORD` environment variable; there is no default. [Security](/security/#authentication) says when to prefer the variable and how strong to make the password.

## No AI CLI found

The banner's **Agents** line shows `(not found)` for a CLI Pockode cannot find, and warns when neither is there. Install Claude Code or Codex from **Settings → AI CLIs**, or yourself. The app runs `npm install --global` as the user running `pockode`, without `sudo`, so it needs `npm` on the `PATH` `pockode` was started with; if it is missing, install Node.js and restart `pockode`. Pockode looks for the CLI each time a session starts, so one installed into a directory already on its `PATH` works at once; if the installer added a new `PATH` entry, restart `pockode` from a new terminal so it inherits it (the banner's **Agents** line is only refreshed by a restart). On Windows, install it on the Windows side, not inside WSL.

## Installing a CLI from the app fails

The card says why and what to do; **Details** has npm's output. The two that need a change on the machine:

- **npm can't write its global folder** — it belongs to another user, usually root. Make your user its owner, or set a prefix in your home directory (`npm config set prefix ~/.npm-global`) and add its `bin` to the `PATH`, then restart `pockode` and try again.
- **Installed, but Pockode can't find it** — the folder npm puts commands in (`npm prefix --global`, plus `/bin` on macOS and Linux) is not on the `PATH` `pockode` was started with. Add it and restart `pockode`.

An install is refused while the same CLI is being installed, updated or signed in; try again once that ends. npm gets 10 minutes.

## A session fails to sign in

Open **Settings → AI CLIs** and sign the CLI in from there, or run `claude` or `codex` once in a terminal on the machine.

## The port is not 9870

Another program had it, so Pockode took the next free port. The banner's **Local** line shows which. Choose one with `-port`.

## Pockode exits at startup with a relay error

With the relay on, Pockode contacts the relay at startup — to register on the first run, to refresh its address after that — and exits if it cannot, printing the reason, such as `register: request failed: …` or `refresh: unexpected status: …`. Check the machine's internet connection and any firewall or proxy in the way. To work on your own network only, start with `-relay=false`.

If it says `client version too old, please upgrade Pockode`, the relay no longer accepts this version: run the install command again.

## The phone cannot reach the machine without the relay

Open `http://<your machine's IP>:9870` from a phone on the same network, and allow that port through the machine's firewall. Over plain HTTP the browser withholds the clipboard, so copy buttons do not work; see [Security](/security/) for what plain HTTP exposes.

## Forgot the password

Stop `pockode` and start it with a new one, then log in again on each device with it.

## A story stopped by itself

An agent that ends its turn without finishing its step or asking you anything is reminded to carry on; after a few reminders in a row Pockode stops the work and hands it back to you. Read its comments and session, then **Restart** it. See [Stories and agent roles](/docs/stories/#what-the-status-means).

## The worktree setup script did not run (Windows)

Install [Git for Windows](https://git-scm.com/download/win); the setup script needs its `bash`. The app says so in **Settings → Worktree → Setup Hook** until it is fixed.

## A preview shows 502 or a password page

See [Port Preview](/docs/port-preview/#when-it-goes-wrong).

## Still stuck

Search or open an [issue](https://github.com/sijiaoh/pockode/issues), with the version from `pockode -version` and the relevant part of `server.log`. Report security problems privately, as [SECURITY.md](https://github.com/sijiaoh/pockode/blob/main/SECURITY.md) describes.
