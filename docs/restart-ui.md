# Restart UI

How a user sees which version of Pockode is running and which is installed on
the server, learns that the two differ, and restarts Pockode — the cluster
manager, or the cluster's nodes, one or all of the outdated ones at once — from
a phone, so an upgrade done with the install script takes effect without a
terminal. What the restart costs and how that is said before the
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

## web-cluster: restarting nodes

The cluster restarts a node **without its password**: it asks the node, and the
node restarts itself with its own password and options
([code/self-restart.md](code/self-restart.md)). That is the whole point of this
part — Start asks for a password every time, so upgrading ten nodes used to mean
ten Stops, ten Starts and ten passwords. A node started by a build from before
node restarts existed cannot be asked; it is stopped and started instead, once
([Older nodes](#older-nodes-stop-and-start-once)).

The panel can only show this once the cluster itself runs a version that knows
`node.restart`, so after an upgrade the order is the header first (its button
already says the cluster is outdated), then the nodes. Nothing enforces the
order; the old panel simply has none of the controls below.

### Which node is outdated

A node runs the executable the cluster starts it from, which is the one the
header's `server.version` reads — so a node's running version is compared with
the **cluster's installed version**, never with the cluster's running one. Same
rules as everywhere here: equality only, `dev` never compared, a node is
outdated only while it runs.

| Kind | When | Card shows |
|------|------|------------|
| Current | running, `version` equals the installed version, or either is `dev` | nothing new |
| Outdated | running, `version` differs from the installed version | the version line and **Restart** |
| Older node | running, no `version` — its `server.json` was written by a build that predates the field, and every such build also predates the restart request (unix would kill it, Windows has no event for it). Also a node `node.restart` refused as `older_node` since it last started — on Windows, one with a version that failed to publish its restart event | the version line, "Older version", and **Restart**, which stops and starts it |
| Not compared | the installed version could not be read, or the read failed | nothing new; no node is called outdated on a guess, and the batch strip is not drawn |

An older node counts as outdated without comparing strings: what marks it is
that its build is older than the field, which is a fact, not an ordering of
versions this panel does not own — so it is one under an installed development
build too, where nothing else is compared. The second way in — a refusal — is the
panel's memory, keyed by the node and its `started_at`, so it ends with the
process it was about; the Windows case is rare enough that the page learning
it on the first press is fine.

**One read for the whole panel.** The installed version is the same read the
header's version button already makes (on connect, on returning to the tab, on
opening a sheet), lifted out of `ClusterVersion` to `NodeList`, which renders
both and passes it down. Never on the node poll: each read runs the executable.

### The card

```
┌───────────────────────────────────────────┐
│ ● my-app                               ⋮  │
│ ~/projects/my-app                         │
│ Port 9870 · up 3h                         │
│ ↑ v0.16.0 · 0.17.0 installed              │
│ [        Open        ]  Local ↗ [Restart] │
└───────────────────────────────────────────┘
```

- **The version line** is drawn only for an outdated or older node, under the
  meta line, `text-xs text-th-text-muted`, led by the header's up-arrow-in-circle
  in `text-th-accent` (inline SVG, `aria-hidden`): "v0.16.0 · 0.17.0 installed",
  or "Older version · 0.17.0 installed". A current node shows no version at
  all — the version of a node that needs nothing is not news, and a line on
  every card would bury the ones that do.
- **Restart** is a `NEUTRAL_BUTTON`, `shrink-0`, after Open and Local. Not
  primary: Open is still what the user came for (cluster rule 1), and a restart
  costs the turns running in that node. It fits beside Open and Local on a
  320px phone; Open is the one that gives up width.
- **The overflow menu** of every running node gains **Restart** as its first
  item, above Stop — also for a current node, since a restart is always offered
  (*The rules*). It opens the same confirmation, inside the menu's sheet, with
  **Back** to the menu, as Stop does. It is withheld only when the installed
  version is unreadable: the cluster would refuse, and the header's sheet is
  where that is explained.

### Confirming one

The confirmation is a sheet: the card's Restart opens it directly, the menu's
Restart turns the menu into it. Opening reads the installed version again; until
that lands the copy uses the last read and **Restart** is disabled, as in the
header's sheet.

> **Restart my-app?**
> Pockode in this project restarts and comes back running 0.17.0 (now 0.16.0).
> Any AI turn running in it is stopped — its session and history are kept, and
> can be continued afterwards. Pages open on it reconnect by themselves.
>
> Cancel · **Restart**

| Part | Copy |
|------|------|
| What happens, versions differ | "Pockode in this project restarts and comes back running 0.17.0 (now 0.16.0)." |
| What happens, same version | "Pockode in this project restarts with the same version, password and options." |
| What happens, development build | "Pockode in this project restarts with the same password and options." |
| What happens, installed version unknown (the read failed) | "Pockode in this project restarts into the installed version, with the same password and options." — the cluster still checks the file before it asks |
| Cost | "Any AI turn running in it is stopped — its session and history are kept, and can be continued afterwards." |
| Ending | "Pages open on it reconnect by themselves." |

- **"Any AI turn", not a count.** The cluster is not signed in to its nodes and
  cannot ask how many turns are running
  ([Considered and not done](#considered-and-not-done)). So there is no
  `danger` variant to switch to: the button is `PRIMARY_BUTTON` always, as for
  Stop, whose cost it shares.
- **In flight**: the button reads "Restarting..." with a spinner; the sheet is
  not dismissible and Cancel/Back is disabled, as for every action here. The
  request answers fast — it returns once the node has been asked, not once it
  is back — so this lasts the cluster's probe of the installed file and no more.
- **On success** the sheet closes and the list is fetched at once, so the card
  shows *Restarting* without waiting for the poll.

| Refusal (`data.reason`) | What the page does |
|---------|------|
| `not_runnable` — the cluster ran the installed file and it did not run | Stays in the sheet as a `role="alert"`: "The installed pockode at <path> didn't run: <why>. The node kept running; nothing was stopped." Confirmable again |
| `already_restarting` — another device asked first; the cluster knows only of restarts it asked for itself, not a `kill -USR1` | Treated as success: the sheet closes and the card shows *Restarting* |
| `older_node` — the node cannot be asked: its file has no version after all, or (Windows) it has one but no restart event | The sheet turns into the older node's (below), in place, and the card is an older node's from now on |
| `not_running` — it stopped, or went stale, since the list was drawn | The sheet closes, the list is fetched, and the card shows "Could not restart this node: <message>" |
| Anything else (the request could not be delivered) | Stays in the sheet, the server's message verbatim |

### Older nodes: stop and start, once

An older node cannot be sent the restart request, so its Restart — on the card,
in the menu, same button — opens a sheet that **stops it and starts it again**,
asking for its password in the same sheet. A node without a `version` is one
also when the installed version could not be compared: its card is then not
marked, but its menu's Restart, where it is offered, still leads here rather
than to a `node.restart` bound to be refused.

> **Restart my-app**
> This node was started by an older Pockode, which can't be restarted by the
> cluster. It is stopped and started again instead, which needs its password —
> this once: after that, Restart needs none.
> Any AI turn running in it is stopped — its session and history are kept.
>
> Node password `[••••••••••••]`
> [Generate] [Copy]
> The password it runs with now. A new one works too, and signs out every
> device signed in to it.
>
> Cancel · **Stop and start**

- **Stop is the existing `node.stop`** — the graceful one, SIGTERM or the
  Windows shutdown event, then the 5 s grace — and only once it has succeeded
  does `node.start` run with the typed password. Nothing is ever signalled with
  the restart request.
- **The password field is the Start sheet's**, Generate, Copy and the
  copy-failed reveal included: the sheet *is* `StartNodeSheet`, in a variant
  with this title, paragraph and button, rather than a copy of it. It is held
  by the list, not the card, because the stop moves the card to the Stopped
  section and mounts it afresh, and the sheet has to outlive that. The same rules hold: never prefilled, never kept.
- **In flight**: "Stopping..." then "Starting...", not dismissible.
- **The stop fails** (the node is still running): the reason in the sheet, the
  password kept, **Stop and start** again. If the node is found stopped instead
  — it went down by itself, or from another device — the sheet becomes the
  Start sheet below: there is nothing left to stop.
- **The start fails** (the node is now stopped): the sheet *becomes the Start
  sheet* — title "Start my-app", button **Start**, password and reason kept —
  because that is now exactly the situation. Cancelled from there, the card is a
  stopped one with its error, like any failed start.
- **No batch here.** Every node has its own password; the batch strip names
  older nodes and leaves them to their cards.

Why one sheet rather than Stop and then a hint on the stopped card: a stopped
node moves to the Stopped section, often below the fold on a phone, so the hint
would be a notice the user first has to find; and a restart that takes two
separate actions in two places is not one the user can finish without being
told the second step. Asking for the password up front costs nothing extra —
the second step would have asked for it anyway — and the sheet already exists.
The appearance stays small on the card: the same Restart, an "Older version"
line, and the difference is explained only to whoever presses it.

### Restart all outdated

A strip at the top of the list, above the first section, drawn when **two or
more** running nodes are outdated or older. For one, its card is the place —
the same threshold as the stale section's Clean up all.

```
┌───────────────────────────────────────────┐
│ ↑ 0.17.0 installed · 3 nodes are outdated │
│                [ Restart all outdated (2) ] │
└───────────────────────────────────────────┘
```

- `rounded-lg border border-th-border bg-th-bg-secondary p-3`, the arrow in
  `text-th-accent`, the text `text-sm text-th-text-secondary`. Not sticky, not a
  warning colour: it is news the user went and caused, not a problem, and the
  cards carry their own marker anyway.
- **N is what the button will restart**: outdated nodes with a version. Older
  nodes are in the strip's count and not in N, because the button cannot do
  them. When every outdated node is older (N = 0), the button is absent and the
  strip reads "… · 2 nodes are outdated. Restart each from its card; nodes
  started by an older Pockode need their password."
- `NEUTRAL_BUTTON`. The cards' Open buttons stay the loudest things on screen.
- A node that is *Restarting* is not outdated any more for the count, so the
  strip shrinks as a batch runs and is gone once fewer than two are left.

Pressing it opens a sheet:

> **Restart 2 outdated nodes?**
> my-app — v0.16.0
> api — v0.15.2
> They restart and come back running 0.17.0. Any AI turn running in them is
> stopped — sessions and history are kept, and can be continued afterwards.
> Not included: legacy-app — started by an older Pockode, it needs its
> password. Restart it from its card.
>
> Cancel · **Restart 2**

- The list and N are recomputed when the installed re-read lands (opening the
  sheet reads, as above); the button says the count it will actually send.
- The "Not included" paragraph appears only when there are older nodes; with
  several it names them all ("…: legacy-app, old-api — started by an older
  Pockode, each needs its password. Restart them from their cards.").
- **In flight**: one `node.restart` per node in parallel, settled together, one
  list fetch at the end — the shape of Clean up all. The button reads
  "Restarting..."; the sheet is not dismissible.
- **When all have answered**, whatever they answered, the sheet closes. Each
  refusal goes to *its own card*, worded as for a single restart
  ("Could not restart this node: <message>"); `already_restarting` is success
  here too. A batch never stops at the first failure: the nodes are
  independent, and a half-done batch that does not say which half is worse.
  An `older_node` refusal is not an error on the card: that node simply turns
  into an older node's card, whose Restart is the way. If any were refused for
  another reason, the strip adds "1 couldn't restart; its card says why." ("2 couldn't
  restart; their cards say why.") until its next press, or until those cards'
  errors are dismissed or cleared. It stays drawn for that note even when fewer
  than two outdated nodes are left.
- **The re-read on opening could not compare** (the request failed, or the
  file did not run): the sheet says so — "The installed version couldn't be
  read just now, so no node is called outdated. The version in the header says
  why." — with Restart disabled, rather than closing under the user. When it
  could compare and nothing is left to restart, the sheet closes.

### While a node restarts

*Restarting* is **the cluster's state**, not the page's (unlike the header's,
which only the page can hold while the cluster is gone): the cluster marked the
node when it asked it and watches its `server.json` for the successor, so every
device sees it, and a reload does not lose it.

```
┌───────────────────────────────────────────┐
│ ● my-app                               ⋮  │   ● in th-warning
│ ~/projects/my-app                         │
│ ◌ Restarting... 0:12                      │
│ [ ◌ Restarting...                       ] │   disabled
└───────────────────────────────────────────┘
```

- **It stays where it was**, in the Running section at its place: a restart
  does not move `last_used_at` (it is upkeep, like Stop, not going to the node),
  so a batch does not shuffle the list it is running on.
- The status dot is `bg-th-warning`, with "Restarting" as its screen-reader
  text; the meta line is a small spinner and "Restarting... 0:12" counted from
  `restart_requested_at`; the version line is gone.
- **Open is replaced by a disabled "Restarting..." button**, and Local and
  Restart are not drawn: the server behind the link is going away, and an Open
  now lands on a page that is still connecting.
- **The overflow menu is disabled** for the minute at most that this lasts.
  Stop or Restart would race the restart; Delete would read the node as not
  running and skip its "this node is running" warning, though it is about to
  run again; Edit could move the path the cluster is watching.
- **Never Start.** On Windows the old `server.json` is deleted before the
  successor writes its own, and the node used to read *stopped* in between
  ([cluster.md](cluster.md#restarting-and-upgrading)) — with a Start button a
  tap away from putting a second server on the project. The cluster keeps
  reporting `restarting` through that gap, and refuses `node.start` while it
  does.

**Done** is a `server.json` written by a new start, with a live process — the
same PID on unix, a new one on Windows. How the cluster tells a new start from
the old one is in [cluster.md](cluster.md#restarting-from-the-cluster).

The card is an ordinary running one again; the version line having gone is the
confirmation, and nothing else is shown.

**Failed** is the cluster giving up after **60 s**, the same minute as
`RESTART_NOT_BACK_MS`. It reports what it then finds, with `restart_error`:

| Found | Card | Error (shown as the cluster wrote it) |
|-------|------|-------|
| The old process, still running (same start) | Running, still outdated | "Didn't restart within a minute; the old server is still running. It may have refused — its project directory gone, say — or still be ending its AI sessions. Its log says which: <path>/.pockode/server.log" |
| Nothing, or a dead process | Stopped or stale | "Stopped for the restart and didn't come back within a minute. Its log says why: <path>/.pockode/server.log" |

- The error is shown in the card's usual error box. **Dismiss** hides it in this
  page for that restart (keyed by `restart_requested_at`); the next action on
  the node that succeeds clears it on the cluster, as for every card error.
- **A successor that turns up late still counts**: the cluster keeps comparing
  against the start it recorded, and the card goes back to running and drops
  the error.
- If the cluster itself restarts while a node is restarting, that knowledge is
  lost and the node reads what its files say; on Windows that may be *stopped*
  for a moment. Accepted: it takes two restarts at once, and the next poll
  corrects it.

### What the node list needs

On top of [What the UI needs](#what-the-ui-needs), for the screens above:

| Field / call | Meaning |
|---|---|
| `status.version` | The running version from `server.json`, as written; only while running. Absent means an older node |
| `status.status = "restarting"` | From an accepted `node.restart` until the successor's `server.json` appears or 60 s pass. Grouped with Running by the panel |
| `status.restart_requested_at` | When the restart was accepted; present while restarting, and while `restart_error` is |
| `status.restart_error` | Why the last restart did not come back, in English, to be shown as it is; cleared by the next start, stop, clean-up or restart that succeeds, or by a late successor |
| `node.restart {id}` | Returns the node's status, like `node.cleanup`, once the node has been asked — not once it is back. Refusals as `CodeRestartRefused` (`-32011`) with `data.reason` `not_runnable`, `already_restarting`, `older_node` or `not_running` — what the page does with each is the table above, when the cluster sends each is [cluster.md](cluster.md#restarting-from-the-cluster); anything else is an ordinary error |
| `node.start` while restarting | Refused, "This node is restarting." |
| `last_used_at` | Not moved by `node.restart` |

**`not_runnable` has to be the cluster's own check.** A node asked by signal or
event has no way to answer, so a node that refused to restart into an unreadable
file would look exactly like one that is slow. The cluster therefore probes the
installed file itself (the same `Program.Version` its `server.version` uses)
before it asks, and refuses for it, so that the refusal arrives in the sheet
and not as a 60 s timeout. The node still makes its own check, which also
covers its working directory; a refusal there is what the timeout's first row
is for.

The `-32011` code and the reasons are parsed by the same helper in
`@pockode/shared` (`serverRestart.ts`): the node reasons are added there beside
`server.restart`'s, so one place knows the code, even though only `web-cluster`
reads the node ones.

## Shared pieces

| Piece | Where | Change |
|-------|-------|--------|
| `ReconnectBanner` | `@pockode/shared` | An optional `restarting` prop: "Restarting..." in place of "Reconnecting...", and after the outage threshold *or* 60 s since the restart, the restart escalation. Its subject is a field of that prop (`{ since, subject }`, "Pockode" / "The cluster") — the copy is shared, the noun is the project's |
| Each project's banner wrapper | `web`, `web-cluster` | Passes `restarting` from its store's restart request time |
| ws stores | both | Hold `restartRequestedAt` (set on a successful restart reply — kept, not moved, by a second press — and cleared on the next successful `auth` or a logout); `web-cluster` gains the version reload |
| `restartRefusedReason` | `@pockode/shared` | Also recognises `node.restart`'s `older_node` and `not_running` |
| `differingVersion`, `displayVersion` | `web-cluster` | Move out of `ClusterVersion` into `src/lib/version.ts`: the header, the card, the strip and the sheets all compare and print versions the same way |
| The installed read | `web-cluster` | Out of `ClusterVersion` into `NodeList`, one read passed to the header and the cards |
| The node password sheet | `web-cluster` | `StartNodeSheet` out of `NodeCard` into its own file, with a `stopAndStart` variant that is the older node's sheet — the field, Generate, Copy and the reveal are the Start sheet's, and turning into the Start sheet after a failed start is a change of variant |

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
- Nodes: the kinds table — outdated only when running and different, never for
  `dev`, an older node without a version, nothing when the installed version is
  unknown; the version line only on outdated and older cards.
- Restart is in the menu of every running node, withheld when the installed
  version is unreadable; the confirmation's parts per the table.
- Each `node.restart` refusal does what its row says; `already_restarting` is
  success.
- The older node's sheet stops, then starts with the typed password; a failed
  stop keeps it as it was, a failed start turns it into the Start sheet. It
  never calls `node.restart`.
- The strip: drawn from two outdated nodes, N excludes older ones and the
  button is absent at N = 0; a batch with a refusal closes, puts the error on
  that card only, and restarts the others.
- *Restarting* cards keep their place, offer no Open or Start, and their menu
  is disabled; an `older_node` refusal turns the card into an older node's;
  `restart_error` shows in the card and Dismiss hides it for that restart only.

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
- **Restarting the nodes from the cluster's Restart.** The cluster's sheet says
  nodes are not touched, and that stays true: the nodes have their own Restart
  and their own strip, and a cluster restart that also took down every project
  would cost what the header's sheet promises it does not.
- **Counting running AI turns in a node's confirmation.** The cluster is not
  signed in to its nodes; the count would have to be published in
  `server.json`, a file read every 5 s, turning a live number into a stale copy
  of one. "Any AI turn" says the cost truthfully without it.
- **One password for all the older nodes in a batch.** Each node has its own,
  and the panel does not hold one past the sheet it was typed in
  ([cluster-ui.md](cluster-ui.md#what-was-rejected-and-why)). Older nodes are a
  one-time case of the upgrade into node restarts; they go one card at a time.
- **Restarting current nodes from the strip too.** Its job is the upgrade; a
  fresh start of a node that needs none is its card's menu, one at a time.
- **Restarting outdated nodes by themselves after an upgrade.** It would stop
  AI turns nobody chose to stop.
- **Persisting "restarting" across a reload.** The reload is itself the
  success signal; a failure is what the banner already tells every page.
