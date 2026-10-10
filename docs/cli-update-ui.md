# AI CLI Update UI

How a user sees which version of Claude and Codex the server machine has,
learns that a newer one is out, and updates to it from a phone — no terminal on
the server. Where the version lives, what an update looks like while it runs,
what every failure says, and what happens to sessions that are running. How
the server does its part is [code/cli-update.md](code/cli-update.md).

Related: [cli-login-ui.md](cli-login-ui.md) for the card this extends and the
conventions it already set, [code/cli-auth.md](code/cli-auth.md) for the
sign-in status the card also shows, [lifecycle.md](lifecycle.md) for when a
session's CLI process starts and closes, [responsive-ui.md](responsive-ui.md)
for the width ladder and hit-area floors, [cluster.md](cluster.md) for why the
cluster frontend has none of this.

## The rules

**One place, next to sign-in.** An update is done from the CLI's card in
Settings, the card that already shows its sign-in and its version. Both are
answers to "is this CLI ready to work?", and the user who came to fix one often
needs the other: a sign-in that broke after a CLI update is fixed by the next
update or by signing in from a terminal
([cli-login-ui.md](cli-login-ui.md#failed), *Flow broke*).

**"Update", never "Upgrade" or "Install".** "Update" is the verb both CLIs use
for themselves. "Install" is kept for a CLI that is not there at all
(*Installing a missing CLI*).

**The installed version is state, the update is an event.** The version on the
card is always read from the CLI. An update's record says what happened: from
which version, to which, and how it ended, in the past tense. The card never
takes the current version from the record — a terminal, Claude's own
auto-updater or another Pockode can change the CLI after the record was written
(AGENTS.md, *Events are events, state is state*).

**The CLI updates itself; Pockode checks the result.** The update is the CLI's
own `update` command, which knows how it was installed (a native build, npm,
Homebrew, …) better than Pockode could guess
([code/cli-update.md](code/cli-update.md#the-update-is-the-clis-own)). What
Pockode adds is the check that command's exit status cannot give: the version
Pockode *runs* is read again afterwards, so an update that went to another
install on the machine is reported as a failure rather than taken on the CLI's
word.

**No Cancel.** An installer killed halfway is the one reliable way to leave a
CLI broken, so an update runs to its end or to the server's timeout. The button
is not offered at all, rather than offered and made to lie.

**Never interrupt a session.** An update does not stop, restart or wait for
running sessions. What it means for them is said before the user presses
(*Running sessions*).

**No nagging.** Claude ships almost daily. An update available is shown on the
card and nowhere else — no badge on Settings, no banner in the chat. A marker
that is on nearly every day stops meaning anything.

## Where it lives: Settings → AI CLIs

The section is labelled **AI CLIs**, since it holds more than sign-in; its id
is still `cli-sign-in`, and its priority (50) and position are
[cli-login-ui.md](cli-login-ui.md#where-status-lives-settings--ai-clis)'s. The
work engine's stop comment names it by the label; stop comments written before
the rename keep the old "CLI sign-in": they are history.

Each card is a header and exactly two rows, always both, in every state:
**Installation** (the version, the update or install) first — a CLI has to be there before
it can be signed in to — then **Account** (sign-in,
[cli-login-ui.md](cli-login-ui.md#the-card-states)). The version is in a row
rather than in the header, since the row can say more than a number:

```
AI CLIS
                                        ↻ Refresh
┌───────────────────────────────────────────────────┐
│ Claude                                            │
│ ↑  Version 2.1.283                     [ Update ] │  installation
│    2.1.290 available                              │
│ ●  Signed in                           Sign out   │  account
│    ada@example.com · Max                          │
├───────────────────────────────────────────────────┤
│ Codex                                             │
│ ✓  Version 0.153.0                                │
│    Up to date                                     │
│ ○  Not signed in                      [ Sign in ] │
│    Sign in to use Codex                           │
└───────────────────────────────────────────────────┘
```

**The card never changes shape while values arrive.** Status, check and update
record are three requests that answer in any order; if each answer added or
removed a line, the card would jump three times on every visit. So a row is a
fixed box (`CliRow`, `web/src/components/Settings/sections/`) that values fill:

- An icon slot, always there; a **title** in `text-sm leading-5
  text-th-text-primary`; a **subtitle** in `text-xs leading-4
  text-th-text-muted`, always rendered (a non-breaking space when there is
  nothing to say). Both are one line, `truncate`, so a button appearing beside
  them changes their width, never their height — which is why every ordinary
  state's copy is short enough to stay whole beside its button on a 320px
  phone. An attention state's title (a failure, *Couldn't read sign-in
  status*) wraps instead: its height is news anyway. The icon carries the
  colour: the success and warning tokens do not reach text contrast on the
  light theme. A row that cannot act yet is dimmed by its title's colour and
  its icon's opacity, never by fading the text, which would drop the muted
  subtitle below text contrast.
- A **trailing slot** for at most one action, inside the row. Every action is
  `min-h-11`, as is the row, so a row is 44px with or without one.
- **Loading** draws skeletons inside the same boxes — icon, title, subtitle —
  and leaves the trailing slot empty: which button will come, if any, is not
  known, and the row's height is held anyway. Refresh and the re-read on
  visibility never go back to skeletons; the last values stay while the
  spinner on Refresh turns.
- A **notice** under a row is the only thing that adds height, and only for
  *attention* states: a failure, a refused action, an unreadable value, a
  reason, *Not yet available*, *Managed outside Pockode*. These are rare, and
  the extra height is the news. A reason is never left only in a `title`
  attribute — a phone has no hover. The notice is indented to the row's text
  and holds, in order, a body in `text-xs text-th-text-muted`, a collapsed
  **Details**, a red `role="alert"` for an action's error, and a right-aligned
  footer of secondary actions.

Buttons:

- **Update** is `secondaryButtonClass`
  (`web/src/components/CliLogin/loginParts.tsx`), in the row's trailing slot.
  It is never primary: the card's one primary action is the sign-in's, and an
  update is rarely what stands between the user and a working session. An
  update's **Try again** is the same; **Dismiss** is `cardTextButtonClass` in
  `text-th-text-secondary`, in the notice's footer.
- **Install**, and an install's **Try again**, are primary: a CLI that is not
  there has no sign-in to offer (its account row is dimmed), so the install is
  the card's one primary action.
- **Refresh** at the top of the section reads the update check too, and its
  spinner turns while either read is in flight. The check also runs when the
  section mounts and when the page becomes visible again, beside the sign-in
  status — it is a separate request, so a slow registry never holds up the
  sign-in row, nor the other way round.

Desktop gets the same layout, as the sign-in cards do: Settings is `max-w-2xl`,
and the button stays next to the thing it acts on.

### The installation row's states

| State | Icon | Title / subtitle | Trailing | Notice |
|-------|------|------------------|----------|--------|
| Loading | skeleton | skeleton / skeleton — until the check answers or sign-in status brings a version | — | — |
| Checking | — | "Version 2.1.283" / "Checking for updates…" (the version from sign-in status while the check is out) | — | — |
| Up to date | `CheckCircle2` `text-th-text-muted` | "Version 2.1.283" / "Up to date" — also when the installed version is newer than the channel's latest, which a prerelease or a switch of channel leaves behind; that is never offered as a downgrade | — | — |
| Update available | `ArrowUpCircle` `text-th-accent` | "Version 2.1.283" / "2.1.290 available"; when the channel is not `latest`, "2.1.290 on stable" | **Update** | — |
| Updating | Spinner | "Updating Claude…" / "Started 0:42 ago" (from `started_at`), or "Started earlier." when this page did not start it — after a reload the same phone is a new page, as with a sign-in | — | why it can't be followed, if it can't |
| Updated | `CheckCircle2` `text-th-success` | "Updated to 2.1.290" / "from 2.1.283". When the version did not move — the CLI was already at the newest release when the update ran (a terminal or Claude's auto-updater got there first), or the registry could not be read to say otherwise — "Already up to date" / "Version 2.1.283" | — | — |
| Not yet available to this install | `Info` `text-th-text-muted` | "Version 2.1.283" / "2.1.290 is out · not reachable yet" | — it lifts by itself when the latest moves on, the installed version changes, or after a few hours ([code/cli-update.md](code/cli-update.md#not-yet-available)) | "The last update didn't reach it: the way Claude is installed may not have it yet, or the update went to another install on this machine." — both, since the server cannot tell them apart |
| Update failed | `AlertTriangle` `text-th-error` | See *Failed* | See *Failed* | See *Failed* |
| Couldn't check | `Info` `text-th-text-muted` | "Version 2.1.283" / "Couldn't check for updates" | — Refresh is the retry | the server's reason |
| Version unreadable | `AlertTriangle` `text-th-error` | "Couldn't read the version" / "Version unknown" | — | the server's reason |
| Not installed | `CircleSlash` `text-th-text-muted` | "Not installed" / "Installs with npm" — short enough to stay whole beside the button at 320px; the dialog says the rest | **Install** (primary) | — |
| Installing | Spinner | "Installing Claude 2.1.290…" (no version when the server could not read the channel's release) / "Started 0:42 ago", from two minutes on "Started 2:10 ago · up to 10 min", the server's budget; "Started earlier." when this page did not start it | — no Cancel, for the reason an update has none | why it can't be followed, if it can't |
| Installed | `CheckCircle2` `text-th-success` | "Installed Claude 2.1.290" / "Checking for updates…" until the check read after it answers, then "Version 2.1.290 · Up to date" (or "· 2.1.291 available", with **Update** offered once the row draws the check again); "Couldn't check for updates" if that read fails | — | the failed read's reason |
| Install failed | `AlertTriangle` `text-th-error` | See *Failed* | See *Failed* | See *Failed* |

"Couldn't check" and "Version unreadable" are the server's one `unavailable`
state, told apart by which version it could not read: no installed version is
*Version unreadable*, anything else — the latest missing, or both read but not
comparable — is *Couldn't check*. "Couldn't check" is
muted, not red: the CLI works, only "is there something newer" went unanswered,
usually because the server is offline. It is never folded into "Up to date" —
the benign guess the sign-in card already refuses to make. "Version unreadable"
offers no **Update**: the CLI's own update command is the CLI, and one that
cannot print its version is not one to trust with replacing itself.

**Which update record the row shows.** The server keeps each CLI's latest
update after it ends, until it is dismissed or the next one starts. The row
draws it by these rules, and otherwise draws the check:

- **Running** — always, whoever started it.
- **Succeeded** — only when this page saw it running and then saw it end.
  "Updated" then stays until the user leaves Settings: it is the one
  confirmation the update gets, and a user who pressed and looked away should
  find it when they look back. A success that ended before this page subscribed
  was confirmed on the screen that watched it; here the row draws the check.
- **Failed install** — while the CLI is still missing: the check has not
  answered, or reads `not_installed`, or `installing` for this same install.
  Once the CLI is there, however it got there, or another install has started,
  the failure is about a state that is gone.
- **Failed** — until it is dismissed or another update starts, on every page
  and after a reload: a failure the user never saw would be a silent one. Except
  when the version the check reads now and the version the update left — the
  record's version read after it, else its `from` — are both known and differ:
  someone changed the CLI since (a terminal, Claude's auto-updater), and the
  failure is about a version that is gone. It is the version *after*, not
  `from`, because a failure can move the CLI part of the way (a package manager
  with an older release than the target), and that failure is still news. An
  empty version on either side hides nothing.

*Not yet available to this install* exists because "latest" is read from the
npm registry, where both CLIs publish every release, while an install through
another package manager gets it later. Without it, such an install would show
**Update**, run an update that changes nothing, fail, and after Dismiss offer
the same button again. The server decides it
([code/cli-update.md](code/cli-update.md#not-yet-available)); the row only
draws it.

**A start the server refuses** — a sign-in to the CLI is running, another
Pockode on the machine is updating it, the server is shutting down, and the
rest in [code/cli-update.md](code/cli-update.md#the-rpc) — produces no
record, so it is drawn where a refused sign-out is: the server's message under
the installation row in its notice, `text-xs text-th-error role="alert"`, gone
when the check or the record changes.

The status role is one visually hidden `<output>` that stays mounted beside the
row, and it holds the update- and install-phase text only, so a screen reader
hears "Updating Claude…", "Updated from … to …", "Installing Claude…",
"Installed Claude 2.1.290" and a failure's title once each — not
"Checking for updates" and "Up to date" for both cards on every refresh. A
region mounted with its text already in it is often not read at all, which is
why it is not one per phase. The elapsed time is outside it.

## Installing a missing CLI

**Install** runs the server's npm install
([code/cli-update.md](code/cli-update.md#installing-a-missing-cli)) — npm
whichever way the user would otherwise install the CLI. It opens a
`ConfirmDialog` (default variant), for the reasons **Update** does: Pockode
cannot undo it, and it reaches the whole machine.

> **Install Claude?**
> Pockode runs npm install --global for the latest Claude (latest channel) on
> the server, as the user running Pockode. It is for the whole machine: every
> project and cluster node here will use it.
>
> Cancel · **Install**

The message is plain text (`ConfirmDialog` takes a string), so it holds no
link; the install page is offered where the npm route has failed instead
(*Failed*). Opening the dialog reads the check again, and the dialog closes when
that read — or the record — shows the CLI there, or an update or install
already running.

On confirm the button shows a spinner while the request is out, and the reply
is the running record, so the row goes to *Installing* at once. While it runs
the account row is dimmed, as for *Not installed*. When this page sees it
succeed, the row says *Installed* and the store reads the check and sign-in
status again: the account row draws "Sign-in" with a skeleton subtitle until
status answers, then its state — usually **Sign in**. No reload, and no row
added or removed: the card keeps its height. *Installed* stays until the user
leaves Settings, as *Updated* does.

A check or status read while the install ran — the page came back into view
mid-install — answers `installing` / `updating` for it. Once the record has
ended those reads are history (an update's too, by the same rule): the card sets them aside (the store's
`isStaleRead`) and draws from the record and the last settled reads until the
store's re-reads land, so the account row moves on as soon as status answers
and a failure's **Try again** opens its dialog.

**Refused installs** leave no record and are drawn as a refused update start:
the server's message in the row's notice, gone when the check or record moves.
`npm_not_found` adds **Install instructions ↗** to the notice's footer. A
refusal for `already_installed` shows nothing: the store reads the CLI again
and the row moves on by itself.

An update that failed with *Not installed* offers **Install** in its trailing
slot, in place of the install page. Until the CLI is read again, the card takes
that failure's word over the check and sign-in status held from before it: the
account row dims, and the Install dialog stays open.

## Pressing Update

**Update** opens a `ConfirmDialog` (the default variant, not danger — nothing is
lost):

> **Update Claude?**
> 2.1.290 is available; this server has 2.1.283. The update is for the whole
> machine: every project and cluster node here uses the same Claude.
> Running sessions aren't interrupted — they keep 2.1.283 until they close, and
> use the new version from their next start.
>
> Cancel · **Update**

- It asks because an update cannot be undone from Pockode (no rollback, see
  *Considered and not done*) and because it reaches past this screen: the CLI is
  machine-wide, like its sign-in.
- The title names no version. The CLI's update installs whatever is newest when
  it runs, which may be newer than the check; the result line reports the
  version it actually ended up at.
- The dialog reads the check for its CLI again as it opens, so the version
  and the count are current, not the card's from whenever it was drawn. When
  this server has sessions with the CLI's process running (`running_sessions`,
  idle ones included), the last sentence begins with the count: "Claude is open
  in 2 sessions in this project. They aren't interrupted — …". With none it
  reads as above. The count covers this server only; the dialog's second
  sentence is what speaks for the rest of the machine. If that read — or the
  update's record — shows an update already running, started from another
  device, the dialog closes and the row shows it: confirming would only have
  joined it.
- **Try again** after a failure opens the same dialog: the failure may be hours
  old, and the count and target may have moved.

On confirm the row goes to **Updating** at once — the reply to the start is the
running update — and stays there however the user moves around: the update
belongs to the server, not to the page.

### While it runs

- **The account row holds still.** The CLI's files are being replaced, so its
  sign-in commands are not run meanwhile: the row keeps the icon and title of
  the sign-in state it last read, its subtitle becomes "Wait for the update to
  finish.", and its action (Sign in, Sign out, Continue, Retry) is withheld.
  After a reload there is no earlier state to keep, so the row reads "Sign-in"
  / "Checked after the update." The sign-in sheet, opened meanwhile from the
  chat, says "<CLI> is being updated" with Close and Retry, and starts
  nothing. When the update ends, the store reads sign-in status again, as it
  does when a sign-in ends.
- **The reverse too:** while a sign-in to the CLI runs, **Update** is withheld
  and the subtitle reads "2.1.290 · update after sign-in" (a failure's
  **Try again** gives way to "Finish or cancel the sign-in first." in its
  footer) — the sign-in's process is the binary the update replaces.
- **The other CLI's card is untouched.**
- **Leaving closes nothing.** Navigating away, backgrounding the PWA, a dropped
  socket, a reload — the update runs on. On return the row follows the server's
  current copy: still *Updating*, or a failure that happened meanwhile.
- **New sessions are not blocked.** A session started with the CLI mid-update
  meets whatever the update has left in place at that instant — a known limit
  ([code/cli-update.md](code/cli-update.md#running-sessions)).

There is no progress bar. Neither update command reports progress in a form
worth drawing, and a bar that sits at 90% for a minute is worse than a spinner
with an honest elapsed time.

### Failed

One layout, the sign-in sheet's failure layout folded into the row: the icon,
the row's **title** saying what happened, its subtitle the version as the check
reads it now (or "Not installed"), **Try again** in the trailing slot, and a
notice with a **body** that says what to do, a collapsed **Details**
(`Details`, `web/src/components/CliLogin/loginParts.tsx`) with the update
command's last lines, and the footer. The title and body have to be enough
without opening Details.

| Reason | Title | Body | Trailing · footer |
|--------|-------|------|-------------------|
| The update command failed | "Claude couldn't update itself" | The last line of the command's output, verbatim, passing over npm's closing "A complete log of this run…", the advice paragraph npm puts before it ("If you believe this might be a permissions issue, … as root/Administrator") and the advice Claude closes with ("Possible causes:", "Try:" and their bullets) — it is where the CLI says why (no write access, a Homebrew install it wants `brew` for, a download that failed, files in use on Windows). Then: "Fix it on the server, or run `claude update` there." | **Try again** · Dismiss |
| Not applied | "Claude was still at 2.1.283 after updating" — "Claude wasn't updated" when neither version was read | "The update didn't reach the `claude` Pockode runs (`<resolved path>`). Either the way it is installed doesn't have 2.1.290 yet, or the update went to a second install on this machine — update that one from a terminal, or remove one." Details start open. | — · Dismiss |
| Timed out | "The update took too long" | "Pockode stopped waiting for it. If Claude no longer starts, run `claude update` on the server." | **Try again** · Dismiss |
| Not installed | "Claude wasn't found" | "Pockode can't find the `claude` command. Install it again, or install it on the server yourself." | **Install** · Dismiss |
| Anything else | "Update failed" | The server's message, verbatim | **Try again** · Dismiss |

An install that failed has the same layout, its subtitle "Not installed" and
its **Try again** primary — it reopens the Install dialog. Every body says how
to get past the failure, since pressing again mostly fails the same way:

| Reason | Title | Body | Trailing · footer |
|--------|-------|------|-------------------|
| `permission_denied` | "npm can't write its global folder" | "npm's global folder belongs to another user (usually root). Give it to this user, or set a prefix in your home directory (`npm config set prefix ~/.npm-global`), add its `bin` to the PATH pockode starts with, restart pockode, then try again." — without the PATH step, following it would fail as `not_on_path` | **Try again** · Install instructions ↗, Dismiss |
| `not_on_path` | "Claude installed, but Pockode can't find it" | "npm installed it, but the folder npm puts commands in isn't on the PATH pockode was started with. Add it (`npm prefix --global`, plus `/bin` on Linux and macOS) and restart pockode." Details start open: they name the prefix when npm said | — (installing again lands in the same folder) · Dismiss |
| `command_failed` | "npm couldn't install Claude" | npm's last line, picked as an update's is, then "Install it on the server yourself, or try again." | **Try again** · Install instructions ↗, Dismiss |
| `timeout` | "The install took too long" | "Pockode stopped npm after 10 minutes. Try again, or install Claude on the server yourself." | **Try again** · Dismiss |
| Anything else | "Install failed" | The server's message, verbatim | **Try again** · Install instructions ↗, Dismiss |

- The command in the bodies — `claude update`, `codex update` — is the CLI's own
  name plus `update`, in `font-mono`, the terminal answer
  [cli-login-ui.md](cli-login-ui.md#failed) gives for a broken sign-in.
- The row's subtitle is the version from the check as it is now — never the
  record's `from` — so a partly applied update shows what the CLI really is.
- **Dismiss** asks the server to drop the failed record, for every client. The
  row then draws the check.
- A failure of a CLI the check now reads as not installed is drawn in place of
  *Not installed*, until it is dismissed or an install replaces it.
- **Not applied** is the server's verdict, not the UI's. Without it, a machine
  with two installs would report success forever while every session kept the
  old version.
- Details go to every client, so the server strips the credentials it
  recognizes before the output is stored
  ([code/cli-update.md](code/cli-update.md#success-is-the-target-reached)).

## Running sessions

What happens is decided by how the CLIs run, not by the UI; the UI's job is to
say it truthfully.

- A session's CLI process is started for a turn and closes once it has been idle
  for a while — 5 minutes by default (`--idle-timeout`), longer while a turn
  waits on a person or on background work ([lifecycle.md](lifecycle.md), the
  lease table). A process that is already running keeps the program it started
  with; its next start, which resumes the same conversation, uses the new
  version. That is the dialog's last sentence.
- Pockode does not stop sessions to let an update through: a turn is the
  user's work, and an update can wait for it. Where a running executable
  blocks the CLI's update (Windows), the command fails, its last line says so,
  and **Try again** once the sessions have closed is the answer.
- Whether the files a running process still reads survive being replaced
  depends on the install method, and is not verified for every one
  ([code/cli-update.md](code/cli-update.md#running-sessions)). If a method
  turns out to break the dialog's promise, the fix is in the server — refusing
  the update while `running_sessions` is not zero, with its own failure row —
  not in the wording.

The session UI shows nothing about the version a session runs on (*Considered
and not done*).

## Cluster

`web-cluster` gets no update or install UI, for the reason it has no sign-in UI
([cli-login-ui.md](cli-login-ui.md#cluster)): the nodes on one machine share one
install of each CLI, so updating or installing it from any node's Pockode does
it for all of them. That sharing is why the dialogs name cluster nodes, and why
two nodes updating or installing the same CLI at once is the server's to rule
out ([code/cli-update.md](code/cli-update.md#one-update-per-cli-per-os-user)).

## Components

| Piece | Where | What |
|-------|-------|------|
| `cliLoginStore` | `web/src/lib/` | Also holds the check and the latest update per CLI, beside sign-in status and the latest sign-in, with the same revision rule. One store for one card: the card's states read both halves (*While it runs*), and splitting them would put that rule in two places |
| `CliStatusCard` | `web/src/components/Settings/sections/` | The header and the two rows, follows its CLI's update (`useCliUpdateSubscription`) as it follows its sign-in, and owns the update and install dialogs as it owns the sign-out one |
| `CliRow` | same | The fixed row box and its skeleton; `CliRowNotice`, the one region that adds height |
| `CliInstallRow` | same | The installation row's state table, *Installing a missing CLI* and *Failed* |
| `CliAccountRow` | same | The account row: [cli-login-ui.md](cli-login-ui.md#the-card-states)'s state table |
| `CliSignInSection` | same | Refresh also reads the check; its spinner covers both reads |

None of it is in `@pockode/shared`: `web-cluster` does not use it.

## What the UI needs

Not a wire format — the server's side, the RPC and why it behaves as it does
are in [code/cli-update.md](code/cli-update.md) — but what the screens above
cannot be drawn without:

- **A check per CLI**, its own request beside `cli_auth.status`: the state
  (up to date / update available / not yet available / updating / not
  installed / unavailable), the installed and the latest version each when it
  could be read — which one is missing tells *Version unreadable* from
  *Couldn't check* — the channel, and `running_sessions`. "Update available" is
  decided by the server, against the release **the CLI's own update would
  install**; a latest it cannot deliver would be a button that fails every
  time.
- **An update**, shaped like a sign-in: start per CLI naming no version (a
  running one is returned, a refused one fails with a message to show as it
  is), a record by id that survives a reconnect — phase, `from`, `target`, the
  version read afterwards (on a failure too), the resolved binary path, a
  failure reason from the *Failed* table and a redacted detail — a subscription
  with the revision rule, and dismiss.
- **Success is the server's verdict**, and so is *Not applied*: the update
  succeeded only if the binary Pockode runs reached the target.
- **While it runs**, for that CLI: `cli_auth.status` answers `updating`
  without running the CLI, and sign-in and sign-out are refused with a reason
  the card can show.

## What to test

- Every card has both rows from the first paint, skeletons in place of what
  is not read yet.
- Each installation-row state renders its row of the table; *Couldn't check* is
  never drawn as *Up to date*, and *Version unreadable* has no **Update**.
- **Update** and **Try again** confirm first; the dialog names the running
  session count when there is one.
- Leaving Settings, a reload and a reconnect keep a running update; the row
  resumes from the server's copy.
- *Updated* shows only on a page that watched the update end. A failure shows on
  every page until dismissed, and not once the installed version differs from
  the version the update left — both known; an empty one hides nothing.
- *Not yet available to this install* has no **Update**. A refused start shows
  the server's message in the row's notice.
- A running update withholds the account row's action, says why in its subtitle
  and keeps the last sign-in state; a running sign-in hides **Update**; the other card is
  untouched.
- Each failure reason renders its title, body and actions.
- The card's current version never comes from an update record.
- **Install** confirms first; the row goes *Installing* → *Installed*, and the
  account row from dimmed to its read state, without a reload. Each install
  failure reason renders its row of the table, **Try again** reopens the
  dialog, and a failed install is hidden once the check finds the CLI. Refusals
  show the server's message (with the install page for `npm_not_found`), except
  `already_installed`, which reads the CLI again.

## Considered and not done

- **A badge or banner when an update is out.** Claude releases often enough that
  it would be on most days, which teaches the user to ignore it.
- **Pockode detecting the install method and running the installer itself.**
  The CLI's own `update` knows its installs better (*The rules*).
- **Saying before the press that an install can't be updated.** Only the CLI's
  update knows, and it answers by trying. The failure row carries its reason and
  the terminal command; offering to pre-detect would be the guessing the rule
  above gives up.
- **Updating from the chat.** A turn that fails because a CLI is too old fails
  with the CLI's own message, which names the fix; the card is one tap from
  Settings. Worth adding if such a failure turns out common *and* detectable
  from a structured signal, as auth failures are.
- **Updating from the sign-in sheet's *Flow broke* screen.** The broken flow
  may be *caused* by the latest update, so offering another one there is a
  guess. The card under it has the button when there is one.
- **Choosing a version, or rolling back.** The case for it is real — an update
  that breaks Pockode's sign-in flow — but it needs a version list and a way
  back per install method. Until then the answer is the terminal, which *Flow
  broke* already names.
- **Warning that a version is newer than Pockode was checked against.** Pockode
  records the versions its CLI integration was verified with
  ([code/cli-auth.md](code/cli-auth.md)), but newer versions usually work, and a
  warning on every update would be noise.
- **Choosing how to install a missing CLI.** npm is the one installer both
  CLIs share; the install page covers the rest, offered wherever npm failed.
- **Showing each session's CLI version.** Useful for "which version did this
  turn run on", but it is per-turn history, not something the update needs.
- **Stopping sessions to let an update through.** It would trade the user's
  running work for a few minutes of waiting.
