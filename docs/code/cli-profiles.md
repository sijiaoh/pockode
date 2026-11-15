# AI CLI Profiles

An AI CLI can be signed in to more than one account on the server machine, and
each Pockode server picks one of them — the CLI's current profile — for
everything it starts. The list of profiles is the OS user's, shared by every
Pockode process; the choice among them is each server's own. This document is
where the profiles are kept and what a profile's directory is made of. Which profile a start uses and what it is started with is
in [agent-integration.md](agent-integration.md#which-account-a-cli-runs-as);
signing a profile in, in [cli-auth.md](cli-auth.md#which-profile).

Every start of a CLI runs as its current profile, and a session already open
moves to a newly chosen one on its next message. The profiles are managed
through the [`cli_profile.*` RPCs](#the-rpc) — listing, adding, renaming,
choosing and removing; signing a profile in and out stays with `cli_auth.*`.
The screens that do it are in [cli-profiles-ui.md](../cli-profiles-ui.md).

Verified against Claude Code 2.1.325 and codex-cli 0.169.0, on macOS.

## Where it lives

| Path | Holds |
|------|-------|
| `server/cliprofile/cliprofile.go` | `Store`: the profile list, `cli-profiles.json`, and this server's current profile, `<dataDir>/current-cli-profiles.json` |
| `server/cliprofile/prepare.go` | each CLI's layout — what a profile shares and what it keeps — and `Prepare`, which makes a profile's directory match it |
| `server/cliprofile/availability.go`, `platform_{unix,windows}.go` | whether this machine can have profiles at all, and what differs on Windows |
| `server/cliprofile/withdraw.go` | what this process alone knows of its profiles: the ones it is removing (`Withdraw`), and the one-shot CLIs running as each (`LaunchOneShot`, `WaitUnheld`) |
| `server/cliprofile/launch.go` | `Resolve` / `Launch`, the one way a CLI start asks for its profile; `Check`, which refuses a client's profile ID the list does not have |
| `server/cliprofile/overview.go` | `Overview`, the lists and the availability as a client is shown them |
| `server/cliauth/remove.go` | `Service.SwitchProfile` / `RemoveProfile`: a switch and a removal, which have to exclude each other and the CLI's sign-in commands |
| `server/ws/rpc_cli_profile.go` | the `cli_profile.*` methods |
| `server/watch/cli_profile.go` | `CLIProfileWatcher`, which pushes this server's changes to the lists |
| `server/cliprofile/cliprofiletest/` | profiles for tests, with the default directory in a temporary one, and a fake CLI on `PATH` that records how it was started |

## One official mechanism, no copied credentials

Each CLI already supports several accounts in its own way: one configuration
directory per account, named by `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. A profile
is exactly that. Pockode never keeps a token of its own (`claude
setup-token`) and never copies or swaps credential files between directories:
both CLIs rotate the refresh token on use, so of two copies of one sign-in, one
stops working.

**The default profile is the directory the CLI uses without Pockode** —
`~/.claude` / `~/.codex`, or the `CLAUDE_CONFIG_DIR` / `CODEX_HOME` the user
started Pockode with (`cliprofile.DefaultDir`). It is implicit and never
stored, so nothing is migrated and a user who never adds a profile sees no
change. Pockode never sets those variables in its own environment, only in the
CLIs it starts, so the default stays the user's directory however many
profiles run.

## The store: a list per OS user, a choice per server

`cli-profiles.json` sits in the OS user's configuration directory, beside
[`cloud.json`](cloud-account.md) and for the same reason: every Pockode process
of the OS user — servers in different projects, a cluster and the nodes it
starts — reads and changes the same list, so an account added, renamed or
signed in from one is there in all ([cluster.md](../cluster.md#frontend-ux)).
The profile directories are under it, in `cli-profiles/<cli>/<id>/`.

```json
{
  "claude": { "profiles": [{ "id": "<uuid v7>", "name": "Work" }] },
  "codex":  { "profiles": [ ... ] }
}
```

A CLI with no profiles has no key at all.

**Which profile is current is not in that file.** Each server keeps its own
choice in its data directory (`--data`, `<work>/.pockode` by default), as
`current-cli-profiles.json`:

```json
{ "claude": "<id>" }
```

So switching accounts in one project's server, or on one cluster node, changes
what no other Pockode runs as: a cluster node is a server with a data directory
of its own, and needs nothing more. A CLI absent from the file is on the
default profile. The data directory's `.gitignore` already ignores the file
([data-model.md](../projects/data-model.md#what-the-projects-git-sees)), and it
survives a restart.

- **A choice that names nothing reads as the default profile** — one naming a
  profile no longer listed (removed, here or by another process), another CLI's
  profile, `null`, or a damaged file (quarantined as `.corrupt`). A stale ID is
  left in the file, harmless since IDs are UUIDv7s and never reused. That is
  what makes a removal reach every server that had chosen the profile without
  any of them being told ([below](#removing-a-profile)).
- **There is no global choice any more.** Before the choice was per server,
  each CLI's entry in `cli-profiles.json` had a `current` every Pockode process
  followed. It is not carried over to anyone: reading ignores it, so after the
  upgrade every server that has not chosen is on the default profile, and the
  next change to the list (an add, a rename, a removal) rewrites the file
  without it — which also moves an older-version process still running, a
  cluster node not yet restarted, to the default.
- `SetCurrent` checks that the profile is listed, then writes only the choice
  file (read-modify-write under that file's lock). A removal by another process
  landing between the two leaves a choice naming nothing, which reads as the
  default.
- **A directory is named by the server-issued ID, never by the name.** The name
  lives only here, so renaming never moves a directory a running CLI has open,
  and a name can be anything a user types (1–64 characters, no control
  characters; unique per CLI ignoring case, since two profiles told apart only
  by case would be picked by mistake). An ID coming from a client is checked to
  be a canonical UUID before it becomes a path.
- Every change is a read-modify-write under the file's cross-process lock
  (`filestore.UpdateFileAtomic`), so two processes changing the list at once
  both land. A damaged file is quarantined as `.corrupt` and read as the empty
  list — the default profile current — like every other store
  ([data-model.md](../projects/data-model.md#atomic-writes)).
- The `pockode/` directory is restricted (`fsperm.RestrictDir`) before every
  change and every preparation: the profile directories hold credentials, and
  on Windows only the parent's ACL protects them.
- `Remove` drops the profile from the list first and then deletes its
  directory, removing the links in it rather than following them. It touches
  no server's choice: every server whose choice it was reads the default one
  as current from then on. A `Prepare` racing it checks
  the list again once it is done and deletes what it recreated — but only on a
  file that parses and does not name the profile: a missing or damaged file is
  an error, never a reason to delete a directory full of credentials.
  `Remove` deletes only what is in the directory: Claude Code's macOS
  Keychain item for the profile outlives it unless the profile is signed out
  first, and a CLI still running as the profile recreates the directory and
  writes there instead of into the shared one. Both are the caller's to
  prevent — `cli_profile.remove` stops the profile's CLIs and signs it out
  before calling it ([below](#removing-a-profile)).

## A profile directory: its own credentials, everything else linked

A profile has to continue the user's conversations, not start a second set: a
user switching accounts carries on the same sessions under the new one. So a profile's
directory keeps only the credentials to itself, and every other entry is a
symbolic link into the default directory. `Prepare` builds and repairs it, and
runs before every start of the CLI — it only changes what is missing or wrong,
so the cost is reading the profile list and the two directories, and whatever the default directory gained
since (a CLI update adding state) is picked up on the next start.

### What must be shared

Some entries are linked whether or not the default directory has them yet,
because without them the profile is broken rather than merely separate:

| CLI | Always linked | Why (measured) |
|-----|---------------|----------------|
| Claude | `projects/` | the transcripts: with an empty directory `--resume` answers `No conversation found` |
| Codex | `sessions/` | the rollouts: `thread/resume` takes only a thread ID now, and finds the thread there (the state database is backfilled from them) |
| Codex | `thread-writer-locks/` | with `sessions/` shared but not this, two directories' processes wrote the same thread at once; with it, the second is refused (`already has an active writer`) |

Their targets are created in the default directory first: a CLI creating
something under a dangling link fails outright.

### What stays private: a denylist

Everything else in the default directory is linked, except:

| CLI | Kept in the profile |
|-----|---------------------|
| Claude | `.credentials.json*`, `.claude.json*` (the account and its side files — a lock, a temp file renamed over the original, older versions' backups), `sessions/`, `backups/` |
| Codex | `auth.json`, `auth.json.lock`, `auth.lock`, `logs_*.sqlite*`, `tmp/`, `.tmp/`, `shell_snapshots/`; on Windows every `*.sqlite*` ([below](#windows-symbolic-links-required)) |

A denylist rather than an allowlist because CLI updates keep adding state:
`thread-writer-locks/` is the example — small, easy to miss, and a corrupted
thread when it is not shared. An allowlist leaves each such addition unshared,
silently. A denylist goes wrong only when an update adds a new credential
file, or something else that breaks when shared, which it would share — so the list is the credentials and the few
entries that break when two directories share them (per-process state, logs,
temporary files), and nothing else. The patterns end in `*` wherever a file
has companions: a SQLite database is its `-wal` and `-shm` as well, and a
private database with a shared write-ahead log corrupts both.

Claude's `.claude.json` is private because it holds the signed-in account, but
it is more than that: it also keeps user-scope MCP servers (`claude mcp add -s
user`), local-scope ones (`claude mcp add`'s default, under `projects`),
per-project state and onboarding. Without `CLAUDE_CONFIG_DIR` the
default profile's copy is `~/.claude.json`, beside `~/.claude` rather than in
it, so there is nothing to link either way: a profile starts with an empty one.

Left at that, a session would lose the user's user-scope MCP servers the moment
it switched accounts. So a session on another profile is given them on the
command line (`server/agent/claude/user_mcp.go`): Pockode reads `mcpServers`
from the default profile's file — only that key, so an entry elsewhere in a
shape it does not expect cannot cost the user their servers — and puts the
entries, as Claude wrote them, into the `--mcp-config` it already writes for
its own server. It never writes the profile's `.claude.json`: Claude rewrites
that file whenever it likes, and two writers would race. It reads without a
lock, since Claude replaces the file by rename and a lock would leave a
`.lock` beside a file that is not Pockode's.

`--mcp-config` outranks every scope Claude reads itself (measured on claude
2.1.325: a server named there replaces a local- or user-scope one of the same
name). Given blindly, the user's server would override a project's `.mcp.json`
or a local-scope server of the same name — the opposite of what the default
profile does. So a server is left out when one of its name is in a scope that
should win: the profile's own user scope, its local scope, or a `.mcp.json` in
the working directory or any directory above it. For the same reason the
default profile is given nothing: Claude reads its user scope itself. Pockode's
own server wins a clash with the user's — without it a session has no `work_*`
tools.

The local scope is the one entry of `projects` Claude keys the working
directory by, and the key is matched exactly as Claude picks it (measured on
claude 2.1.325, which reads the files under `.git` rather than asking git):
outside a repository, the directory itself and nothing above it; anywhere in a
main worktree, its top level; in a linked worktree, the main one's — the parent
of the common git directory, or that directory itself when it is not named
`.git` (a bare repository, or one cloned with `--separate-git-dir`). Where a
worktree sits says nothing about its repository — Pockode makes its own beside
it, in `<repository>-worktrees/` — so Pockode asks git once (`git rev-parse
--absolute-git-dir --git-common-dir --show-toplevel`, and only when the
profile's file has any `projects` at all) and tells a linked worktree apart by
its git directory. Git runs without the server's own `GIT_*` variables and across
filesystem boundaries, so it finds the repository from the `.git` files upwards
as Claude does, and in English, so that "not a git repository" can be told
from other failures. Matching every directory above instead would be wrong both
ways: it misses a worktree outside the repository, and it takes a local server
added in, say, the home directory for one that should win, dropping the user's.

When git cannot answer — not installed, a repository it refuses to read, a
timeout, or a pruned linked worktree, for which the key Claude would use is
not known — the session still starts: every directory from the working one up
counts, which is still right inside a main worktree, and a warning is logged
that the user's servers may override the profile's own. Only then can a
worktree outside the repository miss the profile's local server of a name, or
a local server keyed above the project drop the user's.

A missing default file is no servers. One that cannot be read or parsed does
not stop the session — a damaged file of the user's would otherwise stop every
session on the profile — but it is not silent either: the session starts with
Pockode's server alone and says so in the chat (`user_mcp_servers_unavailable`),
on every start until it is fixed. A single bad entry is passed through as it
is: Claude skips an invalid entry in `--mcp-config` and starts the rest.
One-shots are unaffected: they run with `--strict-mcp-config` and no servers at
all. Codex needs none of this — its MCP servers are in `config.toml`, which is
shared.

Still lost on another profile:

- **Local-scope servers.** They live in the default profile's `projects`, and
  only the user scope is carried over.
- **A remote server's OAuth sign-in.** Its tokens are kept with the account's
  credentials (the Keychain on macOS), so it has to be authorized again under
  each profile.

Configuration is shared on purpose — `settings.json`, `config.toml`, plugins,
models cache. Both CLIs were measured writing through the link into the shared
file (Codex's `config/value/write`, Claude's `plugin disable`), not replacing
it. That is also why a setting that must differ per profile cannot go in the
file: Codex's credential store is given on the command line instead
([agent-integration.md](agent-integration.md#which-account-a-cli-runs-as)).

### Every link is Pockode's; nothing real is moved

`Prepare` repairs links and leaves everything else alone:

- **Its own links** — dangling ones (the default directory moved, or lost the
  entry) are recreated or removed; one whose name has become private is
  removed. Removing a link loses no data.
- **A real file or directory where a link should be** — one the CLI created
  before the default directory had it, say — is never moved: the CLI may have
  it open, and moving a SQLite database in use splits it from its WAL. It is
  reported as a `Conflict`, logged, and readable without changing anything
  (`Store.Conflicts`, which [`cli_profile.inspect`](#the-rpc) reports). The profile still works; it
  just does not share that entry until the user resolves it.
- **A link into another directory that still exists** is a conflict too, not
  repointed: it is another Pockode process of the same user started with a
  different `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and two processes repointing
  each other's links would split a running CLI's files between two
  directories.

Each removal looks at the entry again first: the plan may be stale by the time
it runs, and another `Prepare` of the same profile (every start runs one) may
have replaced a dangling link with a working one already. Two `Prepare`s
creating the same link both succeed.

A Pockode started from inside a CLI running on a profile inherits that
profile's directory as its default. `Prepare` refuses there — linking a profile
into another would chain them instead of sharing the user's directory — and
says to start Pockode without the variable.

## The RPC

```
cli_profile.subscribe   { id }                       ->  { profiles: Overview }
cli_profile.unsubscribe { id }                       ->  {}
notification cli_profile.changed { id, profiles: Overview }
cli_profile.inspect     { agent?, profile_id? }      ->  { profiles: [Inspection] }
cli_profile.add         { agent, name }              ->  { profile: { id, name } }
cli_profile.rename      { agent, profile_id, name }  ->  {}
cli_profile.switch      { agent, profile_id }        ->  {}
cli_profile.remove      { agent, profile_id }        ->  {}
```

```jsonc
// Overview
{
  "available": false,
  "unavailable_reason": "...",       // when not available: why, for the user
  "clis": [{
    "agent": "claude",
    "current_profile_id": "...",     // this server's choice; absent: the default profile
    "profiles": [{ "id": "...", "name": "Work" }]   // the stored ones; never the default
  }]
}

// Inspection
{
  "status": { ... },                 // a cli_auth.status Status, profile_id naming the profile
  "conflicts": [{ "name": "history.jsonl", "path": "..." }],  // entries the profile fails to share
  "conflicts_error": "..."           // why conflicts could not be read
}
```

The CLIs are in display order in both, the ones `cli_auth.*` knows; a change
naming any other CLI is invalid params. The default profile is every CLI's,
with ID `""` and no name, so it is never in `profiles`: a client draws it
itself. `add` does not make the new profile current, and `switch` takes
`profile_id` whatever it is switched to — `""` for the default — because an
absent one would otherwise read as "the current profile", as it does on
`cli_auth.*`.

`current_profile_id` is this server's choice, and `switch` changes only that:
no other Pockode process — another project's server, another cluster node —
follows it, and a switch made on one of them is neither pushed nor applied
here.

**The lists are pushed, the states are read.** The lists and this server's
choice are Pockode's own files, so what this server changes in them — an add,
a rename, a switch, a removal — it pushes to its clients as `cli_profile.changed`, the whole
`Overview` read afresh when sent (`watch/latest.go`, so changes that pile up
collapse into one). A change another Pockode process makes is not heard of
here; a client sees it on its next subscribe, or with the next change this
server pushes. The choice is this server's alone, so every change to it is one
of its own and pushed — except a removal by another process
([below](#removing-a-profile)), which this server does not hear of. The sign-in states and the conflicts come from the CLIs'
directories, which change with nothing in these files changing, so they are not
in the pushed value at all: `inspect` reads them when asked, for the reason
`cli_auth.status` gives ([cli-auth.md](cli-auth.md#no-subscription)). It is
`cli_auth.status` with `all_profiles` underneath — every profile read
concurrently, each CLI's default first — so its budget and the client timeout
it needs are that method's ([cli-auth.md](cli-auth.md#timeouts)). The default
profile has no conflicts: it is what the others link into.

`profile_id` narrows `inspect` to one profile of `agent` (`""` the default
one); absent, it reads them all — never "the current one", as it would mean
on `cli_auth.*`. A client that asks for each profile separately gets each
answer when that profile is read, rather than all of them once the slowest
Codex read is over; the web client does that
([cli-auth.md](cli-auth.md#the-web-client)).

What a client needs to say why something does not work is in these two
replies:

- **No profiles on this machine** — `available: false` and its
  `unavailable_reason`: symbolic links not allowed
  ([below](#windows-symbolic-links-required)), or no configuration directory to
  keep a list in. Where symbolic links are not allowed, `current_profile_id`
  still shows the choice and a switch is not refused: the choice takes effect
  once this server restarts where they are, which is what
  `unavailable_reason` tells the user to do. Until then every CLI runs as its
  default profile, and a status read for another profile answers
  `unavailable` saying why. Without a
  configuration directory there is no list to change: `add`, `rename` and
  `switch` fail with that reason as an internal error (there is no stored
  profile to remove).
- **Profiles that cannot change the account** — `external` on every profile
  of the CLI alike. `ANTHROPIC_API_KEY`, an `apiKeyHelper` in the shared
  settings, a Codex model provider that needs no sign-in: these come from the
  environment Pockode was started in or from shared configuration, not from a
  profile, so a session uses that credential whichever profile is current. A
  client that sees the same `external` on every profile can say switching
  changes nothing, and name the source; `external` on one profile only is that
  profile's own sign-in, a Codex API key
  ([cli-auth.md](cli-auth.md#deciding-external)).
- **An entry the profile does not share** — `conflicts`, each with the path of
  the profile's own copy ([above](#every-link-is-pockodes-nothing-real-is-moved)).
- **The CLI signing in** — while a sign-in runs, every profile of its CLI
  reads `signing_in`; `login_profile_id` says which one is signing in
  ([cli-auth.md](cli-auth.md#which-profile)).

Input is checked at the boundary. A name is the user's: trimmed, then held
to the rules [above](#the-store-a-list-per-os-user-a-choice-per-server), refused with the reason as
invalid params. A profile ID only selects: one that is not a stored profile of
the CLI — a path among them — is `profile not found` before it is used for
anything, and a directory is only ever named by an ID the server issued.
Renaming the default profile is refused, since it has no name. A refused
change writes nothing and pushes nothing.

## Switching and removing

Choosing another profile changes no running CLI, and nothing has to be told:
every session of this server reads the current profile again on its next
message, and one
whose process runs as another is moved over once its turn is over, carrying on
the same conversation
([agent-integration.md](agent-integration.md#a-session-follows-the-current-profile)).
A turn in progress — running, parked on background work, or waiting on a
permission answer — is not interrupted. The choice is this server's, so a
switch made on another cluster node, or in another project's server, changes
nothing here. A sign-in or sign-out made elsewhere still does: the profiles'
directories are shared, and the next start here reads them. A removal of the
profile this server had chosen moves it to the default the same way
([below](#removing-a-profile)).

### Removing a profile

Being current is no reason to keep a profile. Removing one that this server,
or any other, has chosen is allowed: every server whose choice it was is on the
default profile once it is off the list ([above](#the-store-a-list-per-os-user-a-choice-per-server)),
and moves its sessions over on their next message as after a switch. This
server is one of them; refusing only here would be the odd case out, since
another server could remove the profile from under it anyway. No server is
told; only the one that removed the profile pushes the change.

What removal has to guarantee is the rest. No CLI may still run as a profile
when it is removed, or that CLI recreates the directory and writes a real
`projects/` into it, and from then on the shared conversations are split. Nor
may its sign-in be left behind: on macOS Claude Code keeps the credentials in a
Keychain item named after the directory, and once the directory is gone nothing
can find that item again. So `cli_profile.remove`
(`cliauth.Service.RemoveProfile`) goes in this order, and any step that refuses
leaves the profile as it was — listed, signed in, its directory untouched, and
current wherever it was — and pushes nothing:

1. **Refuse the default profile, and withdraw this one**
   (`cliprofile.Store.Withdraw`). The default is the CLI's own directory. A
   sign-in or an update already running refuses here, before anything is
   withdrawn. Withdrawn means, in this process's memory only, that from here
   until the end this server starts nothing as the profile unless asked for it
   by name: where it is current, `Resolve` reads the default one in its place,
   as it will once the profile is off the list, so a session stopped for the
   removal, and a session or one-shot started during it, starts as the default.
   A switch to it, a sign-in to it and a second removal of it are refused
   (`ErrProfileRemoving`). The stored choice is not touched: `Load`, and so
   the `Overview`, still show the profile as current while the removal runs,
   and a refused removal leaves it current again. The sign-out in step 4 names
   the profile explicitly and is unaffected.
2. **Take the profile's sign-in lock**, the one a sign-out takes
   ([cli-auth.md](cli-auth.md#one-command-per-profile-at-a-time)): a status read
   or a sign-out for it waits until the removal is over, and then fails rather
   than recreate the directory. A sign-in or an update of the CLI that started
   meanwhile refuses the removal.
3. **Release this server's CLIs on it** — `worktree.Manager.ReleaseProfile`
   stops the idle sessions on it, waits for their CLIs to exit, and names the
   sessions still mid-turn on it, which refuse the removal
   ([agent-integration.md](agent-integration.md#releasing-a-profile)); then
   `Store.WaitUnheld` waits for the one-shots still running as it (a commit
   message draft, say), which launch through `Store.LaunchOneShot` and hold
   the profile until their CLI exits. It runs without the profile list's lock,
   which a process start takes under its own. Both have to finish within the
   20s the lock wait started, or the removal is refused; the CLIs it stopped
   stay stopped, and a retry waits out the rest.
4. **Sign it out.** A failure refuses the removal. Skipped where profiles
   cannot be used ([below](#windows-symbolic-links-required)), for the reason
   given under "A failed sign-out keeps the profile".
5. **`Store.Remove`** — the list first, then the directory. On success this
   server pushes the change once: the profile gone and, if it was current
   here, `current_profile_id` absent — the same shape as a switch to the
   default.

Why this order, and these refusals:

- **Withdraw rather than refuse.** The release needs the profile not to be
  current, or whatever it stopped would come straight back as it; withdrawing
  gives it that without changing the user's choice, which a refusal has to
  leave as it was. The cost is a window: while a removal runs, a new turn of
  this server's that would have started on the profile starts on the default
  account, even if the removal is then refused. Refusing a sign-in or an update
  before withdrawing keeps the refusals known at once from opening it; what
  still can is the wait for the lock, the release and the sign-out.
- **Release before signing out.** A removal refused because a turn is running
  should leave the profile as the user had it, and a turn running on it should
  not lose its credentials halfway. It also keeps a CLI of this server from
  refreshing its token after the sign-out and writing the credentials back.
- **A failed sign-out keeps the profile.** Removing the directory anyway would
  leave the Keychain item beyond reach, while trying again is cheap. The one
  exception is a machine where profiles cannot be used: no CLI can run as the
  profile there to sign it out, and the only credentials kept outside the
  directory are in the macOS Keychain, on a system where profiles can always
  be used — so the directory is all there is, and it is removed without one.
- **A sign-in refuses, it is not cancelled.** It may be a user halfway through
  on another device, and any sign-in holds the whole CLI, so the sign-out the
  removal needs could not run beside it anyway. A client that wants to go
  ahead cancels it (`cli_auth.login.cancel`) and removes again.
- **Switch and remove exclude each other** (`switchMu`, which every switch on
  this server goes through: `cli_profile.switch` calls
  `cliauth.Service.SwitchProfile`, never the store). The withdraw alone already
  keeps a switch from starting anything as the profile; the exclusion is so
  that a switch reported as done is not silently undone by a removal already
  under way — it is either stored before the removal, after which it names
  nothing and reads as the default, or refused as `removing`.

A refusal the user can act on is `CodeCLIProfileRemoveRefused` (`-32014`) with
`data.reason`; the message says the whole thing in English:

| `reason` | When |
|---|---|
| `in_use` | Sessions of this server are mid-turn on it; `data.sessions` names them (`{ worktree?, session_id }`, no `worktree` for the main one). The idle ones have been stopped already, and move to the current profile on their next message — the default one while the removal runs, if the profile was current here. Trying again once those turns are over works |
| `signing_in` | The CLI is signing in — this profile or another; the message says which |
| `updating` | The CLI is being updated or installed |
| `removing` | Another request is removing the same profile |
| `sign_out_failed` | The sign-out failed; the message carries the CLI's error |
| `still_exiting` | CLIs of this server running as the profile — sessions told to stop for the release, or one-shots — had not exited 20s after the lock wait began. Trying again waits out what is left of them |

There is no `current` reason any more: the profile being current, here or
anywhere, is not a refusal.

The default profile, an ID that is not a stored profile and an unknown CLI are
invalid params, as for the other methods. A removal that took the profile off
the list but could not delete its directory (`cliprofile.ErrDirectoryLeft`) is
an internal error naming the directory — and is pushed, since the list did
change. Waiting more than 20s for the profile's lock is an internal error too.

A removal can take the lock wait and the release (up to 20s together) and the
sign-out (up to 45s) before it answers — the 65s a sign-out can take — so a
client gives it the long timeout `cli_auth.logout` has
([cli-auth.md](cli-auth.md#timeouts)). The release shares the lock's 20s
rather than having a budget of its own because that is the whole margin: a
release with its own time on top would push the worst case past the 75s the
client waits, and the client would give up on a removal the server then
finishes.

**Starts racing a removal by another process.** A session start that read the
profile as current just before another process removed it is refused by
`Prepare`, which finds the profile off the list (`cliprofile.ErrNotFound`);
`process.Manager.GetOrCreateProcess` then reads the current profile again —
the default one by now — and starts as that, rather than failing the message.
`LaunchOneShot` does the same for a one-shot. A `Prepare` that recreated the
directory meanwhile deletes what it made, as [above](#the-store-a-list-per-os-user-a-choice-per-server).

**Known risks, not covered by that order** — all across processes, and not
closable without a lease every process's CLIs hold on a profile:

- **Other Pockode processes' CLIs.** `ReleaseProfile` and `WaitUnheld` see
  only what this server started. A CLI started by another cluster node, or by
  a server for another project, may still run as the profile, and nothing on
  this side can know. That server falls back to its default with nothing to
  tell it: its sessions move off the profile on their next message, but one
  left idle keeps its CLI until its lease collects it, and one mid-turn runs
  until the turn ends. Such a CLI runs against a deleted directory and may
  recreate it, splitting the conversations as above, and a token refresh after
  the sign-out could write credentials back — on macOS into a Keychain item
  nothing can reach.
- **Another process's start just before `Remove`.** One that passed
  `Prepare`'s final "still listed" check a moment before the profile left the
  list has the same effect, in a window of milliseconds.
- **Another process's status reads, sign-outs and sign-ins** are not held off
  by this server's lock either.
- **Two processes removing the same profile at once:** the later one finds it
  gone and fails.
- **A CLI that is not installed** cannot sign out, so its profiles cannot be
  removed until it is installed again. This is deliberate, for the Keychain
  item above; there is no forced removal.
- **Signed out, then `Remove` failed** — reading or writing the list — leaves
  the profile listed and signed out. Removing it again finishes the job.

A real fix would be a per-profile file lock every process's CLIs hold shared
for their lifetime, which `Remove` takes exclusively, or which defers deleting
the directory to whoever lets go of it last. That is a design for later.

## Windows: symbolic links required

A profile directory is made of symbolic links, files among them, and nothing
else will do: a junction links only directories, and a hard link to a SQLite
database that is rewritten or replaced splits into two copies. Windows lets a
program create symbolic links only with Developer Mode on.

So each `Store` probes once, by creating a file link in the `pockode/`
directory that holds the profile directories (`Store.Availability`). Without the permission there is only
the default profile: this server's current profile resolves to it (logged once,
and kept for when it restarts with the permission), a start
or sign-in naming another profile is refused with `ErrSymlinksUnavailable`,
and the reason tells the user to turn on Developer Mode (Settings > System >
For developers) and restart Pockode — the privilege is granted to new
processes, so the probe is not repeated. The list itself is still the shared
one: another process of the same user may well be able to use it. A machine
with no configuration directory at all has no store and likewise only the
default profile.

Even with links, Codex's SQLite databases stay private on Windows. SQLite's
unix layer resolves a linked database to the real file and keeps the `-wal`
and `-shm` beside it, so every profile meets in one write-ahead log; its
Windows layer does not, and would put a second log beside the link, corrupting
the database. Conversations still resume — the state is backfilled from the
shared `sessions/` — but the rest of that state (memories, goals, thread
history) is per profile there.

Not verified on Windows: that the CLIs write configuration through a link
rather than replacing it.
