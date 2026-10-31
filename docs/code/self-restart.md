# Self-Restart

How a running `pockode` — a server or a cluster manager — replaces itself with
the executable that is on disk now, so an upgrade done with the install script
takes effect without anyone stopping and starting it in a terminal. What is
saved at startup to make that possible, what is checked before anything stops,
how the password crosses over, and how unix and Windows differ in the final
step.

The screens are [restart-ui.md](../restart-ui.md); the wire contract of
`server.version` / `server.restart` and how their reply is delivered is
[websocket-rpc.md](websocket-rpc.md#server-installed-version-and-restart).

| Piece | Where |
|---|---|
| The program, the probe, the decision, the replacement | `server/internal/restart/` (`replace_unix.go`, `replace_windows.go`) |
| SIGUSR1 and the Windows restart event, both ends; holding interrupts on Windows | `server/internal/shutdown/` |
| The password across the boundary | `server/password/` — `WithEnv`, `ClearFlags` |
| The RPCs, shared by both modes | `server/ws/rpc_server.go` — `ServerControl` |
| Closing WebSockets on shutdown | `server/ws/connections.go` |
| Wiring | `server/main.go` — `newRestarter`, the shutdown goroutine, `runCluster` |

## A restart is a shutdown with a different ending

There is no second way of stopping. A restart runs the ordinary graceful
shutdown — relay, HTTP server, WebSockets, scheduler, CLI updates and sign-ins,
sessions flushed, every AI CLI ended — and only at the very end, where the
process would return from `main`, it calls `Restarter.Restart` instead. Anything
the shutdown already gets right, a restart gets right for free, and a change to
the shutdown cannot forget the restart.

Two things ask for one:

- **The UI** — `server.restart`, from Settings → Pockode in `web` or the
  cluster panel's header ([restart-ui.md](../restart-ui.md)).
- **Another process**, through `shutdown.RequestRestart(pid)`: SIGUSR1 on
  unix — so `kill -USR1 <pid>` from a script or a person at a terminal — and
  on Windows the named event `Local\pockode-restart-<pid>`, which only a
  program can signal. A server's PID is in its `server.json`; a cluster
  manager publishes none. A cluster asks its nodes this way, with `node.restart`
  ([cluster.md](../cluster.md#restarting-from-the-cluster)).

Both go through `Restarter.Request` (the RPC through `RequestHeld`, below), so
both are checked the same way and refused the same way.

## What is saved at startup

`restart.Current` captures the executable's path, the arguments after it and
the working directory, in `newRestarter`, early in `main`. None of the three can
be asked for reliably later:

- **The path.** Once an upgrade has renamed a new binary over the running one,
  Linux reports `os.Executable()` as `… (deleted)`. So the path is resolved
  while it is still true.
- **Which path.** `os.Executable()` resolves symlinks, and a package manager
  that installs `bin/pockode` as a link into a versioned directory moves the
  link on an upgrade and removes the old directory — the resolved path is
  exactly the one that stops existing. So the path the process was invoked by
  (`argv[0]`, looked up in `PATH` if it is a bare name) is preferred, but only
  when it names the same file `os.Executable()` does: `argv[0]` is whatever the
  parent chose to put there, and is not trusted beyond that.
- **The working directory.** A restart runs in it, so that a relative `-work`
  or `-data` means what it meant.

The environment is not saved: the new run inherits the old process's as it is
at the moment of the restart, the password aside (below). A `PATH` a CLI
installer has changed since in the user's profile is therefore not seen — a
restart is no substitute for starting from a new terminal there. On Windows,
AI CLIs installed into the usual installer directories (`%APPDATA%\npm` and
the others in `server/agent/command_windows.go`) are found anyway, without any
restart: `agent.Command` searches those on every lookup.

`newRestarter` runs after `--version` is handled, not before: `--version` is
what the probe below runs, and it must not depend on the working directory
being there.

A cluster starts its nodes from the same saved path
(`node.NewProcessManager(Program().Path)`), not from `os.Executable()` at the
moment of the Start, for the same `(deleted)` reason: on Linux, a node started
after an upgrade would otherwise fail to start at all.

## Checked before anything stops

`Request` runs `<path> --version` and checks that the working directory still
exists. If either fails, the request is refused with a `*NotRunnableError` and
the process carries on as if nothing had been asked: nothing has been stopped
yet, and nothing will be. The probe is `Program.Version`, which is also what
`server.version` reads the installed version with — the check and the display
cannot disagree about whether the file runs.

The probe catches a missing file, one that does not execute (wrong
architecture, no permission, a truncated download) and one that prints no
pockode version. It runs with a 10 s bound, and with `CREATE_NO_WINDOW` on
Windows, so a server without a visible console does not flash one.

**What it cannot catch is a new version that refuses the old command line.**
The probe runs `--version` alone, not with the saved arguments, so a release
that has dropped or renamed a flag the process was started with passes it and
then exits on the flag (status 2, the flag package's) once it is run with the
original arguments. Running the new
binary with the real arguments as a check would start a second server. The one
case known ahead of time is handled: the deprecated `-auth-token` (removed in
`password.RemovalVersion`) is replayed as `-password=` (see the password
section). For any other, the release notes are the warning, and the failure is
the one in [When the last step fails](#when-the-last-step-fails).

## Who decides the ending

`Restarter` is one per process, and requests can arrive from any goroutine — an
RPC on each connection, the signal watcher. The rule is that **the request the
shutdown loop takes first decides how the shutdown ends**:

- An accepted restart makes every later restart request `ErrAlreadyRestarting`
  — the UI turns that into "already restarting" and waits like the first one.
- An exit request (Ctrl+C, SIGTERM, the Windows named event) that the loop takes
  calls `Restarter.Close`: every later request is `ErrShuttingDown`, and a
  restart that was accepted while the exit request was being taken is dropped.
  Without that, a Ctrl+C racing a probe could turn into a restart the person
  pressing it did not ask for.
- `Pending` is read after the shutdown has finished; only then does `main` call
  `Restart`.

Probes are serialised (`probeMu`) and the state is checked again after waiting,
so two Restart presses on two devices run the executable once.

**SIGUSR1 during startup.** Until something catches it, SIGUSR1's default
action is to terminate, and `shutdown.Listen` comes late in startup, after the
relay is up. A second request sent while a restarted process comes back up
would kill it. So `newRestarter` first calls `shutdown.HoldRestartRequests`,
which catches the signal from then on and hands what arrived to the first
`Listen`; once the shutdown has started, further ones are dropped. It catches
and never ignores: an ignored signal stays ignored in every child, and the AI
CLIs are Node programs, for which SIGUSR1 means something. The moment between
`exec` and that call — runtime start-up and flag parsing — is still uncovered;
nothing in the process runs early enough to cover it.

On Windows the same call publishes the restart event, and requests that come
through it are routed exactly as signals are: held until the first `Listen`,
dropped once the shutdown has started. The event is auto-reset, unlike the
shutdown event: a refused restart leaves the process running, and the next
request has to be seen as a new one. A process that has not published it — a
build that predates restarts, or one between start-up and
`HoldRestartRequests` — is reported to the caller as `ErrRestartUnsupported`;
unix cannot tell, since a signal reaches a process whether or not it is
caught, so a caller that must not terminate an old build checks the `version`
in its `server.json` first, which every build that catches the signal writes.

A second SIGUSR1 cannot cut a shutdown short. A second Ctrl+C still can: the
default handling is restored once the shutdown begins, for a shutdown that is
taking too long.

## The shutdown and the AI CLIs

A restart must not leave an AI CLI behind. On unix one left running would be
inherited by the program exec'd in its place, under the same PID, belonging to
nobody; on Windows it would outlive both. The shutdown ends every one it knows
of — session CLIs through `process.Manager.Shutdown` (process group or Job
Object, waited on), sign-ins and CLI updates through their own `Close`.

The one that was missed is the commit message draft (`git.commit.draft`): its
CLI is killed when the WebSocket connection it runs on ends, and
`http.Server.Shutdown` does not end hijacked connections. That is why both
`/ws` handlers now serve through `ws.Connections`, which closes every
connection with `1001` and waits for the requests on them — for an ordinary
exit too ([Closing on Shutdown](websocket-rpc.md#closing-on-shutdown)). It also
matters for Windows, where the old process can stay alive waiting on its
successor: without it, a client would stay attached to a server that has
stopped instead of reconnecting to the new one.

Out of reach, as for any shutdown: a descendant that left the process group on
purpose (`setsid`, a daemonising command an agent ran).

## Handing the password over

The new program needs the password, and argv is the wrong place for it: on Linux
`/proc/<pid>/cmdline` and `ps` show it to every local user, which is the reason
a cluster already gives nodes their password through the environment
([authentication.md](authentication.md#--password-flag-vs-pockode_password-env-var)).
A restart reuses the same function, `password.WithEnv`: it sets
`POCKODE_PASSWORD` and strips any inherited `POCKODE_PASSWORD` or
`POCKODE_AUTH_TOKEN`, so the new process sees exactly one value. The new
process's `password.Load` removes it from its own environment as usual, so its
children do not see it.

The arguments are replayed through `password.ClearFlags`, which empties the
value of `-password` and `-auth-token` in every spelling the flag package
accepts. Empty, the flag falls through to the environment variable. It is
emptied rather than removed so every other argument keeps its place —
`pockode -password x cluster` runs a server with a positional argument, and
dropping the pair would replay it as `pockode cluster`. `-auth-token` is
replayed under the new name, since the version being started may no longer
know the old one. So a password typed on the original command line is not on
the new one, and the deprecation warning for `-auth-token` /
`POCKODE_AUTH_TOKEN` stops appearing after the first restart.

What this does not change: `/proc/<pid>/environ` holds the environment as of the
exec, readable by the same user and root — the same exposure a cluster's nodes
have always had.

## Replacing the process

`replace` is the platform-specific last step; both versions are given the
cleared arguments and the new environment.

### unix: exec in place

`syscall.Exec` after `chdir` to the saved directory, with the original
`argv[0]`. Everything that names the process stays right:

- **The PID**, which is how a cluster finds a node (its `server.json`), and how
  a person who just sent `kill -USR1` finds it again.
- **The parent**, so a shell, `systemd` or another supervisor waiting on the
  process goes on waiting on the new one, and a restart is not mistaken for an
  exit.
- **The session and terminal**: a node stays detached, a server started in a
  terminal stays on it and keeps answering its Ctrl+C.

Go opens every file close-on-exec, so nothing else crosses over.

`server.json` is therefore **kept** across a unix restart instead of being
deleted and rewritten: it still names the right PID, and the new program
rewrites it on start (with a new `token`, `started_at` and `version` — the
new program's). Deleted, a cluster
would see the node *stopped* for the moment in between, and a Start pressed then
would put a second server on the same project.

A cluster that restarts keeps its PID too, and with it its children: the nodes
it started are still its children after the exec, but the goroutines that
waited on them are gone. An exited node would stay a zombie, and `kill(pid, 0)`
succeeds on a zombie — the panel would show it running forever and Stop would
report it still alive after SIGKILL. So the unix `processExists` in
`server/cluster/node` reaps it first (`wait4` with `WNOHANG`). Nodes themselves
are not touched by a cluster restart: they are separate processes, and keep
serving at their own addresses.

### Windows: a successor

Windows has no exec, so the new program is started as a child and the PID
changes. The successor publishes its own `server.json`, with its own PID and
version; the old one is deleted on shutdown as for an exit — before the
successor starts, so the successor's file is never the one deleted — so the
files say the node is *stopped* for the moment between, the gap unix avoids. A
cluster that asked for the restart reports it *restarting* through the gap and
refuses to start it there ([cluster.md](../cluster.md#restarting-from-the-cluster)).

What the old process does next depends on whether someone is waiting on it,
which is decided by whether its standard input is a console:

- **In a terminal.** The shell that started it would hand the prompt back the
  moment it exited, while the successor goes on writing to the same window. So
  the old process stays, waits, and exits with the successor's exit code. The
  successor shares the console with no creation flags, so Ctrl+C reaches it;
  the old process holds Ctrl+C and Ctrl+Break itself
  (`shutdown.HoldInterrupts`) from just before the successor starts, so a
  Ctrl+C meant for the successor does not end the old one early. The price:
  every restart in that terminal adds one waiting process holding its own
  executable open, until the chain ends.
- **Anywhere else** — a node a cluster started, a service wrapper, Task
  Scheduler. Nothing is waiting, and an old process that stayed would be one
  more left behind on every restart. The successor is started with
  `CREATE_NO_WINDOW`, for the same reason nodes are
  ([cluster.md](../cluster.md#asking-a-node-to-exit-on-windows)), and the old
  process exits 0 at once.

**Replacing the file is the hard part on Windows**, not restarting: Windows does
not let a running executable be overwritten, and `install.ps1` stops with "If
Pockode is running, stop it and run this again." So today an upgrade on Windows
still means stopping Pockode first, and a restart there delivers no new
version. CI's Windows leg runs the restart tests without a console on standard
input, so it covers only the "anywhere else" branch; the terminal branch —
waiting on the successor, holding Ctrl+C, passing its exit code on — has been
neither tested nor run by hand.

## When the last step fails

`exec` failing, or the successor not starting, is past the point of carrying
on: the server has shut down already. `Restart` logs `restart failed`, prints
`Error: restart failed: …` on stderr and exits **1**, rather than leave a
process that serves nothing. A new program that starts and then exits — a flag
it does not know — is the same from outside: the process is gone. Its reason is
harder to find, though: the flag package prints it on stderr and exits 2 before
logging is set up, so it is in the terminal the process ran in and not in
`server.log`. A node a cluster started has no stderr, but it has no arguments
either, so it cannot fail this way; a server started by hand in a node's
directory, with flags, can.

On unix that leaves `server.json` naming a dead PID, so a cluster shows the
node **stale** and offers Clean Up, rather than *stopped*. The UI cannot learn
why from a process that is gone; it says how long it has waited and points at
the server's log and terminal ([restart-ui.md](../restart-ui.md#while-it-restarts)).

The log of a restart, in order: `restart requested` (with the installed
version), `shutting down server restart=true`, `server stopped`, `restarting`
(the argument *count*, never the arguments — a `-password` may be among them),
then the new process's `server starting`. A cluster manager logs the same
around its own lines: `shutting down cluster server restart=true`, `cluster
server stopped`, and the new run's `cluster server started`.

## Reading the installed version

`server.version` runs `Program.Version` on every request. Nothing is cached and
nothing is pushed: an upgrade replaces the file without the server hearing of
it, and running a small binary is cheap next to being wrong. The running
version is not part of it; it is the `auth` reply's, which both frontends
already compare against their own build and reload on. That reload is what
makes a restart from anywhere — the UI, `kill -USR1`, another device — look the
same to every page.

On a pockode server the reply also counts `running_turns` across every
worktree (`worktree.Manager.RunningTurns`): what the confirmation dialog says a
restart will stop. A question an agent posted is not counted — it belongs to
the session, which is on disk and survives the restart.

## The reply reaches the client first

A client that sees its connection drop cannot tell a restart from a crash, so
the success reply must arrive before the process starts going down — and the
shutdown starts by stopping the relay. `RequestHeld` accepts the request
(pending, refusing all others) but keeps `Requested` closed until the handler
releases it, which it does once the client has answered the `1012` close frame
sent behind the reply, or after 10 s. The details, and why the close handshake
proves delivery through the relay, are in
[websocket-rpc.md](websocket-rpc.md#server-installed-version-and-restart).

## Testing

`internal/restarttest` lets a package's tests stand the test binary in for the
executable on disk: a package's `TestMain` calls `restarttest.Main`, and a run
of the test binary with `--version` answers whatever `Install` or `Break` last
set. The `ws` and `cluster` packages read an installed version, and fail to,
through the same `Program.Version` the server uses — by running a file, not a
fake.

`internal/restart`'s own tests start real processes end to end: the arguments,
the directory, the password in the environment and not in argv, the PID kept on
unix, and the exit status 1 when the last step fails.
