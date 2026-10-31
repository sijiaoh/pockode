# Restart UI

How a user sees which version of Pockode is running and which is installed on
the server, learns that the two differ, and restarts Pockode — or the cluster
manager — from a phone, so an upgrade done with the install script takes effect
without a terminal. What the restart costs and how that is said before the
press, what the screen does while the process is gone, and what every failure
says. How the process restarts itself is
[code/self-restart.md](code/self-restart.md).

Related: [cli-update-ui.md](cli-update-ui.md) for the Settings card this one is
built like and the conventions it set, [cluster-ui.md](cluster-ui.md) for the
cluster panel's three rules, [platforms.md](platforms.md) for how Pockode is
installed and upgraded, [lifecycle.md](lifecycle.md) for what a turn is,
[code/websocket-rpc.md](code/websocket-rpc.md) for the reconnect and its
banner.

## The rules

**Running is state, installed is state, and they are read separately.** The
running version is the one the server reports at `auth`, the same value both
frontends already compare against their own build. The installed version is
read from the executable on disk each time it is asked for — by running it, not
by trusting a file name — so it is never cached past the read that produced it.
Neither is ever inferred from the other, nor from a restart having happened.

**Different, not newer.** The two are compared for equality only. An install
script pinned to an older release (`POCKODE_VERSION=0.15.0`) is as much a
reason to restart as a newer one, and the UI does not try to order version
strings it does not own. Its words are "installed", never "available" or
"update": Pockode does not know whether a newer release exists, only what is on
disk.

**Restart is always offered, not only on a mismatch.** A reinstall of the same
version, a development build (whose versions are never compared), or a server
that simply needs a fresh start would otherwise be left to the terminal. What a
restart does not do is refresh the environment: the new run inherits the old
process's, `PATH` included, so it is not the fix for a CLI installed onto a new
`PATH` entry since — that takes a start from a new terminal
([platforms.md](platforms.md#ai-clis-on-windows)). The
one exception is an installed file that cannot be read: the server would refuse
the restart, so the button is replaced by the reason.

**Versions are shown as the server reports them.** A release build's version
has no leading `v` (`scripts/build.sh` strips it from the tag), so the copy
writes "Version 0.17.0" in `web`, and adds the `v` itself where the cluster
panel already writes "v0.17.0". A development build reports `dev`.

**The press says its cost; the server says whether it can.** The confirmation
names what is lost — the AI turns that are running — and what is kept. Whether
the new executable can run at all is checked by the server before it lets go of
anything; a refusal changes nothing and is shown where the press was.

**No nagging outside the place it lives.** A mismatch is shown where the
version is shown — the Pockode section of Settings, the cluster panel's header
— and nowhere else: no badge on the Settings entry, no banner in the chat. A
mismatch exists only after someone ran the installer on purpose; they know
where to look, and a marker that follows them into every chat would outlive
their interest in it.

**A restart from elsewhere is handled the same way.** `kill -USR1`, another
device's Restart, or a terminal restart all look the same from here: the
socket drops, the client reconnects, and if the server's version changed, the
page reloads. Nothing in the UI depends on this page having pressed the button,
except the wording while it waits.

## web: Settings → Pockode

A section labelled **Pockode**, id `pockode`, priority 80 — after **AI CLIs**
(50), before **Account** (90). It is about the server, as the CLI cards are,
and Account stays last because Logout is the one action that ends the page's
own session.

On a cluster node the section is the same and restarts that node only — its
own executable, password and options; the cluster and the other nodes are not
touched. On unix the cluster panel shows the node as running throughout, since
the PID in its `server.json` is kept; on Windows the PID changes, and the node
reads stopped for the moment until its successor publishes itself
([cluster.md](cluster.md#restarting-and-upgrading)). Both are the server's part,
not the UI's.

One card, built from the AI CLIs card's pieces (`CliRow`, `CliRowNotice`,
`secondaryButtonClass` / `primaryButtonClass` from
`web/src/components/CliLogin/loginParts.tsx`), with the same fixed-height row
and the same rule that only an attention state adds height
([cli-update-ui.md](cli-update-ui.md#where-it-lives-settings--ai-clis)).
`CliRow` keeps its name: it is a Settings row in all but name, and a rename is
churn this feature does not need.

```
POCKODE
┌───────────────────────────────────────────────────┐
│ ↑  Version 0.16.0                     [ Restart ] │
│    0.17.0 installed                               │
└───────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────┐
│ ✓  Version 0.17.0                       Restart   │
│    Installed version is the same                  │
└───────────────────────────────────────────────────┘
```

There is no card header: the section label already says "Pockode", and the
card has one row.

**When it reads.** The installed version is read when the section mounts, when
the page becomes visible again — the user typically comes back from a terminal
where they just ran the installer — and when the Restart dialog opens. Not on a
timer: each read runs the executable. A re-read never goes back to skeletons;
the last values stay until the new ones land.

### The row's states

| State | Icon | Title / subtitle | Trailing | Notice |
|-------|------|------------------|----------|--------|
| Loading | skeleton | skeleton / skeleton — until the installed version is read | — | — |
| Same version | `CheckCircle2` `text-th-text-muted` | "Version 0.17.0" / "Installed version is the same" | **Restart**, `secondaryButtonClass` | — |
| Restart needed | `ArrowUpCircle` `text-th-accent` | "Version 0.16.0" / "0.17.0 installed" | **Restart**, `primaryButtonClass` — the card's one action, and the reason it has news | — |
| Development build | `Info` `text-th-text-muted` | "Development build" / "Installed: 0.17.0", or "Installed: development build" | **Restart**, secondary | — |
| Installed unreadable | `AlertTriangle` `text-th-error` | "Version 0.16.0" / "Couldn't read the installed version" | — withheld: the server refuses a restart into a file that does not run, so the button could only fail | the server's reason, then "Pockode can't restart until `<path>` runs. Reinstall it on the server." — `<path>` in `font-mono`, the path saved at startup |
| Couldn't ask | `AlertTriangle` `text-th-error` | "Version 0.16.0" / "Couldn't read the installed version" — the `server.version` request itself failed (not connected, timed out), so nothing is known about the file | **Restart**, secondary — the server still checks; the dialog asks again, and closes back to this row if that read fails too | "Couldn't ask the server: <error>" (`role="alert"`). A re-read that fails after an earlier one landed keeps the earlier row and adds "Couldn't read the installed version again: <error>" |
| Restarting | Spinner | "Restarting Pockode..." / "Started 0:12 ago" | — | from 60 s on, *Not back* below |
| Not back | `AlertTriangle` `text-th-warning` | "Pockode hasn't come back" / "Started 1:04 ago" | — | "The restart may have failed on the server. Its log, or the terminal it runs in, says why; start pockode there again if it isn't running. This page keeps trying to reconnect." — a new version that refuses an option exits before it opens its log, so the reason is on its stderr |

- "0.17.0 installed" stays whole beside the primary button on a 320px phone,
  which is why "restart to use it" is not on the row: the button says Restart,
  and the dialog says the rest.
- *Development build* is a running version of `dev` (no release ldflags).
  A dev build and an installed release are not compared — they would always
  differ — so this state never shows *Restart needed*.
- *Installed unreadable* covers a missing file (the install was removed or
  moved), one that does not execute (wrong architecture, no permission) and one
  whose output has no version in it. The server's reason tells them apart; the
  row does not try to.
- The status role is one visually hidden `<output>` beside the row holding
  only *Restarting* and *Not back*, so a screen reader is not read
  "Installed version is the same" on every visit. A refusal is the dialog's
  own `role="alert"`, so it is heard once, where it is shown.

### Pressing Restart

**Restart** opens a `ConfirmDialog`. Opening it reads the installed version and
the running-turn count again, so the dialog speaks about now, not about when
the card was drawn. Until that read lands the dialog shows the card's last
values and **Restart** is disabled — confirming on the old count is exactly
what the re-read is for. If it finds the installed file unreadable, the dialog
closes and the row shows *Installed unreadable*; if the read itself fails, it
closes too, back to the row's *Couldn't ask*. Only the dialog's own read
decides this: a later background read that fails leaves an open dialog alone.

> **Restart Pockode?**
> Pockode restarts on the server and comes back running 0.17.0 (now 0.16.0).
> 2 AI turns are running and will be stopped — their sessions and history are
> kept, and you can continue them afterwards. This page reconnects by itself.
>
> Cancel · **Restart**

The message is built from parts:

| Part | Copy |
|------|------|
| What happens, versions differ | "Pockode restarts on the server and comes back running 0.17.0 (now 0.16.0)." |
| What happens, same version | "Pockode restarts on the server with the same version and options." |
| What happens, development build | "Pockode restarts on the server with the same options." |
| Cost, turns running | "1 AI turn is running and will be stopped" / "N AI turns are running and will be stopped" + " — their sessions and history are kept, and you can continue them afterwards." |
| Cost, none running | "No AI turn is running; sessions are kept." |
| Ending | "This page reconnects by itself." |

- **Variant:** `danger` while turns are running — a turn stopped halfway is
  work the user loses — and `default` when none is. The confirm label is
  **Restart** in both.
- **The count is the whole server's**, every worktree of this project
  included, since that is what the process holds. A turn waiting on a
  permission is running and counted: the process it would be answered to ends
  too. A question an agent posted is not — it belongs to the session and is
  still there after the restart — and a session whose CLI is merely idle is not
  counted either: nothing in flight is lost.
- **A reply lost with the connection is not a failure.** The server holds
  its shutdown until the reply has been read, through the relay too, so a
  success normally arrives; a connection that drops before its answer anyway
  is waited on as if the restart was accepted, and the reconnect decides — a new version reloads, the same one clears *Restarting*.
  A drop that took the request with it before the server saw it reads the
  same, and is accepted: from the page it cannot be told from a same-version
  restart.
- **The dialog stays up while the request is out** (`onConfirm` returns the
  promise). The server answers only after the new executable has passed its
  check, so the wait covers that check.
- **A refusal is shown in the dialog**, as `ConfirmDialog` shows a rejection,
  and the dialog can be confirmed again or cancelled. Nothing was stopped.

| Refusal | Copy (the server's message, shaped like this) |
|---------|------|
| The new file does not run | "The installed pockode at <path> didn't run: <reason>. Pockode kept running; nothing was stopped." |
| A restart is already under way (another device, `kill -USR1`) | "Pockode is already restarting." — the dialog then closes, and the row goes to *Restarting* as if this page had asked |
| The server is shutting down | "Pockode is shutting down." — shown in the dialog like any refusal; the socket is about to drop anyway |
| Anything else | The server's message, verbatim |

The dialog's message and its error are plain text (`ConfirmDialog` takes
strings), so these carry no code formatting; the path is the one place a
reader needs it whole, and it is.

### While it restarts

On a successful reply the dialog closes and the row goes to *Restarting*. Then:

- **The socket drops.** The app-wide `ReconnectBanner` says "Restarting..."
  instead of "Reconnecting..." while this page is waiting on a restart it
  asked for; the escalation after a few attempts reads "Pockode hasn't come
  back from the restart. Still trying..." with **Retry now** (*Shared
  pieces*). Every page shows it, so a user who leaves Settings still sees it.
- **The version changed** — the reconnect's `auth` reports a version other
  than the page's build: the page reloads, as it already does
  (`web/src/lib/wsStore.ts`). After the reload the row reads *Same version*,
  which is the confirmation; nothing else is needed.
- **The version did not change** (a same-version restart): the page stays,
  the reconnect refetches as on any reconnect, the row leaves *Restarting* and
  reads the installed version again.
- **It doesn't come back.** From 60 s after the reply, the row turns to *Not
  back* and the banner to its restart escalation. The reconnect never stops
  trying. This is the screen's share of the rule that a failed exec exits
  non-zero rather than hangs: a process that exited cannot say so to the page,
  so the page says what it can — how long, where to look.
- **Restarting is this page's memory, not the server's.** It is gone on a
  reload and never shown to another device; those see an ordinary reconnect.

A reconnect through the cloud relay may take longer than a local one — the
new process has to register its tunnel again — which is part of why the
threshold is a minute, not seconds.

## web-cluster: the header

The cluster panel's header gains a **version button** between the title block
and **Add node**, and the footer line "Pockode cluster vX" moves into it. The
version is the cluster's own; it says nothing about the nodes, which are
separate processes started from the same executable.

```
┌────────────────────────────────────────────────┐
│ Cluster                     [↑ v0.16.0]  [ + ] │   phone
│ Connected                                       │
└────────────────────────────────────────────────┘

│ Cluster              [↑ v0.16.0 → 0.17.0]  [ + Add node ] │   sm and up
```

- `min-h-11`, text button in `text-xs text-th-text-secondary`, the version as
  "v0.16.0" ("dev" for a development build).
- On a mismatch it gains an up-arrow-in-circle icon in `text-th-accent` — an
  inline SVG, since this panel has no icon library
  ([cluster-ui.md](cluster-ui.md#what-the-panel-is-for)) — and from `sm` up the
  label reads "v0.16.0 → 0.17.0". The accessible name says it in words,
  starting with the visible label so a voice user can say what they see:
  "Pockode cluster v0.16.0, 0.17.0 installed"; without a mismatch, "Pockode
  cluster v0.17.0".
- When the installed version is unreadable it shows the version alone, with no
  marker: the header is not where an error about the install belongs; the
  sheet says it.
- Not shown before the first connect (`version === null`), as today.

**When it reads.** The installed version is read on every successful connect,
when the tab becomes visible again (where the node poll already catches up),
and when the sheet opens. It does not ride the node poll: each read runs the
executable.

### The cluster sheet

The button opens a `Sheet` titled **Pockode cluster**. The sheet is both the
information and the confirmation (cluster rule 2: Restart costs little here,
and the sheet already names it beside the button; cluster rule 3: no second
overlay).

```
Pockode cluster
──────────────────────────────────
Running     0.16.0
Installed   0.17.0

Restarting the cluster manager doesn't affect nodes:
they keep running and stay reachable at their own
addresses. This panel reconnects by itself.

                     Cancel · [ Restart ]
──────────────────────────────────
```

| Case | Body | Footer |
|------|------|--------|
| Versions differ | Rows as above; then "Restart to use 0.17.0." before the paragraph | Cancel · **Restart** (`PRIMARY_BUTTON`) |
| Same version | Rows; the paragraph | Cancel · **Restart** (`NEUTRAL_BUTTON`) |
| Development build | "Running: development build", "Installed: …"; the paragraph | Cancel · **Restart** (`NEUTRAL_BUTTON`) |
| Installed unreadable | "Installed: couldn't read" in `text-th-error`, then the server's reason and "The cluster can't restart until `<path>` runs. Reinstall it on the server." | Close |
| Couldn't ask | "Installed: unknown", then "Couldn't ask the cluster for its installed version: <error>" — the request failed, which says nothing about the file | Cancel · **Restart** (`NEUTRAL_BUTTON`) |
| Reading | The installed row is a skeleton; Restart is shown, disabled, until the read lands | Cancel · Restart (disabled) |
| Request out | — | Restart shows a spinner; the sheet is not dismissible (`dismissible={false}`) and Cancel is disabled, as for every in-flight action in this panel (`NodeCard`, `NodeForm`) |
| Refused | The server's message as a `role="alert"` under the paragraph, in the refusal copy of the *web* table with "the cluster" for "Pockode" | Cancel · **Restart** (try again) |

The paragraph is the confirmation's cost statement, and it is the whole of it:
the cluster manager runs no AI turn. What a restart does interrupt is the
panel's own connection and any node action in flight from another device; a
node Start or Stop that was mid-request fails with the connection error it
already shows.

On a successful reply the sheet closes and the header's status line reads
"Restarting..." (`text-th-warning`) in place of "Reconnecting...", the banner
says "Restarting...", and from 60 s on its escalation reads "The cluster hasn't
come back from the restart. Still trying..." with **Retry now**. The node list
stays on screen, as for any reconnect.

### Reloading on a new version

`web-cluster`'s store compares the version `auth` returns with its own build
(`__APP_VERSION__`, which its `vite.config.ts` already defines) and reloads on
a mismatch, as `web`'s does. A development build is `dev` on both sides, so a
dev panel never reloads itself.

A reload throws away a sheet that is open — a Start sheet with a typed
password, a half-filled node form. When this page pressed Restart, nothing is
open. When the restart came from elsewhere, the loss is accepted: the panel's
inputs are short, and a page running the old frontend against a new server is
the worse failure.

## Shared pieces

| Piece | Where | Change |
|-------|-------|--------|
| `ReconnectBanner` | `@pockode/shared` | An optional `restarting` prop: "Restarting..." in place of "Reconnecting...", and after the outage threshold *or* 60 s since the restart, the restart escalation. Its subject is a field of that prop (`{ since, subject }`, "Pockode" / "The cluster") — the copy is shared, the noun is the project's |
| Each project's banner wrapper | `web`, `web-cluster` | Passes `restarting` from its store's restart request time |
| ws stores | both | Hold `restartRequestedAt` (set on a successful restart reply — kept, not moved, by a second press — and cleared on the next successful `auth` or a logout); `web-cluster` gains the version reload |

The rest stays in each project. The Settings row and the cluster sheet look
different because their homes do; what they share is the copy, which this
document holds.

## What the UI needs

Not a wire format — that is
[code/websocket-rpc.md](code/websocket-rpc.md#server-installed-version-and-restart)
— but what the screens above cannot be drawn without:

- **An installed-version read**, one request per server kind (pockode, cluster):
  the installed version when it could be read, otherwise a reason; the
  executable path saved at startup, for the copy; and for `pockode`, the count
  of running AI turns. The running version is already in `auth`.
- **A restart request** that answers only after the new executable has been
  checked: success means "the old process is going down now", refusal carries
  a message that can be shown as it is and changes nothing.
- **Restart, then disconnect**: the reply has to reach the client before the
  socket closes, or the page cannot tell a refusal from a restart.

## What to test

- The row's states render their row of the table; *Installed unreadable* has
  no Restart; *Development build* is never *Restart needed*.
- Restart is offered when the versions are the same.
- The dialog re-reads on open; its message names the count and the versions
  per the parts table; its variant is `danger` only with running turns.
- A refusal stays in the dialog and stops nothing; "already restarting" closes
  it into *Restarting*.
- After a successful reply: *Restarting*, the banner's restart wording, *Not
  back* from 60 s; a reconnect with a new version reloads, one with the same
  version clears *Restarting*.
- `web-cluster` reloads when `auth` reports a version other than its build,
  and not for `dev`/`dev`.
- The cluster version button shows the marker only on a mismatch; the sheet's
  cases render their row; the sheet cannot be dismissed while the request is out.

## Considered and not done

- **Showing "update available" from the release feed.** The UI would have to
  ask the network what is newest, and the next story installs from the UI;
  until then, what is on disk is the only thing a restart can deliver.
- **A badge on the Settings entry, or a banner in the chat, on a mismatch.**
  *No nagging* above.
- **Waiting for running turns to end before restarting.** It would hand the
  user a restart that happens at some unknown later moment, which is harder to
  reason about than one that happens now with its cost named. If a "restart
  when idle" turns out to be wanted, it is a second button, not a change to
  this one.
- **Stopping and restarting the nodes from the cluster's Restart.** A later
  story restarts nodes; this one is said not to touch them, and says so.
- **Persisting "restarting" across a reload.** The reload is itself the
  success signal; a failure is what the banner already tells every page.
