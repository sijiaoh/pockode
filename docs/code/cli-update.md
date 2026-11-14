# AI CLI Update

How the server tells a client whether Claude Code and Codex have a newer release
than the one it runs, updates them from a phone, and installs one the server
cannot find. The screens that read this
are in [cli-update-ui.md](../cli-update-ui.md); the sign-in state beside it is
[cli-auth.md](cli-auth.md).

Updates verified against Claude Code 2.1.280 → 2.1.285 and codex-cli 0.158.0 →
0.159.2, both installed with npm, on Linux. The install's scripts were read as
their four URLs served them in November 2026.

## Where it lives

| Path | Holds |
|------|-------|
| `server/cliupdate/` | `Service`: the check (`cliupdate.go`), the update flow (`update.go`), the install (`install.go`, with `installer_{unix,windows}.go` picking the platform's script), the npm registry read (`registry.go`) |
| `server/agent/claude/update.go` | Claude as `cliupdate` sees it: its npm package, its release channel read from the user's settings, and its official install scripts |
| `server/agent/codex/update.go` | Codex, likewise (it has no channel setting) |
| `server/agent/version.go` | `agent.Version`, the `--version` read shared with sign-in status |
| `server/agent/semver.go` | `agent.CompareVersions`, version ordering — shared with the Claude adapter, which gates a launch flag on the installed version |
| `server/watch/cli_update.go` | `CLIUpdateWatcher`, which pushes update changes; the mechanism is `watch/cli_record.go`, shared with sign-ins |
| `server/ws/rpc_cli_update.go` | the `cli_update.*` methods |
| `server/filestore/lock.go` | `TryLock`, the lock shared by every Pockode of the OS user |

## The RPC

```
cli_update.check       { agent? }           ->  { checks: [Check] }
cli_update.start       { agent }            ->  { update: Update }
cli_update.install     { agent }            ->  { update: Update }   // kind "install"
cli_update.dismiss     { update_id }        ->  {}
cli_update.subscribe   { id, agent }        ->  { update: Update | null }
cli_update.unsubscribe { id }
notification cli_update.changed { id, update: Update | null }
```

```jsonc
// Check
{
  "agent": "claude",
  "state": "update_available",     // up_to_date | update_available | not_yet_available | updating | installing | not_installed | unavailable
  "version": "2.1.283",            // installed, when it could be read
  "latest_version": "2.1.285",     // the channel's release, when it could be read
  "channel": "latest",             // always set: the dist-tag latest_version is read from
  "error": "...",                  // unavailable, not_installed
  "update_id": "...",              // updating, installing: the running update or install
  "running_sessions": 2            // always set: this server's live processes of the CLI
}

// Update
{
  "id": "...",
  "agent": "claude",
  "kind": "update",                // update | install
  "revision": 42,                  // grows with every change; keep the higher copy
  "phase": "running",              // running | succeeded | failed
  "binary_path": "/home/ada/.local/bin/claude",  // the install the update has to reach; empty when not found
                                   // install: empty until it ends, then where the CLI was found
  "from_version": "2.1.283",       // once read; never on an install
  "target_version": "2.1.285",     // the latest when it started, once read
  "to_version": "2.1.285",         // read afterwards, on a failure too
  "started_at": "...", "ended_at": "...",
  "failure": { "reason": "command_failed", "detail": "..." }   // failed
}
```

`checks` is in display order, Claude then Codex; without `agent` every CLI is
read, concurrently. A check that could not tell is in the list as
`unavailable`, with `error` saying why and whichever of the two versions could
be read still set — so no `version` is "couldn't read the installed version",
and a `version` without `latest_version` is "couldn't check for updates". Only
an unknown agent fails the request.

`start` on a CLI with an update running returns that update. A start the server
refuses leaves no record and fails the request with a message to show as it
is: the CLI is being installed, it is being updated by another Pockode on this
machine, a sign-in to it is running, the server is shutting down, or the server
has no home directory to run the update in or no cache directory to lock it in.

`install` is the same record with `kind: "install"`, so `subscribe`,
`cli_update.changed`, `dismiss` and the revision rule below serve both. A CLI
has one record at a time, of either kind. How an install runs, what it is
refused with and how it fails are in
[Installing a missing CLI](#installing-a-missing-cli).

`dismiss` drops an update that has ended — a running one is refused — and every
subscriber is sent `update: null`. An update, like a sign-in, belongs to the
server and not to the connection that started it; the last one to end is kept,
in memory, until it is dismissed or the next one starts. `revision` works as
for a sign-in ([cli-auth.md](cli-auth.md#one-per-cli-owned-by-the-server)):
only copies with the same `id` compare, and a different `id` or `null` replaces
what the client has.

`check` is plain request and response, as `cli_auth.status` is, and for the
same reason: the installed version changes whenever Claude updates itself or
someone updates a CLI in a terminal, where no Pockode process sees it. Nothing
is cached. The client asks when the screen needs to know, and again when an
update or install it followed ends.

## Latest: the npm registry, on the CLI's channel

Both CLIs publish every release to npm (`@anthropic-ai/claude-code`,
`@openai/codex`) with the same version numbers they ship through their other
installers, so the latest release is one small read of the package's
dist-tags (`GET <registry>/-/package/<name>/dist-tags`) — no CLI to run, no
text to parse.

The tag has to be the one **the CLI's own update installs from**, or the card
would offer a release that update then declines. Claude has two:
`autoUpdatesChannel` in the user's `settings.json` (under the
`CLAUDE_CONFIG_DIR` Pockode was started with, else `~/.claude` — the default
profile's, which every [profile](cli-profiles.md) links to) picks `latest` or `stable`, and `latest` is the default.
Only the user's settings are read: the update runs outside any project
([below](#running-the-update)), so a project's settings do not decide it
either. Codex has one, `latest`.

The order is semver's, pre-releases included, and decided on the server so a
client never compares version strings. An installed version newer than the
channel's — a switch of channel leaves one — is `up_to_date`: the CLI's own
update does not go back.

The registry is the public one. A machine that can only reach a mirror reads
`unavailable` with the connection's error, and its update — which goes through
the CLI and so through the machine's npm configuration — still works; see
[Success is the target reached](#success-is-the-target-reached) for how it is
judged then.

## The update is the CLI's own

`claude update` and `codex update` each know how their CLI was installed and
how to update each kind: Claude's native build, npm, a package manager's;
Codex's npm, bun, Homebrew. Both run to the end with stdin closed and no
terminal (measured), print what they did, and exit non-zero when they could not
(a root-owned npm prefix: Claude "Insufficient permissions to install update",
Codex npm's `EACCES` block). Pockode runs that command through `agent.Run` —
the whole process tree is killed at the budget, on Windows too — and does not
second-guess the install method. Detecting it would be guessing what each CLI
already knows, and would lag every new installer they add.

### Running the update

In the user's home directory, not the project's. A global install belongs to the
user, and a project's `.npmrc` must not be able to point `npm install -g` at
another prefix or registry. A server whose user has no home directory refuses
updates, saying so, rather than fall back to the project. As the server's own
user: no `sudo`, and no prompt anyone could answer.

Before the command runs, `<cli> update --help` has to print that command's own
usage line (`Usage: claude update|upgrade …`, `Usage: codex update …`). Codex's
argument parser takes an unknown first word for a prompt, so on a version
without `update` the command would start a turn rather than an update. Every
version measured has it, codex-cli 0.130.0 included; one without fails as
`other`, and nothing is run. So does a `--help` that exits non-zero, with its
output as the detail: that is a broken CLI, not an old one.

The budget is 10 minutes. The two updates above took 33s and 22s, almost all
of it download, so the budget is for a slow connection. It is not tied to the
client's RPC timeout: `start` answers at once, and the rest arrives as
`cli_update.changed`.

There is no cancel method, for the reason the UI gives none
([cli-update-ui.md](../cli-update-ui.md#the-rules), *No Cancel*). Server
shutdown does kill a running update (a 10-minute download cannot hold a
shutdown that a cluster stop force-kills after 5 seconds), and records it as
failed with a message saying so, which the process then loses with its memory.
The next check is the evidence.

### Success is the target reached

The command's exit status says what the CLI thinks happened, not whether the
`claude` Pockode runs changed. The measured counterexample: a CLI whose npm
prefix was not writable, run with `NPM_CONFIG_PREFIX` pointing elsewhere,
printed "Successfully updated from 2.1.280 to version 2.1.285", exited 0, and
left the binary Pockode resolves at 2.1.280. Two installs on one machine — an
npm one and a native one, two Node versions each with its own global prefix —
are common, and each reports success forever while every session keeps the old
version.

So before running it, the Service reads the installed version and the latest
release (`from_version`, `target_version`); afterwards, the version of the
binary `agent` [resolves](#where-the-cli-is-found) (`to_version`). The update
succeeded when that is at least the target. With no target — the registry
could not be read — the CLI's word is taken: exit 0 is success, whatever the
version. A target or a result that does not parse as a version fails as
`other`, as the check reports it `unavailable`. The version afterwards is read
on the server's own budget, not what the update left of its 10 minutes.

| `failure.reason` | When |
|---|---|
| `command_failed` | the update command exited non-zero. `detail` is `` `<cli> update` exited with status N `` and the end of what it printed, stdout then stderr, which is where both CLIs say why |
| `not_applied` | it exited 0, but the binary Pockode runs is older than the target. `detail` names both versions and adds the command's output |
| `timeout` | it ran past the budget; its process tree was killed. `to_version` is read anyway: what a half-run install left is the first thing to know |
| `not_installed` | the CLI is not found |
| `other` | anything else — the CLI has no `update` command, the version afterwards could not be read, the server shut down — `detail` says what |

`detail` keeps the last 10 non-blank lines of stdout and 20 of stderr — npm
writes warnings to stderr, and Claude its advice about an unwritable prefix to
stdout — at most 4 KiB each, whole lines dropped from the front (a single line
longer than that is cut from the front and marked `…`), without
terminal escapes, and with credentials removed: URL user info, `.npmrc`'s
`_authToken` / `_auth` / `_password`, `Authorization` values (as text, JSON or
Node's inspected objects), and bare npm or GitHub tokens. npm prints its
registry URL and, when it fails verbosely, its configuration and request
headers; the detail goes to every client and into the log. Credentials are
removed before the output is cut, so a cut cannot split one into something no
longer recognizable.

### Not yet available

A `not_applied` update whose version did not move at all is remembered: that
release, and the version it stayed at. While a check reads that same pair, it
answers `not_yet_available` instead of `update_available`, even after the record
is dismissed. Either the install's package manager gets releases later than npm
(Homebrew's does), or the update went to a second install on the
machine; the server cannot tell which, so a client must not claim either.
Offering the button again at once would only fail again.

It lifts when either version changes, and after 6 hours (`NotAppliedFor`)
regardless: nothing tells Pockode that the package manager caught up, and a
second install never will, so the update is offered again rather than never.
Six hours is meant to outlast a package manager's usual lag without leaving
the card offering an update that has just failed.
In memory: a restart offers it at once.

## Where the CLI is found

Everything here — `check`'s version, an update's `binary_path` and
`to_version`, the install's success — runs the CLI through `agent.Command`, so
it finds the same copy a session start and a sign-in do: PATH first, then, only
when the CLI is not on PATH at all, its official installer's directory — where
[an install](#installing-a-missing-cli) from here lands — and on Windows
`%APPDATA%\npm`. The lookup, the directories and why are in
[agent-integration.md](agent-integration.md#finding-the-binary). Nothing caches
the answer, so a CLI installed a moment ago is found on the next read.

## Installing a missing CLI

`cli_update.install` installs a CLI `check` reports `not_installed` with that
CLI's own official install script — the one its documentation tells a user to
pipe into a shell:

| CLI | Unix | Windows |
|---|---|---|
| claude | `bash install.sh <channel>`, from `https://claude.ai/install.sh` | `install.ps1 <channel>`, from `https://claude.ai/install.ps1` |
| codex | `sh install.sh`, from `https://chatgpt.com/codex/install.sh`, with `CODEX_NON_INTERACTIVE=1` | `install.ps1`, from `https://chatgpt.com/codex/install.ps1`, with `CODEX_NON_INTERACTIVE=1` |

A `.ps1` runs under `powershell -NoProfile -NonInteractive -ExecutionPolicy
Bypass -File` (`cliupdate.PowerShell`): Windows PowerShell 5.1, the one every
supported Windows has, without the user's profile, and past the execution
policy, which refuses an unsigned downloaded script. Which of the two columns
runs is decided at build time (`installer_{unix,windows}.go`).

Why the official scripts and not npm: they need no Node.js, they install into
the user's own directories rather than a global prefix that is often root's,
and the CLI they leave is the native build, which `claude update` /
`codex update` then update the native way. Both CLIs' instructions lead with
them.

- **Claude's channel** is the one the check reads
  ([above](#latest-the-npm-registry-on-the-clis-channel)), handed to the script
  as its one argument, its `TARGET`. The script passes it to `claude install`,
  which records it as the channel the install updates from, so the later
  `claude update` follows the same one. `install.sh` is bash, not sh — it uses
  `[[ ]]` and `BASH_REMATCH`.
- **Codex** has no channel argument: with no `--release` (`CODEX_RELEASE`) its
  scripts install the latest release, the one `codex update` follows.
  `CODEX_NON_INTERACTIVE=1` is not optional. Without it `install.sh` asks on
  `/dev/tty`, not stdin — whether to remove an npm or Homebrew install it
  found, whether to start Codex — so a server started from a terminal would
  wait on a question nobody sees until the budget ran out; closing stdin does
  not stop it. It is what Codex's own standalone update sets.

**The URLs are constants** in each CLI's package, never anything a client, a
project or a setting can change: what they serve runs as the server's user.

**Downloaded, then run as a file** — not `curl … | sh` as the instructions
have it. A download that fails halfway through a pipe hands the shell a
truncated script, or none, which it runs without complaint; and a piped
script's commands read the rest of the script as their stdin. The server
fetches the script itself (`net/http`), into a directory `os.MkdirTemp` made
for this install alone, removed when it ends:

- Redirects are followed — every URL above redirects today, to its CLI's
  download host — but never off HTTPS (`checkScriptRedirect`); a redirect to
  plain `http` fails the download.
- Anything but `200 OK` fails it, and so does a script over 1 MiB (the largest
  today is about 70 KiB).
- A `.ps1` without a UTF-8 byte-order mark is written with one: Windows
  PowerShell 5.1 reads a script without it in the ANSI code page, where a
  non-ASCII character is garbled and can end a string early. Both CLIs'
  `.ps1` scripts are ASCII today.

The script runs [where an update runs](#running-the-update) — the user's home
directory, as the server's own user, no `sudo`, stdin closed, the whole process
tree killed at the budget — under the same machine-wide lock, sign-in gate and
10-minute budget, the download included. Like `start` it answers at once; the
rest arrives as `cli_update.changed`. Codex's `install.sh` appends a block
putting its directory on `PATH` to the user's shell profile, as it does for an
install from a terminal; the server does not rely on it (*Success is the CLI
found*, below).

### Refused before it starts

An install the server refuses starts nothing and leaves no record. The refusals
a client has its own copy for answer `-32003` (`rpc.CodeCLIInstallRefused`)
with `data.reason`; the message is still a whole English sentence to show as
it is ([websocket-rpc.md](websocket-rpc.md#error-replies)).

| `data.reason` | When |
|---|---|
| `already_installed` | the server finds the CLI already; the message names the path. Reading `check` again shows it |
| `installer_tool_not_found` | what the script needs before it can start is not on the server's PATH: its shell (`bash`, `sh`, `powershell`), or, for a Unix script, both of `curl` and `wget`. The message names the script's URL and the missing tool, and says to install it and restart pockode |
| `busy` | the CLI is being updated on this server, another Pockode on the machine is updating or installing it ([below](#one-update-per-cli-per-os-user)), or a sign-in to it is running. Trying again once that has ended works |

Only what keeps the script from starting is checked here. What it needs once
it runs — `tar`, `mktemp`, a SHA-256 tool for Codex's — the script checks
itself, and its message arrives as `command_failed`.

`-32602` is a missing or unknown `agent`; `-32603`, with a message only, is a
server shutting down or one with no home or cache directory.

An install already running for the CLI is returned, as `start` returns a
running update. An install and an update exclude each other: each is refused
(`busy` for the install) while the other runs.

### Success is the CLI found

The script resolves the release itself, so `target_version` — the channel's
release, read from the npm registry once the install has begun — is only what a
client shows while it runs, and empty when the registry could not be read.
There is no `from_version`. The install succeeded when the script exited 0 and
the CLI's `--version` then reads: `to_version` is that version, and
`binary_path` where the CLI was found. The script's own `PATH` edits are not
needed for that: the lookup searches the official installer's directory when
the CLI is not on PATH ([above](#where-the-cli-is-found)). Nothing caches where
a CLI is — `check`, `cli_auth.status` and every session start search afresh —
so the next read after a success finds it; a client reads both again when it
sees an install end, as it does for an update.

Every install `detail` names the script by its URL — `the official installer
(<URL>)` — so it says which file the server ran.

| `failure.reason` | When |
|---|---|
| `download_failed` | the script could not be downloaded: no network, a proxy, a region the CLI's download service does not serve, a status other than 200, a redirect off HTTPS. `detail` is `could not download the official installer (<URL>): <error>` |
| `command_failed` | the script exited non-zero. `detail` is `the official installer (<URL>) exited with status N`, then, after a `:` and a newline, the end of what it printed — where the script says why: a failed download or checksum, an unsupported platform, `tar` or a checksum tool missing |
| `not_on_path` | the script exited 0 but the server still cannot find the CLI, on its PATH or in the official installer's directory — an installer whose default directory moved ([below](#what-it-depends-on)). `detail` is the lookup's own message — where it looked, and to put the CLI on pockode's PATH and restart pockode — then the end of the script's output, which usually says where it put the CLI |
| `timeout` | it ran past the budget; its process tree was killed. `to_version` is read anyway |
| `other` | anything else — the temporary directory could not be made, the shell could not be started, the installed CLI's `--version` failed, the server shut down — `detail` says what |

`detail` is cut and redacted as an update's is ([above](#success-is-the-target-reached)).

## One update per CLI per OS user

Every Pockode of the OS user — other projects, the nodes of a cluster —
updates the same install and installs into the same home directory, and two
installers replacing one directory at once can leave neither version whole.
So a start takes an exclusive lock on
`<user cache dir>/pockode/cli-update-<agent>.lock` (`os.UserCacheDir`:
`~/.cache`, `~/Library/Caches`, `%LocalAppData%`) and a second Pockode's start is
refused, not queued. An install takes the same lock, so an update and an
install of one CLI exclude each other across Pockodes too. It is an OS file
lock (`flock`, `LockFileEx`), so a Pockode that crashed mid-update leaves
nothing behind — a PID file would. A machine without a cache directory refuses
every update and install, saying why.

Within one server the rule is the same without the file: a second `start`
returns the running update, a second `install` the running install, and either
is refused while the other kind runs.

## With sign-in

An update or an install and the CLI's sign-in commands exclude each other
through `cliauth.Service.BeginUpdate`; what each side is refused, and why, is in
[cli-auth.md](cli-auth.md#one-command-per-cli-at-a-time). `cliupdate` sees
this as a `Gate`, so it has no dependency on sign-in. Sign-in does not know
the kind: while an install runs, `cli_auth.status` answers `updating` with the
install's id, and a client that wants to say *installing* reads the record's
`kind`. The checks are held off the same way: a check that finds an update
running answers `updating` (an install, `installing`) without running the CLI,
and an update or install that has begun waits for the checks already running
`--version` before it runs anything.
This is per server, like sign-in's own lock: a sign-in on another cluster node
is not seen.

## Running sessions

An update does not stop, restart or wait for sessions, and
`running_sessions` is how many of this server's processes of the CLI are alive
(`worktree.Manager.AgentProcessCount`, idle ones included), for the client to
say so before the user presses. What happens to them is the install method's:

- A process keeps the executable it started with. Claude's native build puts
  each version in a file of its own (`~/.local/share/claude/versions/<version>`)
  and moves the `claude` link, so a running Claude is untouched. npm renames
  the old package directory aside and the new one in; on Linux and macOS a
  running executable survives that, since it holds its file open.
- The next process — a new session, or an idle one's next turn, which resumes
  the same conversation — runs the new version.
- On Windows a running executable cannot be replaced, so an update there is
  expected to fail as `command_failed` with the installer's own message, and
  to work when tried again once the sessions have closed. Not measured.
- Not verified: a running process reading a file from its package *after* the
  swap (a helper binary, a lazily loaded module) finds the new version's, or
  none in the moment between the two renames. The measured updates above ran
  with no session open.
- Not verified either: `codex update` of an npm install on Windows, where the
  `codex.exe` running the update is itself a file npm has to replace.

Session starts are not held back while an update runs. A session started in the
middle meets whatever is on disk at that instant; if that fails to start, it
fails as any start does, with the CLI's error in the transcript, and a work's
kickoff that fails there stops the work. Holding starts is worth doing if that
turns out to happen.

## Timeouts

| Call | Budget |
|------|--------|
| `--version` | 10s |
| registry read | 10s, beside `--version` |
| `update --help` probe | 10s, inside the update's 10 minutes; running out of it fails as `other`, naming the limit |
| update command | 10 minutes, everything from the start of the update on; a timed-out one then reads `--version` for up to 10s more |
| install | the same 10 minutes, the script's download included; `--version` afterwards, 10s on top |

`check` is at most the longer of the first two, inside the client's default
30s. `start`, `install`, `dismiss` and `subscribe` run nothing while the
client waits.

## What it depends on

Much less than a sign-in does:

- `<cli> update` updating the CLI non-interactively, exiting non-zero when it
  could not, and saying why at the end of its output. A reworded message changes
  nothing here; a CLI that stopped exiting non-zero would still be caught by the
  version check afterwards, as `not_applied`.
- `<cli> update --help` printing `Usage: <cli> update`. A reworded usage line
  refuses every update with a message saying the command is missing — wrong,
  but not silent.
- `<cli> --version` printing the version (`agent/version.go`).
- Both packages on npm carrying every release, with the dist-tags above.
- For an install: the four script URLs staying where they are, and the
  scripts installing unattended — Claude's taking the channel as its first
  argument, Codex's not asking while `CODEX_NON_INTERACTIVE` is set, both
  exiting non-zero when they fail. A moved URL fails as `download_failed`, and
  a Codex script that asked again waits out the budget and ends `timeout` —
  explained, not silent. A Claude script that stopped reading its argument
  would install `latest` for a `stable` user without saying so.
- Each installer keeping the default directory registered for it
  ([agent-integration.md](agent-integration.md#finding-the-binary)). If one
  moves, a CLI it installed that is not yet on pockode's PATH reads
  `not_installed`, with the old directory in the message's `also looked in` —
  explained, not silent.
- Claude's `autoUpdatesChannel` keeping its name and values. If it changes,
  a `stable` user is offered the `latest` release, and the update ends
  `not_applied` — explained, not silent.

## The web client

The screens are in [cli-update-ui.md](../cli-update-ui.md); the code behind
them sits beside the sign-in's ([cli-auth.md](cli-auth.md#the-web-client)):

| Path | Holds |
|------|-------|
| `web/src/lib/rpc/cliUpdate.ts` | the `cli_update.*` requests, and `cliInstallRefusedReason`, which reads a refused install's `data.reason` |
| `web/src/lib/cliLoginStore.ts` | the check and latest update or install per CLI, beside sign-in status and the latest sign-in |
| `web/src/hooks/useCliUpdateSubscription.ts` | follows a CLI's update into the store while a card shows it |
| `web/src/components/Settings/sections/CliStatusCard.tsx` | one CLI's card: the install and update dialogs, refusals, and which reads are live |
| `web/src/components/Settings/sections/CliInstallRow.tsx` | the installation row of each `CliStatusCard`, and the failure copy |

One store for both halves because the card's states read both: a running update
holds the account row still, and a running sign-in holds **Update** off. The
revision rule is `applyUpdate`'s, as it is `applyLogin`'s for a sign-in. The
store keeps the last status that was not `updating` (`settledStatuses`), which
is what the card shows while an update runs. When it sees an update end that
it was following, or that it started — a fast one can reach the page ended
before the start's reply does — it reads the check and `cli_auth.status` again,
superseding any read still out, and remembers the id (`updatesSeenEnding`):
only such a success is drawn as *Updated*, and the list is forgotten when
Settings unmounts. A read answered `updating` (or a check answered
`installing`) that lands after the update it names has ended is read once
more, so a Refresh sent mid-update cannot leave the card held still. A failed check
request leaves the last check in place and records why in `checkErrors`; it
is drawn as *Couldn't check*, never as *Up to date*.

An install is followed as an update is, since it is one: `startInstall` shares
`startUpdate`'s path (`followStarted`), and its record arrives through the same
subscription and `applyUpdate`, so its end triggers the same reads. A refused
install rejects with the server's error; the caller tells the reasons apart
with `cliInstallRefusedReason` — by code and `data.reason`, never the message,
which is for showing as it is. An `already_installed` refusal also reads the
check and status again, because the `not_installed` on screen is stale by then.

The store's re-reads after an install supersede reads still out, but a read
that already landed mid-install stays in the store until they answer. The card
therefore sets aside any check or status that `isStaleRead` says belongs to an
ended update or install — the rule is the same for both, though an install is
where it shows — and draws from the record and the last settled status in the
meantime — otherwise the account row would wait on the slower check, and a
failure's **Try again** would close its own dialog
([cli-update-ui.md](../cli-update-ui.md#installing-a-missing-cli)).

## Logged and not logged

An update or install is logged when it starts (an update with the path it has
to reach) and when it ends — from what version to what, and where the CLI is, when it
succeeded, the reason and the
redacted detail when it failed. A check that
could not be read is logged unless its client went away.
