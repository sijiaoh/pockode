# AI CLI Sign-in

How the server tells a client whether Claude Code and Codex are signed in on the
machine it runs on, signs them in from a phone, and signs them out. The screens
that read this are in [cli-login-ui.md](../cli-login-ui.md).

Verified against Claude Code 2.1.283 and codex-cli 0.153.0.

## Where it lives

| Path | Holds |
|------|-------|
| `server/cliauth/` | `Service`, the status vocabulary (`State`, `Account`, `External`), the `Provider` interface; `login.go`, the sign-in flows (`Login`, one per CLI) |
| `server/agent/claude/auth.go` | Claude's provider: `claude auth status --json`, `claude auth logout` |
| `server/agent/claude/login.go` | Claude's sign-in: `claude auth login` over pipes |
| `server/agent/codex/auth.go` | Codex's provider: the app-server's `account/read` and `account/logout` |
| `server/agent/codex/login.go` | Codex's sign-in: the app-server's device-code `account/login/*` |
| `server/watch/cli_login.go` | `CLILoginWatcher`, which pushes sign-in changes; the mechanism is `watch/cli_record.go`, shared with [updates](cli-update.md) |
| `server/cliauth/cliauthtest/` | a `Provider` for tests that need a CLI's sign-in without running one |
| `server/agent/run.go` | `agent.Run`, the one-shot command runner: Claude's commands and every `--version` |
| `server/agent/version.go` | `agent.Version`, the `--version` read, shared with [updates](cli-update.md) |
| `server/ws/rpc_cli_auth.go` | the `cli_auth.*` methods |

What a CLI prints and how it is read belongs with the rest of that CLI's
integration, so each provider sits in its CLI's package, beside the code that
already knows its binary and protocol. `cliauth` holds only what the two share
and the one place both are reached from. A sign-in flow is the same split: the
flow's steps go in the provider, anything shared — one flow per CLI, the lock
below — in `Service`.

## The RPC

```
cli_auth.status  { agent? }  ->  { statuses: [Status] }
cli_auth.logout  { agent }   ->  { status: Status }
```

The sign-in methods are [below](#signing-in).

```jsonc
// Status
{
  "agent": "claude",               // session.AgentType
  "state": "signed_in",            // signed_in | signed_out | external | not_installed | signing_in | updating | unavailable
  "version": "2.1.283",            // optional
  "account": { "email": "...", "organization": "...", "plan": "max" },  // signed_in; every field optional
  "external": { "kind": "api_key", "source": "ANTHROPIC_API_KEY" },     // external
  "error": "...",                  // unavailable, not_installed
  "login_id": "...",               // signing_in: the running sign-in
  "update_id": "..."               // updating: the running update or install
}
```

`external.kind` is one of `api_key`, `api_key_helper`, `oauth_token`,
`cloud_provider` (with `provider`: `bedrock` / `vertex` / `foundry`),
`no_sign_in_needed`, `other` (with `method`, the CLI's own word, and `provider`
when the CLI names a platform beside it). It is
Pockode's vocabulary, not either CLI's, so a client does not have to know that
Claude says `third_party` where Codex says `amazonBedrock`. It names sources and
never carries a value.

`statuses` is in display order, Claude then Codex. Without `agent` every CLI is
read, concurrently.

## No subscription

Status is read afresh on every call and nothing is pushed. The credentials are
the CLI's own store (files, or the Keychain on macOS for Claude), shared by
every process of the OS user: other projects, other cluster nodes, a terminal.
Almost every way the answer changes — a login in a terminal, a token expiring,
another node signing out — happens where no Pockode process can see it, so a
subscription would push only the changes this server made and stay silent about
the rest, which reads as current when it is not. The client asks when it needs
to know (when the screen mounts, when the page becomes visible, on Refresh), and
`cli_auth.logout` answers with the status read afterwards so the screen that
pressed it needs no second call.

A sign-in is different: it is a flow of this server's own, so its progress is
pushed ([below](#signing-in)). The status a finished sign-in leaves behind is
read, not remembered — it is in the sign-in because it was read right after.

## Failure is its own state

`unavailable` is never folded into `signed_out`. A read that timed out, an
output this version cannot parse, an app-server that exited — each would send the
user into a sign-in that cannot fix what is wrong. So `cli_auth.status` does not
fail for them: the CLI is in the list with its reason in `error`, and only a
request naming an agent the server does not know is refused.

`not_installed` comes from `agent.BinaryNotFoundError`, the same lookup a
session start uses, including the Windows fallback directories.

## Deciding "external"

**Claude** — `authMethod` decides, not `loggedIn`. An environment variable
outranks the credential file, so a machine with `ANTHROPIC_API_KEY` set reads as
`api_key` even with a subscription signed in too, and the key is what every
session would use. A Pockode sign-in can change `claude.ai`, `none`, and an
`api_key` whose `apiKeySource` is `/login managed key` — the key a Console
sign-in saves, which `auth logout` clears, so it reads as `signed_in`. Any other
method, including one a later version adds, is `external`. An
expired login that could not be refreshed reads as `claude.ai` with `loggedIn:
false`, which is `signed_out`: a fresh sign-in is what it needs. `auth status`
exits 1 when signed out and still prints its JSON, so the exit status only
matters when there is no JSON.

**Codex** — `requiresOpenaiAuth: false` (a model provider that does not use
OpenAI's sign-in) is `no_sign_in_needed` whatever account is stored, because
sessions do not use it. Otherwise `account: null` is `signed_out`, and only a
`chatgpt` account is `signed_in`. `OPENAI_API_KEY` / `CODEX_API_KEY` need no
case: the app-server does not read them, so an unsigned-in app-server with either
set still fails its turn.

## Where the commands run

In the server's work directory, not wherever the server process was started.
Both CLIs read project-level settings there — Claude's `.claude/settings.json`
can put an API key or an `apiKeyHelper` in front of the sign-in, and a trusted
project's `.codex/config.toml` can pick a model provider that needs no OpenAI
sign-in — so a status read anywhere else describes credentials the sessions do
not use.

## Codex: a fresh app-server per call

Each Codex call starts `codex app-server`, does the handshake, asks what it needs
and ends it. The app-server a session is using cannot be asked instead: it
caches the account it read at startup, and still answered "signed out" after new
credentials were written under it, even though its next turn used them. A
sign-out does read the result on its own app-server, right after
`account/logout`: that process's cache is the one the sign-out just updated
(measured: it then answers `account: null`), and one handshake instead of two is
most of the time the call takes.

## Timeouts

Each provider bounds its own commands, and each status or sign-out RPC's worst
case is 45s. The `cli_auth.login.*` methods run no CLI while the client waits —
`start` and `submit_code` answer at once and the rest arrives as notifications,
and `cancel` waits at most 10s for the CLI to be gone — so they fit the default
RPC timeout.

| Call | Budget |
|------|--------|
| Claude status | 15s |
| Claude sign-out | 30s for `auth logout`, then 15s for the status after it |
| Codex status or sign-out | 45s for everything, `--help` probe and handshake included |
| `--version` | 10s, beside the rest, not after it |

Codex sets the number: `initialize` took 2.3–4.9s and `account/read` 3–12s
against a real `CODEX_HOME` (measured), so about 17s at worst, and a read cut
short is paid again in full by the retry. `Statuses` reads the CLIs
concurrently so Claude never waits it out.

The client has to wait longer than 45s, with margin, or a slow Codex read is
abandoned while the server is still on its way to an answer. The default RPC
timeout in `web/src/lib/wsStore.ts` is 30s; `cli_auth.status` and
`cli_auth.logout` use the longer one agent-starting requests already use
(`web/src/lib/rpc/cliAuth.ts`). Raising a budget here eats into that
margin, so the two grow together. Waiting for another command on the same CLI
(below) comes on top and is capped at 20s, so the longest reply is 65s, inside
the 75s that timeout allows; a call that waited that long without its turn is
answered as `unavailable` (or, for a sign-out, an error) saying another command
was still running.

## Running the commands

Claude's commands and every `--version` go through `agent.Run`, which is
`agent.StartProcess` run to completion; Codex's app-server goes through
`agent.StartProcess` directly. Not `exec.CommandContext`: on a timeout the whole
tree is killed
(an npm-installed CLI on Windows is a grandchild of the `cmd.exe` wrapper), and
the CLI gets no console window of its own on a server that has none. A non-zero
exit is a result, not an error, because the auth commands answer through it.

## One command per CLI at a time

`Service` holds a lock per CLI around everything that runs one of its auth
commands. A sign-out and a sign-in both rewrite the same credential file, and so
may a status read: Claude refreshes expired credentials when asked for its
status. Nothing inside a CLI coordinates two of its own processes doing that, so
a read racing a sign-out could write back the credentials it just removed.

The lock is a channel, not a `sync.Mutex`, so a caller can stop waiting for it:
one whose client has gone does not stay queued behind a sign-out. `--version`
touches no credentials, but runs under it all the same, beside the command it
accompanies: an update takes the lock before replacing the CLI's files, and
must not do so under a `--version` still running. A status answered without
the lock — `signing_in`, `updating`, or a wait that timed out — has no version.

A running sign-in holds its CLI's lock from start to end — up to 15 minutes —
because the CLI writes the credential file at a moment only it knows. It waits
for the lock without the 20s cap: that bounds a request someone is waiting on,
and a sign-in has its own deadline and Cancel. So nothing
queues behind it: a status read answers `signing_in` without running the CLI,
and a sign-out is refused ("cancel it before signing out"). A read already
waiting for the lock when a sign-in takes it is woken and answers the same way,
rather than sitting out its 20s.

An [update](cli-update.md) holds the lock the same way, through
`BeginUpdate`, for the opposite reason: it is the CLI's files that are being
replaced. While it runs, a status read answers `updating` without running the
CLI, and a sign-in or a sign-out is refused ("is being
updated; try again once the update has finished"). An update is refused in turn
while a sign-in runs, since that sign-in's process is the binary it would
replace. Unlike a sign-in, an update does not have to have the lock to start:
it marks the CLI at once, so nothing new begins, and then waits for a read or a
sign-out already running before it runs the CLI.
An [install](cli-update.md#installing-a-missing-cli) goes through
`BeginUpdate` too and is, to this package, an update: a status read answers
`updating`, with the install's id.

Server shutdown ends status reads and sign-outs too, and `Service.Close` waits
for their CLIs to be gone. Their context is the connection's, and the HTTP
server's shutdown does not wait for a WebSocket, so nothing else would stop a
`claude auth logout` or a Codex app-server from outliving the server.

## Signing in

```
cli_auth.login.start       { agent, account_kind? }  ->  { login: Login }
cli_auth.login.submit_code { login_id, code }        ->  { login: Login }   // Claude
cli_auth.login.cancel      { login_id }              ->  { login: Login }
cli_auth.login.subscribe   { id, agent }             ->  { login: Login | null }
cli_auth.login.unsubscribe { id }
notification cli_auth.login.changed { id, login: Login }
```

```jsonc
// Login
{
  "id": "...",
  "agent": "claude",
  "revision": 42,                  // grows with every change; keep the higher copy
  "account_kind": "claude_ai",     // Claude only: claude_ai (default) | console
  "phase": "waiting",              // starting | waiting | verifying | succeeded | failed | canceled
  "version": "2.1.283",            // optional; arrives shortly after start
  "started_at": "...", "expires_at": "...",
  "url": "https://...",            // from waiting on, until the sign-in ends
  "user_code": "ABCD-12345",       // Codex, likewise
  "code_malformed": true,          // Claude, back in waiting: the last code was incomplete
  "failure": { "reason": "...", "detail": "...", "external": {...} },  // failed
  "account": { "email": "...", ... } // succeeded: whom the CLI said it signed in as
}
```

### One per CLI, owned by the server

A CLI has at most one running sign-in. `start` on a CLI that has one returns it —
whatever `account_kind` was asked for — so two screens that both read "signed
out" land in the same sign-in, and switching between the subscription and the
Console is `cancel` then `start`. A sign-in belongs to the server, not to the
request or the connection that started it: a reload or a dropped socket leaves
it running, and `subscribe` finds it again. The last sign-in to end is kept too
(until the next `start` replaces it), so a client that was away when it ended
still learns how; its link and codes are cleared the moment it ends.

`submit_code` and `cancel` name the sign-in rather than the CLI, so a stale
screen cannot act on a newer sign-in. `cancel` on one that already ended answers
with how it ended. `submit_code` returns at once in `verifying`; the verdict
arrives as `cli_auth.login.changed`, like everything the sign-in does on its own
(a Codex sign-in finishing in the browser). Each notification carries the whole
sign-in, so a client only ever replaces what it has — but a command's reply and
a notification are sent separately and can arrive in either order (a malformed
code comes back within milliseconds, often ahead of the `verifying` reply). So
every copy carries a `revision`, which grows with each change, and a client
keeps the copy with the higher one. Revisions compare copies of the same `id`
only: they restart with the server, so a different `id` in a notification or a
fresh `subscribe` — or `null` from one — replaces what the client has. A reply
to `submit_code` or `cancel` is about the sign-in it names, which may no longer
be the CLI's latest, so it replaces nothing else.

`account` on a succeeded sign-in is what happened: whom the CLI said it was
signed in as, read right after. It is not the CLI's status. The record is kept
after it ends and a terminal can sign out meanwhile, so the status card reads
`cli_auth.status` — on `succeeded` as at any other time — and never this.

"One per CLI" is one per server. Cluster nodes on one machine share the CLIs'
stored credentials but each runs its own `Service`, so two nodes could run a
sign-in to the same CLI at once; the second to finish wins.

### Phases and failures

```
starting ──► waiting ──► (verifying) ──► succeeded
    │           │  ▲          │
    │           │  └──────────┤ code_malformed
    └───────────┴─────────────┴──────────► failed / canceled
```

| `failure.reason` | When |
|---|---|
| `code_rejected` | Claude: the token endpoint refused a pasted code (wrong, used, another sign-in's). The CLI has exited: start again |
| `expired` | Pockode's 15-minute deadline passed, or Codex's own code expired |
| `device_auth_failed` | Codex reported the device-code sign-in failed; `detail` is its message |
| `not_installed` | the CLI is not found |
| `external` | credentials managed outside Pockode: Claude reporting an external method before the sign-in (`external` says which), Claude refusing because managed settings want a gateway, Codex refusing because its config forces API-key sign-in |
| `flow_broken` | the CLI did not behave as driven: no link within 30s, a link that does not lead to the paste-a-code page, no answer to a code within 60s, a Codex response of the wrong shape or a missing account API. Usually a CLI update |
| `other` | anything else; `detail` says what |

A code missing its `#state` part is not a failure: Claude says "Invalid code"
and waits for another, so the sign-in goes back to `waiting` with
`code_malformed` and the user pastes again. A well-formed code the server
refuses ends the CLI, which is why the two are told apart.

Codex does not say distinctly that device-code authorization is off for the
account (none of its error texts is about it, and a test account could not
reproduce it), so that is `device_auth_failed` with Codex's message, and the
client adds a hint to check the setting.

`detail` never carries the link's parameters, the link itself when it has any,
the device code or a pasted code: the Service removes every one of them it has
seen in the sign-in before the failure is stored. A link without parameters —
Codex's device page — is a public page and stays readable.

### The deadline

15 minutes from `start`, in `expires_at`. Codex's device code lasts 15 minutes
by its own text and error. `claude auth login` has no timeout of its own and does
not end when its stdin closes, yet a code pasted 15 minutes in still worked
(measured) — so both get the same deadline, and the countdown never outlasts
what the CLI allows. At the deadline the CLI's process tree is killed and the
sign-in fails as `expired`; `cancel` kills it the same way; server shutdown ends
every running one. Either way the CLI's process tree is gone before the sign-in
is recorded as ended, and so before the CLI's lock passes on.

A cancel that lands after the CLI has already finished does not rewrite how it
finished: the outcome is taken as of the moment the provider returned, and
Claude's exit status, once seen, is the verdict even if the cancel arrives while
its last output is still being read.

### Claude: `claude auth login` over pipes

Run with stdin and stdout as pipes, the CLI prints plain text: a line with the
link, then `Paste code here if prompted > ` without a newline, which is never
waited for. The link is taken from the first `https://` on stdout, and checked:
it must carry `code=true` and a `redirect_uri` ending in `/oauth/code/callback`,
the page that shows a code to paste — the one way through a phone can finish.
Its host is not checked (the Console's is another). `--console` goes through the
same page.

The CLI also opens a browser on the server and listens on a local port; either
path finishing ends it. It is run with `BROWSER=true` so no browser pops up on a
server's desktop; where `true` is not a command (Windows) the attempt fails
quietly and the link is printed all the same (measured with a `BROWSER` naming
nothing).

A pasted code is written to stdin as one line. The exit status is the verdict:
0 is signed in; otherwise the last stderr line is the reason, and a 4xx after a
code is `code_rejected`. Before starting, `auth status` is read: a CLI already
using credentials from elsewhere would sign in successfully and change nothing a
session uses.

### Codex: the device code on an app-server of its own

`account/login/start {type: "chatgptDeviceCode"}` answers at once with the link
and the code, and `account/login/completed` arrives when the user is done — or
the code expired. The sign-in lives in that app-server, so it is started for the
sign-in and kept up until it ends; only its start and handshake are bounded by
the 45s budget. The status after success is read on the same app-server, as a
sign-out's is. Cancelling kills it, which ends the sign-in with it.

While the user is in the browser nothing is asked of the app-server, so its
reader hands over only the reply a call is waiting for and drops any other: a
stray reply blocking it would hold up the completion behind it until the
deadline. A completion Pockode cannot read is `flow_broken`, not dropped — the
end came, and waiting out the deadline for it would report `expired`.

Unlike Claude, Codex is not read before the sign-in. The case it would catch —
a model provider that needs no OpenAI sign-in — already reads as `external` in
`cli_auth.status`, which the client reads before offering a sign-in, and the
read costs 3–12s before the code could be shown.

## What the flows depend on

The two sign-ins stand on very different ground, and an update to either CLI
is the likely way one of them stops working.

**Codex** is driven through the app-server's JSON-RPC account API:
`account/read`, `account/login/start`, `account/logout`, and the
`account/login/completed` notification. That API is built for programs, so
Pockode reads fields rather than text. `codex app-server` is still marked
`[experimental]` in `codex --help`, though. A method a later codex removes
answers `-32601`, and Pockode reports that as the CLI lacking a method it needs
and says to update codex. A response Pockode cannot read is `flow_broken` for a
sign-in and `unavailable` for a status read.

**Claude** has no such API. The sign-in drives `claude auth login` the way a
person at a terminal would, and relies on things the CLI does but does not
promise:

- Run over pipes, it prints plain text, with the link on a line of its own.
- The link leads to the paste-a-code page (checked as described
  [above](#claude-claude-auth-login-over-pipes)), not only to a callback on the
  server's own localhost. The same holds with `--console`.
- It reads the pasted `code#state` as one line on stdin. After a line without
  `#` it prints `Invalid code.` and waits for another.
- It exits 0 on success and non-zero otherwise, with the reason on the last line
  of stderr. A refused code names the HTTP 4xx there, and a machine whose managed
  settings want a gateway starts that line with `Managed settings`.
- `claude auth status --json` prints `loggedIn` and `authMethod`.

None of this is a supported interface, and any update may change it. Pockode
checks each point instead of assuming it, so a change shows up as an error the
user can read, never as a spinner that never ends or a "wrong code". (It also
relies on the CLI opening its browser through `BROWSER`. That one is not
checked, because a CLI that stopped honouring it would only open a browser on
the server's desktop.)

| What changed | What the user sees |
|---|---|
| No link within 30s, a link to another kind of page, no answer to a code within 60s (a reworded `Invalid code.` lands here too, since the CLI then waits silently) | The sheet's *Flow broke* screen. It names the CLI and its version, says this usually follows a CLI update, offers the terminal command (`claude auth login`) as the way out, and shows the details (without link or code) already open |
| A reworded refusal or managed-settings line, or `--console` no longer accepted | *Sign-in failed*, with the CLI's own line as the body |
| `auth status` output without JSON or without the two fields | The card's *Status unavailable* row ("Couldn't read sign-in status") with the reason and Retry. There is no Sign in, since a sign-in could not fix it |
| An `authMethod` this version does not know | *Managed outside Pockode*, showing the CLI's own word, or the platform when it names one |
| Codex without the account API, or answering in a shape Pockode cannot read | *Flow broke* for a sign-in, and *Status unavailable* for a status read |

Detecting an auth failure mid-conversation relies on the same kind of thing: the
field each CLI puts on its error frames
([agent-integration.md](agent-integration.md#auth-failures)). If that field
changes, the turn still fails and shows the CLI's error as an ordinary error
line. Only the notice and its sign-in button are lost, and Settings → AI
CLIs still works.

Everything here was verified against the versions at the top of this document.
When the CLIs are updated, check it again by running both sign-ins end to end.
The fake-CLI tests cover only Pockode's side of the contract. The one cheap
check of the CLI's side is Codex's schema drift test
(`server/agent/codex/schema_integration_test.go`, integration tag, no tokens).
It holds `account/read` against the schema codex generates, but not
`account/login/*`. Claude has no equivalent.

## The web client

The screens are in [cli-login-ui.md](../cli-login-ui.md); the code behind them:

| Path | Holds |
|------|-------|
| `web/src/lib/rpc/cliAuth.ts` | the `cli_auth.*` requests |
| `web/src/lib/cliLoginStore.ts` | status per CLI and its latest sign-in, in memory only; the update half is in [cli-update.md](cli-update.md#the-web-client) |
| `web/src/hooks/useCliLoginSubscription.ts` | follows a CLI's sign-in into the store while a screen shows it |
| `web/src/components/CliLogin/` | `CliLoginSheet`, the one sign-in flow, and the wording it shares with the card |
| `web/src/components/Settings/sections/CliSignInSection.tsx` | Settings → AI CLIs, one `CliStatusCard` per CLI |
| `web/src/components/Chat/AuthFailureNotice.tsx` | the chat's way in: a turn that failed on its credentials ([agent-integration.md](agent-integration.md#auth-failures)), opening the same sheet from `ChatPanel` |

The store applies the revision rule above in one place, `applyLogin`, which
every reply and notification goes through. A subscribe snapshot, a notification
and a `start` reply are the CLI's current sign-in and replace a different `id`;
a `submit_code` or `cancel` reply is only about the sign-in it names, which a
newer one may have replaced meanwhile, so it updates that one and displaces
nothing. The store never takes status from a sign-in: when a sign-in it was
following ends, or one it has not seen in the status appears, it reads
`cli_auth.status` again. A failed status request is stored as `unavailable`
with the request's error, the same state the server uses for a read that
failed on its side. `ensureStatus` reads only when nothing has been read or is
being read, or the last read came back `unavailable`, for the many notices a
transcript can hold — each Codex read starts
an app-server.

The subscription is per screen, not one for the app: nothing needs to hear a
sign-in nobody is looking at, and the snapshot a fresh `subscribe` answers with
is the server's current copy — which is also how a reconnect catches up.

## Logged and not logged

A sign-out and a failed read are logged with the CLI's name; a read abandoned
because its client went away is not a failure and is not logged. Account details
(email, organization) are not: they go to the client that asked and nowhere
else.

A sign-in is logged when it starts and ends, by id, with its reason and the
redacted detail. Its link, device code and pasted codes are never logged: they
go to clients over `cli_auth.login.*` and nowhere else, and the code a user
pastes is never echoed back — a notification carries the phase, not the code.
