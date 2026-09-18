# Git

Users view status, diffs and commit history; stage, unstage and discard files; commit and amend; switch or create branches; and sync with the remote. All operations shell out to the `git` CLI. Real-time updates are delivered via the watch/subscription system.

The panel UI built on top of these operations is described in [git-ui.md](git-ui.md).

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──exec──▶ git CLI
                              │
                         watch system (3s polling)
```

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_git.go` | `git.status`, `git.add`, `git.reset`, `git.discard`, `git.commit`, `git.log`, `git.show`, `git.show.diff`, `git.show.file`, `git.branches`, `git.checkout`, `git.branch.create`, `git.fetch`, `git.pull`, `git.push`, and the `git.subscribe` / `git.diff.subscribe` pairs with their unsubscribes |
| Git operations | `server/git/git.go` | Init, Status, Add, Reset, Diff, DiffWithContent, Log, Show, ShowFileDiff |
| Historical file contents | `server/git/showfile.go` | ShowFile |
| Branch operations | `server/git/branch.go` | Head, Branches, Checkout, CreateBranch |
| Remote operations | `server/git/remote.go` | sync state (upstream, ahead/behind, last fetch), Fetch, Pull, Push |
| Commit operations | `server/git/commit.go` | CreateCommit |
| Discard operations | `server/git/discard.go` | Discard |
| Write serialisation | `server/git/lock.go` | A worktree's two locks — index and refs — with what each write takes, `BusyError`, and the operation names that lock and wire share ([Serialising Writes](#serialising-writes)) |
| Command execution | `server/git/command.go` | `gitCommand` / `execGit` / `execGitLines` / `execGitVerbose` / `execGitNetwork`, `CommandError`, and `literalPathspec` |
| Frontend components | `web/src/components/Git/` | `DiffTab` is the panel: `BranchBar` (with `SyncChip`) and `CommitBar` frame the existing `DiffFileList` / `LogList` and open `BranchSheet` / `NewBranchSheet` / `SyncSheet` / `CommitSheet`, and `ErrorBanner` catches the failures with no sheet to land in. `DiffView` renders in the content area rather than the panel, as does the chain from `CommitView` to `CommitDiffView` to `CommitFileView` |
| Frontend types | `web/src/types/git.ts` | Wire types, plus the pure `describeGitSync` / `describeCommitAction` / `describeDiscard` the panel's labels and confirmation copy come from |
| Frontend hooks | `web/src/hooks/useGit*.ts` | The panel's queries, mutations and watch subscriptions. Note `useGitCommit` *reads* a commit (`git.show`) — `useGitCreateCommit` is the one that writes. `useCommitFile` (`git.show.file`) is outside the glob because it is not the panel's: it backs a content-area screen ([git-ui.md](git-ui.md#viewing-a-file-from-a-commit)) |
| RPC actions | `web/src/lib/rpc/git.ts` | RPC action creators for all git methods |
| Query keys | `web/src/hooks/gitQueries.ts` | The panel's three query keys plus `invalidateGitQueries` |

## Path Encoding

Paths the server reports are sent straight back by the frontend as arguments to follow-up commands — `git.status` output feeds `git.add` / `git.reset` / `git.discard` / `git.diff.subscribe` verbatim. A path that is merely *displayable* is therefore not enough; it has to match the file again as a pathspec. When it doesn't, `git diff` reports no changes and `git add` fails outright with `did not match any files`.

Three separate git behaviours get in the way, and each has its own countermeasure:

- **Machine-parsed path lists use `-z`.** In the whitespace-delimited list formats (`status --porcelain`, `--name-status`, `config --get-regexp`) a path containing non-ASCII bytes, spaces or control characters is quoted and C-escaped (`中文.md` → `"\344\270\255\346\226\207.md"`), and `status --porcelain=v1` renders a rename as `old -> new`, which is ambiguous for a file genuinely named `a -> b`. Turning `core.quotePath` off is not sufficient here: it only governs the non-ASCII case, while spaces and control characters keep the path quoted whatever it is set to, and the rename ambiguity is not a quoting problem at all. With `-z` each path is instead a verbatim NUL-terminated field and the rename source is a field of its own.
- **Human-readable output disables `core.quotePath`.** Diff bodies embed paths in their headers (`diff --git a/中文.md`) and have no `-z` form, so those commands run with `-c core.quotePath=false` to keep the header readable. Header quoting is looser than the list formats' — the `a/` `b/` prefixes disambiguate spaces, so only quotes, backslashes and control characters force quoting there. `gitCommand` applies the flag to every command it builds; it is simply redundant under `-z`.
- **Every path goes back to git as a `:(literal)` pathspec.** Everything after `--` is still a pathspec, and pathspec magic is spelled in the *leading characters of the name itself* — nothing to do with the shell, so `exec` without a shell does not help. A file actually named `:!important.txt` reads as `:!` (exclude) applied to `important.txt`, i.e. a pathspec matching every path **but** that one: `git clean -f -- ':!important.txt'` then deletes the whole untracked tree and `git add -- ':!important.txt'` stages every change, each exiting 0 and reported as the success the user asked for. `git status` hands out such a name the moment a file has one. `literalPathspec` in `command.go` turns the magic off for every path that goes back to git — one at a time for `Diff` and `ShowFileDiff`, a whole request's worth at once for `Add`, `Reset` and `Discard` — so each pathspec matches only itself.

  The prefix has a counterpart that has to be guarded, and it is the reason `literalPathspec` returns an error rather than a string: **`:(literal)` with nothing behind it matches everything**, where a bare empty pathspec would have been rejected outright by git. A path that is exactly a submodule's own directory resolves to an empty path inside that submodule, so such a path is refused rather than turned into a pathspec that would take the whole submodule with it.

None of this helps when a filename is not valid UTF-8 (e.g. latin-1 byte sequences), since `encoding/json` replaces the invalid bytes on the way to the frontend.

## Serialising Writes

A worktree never runs two git writes that touch the same thing. The nine writes take one or both of that worktree's **two** locks (`server/git/lock.go`) — one for the index and working tree, one for refs — and every read (`Status`, `Log`, `Diff`, `DiffWithContent`, `Show`, `ShowFileDiff`, `ShowFile`, `Branches`, `Head`) takes neither.

| Write | index | refs | What it touches |
|-------|:-----:|:----:|-----------------|
| stage, unstage, discard | ● | | the index and the working tree; none of them names a ref |
| commit | ● | | reads the index, and moves the current branch — see below |
| checkout, branch-create | ● | ● | rewrite the working tree *and* move HEAD |
| fetch, push | | ● | remote-tracking refs and `FETCH_HEAD`; a push may write an upstream into config |
| pull | ● | ● | the only network operation that fast-forwards the working tree |

Without any of this, two writes that overlap race for the lock file they have in common and whichever loses fails. Nothing about that is silent, so the project's rule on errors was already satisfied — but the failure is arbitrary in a way a user cannot reason about: which of two taps survives depends on timing, and what comes back names a lock file rather than the operation that was holding it.

**Two locks rather than one, because the panel is expected to stay usable while a sync runs.** Neither fetch nor push goes anywhere near the index, and git itself lets a file be staged throughout either of them — so a single per-worktree lock would take away, for the minutes a fetch of a large repository lasts, something the panel could do before and git never objected to. The split is by what git commands actually contend for, not by how the panel groups them into buttons.

Fetch and push do still exclude each other, and the operations that move the same refs: two clients fetching at once collide on `FETCH_HEAD.lock`, and a guard in one client cannot see the other client at all.

**Commit takes the index lock only** — the one row of that table worth arguing, since a commit plainly moves a ref. It moves the *current branch*, though, and never changes which branch that is, so the reason `Push` needs the refs lock does not reach it: what push reads before it pushes is the branch's name and where it goes, and a commit changes neither. Nor does one weaken `--force-with-lease`, which is a claim about the remote-tracking ref rather than about the local tip. The other choice would cost something real — a commit runs arbitrary hooks, so a slow hook would hold up a fetch, which is the thing the split exists to prevent. The exclusion that matters is not lost: a checkout takes the index lock too, so it and a commit still cannot overlap.

**The lock order is index before refs, and it is the only order there is.** Two locks taken in two orders is a deadlock; here it would surface as both callers refusing each other rather than as a hang, since every wait has a deadline — quieter than a hang and harder to recognise. No operation takes the index after the refs, so the cycle cannot form.

One deadline covers both acquisitions, so needing two locks cannot cost twice the wait: a refused caller waited at most the two seconds below, whatever it asked for. An operation that needs both does hold the index while it waits for the refs — the price of a fixed order — but it cannot push anyone past their own deadline, because a caller arriving during that wait started its own wait later. And a caller refused half-way gives back what it already took: a pull that never ran must not go on refusing every stage for as long as it sat waiting.

**The locks live in this package, not in the RPC handlers.** A handler does not see every caller: two connections reach the same worktree, and worktree setup and the watchers run git without passing through the handlers at all. Every git command the server runs is built here, so this is the narrowest place the rule can sit — and sitting there makes bypassing it impossible by construction rather than by review. It is also what keeps the lock order a property of one file: the nine operations carry what they lock as part of what they are, so adding a write cannot mean adding a name and forgetting to say what it conflicts with.

**Reads are left out deliberately, and not by a read-write lock.** A read has no need to participate: none of them has to win one of git's lock files. The only one that would even want `index.lock` is a status writing back a refreshed stat cache, which git treats as optional and skips when it cannot have it — the same thing the pollers in `watch/git.go` ask for up front with `--no-optional-locks`. So the reads behind the panel are not what the split above is for: they keep refreshing throughout a five-minute fetch because they were never in any queue, not because a reader lock was generous enough to let them in. A read racing a write sees one state or the other, and the watcher that notices the write corrects what was shown.

**A conflicting write waits two seconds, then is refused.** Both halves of that are load-bearing:

- *Not zero.* The server cannot assume its callers queue — staging two files is two independent requests, and a second tab or a second device has nothing in common with the first except these locks — so two fast local writes overlapping is ordinary use, not a conflict anybody needs to hear about. A local git command is tens of milliseconds; the slowest write here — a discard that reads submodule status, a checkout of a large tree — is on the order of a second. Refusing immediately would answer a double tap with an error the user did nothing to earn, trading git's `index.lock` message for one that is no more use to them.
- *Not unbounded.* Three of the nine wait on another machine and commit runs arbitrary hooks. A queue with no ceiling makes "my tap did nothing for five minutes" the normal case, with nothing on screen to explain it and no way to take it back. Anything still holding a lock after two seconds is waiting on a network or on a hook, which is precisely the case a refusal exists for — and the wait a user can be made to sit through is capped at two seconds whatever the operation ahead of them is doing.

The refusal names what is running at the moment it gives up rather than what was running when the wait began: the worktree may have changed hands during those two seconds, and what the user can act on is what to wait for *now*.

**A refusal is its own wire error, because nothing failed.** `rpc.CodeGitBusy` (`-32001`) carries `data.operation`, naming the holder by the same nine names. The request was never started, and repeating it once that operation ends will work — so it is not the `-32603` a git command that ran and failed comes back as, and the client can tell the two apart without matching English prose. Why that is a code rather than a recognisable sentence, and where the number comes from, is in [code/websocket-rpc.md](code/websocket-rpc.md#error-replies); what the user ends up reading is in [git-ui.md](git-ui.md#feedback-and-errors).

**A lock spans a whole operation, not a single command.** `Pull` (rev-parse, pull, rev-list), `Push` (read HEAD and upstream, then push) and `Discard` (read status, then delete or restore per path) are each several commands whose middle must not be interleaved — `Discard` most of all, since a path staged between its status read and its `clean` would send it down the deletion branch. This is also why `execGitNetworkTimeout` rooting its own context is not a problem: the lock is released by the closure around it, which cannot return before the command has.

It is also why `Add` and `Reset` take a whole request's paths in one call rather than one per path: staging a selection as several locked operations lets a commit take the index lock between two of them and commit half of what the user picked.

**The frontend serialises its fast writes too**, rather than leaving the two-second wait to absorb every double tap ([git-ui.md](git-ui.md#feedback-and-errors)). Both sides are needed: a client can only order the requests it sends itself, and two tabs or two devices have nothing in common except this server.

**Some git this server runs takes no lock, on purpose.** `git.Init` runs before any client can connect and returns immediately once `.git` exists. The `git worktree add` / `remove` / `list` in `worktree/registry.go` run in the *main* checkout, which is a key of its own and not among the locks any worktree's writes take; removing a worktree while git runs in it is a lifecycle question rather than one about a lock file. The `watch/` pollers and `search`'s `git ls-files` only read.

**And these locks only serialise the git *this server* runs.** An AI CLI session in the same worktree runs `git commit` in its own shell, which never passes through this package; the server cannot stop it and does not pretend to. What the locks are for is the panel's own concurrency — one user, several taps, and a UI that offers no way to see that two of them collided.

## Merge Commits

`git.show` and `git.show.diff` present a merge as an ordinary diff against its **first parent** (`-m --first-parent`, a no-op on ordinary commits). The `old_content` returned with a diff comes from `hash^`, which is that same parent.

Both must agree on this. Plain `git show` on a merge produces a *combined* diff, which by definition only keeps hunks differing from **every** parent — so a file identical to one side of the merge, the common case, yields nothing. Using it for the file contents while listing files against the first parent is what makes the list offer files that open blank.

`git.log` is not first-parent filtered; history lists merge commits alongside the rest.

## Historical File Contents

`git.show.file` returns one path as it stood in one commit, in the shape `file.get` returns for a file (`contents.FileContent`): same `encoding`, same `omitted`/`limit` for a blob that is binary or over `contents.MaxFileSize`. One shape because the client renders a historical version with the viewer it already has.

`ShowFile` reads the blob through `<hash>:<path>` — a rev-spec resolved against the repository root, not a pathspec, so none of the `:(literal)` concerns above apply. Over-sized blobs are read only as far as `contents.SniffLen`, enough to name the MIME type; git is stopped there rather than buffered in full.

A path the commit does not contain is `contents.ErrNotFound`; a path that names a tree or a submodule there is `contents.ErrInvalidPath`, because this method has no listing to fall back on the way `file.get` has for a directory. Both are answered as invalid params, as `file.get`'s are. The not-found error carries git's own message, because a commit that does not exist and a path that does not exist in it arrive as the same non-zero exit and only git can say which happened.

The not-found case is ordinary rather than exceptional: a deleted file is listed by the commit that **deleted** it, so that hash no longer has its content — `hash^` does.

**A symlink is returned as a text file whose content is the path it points at.** git stores a mode-120000 entry as a blob holding the target path, and `cat-file -t` calls it `blob` like any other, so `git.show.file` hands back the link itself where `file.get` hands back what it points at — that side follows the link, for the reasons in [file.md](file.md#security). One path therefore reads as two unrelated files on the two screens, with nothing in either result marking one of them as a link. Accepted rather than fixed: `contents.FileContent` has no field that could say "symlink", recognising one costs a second command to read the mode, and what to show once it is recognised is a question of its own — the target path, or the target's own version in that commit, which the commit need not contain.

## Branches

`git.branches` returns HEAD (branch name, or the short hash it is detached at) together with the local branches and the branches that exist only on a remote. `git.checkout` switches; `git.branch.create` branches from the current HEAD and switches to it.

**Its own method, not a field of `git.status`.** The branch bar has to survive a failing `git.status` — a repository whose status cannot be read still has a branch worth showing — and `Status` recurses into submodules, which have their own HEAD the panel deliberately does not expose. The two are still refreshed together: `invalidateGitQueries` refetches status, log and branches on the same `git.changed` notification, so this is not a second poll.

**Local branches carry the worktree that occupies them.** Pockode runs in git worktrees and git refuses to check the same branch out twice, so `Branches` joins `git worktree list --porcelain` onto the branch list and the UI disables those rows. The mapping needs no path comparison to exclude the current worktree: a branch lives in at most one worktree, so any entry other than the current branch belongs to a different one.

Linked worktrees are named by their directory, which is the name the worktree switcher gives them. The main checkout is named `main worktree` instead: its directory carries the repository's name, which the switcher never shows — there the main checkout is labelled by its branch, and labelling a branch with the branch occupying it would say nothing. git lists the main worktree first from any worktree of the repository, which is how it is identified.

**Refusals are forwarded verbatim.** A switch is attempted as-is — nothing in the panel stashes implicitly, for the reason in [git-ui.md](git-ui.md#goals-and-constraints) — and when git refuses, `CommandError` carries its stderr up as the error message so the panel can name the files that got in the way. Every write added here follows the same rule.

**Branch names are parsed line by line, not with `-z`.** git rejects control characters in ref names, so no branch name can span two lines — the quoting problem that forces `-z` on path listings (see [Path Encoding](#path-encoding)) does not exist for refs.

## Remote Sync

`git.branches` carries a `sync` object alongside the branch list: the upstream ref, ahead/behind counts, whether HEAD is already contained in the upstream, and when this worktree last fetched. `git.fetch`, `git.pull` and `git.push` are the writes.

**Sync rides with the branch list rather than having a method of its own.** The chip and the branch name are one row of the panel; from two queries the chip could end up counting a branch the bar is no longer showing. Every read behind it is local and cheap (`for-each-ref`, `rev-list --count`, one `stat`), so it costs nothing to answer them together.

**Ahead/behind come from `rev-list --left-right --count`, and "HEAD is pushed" is just `ahead == 0`** — a commit of ours the upstream lacks is exactly what makes amending a rewrite of published history.

**A configured upstream whose ref is missing locally is its own state** (`upstream_gone`), not zero-and-zero: nothing has been compared, and the branch may well exist on the remote. It happens after a `--prune` that removed a deleted remote branch, or on a branch whose tracking config was set without ever fetching. Detecting it needs the *full* ref from `%(upstream)`, since a local branch could be named `origin/main` and shadow the short form as a revision.

**Last-fetch time is the mtime of `FETCH_HEAD`, located with `rev-parse --git-path`.** That file is per-worktree, so it answers "when did *this* workspace last fetch" — and `--git-path` is what finds a linked worktree's copy, which is not in the repository's main `.git` directory.

**The three network commands run through `execGitNetwork`**, which differs from `execGit` in three ways, each guarding against a way the request could otherwise never come back or leak:

- A `networkTimeout` deadline, enforced as gently as the platform allows. These three are the only operations that wait on a machine other than this one, which is the whole reason a deadline is theirs alone — not that they are the only unbounded ones, since a `pre-commit` hook may take as long as it likes ([Commit](#commit)) but at least fails or finishes on this machine. Without a deadline a wedged connection spins forever: the panel offers no cancel, so closing the sync sheet only leaves the spinner on the branch bar's chip instead ([git-ui.md](git-ui.md#remote-sync)), and this deadline is the only thing that ends the run; without the gentler stop, the timeout would leave `index.lock` or `FETCH_HEAD.lock` behind and break every later git command in the worktree — worse than the hang it was meant to prevent. On unix that stop is SIGTERM, which git answers by removing its lock files, with `WaitDelay` as the backstop for a git that ignores it. Windows has no such request to make: `Process.Signal` fails for anything but `Kill`, and `GenerateConsoleCtrlEvent` reaches only processes sharing the caller's console — which a service, a scheduled task or a detached cluster node does not have — carrying an event git installs no lock-file cleanup for. So there the whole process tree is killed instead: promptly, because git's helpers (`git-remote-https`, `ssh`, a credential helper) hold the stderr pipe and killing git alone would stall until `WaitDelay` anyway, but without cleanup, so a lock file can survive the timeout.
- Every prompt disabled (`GIT_TERMINAL_PROMPT=0`, empty askpass variables, `ssh -o BatchMode=yes` unless the operator set their own `GIT_SSH_COMMAND`). A server process has nobody to answer "Username:", and git will open `/dev/tty` to ask unless told not to. With prompts off, a bad credential fails at once instead of consuming the timeout.
- stderr passes through `redactCredentials`, which strips the userinfo from any URL git echoes back. Pockode keeps its token in a credential helper rather than in the remote URL, so this normally matches nothing; it is the guard for a repository configured elsewhere with the token inline.

**Fetch is `--all --prune`.** Every remote, because the panel has one fetch button and no remote picker — remote management is out of scope — so a fetch that covered only the current branch's remote would leave the rest of the branch sheet stale with nothing saying so. Pruned, because a remote-tracking ref that outlives its deleted remote branch stays in that sheet forever, offering a checkout that cannot work.

**Pull reports how many commits it brought in, counted by the server.** `git pull` fetches before it fast-forwards, so it can bring in more than the panel's behind count promised — a number taken from the chip would be a figure the panel never measured. Counting fails softly: a pull that succeeded must not be reported as a failure because the count afterwards could not be read.

**Pull is `--ff-only` and push is at most `--force-with-lease`.** The reasoning is in [git-ui.md](git-ui.md#remote-sync): a merge conflict is unescapable from a phone, and a bare `--force` has no safe single-tap form. `Push` reads the upstream itself rather than trusting the client, and adds `--set-upstream` when there is none — the client's copy can be seconds old, and pushing to the wrong place is not a mistake to make on stale data.

## Commit

`git.commit` takes a message and an `amend` flag; what goes into the commit is already settled by the index.

**The root repository only.** `git.add` stages a submodule's file in that submodule's index, which a root `git commit` never reaches, so those entries are still staged when the commit returns. The panel names them rather than letting them sit there unexplained; why committing each submodule as well was rejected is in [git-ui.md](git-ui.md#submodules).

**Failures are read off stdout as well as stderr.** git announces "nothing to commit" and "no changes added to commit" on *stdout*, exiting non-zero with an empty stderr; an error built from stderr alone would reach the user as `exit status 1`. `execGitVerbose` keeps both streams, which also covers hook output — it lands on either one, and a `commit-msg` hook's verdict is the entire explanation of why nothing was committed.

**Hooks and signing are left in force.** No `--no-verify` and no `--no-gpg-sign`: a hook the repository installs is part of what committing means there, and its rejection is for the user to see rather than for the server to route around.

**HEAD's message rides along with `git.branches`** as `head.message` (`git log -1 --no-show-signature --format=%B`), which is what amend prefills the sheet with. It is read from git rather than rebuilt out of the parsed commits `git.log` already returns: rebuilding guesses at the blank line between subject and body, and an amend would then silently rewrite the message it was asked to preserve.

`--no-show-signature` is load-bearing. With `log.showSignature=true` git prints its verification of a signed commit (`gpg: Good signature…`, or an error when the allowed-signers file is missing) *ahead of* the format output, and that text would become part of the prefilled message and get committed. `Log` and `Show` do not need the flag — their format is delimited, and `parseLogOutput` drops anything before the first `---COMMIT_START---` — but a bare `%B` has no delimiter to hide behind.

## Discard

`git.discard` takes paths and throws away their unstaged state. A tracked path is restored, an untracked one is deleted — and **which of the two a path gets is decided on the server from a fresh `git status`, never taken from the request**. The panel's file list is only as new as its last refresh, and the branches are not interchangeable: deleting a path that has since been added to the index would destroy work nobody asked to lose, and discarded worktree changes are not in the reflog.

**Restore comes from the index, not from HEAD.** `git restore --worktree` leaves the index alone, so a file that was staged and then edited again keeps what was staged. That matches where the button lives — discard appears on unstaged rows only.

**Untracked files go through `git clean -f`** rather than being removed directly, because clean refuses to touch anything git tracks: a path classified wrongly is a no-op instead of a deletion.

**Paths go to git as `:(literal)` pathspecs**, like every other path the panel sends back — see [Path Encoding](#path-encoding). Discard is where it matters most: a name carrying pathspec magic turns "delete this file" into "delete the whole untracked tree", exit 0.

**Both commands explain themselves on stderr** (`error: pathspec … did not match`, `warning: failed to remove x: Permission denied`), so `execGit` is enough here — unlike `git commit`, which needs `execGitVerbose`.

**A directory holding its own git repository survives `git clean`** — exit 0, no output — and `git status -uall` lists such a directory as a single untracked entry, so a deletion the user confirmed would appear to do nothing. `Discard` therefore checks that the paths it cleaned are gone and reports the ones that are not. Forcing them through would take `-ff`, which overrides that protection for a repository whose commits may exist nowhere else.

Paths are validated up front, before anything runs, so a rejected path stops the operation instead of being reached halfway through it. Submodule paths resolve into the submodule the way `Add` and `Reset` do, and paths are grouped into one git invocation per (repository, kind) — discarding every unstaged change is a single tap.

## Real-Time Updates

Two watchers deliver live updates via the subscription system. Both poll every 3 seconds and only while they have subscribers — see [watcher.md](watcher.md) for the watcher inventory and [code/subscription-system.md](code/subscription-system.md) for why git polls instead of using fsnotify.

- **GitWatcher** — Polls `git rev-parse HEAD` + `git status` and compares the result against the previous one. Subscribers receive `git.changed` notifications when it differs (e.g., after `git add`).
- **GitDiffWatcher** — Recomputes the diff behind each `git.diff.subscribe` subscription and sends `git.diff.changed` to that subscriber when the result changes. Each notification carries the full diff and file contents, not a delta.

## Configuration

Git is opt-in via `--git` flag. When enabled, the server initializes the repo with remote config from command line arguments (`--git-repo-url`, `--git-repo-token`, `--git-user-name`, `--git-user-email`). See `server/AGENTS.md` for the full argument list.
