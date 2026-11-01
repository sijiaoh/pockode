# Self-Update UI

How a user learns from a phone that a newer Pockode release is out, installs
it with one press, and ends up running it, for a `pockode` server
(Settings → Pockode in `web`) and for a cluster manager (the header of
`web-cluster`). It covers which releases are offered, what the press costs and
how the confirmation says so, what the screen does while the file is being
replaced, every reason an update is not possible, and every failure.

The restart that follows the install is
[restart-ui.md](restart-ui.md)'s, unchanged: this document ends where that one
takes over, and refers to its states by name (*Restarting*, *Not back*,
*Restart needed*). The installer's server side is `server/selfinstall` and
the release check `server/internal/release`; how Pockode is installed by hand
is [platforms.md](platforms.md).

Related: [restart-ui.md](restart-ui.md) for the card and the cluster sheet this
extends, and for the rules this document adjusts (*What changes in the restart
rules*); [cli-update-ui.md](cli-update-ui.md) for the row conventions and the
update vocabulary it set; [cluster-ui.md](cluster-ui.md) for the panel's three
rules; [responsive-ui.md](responsive-ui.md#hit-areas-and-spacing) for the 44px
floor the release-notes link is held to.

## The rules

**Two releases at most, both newer, picked by the server.** A *candidate* is
one of:

- **latest** — the newest non-prerelease GitHub release;
- **alpha** — the newest prerelease, only when it is newer than latest.

A candidate is offered only when it is newer than the running version **and**,
when the installed file could be read as a release version, newer than the
installed version (an unreadable file or an installed development build sets no
floor) — a
release already on disk is a restart, not an update, and one older than what is
on disk would be a downgrade of the file. So a server running
`0.26.0-alpha.1` sees no latest `0.25.0`, and one with `0.25.0` already
installed but not yet restarted into sees *Restart needed* and no `0.25.0`
row. There is no version picker and no downgrade: going back is the install
script's version option ([platforms.md](platforms.md#installing-a-specific-version)),
and the confirmation says so. The server decides the candidates
(`agent.CompareVersions`, which orders prereleases) and the UI only draws them,
so neither frontend ever orders a version string.

**One press, then the restart.** Confirm → install → restart, with one
confirmation that names both costs. The install replaces the file and nothing
else; the page then sends the ordinary `server.restart`, and from its reply on,
everything is [restart-ui.md](restart-ui.md#while-it-restarts). The two are kept
apart so that a restart that fails after a good install leaves exactly the
state the restart UI already knows: a newer file on disk, *Restart needed*.

**The original file is never touched until the new one is proven.** The
download is checked against the same release's `checksums.txt` and run with
`--version` before it replaces anything, and the replacement is a rename. So
every failure in this document leaves the installed Pockode as it was, and
every failure's copy says so — that sentence is the answer to the fear the user
actually has. The one exception is Windows failing to move the old file back
after moving it aside, and its copy says exactly where the old file is
(*Failed*, `restore_failed`).

**"Update" is the verb, the channel is the noun.** As in
[cli-update-ui.md](cli-update-ui.md#the-rules): **Update**, never "Upgrade";
"install" only as the description of what the server does to the file. A
candidate is named by its version and its channel — "0.25.0 (latest)",
"0.26.0-alpha.1 (alpha)" — and "available" is not needed: a row that exists is
one that is available.

**Can't update is a reason, never a missing button.** When the server cannot
install — a development build, a directory it cannot write, a container, a
release with no file for this platform — the candidates (or the check) are still
drawn, with the reason and what the user can do instead. **Restart stays**
in every one of those cases: it has nothing to do with whether this server can
write its own file.

**No nagging, still.** Pockode now knows when a release is out, and shows it
only where the version already lives: the Pockode card in Settings, the
cluster's version button. No badge on the Settings entry, no banner in the
chat. Alphas come often; a marker that is on most weeks teaches the user to
ignore it ([cli-update-ui.md](cli-update-ui.md#the-rules), *No nagging*).
The one marker added is for a newer **latest** in the cluster header
(*web-cluster*), and not for an alpha.

## What changes in the restart rules

The restart UI was written before Pockode knew what the newest release is, and
two of its rules, and one entry of what it left undone, say so. They stay true
for what they govern — the running version against the installed file — and
stop short of the release feed. The other two rows restate rules that carry
over, so their reach is clear; the last one with a change of emphasis:

| Rule in restart-ui.md | Now |
|---|---|
| **Different, not newer** | Unchanged for *running vs installed*: a restart is offered on any difference, a pinned older install included, and the row still compares for equality only. The release candidates are a second, separate comparison, ordered — by the server, because the versions are Pockode's own tags and `agent.CompareVersions` already orders them. The UI orders nothing in either case. |
| Its words are "installed", never "available" or "update" | "Installed" still means the file on disk and only that; the version row never says "update". "Update" now belongs to the candidate rows, which speak about releases, not the disk. The two never borrow each other's word: a candidate already on disk is not a candidate (*The rules*), so a row never says "update" about something that only needs a restart |
| Considered and not done: *Showing "update available" from the release feed* | Done here. |
| **No nagging outside the place it lives** | Unchanged, and extended to releases (*No nagging, still*). |
| **Restart is always offered** | Unchanged, and now also beside every *Can't update* reason. It is no longer always the primary button: a latest **Update** takes that place, on the card (*Which button is primary*) and in the cluster sheet's footer (*The sheet*). |

## web: Settings → Pockode

The section and its card are [restart-ui.md](restart-ui.md#web-settings--pockode)'s.
The card keeps its version row first, unchanged, and gains the **updates
rows** under it, stacked as `CliStatusCard`'s rows are, built from the same
`CliRow` and `CliRowNotice`:

```
POCKODE
┌───────────────────────────────────────────────────┐
│ ✓  Version 0.24.0                       Restart   │  version row
│    Installed version is the same                  │
│ ↑  0.25.0 (latest)                   [ Update ]   │  latest
│    Release notes ↗                                │
│ ↑  0.26.0-alpha.1 (alpha)              Update     │  alpha
│    Release notes ↗                                │
└───────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────┐
│ ✓  Version 0.25.0                       Restart   │
│    Installed version is the same                  │
│ ✓  Up to date                       Check again   │  status row
│    Checked 3 min ago                              │
└───────────────────────────────────────────────────┘
```

Under the version row there is either **one status row** (checking, not
checked, up to date, couldn't check, development build, installing
elsewhere) or **one row per candidate** — one or two. So the card is two
rows on almost every visit, and three only when both an alpha and a latest
are out; that third row arriving is the news, as a notice's height is.

### A candidate row

- **Icon**: `ArrowUpCircle`, `text-th-accent` for latest, `text-th-text-muted`
  for alpha — an alpha is offered, not pushed.
- **Title**: "0.25.0 (latest)", "0.26.0-alpha.1 (alpha)" — no leading `v`, as
  everything in `web` ([restart-ui.md](restart-ui.md#the-rules), *Versions are
  shown as the server reports them*).
- **Subtitle**: "Release notes" with an `ExternalLink` icon.
- **The title and subtitle are one link**: the whole text block is an `<a>` to
  the release's GitHub page (`target="_blank" rel="noreferrer"`), so its hit
  area is the row's 44px height and the text's width, not a 16px line of
  `text-xs` ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing) — a
  link inside a subtitle line is the case it says to move rather than pad).
  Hover underlines "Release notes". Accessible name: "Release notes for 0.25.0
  (latest), opens GitHub".
- **Trailing**: **Update**. Its accessible name is the story's full label,
  "Update to 0.25.0 (latest)", so a voice user can say it and a screen reader
  user hears which one; the visible label is the one word, because
  "Update to 0.26.0-alpha.1 (alpha)" does not fit beside the title on a 320px
  phone, and the title already says it.

**Which button is primary.** The card keeps one primary action, and it goes to
the step that takes the user furthest:

| On the card | Primary | Secondary |
|---|---|---|
| A latest row with **Update** | latest's **Update** | Restart, alpha's Update |
| No such row, version row is *Restart needed* | **Restart** | alpha's Update |
| Otherwise | none | alpha's Update, Restart |

An alpha is never primary: it is the channel the user opts into, and the
loudest button on the card should not be a prerelease.

**A candidate that can't be installed** keeps its row and its release-notes
link, loses **Update**, and gets an attention notice (*Can't update*,
per-release reasons).

### The status row's states

| State | Icon | Title / subtitle | Trailing | Notice |
|-------|------|------------------|----------|--------|
| Checking | skeleton | skeleton / skeleton — only before the section's first answer | — | — |
| Not checked | `CircleDashed` `text-th-text-muted` | "Updates not checked" / "Checked only on request" — the server has nothing to say yet (no candidates, no `checked_at`, no error) | **Check**, `textButtonClass`, accessible name "Check for updates" | if the request failed, `error`: "Couldn't check: <error>"; if a forced check answered and is still not checked, "The check is still running on the server. Press Check in a moment to see its answer." |
| Up to date | `CheckCircle2` `text-th-text-muted` | "Up to date" / "Checked 3 min ago" (from the server's `checked_at` through `utils/relativeTime.ts`, so a cached answer says how old it is) | **Check again**, `textButtonClass` | — |
| Couldn't check | `Info` `text-th-text-muted` | "Couldn't check for updates" / "Checked 3 min ago", or nothing when no check ever answered | **Try again**, `textButtonClass` | the server's reason, then "If this server reaches the internet through a proxy, start pockode with `HTTPS_PROXY` set." |
| Development build | `Info` `text-th-text-muted` | "No updates for a development build" / "Built from source" | — | — (the version row already says *Development build*) |
| Installing elsewhere | Spinner | "Another update is running" / "Started 0:40 ago", or "On this machine" when it is another process's | — | "Another Pockode on this machine — a cluster node, or this server from another device — is installing a new version. This card checks again when you come back to it." |

- *Not checked* is what a fresh server answers until someone presses
  **Check**: the server asks GitHub only on request, so a visit by itself
  never fills this row in (*When it checks*). It is never drawn as *Up to
  date*, and never as an endless skeleton. Its visible label is the one word
  for the same reason as **Update**'s: at 320px "Check for updates" would cut
  the title to "Updates…". Like *Up to date*, it ignores `cannot_install` —
  the reason waits for a release it would matter to.
- *Couldn't check* is muted, as [cli-update-ui.md](cli-update-ui.md#the-installation-rows-states)'s
  is: Pockode works, only "is there something newer" went unanswered. It is
  never drawn as *Up to date*.
- **Check**, **Check again** and **Try again** ask the server to look now,
  past its cache; the server honours that at most once a minute and otherwise
  returns what it has, with its `checked_at`, so a press soon after another
  comes back with that check's real age ([code/websocket-rpc.md](code/websocket-rpc.md#server-updating-to-a-release)). Each is a text button
  (`textButtonClass`, "beside a value it acts on"), not a
  `secondaryButtonClass`, because it is upkeep beside a row with nothing to do.
- **A request that fails** — the server, not GitHub — leaves the last answer
  standing with an `error` notice: "Couldn't check again: <error>" under a row
  that had one, "Couldn't check: <error>" under *Not checked*, where nothing
  was checked before. With no answer at all yet, the row is *Couldn't check*
  with "Couldn't ask the server: <error>" and no proxy hint.
- **While a forced check is out**, the row keeps its title, its icon becomes a
  Spinner and its subtitle "Checking...", and the previous attempt's error
  notice is held back until the new answer. The button stays where it is, as
  wide as it was, with `aria-disabled` and muted text (`busyTextButtonClass`):
  a second press sends nothing, and it is not `disabled`, which would drop
  focus to the page mid-check. The busy state lasts at least 400 ms, and the
  card shows the check as it was at the press until then: a cached answer is
  instant, and a press that changes nothing visible invites another. It ends
  when the forced read lands, or a newer read does (that one joins the running
  check); a dropped connection forgets the press, since the reconnect may
  reach a restarted server that never ran it. Leaving Settings forgets it too
  — the check belongs to the server, and the next visit's read joins it.
- **Focus and announcements.** Focus stays on the button through the check,
  unless the answer replaces the status row with candidate rows; then it moves
  to the card. The card's status region, which otherwise speaks only of
  installs and the restart, reads a forced check out: "Checking for
  updates..." on the press, then "Up to date", "Update available: 0.25.0
  (latest)" / "Updates available: 0.25.0 (latest), 0.26.0-alpha.1 (alpha)",
  "Couldn't check for updates", "Still checking on the server" or "Another
  update is running". A failed request adds nothing — its notice is an alert —
  and a read the page made by itself is never announced, so an ordinary visit
  stays silent.
- *Installing elsewhere* is drawn from the check: the server reports an install
  of its own (started from another device) with its target and start, and an
  install by another process of the same OS user — which holds the lock — as
  busy, without either. While it shows, no **Update** is offered on this page:
  a press would only be refused.

### Can't update

Two kinds, drawn differently because they are about different things:

**About this server** — nothing can be installed whatever the release. The
candidate rows are still drawn, so the user knows what is out and can install it
from a terminal, but without **Update**, and one notice under the last of them
says why. With no candidate there is nothing to explain: the status row reads
*Up to date* as anywhere else, and the reason waits until a release makes it
matter.

| Reason | Notice title | Notice body |
|--------|--------------|-------------|
| `not_writable` | "Can't update from here: no write access to `<dir>`" | The server's `hint` (its `message` when there is none), which says what to do on this OS — the two ways out are listed in [platforms.md](platforms.md#updating-from-the-app) |
| `container` | "Can't update from here: running in a container" | "A file replaced inside a container is gone the next time it is recreated. Update by pulling a newer image." |

- `<dir>` is the directory of the **real file** — a symlinked `pockode` is
  replaced where it points, so that is the directory that has to be writable,
  and the copy names it rather than the link's. In `font-mono`, `break-all`.
- **The OS-specific advice is the server's text** (`hint`, from `notWritableHint`), shown as
  written, with each backtick span drawn in `font-mono` without its backticks:
  the server knows its OS and the install scripts' defaults, and one copy of
  that advice is enough. It deliberately never says `chown` the directory —
  that directory is usually `/usr/local/bin`, which should stay root's.
- The development build is not in this table: the version row already says
  *Development build*, and its status row is enough.

**About one release** — that release has nothing this server can install. Its
row stays, loses **Update**, and gets its own notice:

| Reason | Subtitle | Notice |
|--------|----------|--------|
| No file for this platform | "No build for linux/riscv64" | "Release 0.25.0 has no `pockode-linux-riscv64`, so it can't be installed here. Build it from source." |
| No `checksums.txt` | "Can't be verified" | "Release 0.25.0 has no `checksums.txt`, so its download can't be verified and Pockode won't install it." |

The subtitle replaces "Release notes"; the text block is still the link. The
asset name is the one `install.sh` / `install.ps1` / `scripts/build.sh` use
(`pockode-<os>-<arch>[.exe]`), from the server, so the copy says exactly the
file that is missing. Windows on Arm runs the x64 build
([platforms.md](platforms.md#release-binaries)) and reports `amd64`, so it never
lands here.

When *Installed unreadable* is on the version row, candidates are still offered
if the server can install: an update replaces the broken file, which is the fix
that row asks for. Its notice then reads "… Pockode can't restart until
`<path>` runs. Update it below, or reinstall it on the server." The restart
after the install probes the new file as always.

### Pressing Update

**Update** opens a `ConfirmDialog`. Opening it checks again (the cached answer
is fine — this is about "is it still a candidate", not "is there something
newer") and reads `server.version` again for the turn count, as the Restart
dialog does; until both land the dialog shows the card's last values and its
confirm button is disabled. If the candidate is gone from the fresh check —
installed from elsewhere meanwhile, or superseded — the dialog closes and the
card shows what is there now.

> **Update Pockode to 0.25.0?**
> Pockode downloads 0.25.0 (latest) from GitHub, verifies it and replaces
> /home/ada/.local/bin/pockode, then restarts. 2 AI turns are running now; any
> still running when it restarts are stopped — their sessions and history are
> kept. Other Pockode servers that run this file, cluster nodes included, keep
> the version they run until they restart. To go back, install 0.24.0 with
> the install script. This page reconnects by itself.
>
> Cancel · **Update and restart**

| Part | Copy |
|------|------|
| Prerelease (alpha only, first) | "0.26.0-alpha.1 is a prerelease and may be less stable than 0.25.0." — the latest it is offered over |
| What happens | "Pockode downloads 0.25.0 (latest) from GitHub, verifies it and replaces `<path>`, then restarts." |
| Cost, turns running | "1 AI turn is running now" / "N AI turns are running now" + "; any still running when it restarts are stopped — their sessions and history are kept." |
| Cost, none running | "No AI turn is running now; any running when it restarts are stopped — sessions are kept." |
| The shared file | "Other Pockode servers that run this file, cluster nodes included, keep the version they run until they restart." |
| The way back | "To go back, install 0.24.0 with the install script." — the running version, which is what "back" means to the user. No flag spelled out: it is `POCKODE_VERSION` for `install.sh` and `-Version` for `install.ps1` ([platforms.md](platforms.md#installing-a-specific-version)), and the dialog does not need to know the OS for one sentence |
| Ending | "This page reconnects by itself." |

- **"Running now", "still running when it restarts".** The download takes
  seconds to a minute, and a turn started meanwhile is stopped too; the count
  says now, the clause says the rule.
- **The shared file sentence is always there.** The server cannot tell whether
  another process runs the same file, and the user who would be surprised is
  the one running nodes or a second project from it. On a cluster node this is
  the sentence that matters: the cluster and its other nodes are now outdated
  against the file, and their own UIs say so.
- **Variant** `danger` while turns are running, `default` otherwise, as for
  Restart. Confirm label **Update and restart** in both — it says the second
  half the user might not expect from "Update".
- Plain text: `ConfirmDialog` takes a string. The release-notes link is on the
  row the user just pressed from.
- **Try again** after a failure opens this dialog again.

On confirm the dialog **closes at once** and the candidate row becomes
*Installing* (the other candidate row, if any, is hidden; the version row's
**Restart** is withheld, since a restart now would end the install). This is
unlike Restart, whose dialog stays up while its request is out: that request
answers in about a second, while a download can take a minute, and the row is
where a minute of progress belongs.

### Installing, and after

| State | Icon | Title / subtitle | Trailing | Notice |
|-------|------|------------------|----------|--------|
| Installing | Spinner | "Installing 0.25.0..." / "Started 0:12 ago"; from 2 minutes on "Started 2:10 ago · up to 5 min", the server's budget | — no Cancel | — |
| Restarting | — | the version row's *Restarting* takes the whole card, as for any restart | | |
| Installed, not restarted | — | the version row's *Restart needed* ("0.25.0 installed", **Restart** primary), and the status row | | see below |
| Failed | `AlertTriangle` `text-th-error` | see *Failed* | **Try again** (secondary) | see *Failed* |

- **The install is a request in flight, so it lives in the ws store**, beside
  `restartRequestedAt`, not in the section: leaving Settings while it runs must
  not lose the restart that follows it, and coming back must find *Installing*
  (web/AGENTS.md, a request already sent outlives its component). The store
  holds the target and the start time, sends `server.restart` when the install
  answers, and forgets both on that reply or on a reload. A failure is kept,
for its row and its Try again, until it is dismissed or a later check no
longer offers the release.
- **No Cancel.** Cancelling is safe on the server until the rename, but it buys
  little for a download this size, and a button that is safe for 30 seconds and
  then not is a button that has to explain itself.
- **Success**: the page sends `server.restart` itself, with no second dialog —
  the user confirmed both. From its reply the card is
  [restart-ui.md](restart-ui.md#while-it-restarts)'s: *Restarting*, the
  banner's "Restarting...", the reload when the new version answers `auth`.
- **The restart is refused after a good install** (another device restarted
  first, the server is shutting down, the new file somehow did not run): the
  card shows the version row's state from a fresh read — normally *Restart
  needed* — with the refusal in its notice: "0.25.0 was installed, but Pockode
  didn't restart: <message>". `already_restarting` is not a refusal here, as in
  the restart UI.
- **The connection drops during the install** (the phone slept, the relay
  hiccuped): the install runs on — it belongs to the server — and the page does
  not restart on its own once it reconnects. The user may have walked away from
  a decision they made minutes ago; a restart nobody is watching, which stops
  turns started since, is not one to send blind. After the reconnect the card
  reads again and lands where the server is: *Installing elsewhere* if it still
  runs, *Restart needed* with "0.25.0 installed" if it finished, the candidate
  again if it failed. In the last case the notice says "The connection was lost
  during the update; it didn't finish. `<path>` is unchanged." — the page knows
  it asked, and the check says the file is not the target.
- The status `<output>` beside the card ([restart-ui.md](restart-ui.md#the-rows-states))
  also holds "Installing 0.25.0..." and a failure's title, so each is heard
  once.

### Failed

The candidate row keeps its title, its link and gains **Try again**; its notice
has a body that says what happened and what to do, and every body ends with
"`<path>` is unchanged." — the rule that failure here costs nothing, said each
time — except `restore_failed`, the one failure where it is not true. Details (`Details` from `loginParts.tsx`, collapsed) carry the server's
detail when there is one: the URL tried, the expected and actual sha256, the
Windows error code.

| Reason | Title | Body | Trailing · footer |
|--------|-------|------|-------------------|
| `checksum_mismatch` | "The download didn't match its checksum" | "`pockode-linux-amd64` from 0.25.0 doesn't match the release's `checksums.txt`, so it was discarded. Try again; if it keeps failing, the download is being changed on the way — a proxy or a filter in between." | **Try again** · Dismiss |
| `download_failed` | "Couldn't download 0.25.0" | The server's message (it names GitHub or the error), then "If this server reaches the internet through a proxy, start pockode with `HTTPS_PROXY` set." | **Try again** · Dismiss |
| `not_runnable` | "0.25.0 didn't run on this machine" | "The downloaded file failed `--version`: <reason>. It was discarded." | — · Dismiss — trying again downloads the same file |
| `replace_failed` | "Couldn't replace pockode" (`pockode.exe` on Windows) | "<reason>. On Windows this is usually antivirus still scanning the new file; try again in a minute." — the Windows sentence only on Windows; the server has retried with back-off before it says this | **Try again** · Dismiss |
| `restore_failed` (Windows only) | "Couldn't replace pockode.exe, and the old one wasn't put back" | The server's message, which names where the old file is now and the rename that puts it back, then "This Pockode keeps running, but it can't restart or start again until `<path>` is back." The version row turns *Installed unreadable* on its next read, which is right | — · Dismiss — another try would move aside a file that is not there |
| `timeout` | "The update took too long" | "Pockode stopped after 5 minutes. Try again on a better connection, or run the install script on the server." | **Try again** · Dismiss |
| `no_checksums` | "Update failed"; the subtitle and body as the per-release *Can't update* row: "Release 0.25.0 has no `checksums.txt` …" | — | — · Dismiss — the release itself lacks it |
| `no_asset` | "Update failed"; the subtitle and body as the per-release *Can't update* row: "Release 0.25.0 has no `pockode-linux-riscv64` …" | — | — · Dismiss — known only now when the check came from `releases.atom`, which lists no assets |
| `not_installable` | the matching *Can't update* row replaces the candidate rows — the directory stopped being writable since the check, say | — | — |
| `release_gone` | — | the card checks again and draws what it gets: the release was withdrawn or replaced | — |
| `already_installing` | — | the card draws *Installing elsewhere* | — |
| Anything else | "Update failed" | The server's message, verbatim | **Try again** · Dismiss |

- **The failure is this page's memory**, not a record on the server like a CLI
  update's. Nothing changed on disk, so no other device has anything to be told;
  a reload clears it, as does **Dismiss**, a successful check that no longer
  offers this release, or the next press.
- `not_runnable` means the release itself is broken for this machine — wrong
  architecture under emulation, a binary that cannot start on this OS version.
  Pressing again would fetch the same file; the release notes and the issue
  tracker are where it goes from here.

## web-cluster: the header

The version button and the **Pockode cluster** sheet are
[restart-ui.md](restart-ui.md#web-cluster-the-header)'s. The sheet gains the
candidates and becomes their confirmation too (cluster rule 3: one overlay, a
second question in the same sheet). It updates the **cluster manager only**;
the nodes are updated by being restarted into the new file, with the controls
that already exist (*After the update*).

### The version button

Unchanged, plus one marker:

- A **latest** candidate — installable or not; the user may update from a
  terminal — adds a 6px accent dot after the version
  (`h-1.5 w-1.5 rounded-full bg-th-accent`, `aria-hidden`). Not for an alpha
  (*No nagging, still*), and not the up-arrow, which keeps meaning "the file on
  disk differs — restart". Both can show: "↑ v0.23.0 → 0.24.0 •".
- The accessible name adds ", 0.25.0 out" after what it says today:
  "Pockode cluster v0.24.0, 0.25.0 out".
- The button never says "Update": it opens the sheet, which says the rest.

### The sheet

```
Pockode cluster
──────────────────────────────────────
Running     0.24.0
Installed   0.24.0

0.25.0 (latest)                [ Update ]
Release notes ↗
0.26.0-alpha.1 (alpha)           Update
Release notes ↗
Checked 3 min ago · Check again

Restarting the cluster manager doesn't
affect nodes: they keep running and stay
reachable at their own addresses. This
panel reconnects by itself.

                     Cancel · Restart
──────────────────────────────────────
```

- **The candidate rows** are the `web` rows in this panel's parts: the text
  block a link (`min-h-[44px]`), **Update** a `PRIMARY_BUTTON` for latest and
  `NEUTRAL_BUTTON` for alpha, the accessible names as in `web`. No icons: the
  panel has no icon library, and the dl above already sets the sheet's tone.
- **The check line** under them, `text-xs text-th-text-muted`: "Checked 3 min
  ago" and **Check again** (a 44px text button). With no candidate it reads "Up
  to date · checked 3 min ago · Check again"; on a failure "Couldn't check for
  updates: <reason> · Try again".
- **The footer's Restart** follows the `web` primary rule: `NEUTRAL_BUTTON`
  when a latest row carries **Update**, `PRIMARY_BUTTON` for *Versions differ*
  otherwise — a latest row the cluster can't install does not take it.
- **Can't update** — `web`'s notice title and body (for `not_writable`, the
  server's `hint`), as a paragraph under the rows. A development build
  shows no rows and no check line: the dl already reads "development build".
- **Another install running** — "Another Pockode on this machine is installing
  a new version." in place of the check line, no **Update**.
- **Before the first check answers**, "Checking for updates..." stands in
  for the check line.

### Confirming, in the sheet

**Update** turns the sheet into the confirmation, in place:

> **Update the cluster to 0.25.0?**
> The cluster downloads 0.25.0 (latest) from GitHub, verifies it and replaces
> /home/ada/.local/bin/pockode, then restarts. Nodes keep running and keep
> their version — afterwards they show as outdated, and Restart all outdated
> moves them over. To go back, install 0.24.0 with the install script.
> Release notes ↗
>
> Back · **Update and restart**

- The prerelease sentence leads for an alpha, as in `web`. No turn count: the
  cluster runs no AI turn ([restart-ui.md](restart-ui.md#the-cluster-sheet)).
- The release-notes link is here too: a `Sheet` takes any content, unlike
  `ConfirmDialog`, and this is the last look before the press.
- Opening it re-checks, as in `web`; until the answer lands **Update and
  restart** is disabled, and a candidate that is gone returns the sheet to its
  first view.
- `PRIMARY_BUTTON` for both channels — the choice was made on the button
  before.

**In flight** the sheet stays and is not dismissible, as for every in-flight
action in this panel (`NodeCard`, `NodeForm`): the button reads
"Installing..." with a spinner, Back is disabled, and a line above the footer
says "Started 0:12 ago" — "· up to 5 min" from two minutes on. The sheet is the
only place this panel has for the install's progress and its failure; a
dismissible sheet would need a second home for both, in a header that has room
for neither.

- **Success**: the page sends `server.restart`; on its reply the sheet closes
  and the header is [restart-ui.md](restart-ui.md#the-cluster-sheet)'s
  *Restarting*. A refused restart stays in the sheet, which goes back to its
  first view with "0.25.0 was installed, but the cluster didn't restart:
  <message>" as a `role="alert"` and Restart (now primary) in the footer.
- **Failure**: the sheet goes back to its first view with the failure under the
  candidate, `role="alert"`, worded as `web`'s *Failed* table with "the
  cluster" for "Pockode", ending with "`<path>` is unchanged." (but for
  `restore_failed`); **Update** is the retry where `web` offers Try again.
- **The connection drops**: the sheet goes back to its first view with "The
  connection was lost during the update. The cluster checks again when it
  reconnects." When it does, the dl and the rows say where the server is —
  *Versions differ* ("Restart to use 0.25.0.") if the install finished, the
  candidate if it did not. No restart is sent on its own, for `web`'s reason.
  The page's own timeout running out, with the connection still up, is the
  same not knowing: "No answer came for the update, so it may or may not have
  finished. What is shown here is checked again." — never "unchanged", and no
  restart.

### After the update

The cluster comes back on 0.25.0; its nodes are still running 0.24.0 from the
replaced file. Nothing new is needed: they are now *outdated* against the
installed version and the panel already says so — the version line on each
card, the **Restart all outdated** strip from two
([restart-ui.md](restart-ui.md#restart-all-outdated)). Nodes started by a build
from before node restarts are the older nodes they already were, with their
one-time stop-and-start. The confirmation's "afterwards they show as outdated"
sentence is what joins the two.

Updating a node's Pockode from that node's own Settings replaces the same file;
the cluster header then shows its own *Versions differ* arrow, and the other
nodes their version lines — the shared-file sentence in `web`'s dialog said so.

## When it checks

| Trigger | web | web-cluster |
|---|---|---|
| The section / sheet mounts | ✓ (section) | on every successful connect, as the installed read |
| The page becomes visible again | ✓ | ✓ |
| The confirmation opens | ✓ (cache is fine) | ✓ |
| A failed install, a dropped install | ✓ | ✓ |
| **Check** (web) / **Check again** / **Try again** | ✓, forced | ✓, forced |
| A timer | — | — |

The check is a separate request from `server.version`, so a slow GitHub never
holds up the version row or the Restart button — the reason the CLI check is
separate from sign-in status. Never on the node poll, never on a timer.

On the server, only a forced check (**Check**, **Check again**, **Try
again**) asks GitHub; every other row above is answered from what the
process already knows, which on a fresh process is nothing (no `checked_at`,
no error).
Every Pockode behind one address — each node, the cluster, a second server —
spends from one GitHub rate limit, so none of them asks unless a user does
([code/self-update.md](code/self-update.md#asking-github-rarely)). Until
someone has checked, the server has nothing on offer, and a `server.update`
answers `release_gone`.

## What the UI needs

The wire contract — fields, reasons, the cache, the budget — is
[code/websocket-rpc.md](code/websocket-rpc.md#server-updating-to-a-release),
and its shapes are `@pockode/shared`'s (`ServerUpdateCheck`,
`updateFailedReason`, `UPDATE_BUDGET_MS`), because a `pockode` server and a
cluster serve the same methods. What the screens above rely on it for:

- **Each part of a check can be drawn on its own.** The candidates, the
  failure to check, the per-server reason nothing can be installed and the
  install under way are independent fields. That is how *Can't update* keeps
  the candidate rows, and *Couldn't check* keeps the last good ones. A check
  with neither `checked_at` nor an error means the process has not checked
  yet — nobody has forced a check since it started, or the first is still
  running — and is never drawn as *Up to date* (`web` draws it *Not
  checked*).
- **The newest latest release comes even when it is not a candidate**, for the
  alpha dialog's "may be less stable than 0.25.0".
- **The server holds the floor.** It installs only a candidate of its own
  check, measured against the installed file again under the install lock. A
  stale page can at worst get `release_gone`, never a downgrade.
- **The downloaded file is run before the rename**, with `--version`, and must
  report the version asked for. That is why every failure but
  `restore_failed` can promise the file is unchanged.
- **The install belongs to the server process, not to the request.** A dropped
  connection does not stop it, which is why the page never restarts on its own
  after a reconnect: the next check says how it ended.
- **The restart is the existing `server.restart`**, unchanged.

## What to test

- Candidates: latest only when newer than running and installed; alpha only
  when also newer than latest; none for a dev build; a candidate equal to the
  installed version is not drawn (the version row says *Restart needed*).
- The primary rule: latest's Update is primary; Restart only without a latest
  Update; an alpha never.
- The candidate's text block is one link to the release; the Update button's
  accessible name is "Update to <version> (<channel>)".
- Each status-row state renders its row; *Couldn't check* is never *Up to
  date*; **Check again** sends `force`.
- A first answer with neither `checked_at` nor `check_error` is *Not
  checked* with a "Check for updates" button — no skeleton, no *Up to date*,
  nothing announced. Pressing it sends `force`; while out the subtitle is
  "Checking...", the button is `aria-disabled` and keeps focus, and a second
  press sends nothing. Each answer draws its row: *Up to date* (focus kept),
  candidates (focus to the card), *Couldn't check*, still not checked (its
  notice); a failed request reads "Couldn't check: …" and keeps *Not checked*.
- Check again and Try again show the busy state even when the answer is
  instant; a dropped connection forgets the press; the status region announces
  a forced answer and stays empty for every other read.
- *Can't update*: server reasons keep the candidate rows without Update and add
  the notice; per-release reasons drop only that row's Update; Restart is there
  in every case.
- The dialog re-checks on open, closes when the candidate is gone, carries the
  parts per the table, `danger` only with running turns.
- Confirm: the row goes *Installing*, Restart is withheld; success sends
  `server.restart` once, with no second dialog; a refused restart lands on
  *Restart needed* with the message.
- A drop during the install never sends a restart after the reconnect.
- Each failure reason renders its row; every body but `restore_failed`'s ends
  with the path unchanged.
- Leaving Settings during an install still sends the restart, and coming back
  shows *Installing*.
- web-cluster: the dot only for a latest candidate; the sheet's rows and check line;
  the in-sheet confirmation is not dismissible while out; failure and a dropped
  connection return to the first view with the message.

## Considered and not done

- **Updating without restarting** ("Install only"). A second button per
  candidate for the user who wants to wait for turns to end; the restart UI
  already turned down "restart when idle" for the same reason
  ([restart-ui.md](restart-ui.md#considered-and-not-done)), and a failed restart
  after the install lands on exactly that state anyway.
- **Choosing a channel in Settings** instead of showing both. Both fit in two
  rows, and a setting would hide the one the user did not choose — the alpha
  user would not see that a latest overtook it.
- **Any version, or a downgrade.** The install script does it, with a command
  the confirmation spells out; a version list in a phone UI is a picker for a
  case that happens rarely and wants care.
- **Updating the nodes from the cluster's Update.** The cluster updates itself;
  the nodes go through their own restarts, whose costs they already state.
- **Restarting by itself after a dropped install.** *Installing, and after*.
- **Cancel, and a progress bar.** The download is one file; an elapsed time is
  honest, and a Cancel that stops being safe at the rename is not.
- **Rendering release notes in the app.** A link to GitHub is the full page,
  with the notes as written; rendering them here is a Markdown surface for
  something read once.
- **A badge on Settings or a banner in the chat for a new release.** *No
  nagging, still.*
- **Updating automatically.** It would stop AI turns nobody chose to stop.
