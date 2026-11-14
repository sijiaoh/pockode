# AI CLI Profiles

An AI CLI can be signed in to more than one account on the server machine, and
Pockode picks one of them — the CLI's current profile — for everything it
starts. This document is where the profiles are kept and what a profile's
directory is made of. Which profile a start uses and what it is started with is
in [agent-integration.md](agent-integration.md#which-account-a-cli-runs-as);
signing a profile in, in [cli-auth.md](cli-auth.md#which-profile).

What is wired up today is the running side: every start of a CLI runs as its
current profile. Adding, choosing and removing profiles have no RPC or screen
yet; `Store` already has them for the profile screens to come.

Verified against Claude Code 2.1.325 and codex-cli 0.169.0, on macOS.

## Where it lives

| Path | Holds |
|------|-------|
| `server/cliprofile/cliprofile.go` | `Store`: the profile list and the current profile, `cli-profiles.json` |
| `server/cliprofile/prepare.go` | each CLI's layout — what a profile shares and what it keeps — and `Prepare`, which makes a profile's directory match it |
| `server/cliprofile/availability.go`, `platform_{unix,windows}.go` | whether this machine can have profiles at all, and what differs on Windows |
| `server/cliprofile/launch.go` | `Resolve` / `Launch`, the one way a CLI start asks for its profile |
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

## The store: one per OS user

`cli-profiles.json` sits in the OS user's configuration directory, beside
[`cloud.json`](cloud-account.md) and for the same reason: every Pockode process
of the OS user — servers in different projects, a cluster and the nodes it
starts — reads and changes the same list, so choosing an account in one is
choosing it in all ([cluster.md](../cluster.md#frontend-ux)). The profile directories are
under it, in `cli-profiles/<cli>/<id>/`.

```json
{
  "claude": { "current": "<id>", "profiles": [{ "id": "<uuid v7>", "name": "Work" }] },
  "codex":  { "profiles": [ ... ] }
}
```

- `current` absent is the default profile. A CLI with no profiles, and so on
  its default one, has no key at all.
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
  ([data-model.md](../projects/data-model.md#atomic-writes)); a `current` naming no profile,
  which a hand edit can produce, reads as the default too.
- The `pockode/` directory is restricted (`fsperm.RestrictDir`) before every
  change and every preparation: the profile directories hold credentials, and
  on Windows only the parent's ACL protects them.
- `Remove` drops the profile from the list first and then deletes its
  directory, removing the links in it rather than following them; a removed
  current profile leaves the default one current. A `Prepare` racing it checks
  the list again once it is done and deletes what it recreated — but only on a
  file that parses and does not name the profile: a missing or damaged file is
  an error, never a reason to delete a directory full of credentials.
  `Remove` deletes only what is in the directory: Claude Code's macOS
  Keychain item for the profile outlives it unless the profile is signed out
  first, and a CLI still running as the profile recreates the directory and
  writes there instead of into the shared one. Both are the caller's to
  prevent — sign out, and stop the profile's CLIs, before removing.

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
user`), per-project state and onboarding. Without `CLAUDE_CONFIG_DIR` the
default profile's copy is `~/.claude.json`, beside `~/.claude` rather than in
it, so there is nothing to link either way: a profile starts with an empty one,
and the user's own user-scope MCP servers are absent there until added again.
Pockode's own MCP server is unaffected — it is given on the command line.

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
  (`Store.Conflicts`, for the screens to come). The profile still works; it
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

## Windows: symbolic links required

A profile directory is made of symbolic links, files among them, and nothing
else will do: a junction links only directories, and a hard link to a SQLite
database that is rewritten or replaced splits into two copies. Windows lets a
program create symbolic links only with Developer Mode on.

So each `Store` probes once, by creating a file link in the `pockode/`
directory that holds the profile directories (`Store.Availability`). Without the permission there is only
the default profile: the current profile resolves to it (logged once), a start
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
