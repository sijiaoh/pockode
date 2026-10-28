# Git

Users view status, diffs and commit history; stage, unstage and discard files; commit and amend; switch or create branches; and sync with the remote. All operations shell out to the `git` CLI. Real-time updates are delivered via the watch/subscription system.

The UI built on top of these operations — the Git workspace and the sidebar's Git tab that leads into it — is described in [git-ui.md](git-ui.md).

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──exec──▶ git CLI
                              │
                         watch system (3s polling)
```

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_git.go` | `git.status`, `git.add`, `git.reset`, `git.hunk.stage`, `git.hunk.unstage`, `git.discard`, `git.commit`, `git.log`, `git.show`, `git.show.diff`, `git.show.file`, `git.branches`, `git.checkout`, `git.branch.create`, `git.branch.inspect`, `git.branch.delete`, `git.fetch`, `git.pull`, `git.push`, `git.abort`, and the `git.subscribe` / `git.diff.subscribe` pairs with their unsubscribes; `server/ws/rpc_git_draft.go` has `git.commit.draft` and `git.commit.draft.cancel` |
| Git operations | `server/git/git.go` | Init, Status, Add, Reset, Diff, DiffWithContent, Log, Show, ShowFileDiff |
| Historical file contents | `server/git/showfile.go` | ShowFile |
| Branch operations | `server/git/branch.go`, `server/git/divergence.go`, `server/git/branchdelete.go` | Head, Branches (with each branch's standing against the default branch, counted in `divergence.go`), Checkout, CreateBranch; InspectBranch and DeleteBranch ([Deleting a branch](#deleting-a-branch)) |
| Remote operations | `server/git/remote.go` | sync state (upstream, ahead/behind, last fetch), Fetch, Pull, Push |
| Commit operations | `server/git/commit.go` | CreateCommit |
| Commit message drafts | `server/git/draft.go`, `server/commitdraft/` | StagedChange (what a commit would record, cut to size), and Draft (the prompt, the one-shot AI call, the answer) — [Drafting a Commit Message](#drafting-a-commit-message) |
| Hunk staging | `server/git/hunk.go` | StageHunk, UnstageHunk, and the hunk IDs a diff carries ([Staging Hunks](#staging-hunks)) |
| Discard operations | `server/git/discard.go` | Discard |
| Operations in progress | `server/git/operation.go` | The merge / rebase / cherry-pick / revert a repository is left in the middle of, and Abort ([Operations in Progress](#operations-in-progress)) |
| Write serialisation | `server/git/lock.go` | A worktree's two locks — index and refs — with what each write takes, `BusyError`, and the operation names that lock and wire share ([Serialising Writes](#serialising-writes)) |
| Command execution | `server/git/command.go` | `gitCommand` / `execGit` / `execGitLines` / `execGitVerbose` / `execGitNetwork` / `execGitInput` (stdin, for `git apply -` and `hash-object --stdin`), `CommandError`, and `literalPathspec` |
| Frontend components | `web/src/components/Git/` | `GitWorkspace` is the `/git` page: `BranchBar` (the top bar, with `SyncChip` and `SyncSheet`) over three segments — `ChangesSection` (`ChangesHeader`, `ChangedFileRow` and its `ChangedFileMenu`, `CommitBar` → `CommitSheet`), `HistorySection` (`LogList`, amend → `CommitSheet`) and `BranchesSection` (`BranchList`, `BranchMenu`, `NewBranchSheet`) — with `DiffView` and the chain from `CommitView` to `CommitDiffView` to `CommitFileView` as layers under the first two. `ErrorBanner` catches the failures with no sheet to land in. `OperationBanner` (under the top bar) and `ConflictView` (inside `DiffView`) are the in-progress operation's ([git-conflict-ui.md](git-conflict-ui.md#where-it-lives)). `GitTab` is the sidebar's read-only overview and its entries into the workspace |
| Frontend types | `web/src/types/git.ts` | Wire types, plus the pure `describeGitSync` / `describeCommitAction` / `describeDiscard` the workspace's labels and confirmation copy come from |
| Frontend hooks | `web/src/hooks/useGit*.ts` | The workspace's queries, mutations and watch subscriptions, and `useAutoFetch`, the fetch it runs on the way in. Note `useGitCommit` *reads* a commit (`git.show`) — `useGitCreateCommit` is the one that writes. `useCommitFile` (`git.show.file`) is outside the glob because it reads a file rather than the repository's state: it backs the commit-file layer ([git-ui.md](git-ui.md#viewing-a-file-from-a-commit)) |
| RPC actions | `web/src/lib/rpc/git.ts` | RPC action creators for all git methods |
| Query keys | `web/src/hooks/gitQueries.ts` | The workspace's three query keys plus `invalidateGitQueries` |

## Path Encoding

Paths the server reports are sent straight back by the frontend as arguments to follow-up commands — `git.status` output feeds `git.add` / `git.reset` / `git.discard` / `git.diff.subscribe` verbatim. A path that is merely *displayable* is therefore not enough; it has to match the file again as a pathspec. When it doesn't, `git diff` reports no changes and `git add` fails outright with `did not match any files`.

Three separate git behaviours get in the way, and each has its own countermeasure:

- **Machine-parsed path lists use `-z`.** In the whitespace-delimited list formats (`status --porcelain`, `--name-status`, `config --get-regexp`) a path containing non-ASCII bytes, spaces or control characters is quoted and C-escaped (`中文.md` → `"\344\270\255\346\226\207.md"`), and `status --porcelain=v1` renders a rename as `old -> new`, which is ambiguous for a file genuinely named `a -> b`. Turning `core.quotePath` off is not sufficient here: it only governs the non-ASCII case, while spaces and control characters keep the path quoted whatever it is set to, and the rename ambiguity is not a quoting problem at all. With `-z` each path is instead a verbatim NUL-terminated field and the rename source is a field of its own.
- **Human-readable output disables `core.quotePath`.** Diff bodies embed paths in their headers (`diff --git a/中文.md`) and have no `-z` form, so those commands run with `-c core.quotePath=false` to keep the header readable. Header quoting is looser than the list formats' — the `a/` `b/` prefixes disambiguate spaces, so only quotes, backslashes and control characters force quoting there. `gitCommand` applies the flag to every command it builds; it is simply redundant under `-z`.
- **Every path goes back to git as a `:(literal)` pathspec.** Everything after `--` is still a pathspec, and pathspec magic is spelled in the *leading characters of the name itself* — nothing to do with the shell, so `exec` without a shell does not help. A file actually named `:!important.txt` reads as `:!` (exclude) applied to `important.txt`, i.e. a pathspec matching every path **but** that one: `git clean -f -- ':!important.txt'` then deletes the whole untracked tree and `git add -- ':!important.txt'` stages every change, each exiting 0 and reported as the success the user asked for. `git status` hands out such a name the moment a file has one. `literalPathspec` in `command.go` turns the magic off for every path that goes back to git — one at a time for `Diff` and `ShowFileDiff`, a whole request's worth at once for `Add`, `Reset` and `Discard` — so each pathspec matches only itself.

  The prefix has a counterpart that has to be guarded, and it is the reason `literalPathspec` returns an error rather than a string: **`:(literal)` with nothing behind it matches everything**, where a bare empty pathspec would have been rejected outright by git. A path that is exactly a submodule's own directory resolves to an empty path inside that submodule, so such a path is refused rather than turned into a pathspec that would take the whole submodule with it.

None of this helps when a filename is not valid UTF-8 (e.g. latin-1 byte sequences), since `encoding/json` replaces the invalid bytes on the way to the frontend.

## Serialising Writes

A worktree never runs two git writes that touch the same thing. The eleven writes take one or both of that worktree's **two** locks (`server/git/lock.go`) — one for the index and working tree, one for refs — and every read (`Status`, `Log`, `Diff`, `DiffWithContent`, `Show`, `ShowFileDiff`, `ShowFile`, `Branches`, `Head`, `InspectBranch`) takes neither.

| Write | index | refs | What it touches |
|-------|:-----:|:----:|-----------------|
| stage, unstage, discard | ● | | the index and the working tree; none of them names a ref |
| commit | ● | | reads the index, and moves the current branch — see below |
| checkout, branch-create | ● | ● | rewrite the working tree *and* move HEAD |
| branch-delete | | ● | removes a ref, its reflog and its config section; never the current branch, so never what a commit moves |
| fetch, push | | ● | remote-tracking refs and `FETCH_HEAD`; a push may write an upstream into config |
| pull | ● | ● | the only network operation that fast-forwards the working tree |
| abort | ● | ● | resets the index and working tree and moves HEAD back — a rebase's onto another branch |

Without any of this, two writes that overlap race for the lock file they have in common and whichever loses fails. Nothing about that is silent, so the project's rule on errors was already satisfied — but the failure is arbitrary in a way a user cannot reason about: which of two taps survives depends on timing, and what comes back names a lock file rather than the operation that was holding it.

**Two locks rather than one, because the workspace is expected to stay usable while a sync runs.** Neither fetch nor push goes anywhere near the index, and git itself lets a file be staged throughout either of them — so a single per-worktree lock would take away, for the minutes a fetch of a large repository lasts, something the workspace could do before and git never objected to. The split is by what git commands actually contend for, not by how the workspace groups them into buttons.

Fetch and push do still exclude each other, and the operations that move the same refs: two clients fetching at once collide on `FETCH_HEAD.lock`, and a guard in one client cannot see the other client at all.

**Commit takes the index lock only** — the one row of that table worth arguing, since a commit plainly moves a ref. It moves the *current branch*, though, and never changes which branch that is, so the reason `Push` needs the refs lock does not reach it: what push reads before it pushes is the branch's name and where it goes, and a commit changes neither. Nor does one weaken `--force-with-lease`, which is a claim about the remote-tracking ref rather than about the local tip. The other choice would cost something real — a commit runs arbitrary hooks, so a slow hook would hold up a fetch, which is the thing the split exists to prevent. The exclusion that matters is not lost: a checkout takes the index lock too, so it and a commit still cannot overlap.

**The lock order is index before refs, and it is the only order there is.** Two locks taken in two orders is a deadlock; here it would surface as both callers refusing each other rather than as a hang, since every wait has a deadline — quieter than a hang and harder to recognise. No operation takes the index after the refs, so the cycle cannot form.

One deadline covers both acquisitions, so needing two locks cannot cost twice the wait: a refused caller waited at most the two seconds below, whatever it asked for. An operation that needs both does hold the index while it waits for the refs — the price of a fixed order — but it cannot push anyone past their own deadline, because a caller arriving during that wait started its own wait later. And a caller refused half-way gives back what it already took: a pull that never ran must not go on refusing every stage for as long as it sat waiting.

**The locks live in this package, not in the RPC handlers.** A handler does not see every caller: two connections reach the same worktree, and worktree setup and the watchers run git without passing through the handlers at all. Every git command the server runs is built here, so this is the narrowest place the rule can sit — and sitting there makes bypassing it impossible by construction rather than by review. It is also what keeps the lock order a property of one file: the eleven operations carry what they lock as part of what they are, so adding a write cannot mean adding a name and forgetting to say what it conflicts with.

**A worktree is identified by where it is, not by how the path was spelled.** The locks are keyed by the directory every git command here is already given, but that directory arrives by two routes: from the worktree registry, which resolves symlinks, and from callers that never went near it. Keying on the raw string would give one worktree two locks, which is not weaker exclusion but none — and it would only ever show up where two spellings of a path differ: `/var` against `/private/var` on macOS, a short `8.3` path or a differently-cased drive letter on Windows, a symlinked checkout anywhere. So the key is the path resolved the same way the registry resolves it, and a path that cannot be resolved at all (the worktree is gone) falls back to the cleaned string rather than failing the command.

**Reads are left out deliberately, and not by a read-write lock.** A read has no need to participate: none of them has to win one of git's lock files. The only one that would even want `index.lock` is a status writing back a refreshed stat cache, which git treats as optional and skips when it cannot have it — the same thing the pollers in `watch/git.go` ask for up front with `--no-optional-locks`. So the reads behind the workspace are not what the split above is for: they keep refreshing throughout a five-minute fetch because they were never in any queue, not because a reader lock was generous enough to let them in. A read racing a write sees one state or the other, and the watcher that notices the write corrects what was shown.

**A conflicting write waits two seconds, then is refused.** Both halves of that are load-bearing:

- *Not zero.* The server cannot assume its callers queue — staging two files is two independent requests, and a second tab or a second device has nothing in common with the first except these locks — so two fast local writes overlapping is ordinary use, not a conflict anybody needs to hear about. A local git command is tens of milliseconds; the slowest write here — a discard that reads submodule status, a checkout of a large tree — is on the order of a second. Refusing immediately would answer a double tap with an error the user did nothing to earn, trading git's `index.lock` message for one that is no more use to them.
- *Not unbounded.* Three of the eleven wait on another machine and commit runs arbitrary hooks. A queue with no ceiling makes "my tap did nothing for five minutes" the normal case, with nothing on screen to explain it and no way to take it back. Anything still holding a lock after two seconds is waiting on a network or on a hook, which is precisely the case a refusal exists for — and the wait a user can be made to sit through is capped at two seconds whatever the operation ahead of them is doing.

The refusal names what is running at the moment it gives up rather than what was running when the wait began: the worktree may have changed hands during those two seconds, and what the user can act on is what to wait for *now*.

**A refusal is its own wire error, because nothing failed.** `rpc.CodeGitBusy` (`-32001`) carries `data.operation`, naming the holder by the same eleven names. The request was never started, and repeating it once that operation ends will work — so it is not the `-32603` a git command that ran and failed comes back as, and the client can tell the two apart without matching English prose. Why that is a code rather than a recognisable sentence, and where the number comes from, is in [code/websocket-rpc.md](code/websocket-rpc.md#error-replies); what the user ends up reading is in [git-ui.md](git-ui.md#feedback-and-errors).

**A lock spans a whole operation, not a single command.** `Pull` (rev-parse, pull, rev-list), `Push` (read HEAD and upstream, then push) and `Discard` (read status, then delete or restore per path) are each several commands whose middle must not be interleaved — `Discard` most of all, since a path staged between its status read and its `clean` would send it down the deletion branch. This is also why `execGitNetworkTimeout` rooting its own context is not a problem: the lock is released by the closure around it, which cannot return before the command has.

It is also why `Add` and `Reset` take a whole request's paths in one call rather than one per path: staging a selection as several locked operations lets a commit take the index lock between two of them and commit half of what the user picked.

**The frontend serialises its fast writes too**, rather than leaving the two-second wait to absorb every double tap ([git-ui.md](git-ui.md#feedback-and-errors)). Both sides are needed: a client can only order the requests it sends itself, and two tabs or two devices have nothing in common except this server.

**Some git this server runs takes no lock, on purpose.** `git.Init` runs before any client can connect and returns immediately once `.git` exists. The `git worktree add` / `remove` / `list` in `worktree/registry.go` run in the *main* checkout, which is a key of its own and not among the locks any worktree's writes take; removing a worktree while git runs in it is a lifecycle question rather than one about a lock file. The `watch/` pollers and `search`'s `git ls-files` only read.

**And these locks only serialise the git *this server* runs.** An AI CLI session in the same worktree runs `git commit` in its own shell, which never passes through this package; the server cannot stop it and does not pretend to. What the locks are for is the workspace's own concurrency — one user, several taps, and a UI that offers no way to see that two of them collided.

## Status

`git.status` answers `git.GitStatus`: the `staged` and `unstaged` file lists, plus `submodules`, one nested `GitStatus` per submodule keyed by its path. A file changed on both sides is in both lists. While a repository is in the middle of a merge, rebase, cherry-pick or revert, or holds unresolved conflicts, the answer also carries `operation` and `conflicted` ([Operations in Progress](#operations-in-progress)).

**Each entry carries its own side's line counts.** `lines` is `{additions, deletions}` from `git diff --cached --numstat` for a staged entry and `git diff --numstat` for an unstaged one, so a file's whole change is the sum of its two entries — exactly the two diffs a reviewer opens for it. That sum is not `git diff HEAD`: a line staged and then removed again counts on both sides — on purpose, since the review reads those two diffs and not that third one ([git-changes-ui.md](git-changes-ui.md#what-the-list-reads-from-the-server)).

| Entry | `lines` | `binary` |
|-------|---------|----------|
| Text change, staged or unstaged | git's numstat | — |
| Binary file (git reports `-`) | absent | `true` |
| Staged rename | git's numstat for the pair, under the new path the status entry carries | — |
| Untracked text file | every line an addition, counted by the server as `untrackedDiff` renders it; a symlink is its target, one line | — |
| Untracked file with a NUL in its first 8000 bytes (git's own binary test) | absent | `true` |
| Untracked file over `contents.MaxFileSize`, unreadable, or a nested repository | absent (unknown) | — |
| Untracked file past the status's read budget (`untrackedBudget`, 8 × `contents.MaxFileSize` per repository) | absent (unknown) | — |
| Conflicted file (`U` on either side, `AA`, `DD`) — the index holds its stages, not a version | absent (unknown) | — |
| A rename the status and the numstat pair differently (`status.renameLimit` set apart from `diff.renameLimit`) | absent (unknown) | — |

**Renames are paired the same way by every read of them, whatever the user's git config says.** The status and the staged numstat pass `--find-renames`, and so does the review's staged diff, which names both paths (`git diff --cached --find-renames -- <new> <old>`) and reads the old side from `HEAD:<old>`; limited to the new path alone, git would show a renamed file as wholly added, and the row's count would not be the diff it opens. The working tree's numstat and diff pass `--no-renames`: its one rename — a move after `git add -N` — is counted and diffed as its new path alone.

**A staged rename carries its source.** `orig_path` is the path the file had in HEAD, read from the field `git status -z` emits after a rename's entry, for the Changes list's `Renamed from …`. Only staged entries have one: an unstaged move is a deletion plus an untracked file, or, after `git add -N`, an unstaged rename that is shown as its new path alone.

A submodule's own entry in the parent is left out of the lists, as it always was; its files are counted inside its nested `GitStatus`.

**Three processes per repository, not one per file.** The status and the two numstats run in parallel; untracked files are read in-process, since git has no way to count them in one invocation. That read is what can grow with the tree — GitWatcher repeats it every poll — so it stops at a budget, and only regular files and symlinks are opened (a fifo would block the status). Internal status reads (`DiffWithContent`, `Discard`) skip the counts — only the client displays them.

**GitWatcher fingerprints the whole `git.status` answer.** A file edited again stays ` M` in the porcelain while its counts move, so comparing porcelain alone would leave the client showing stale numbers until something else changed.

## Diffs

One file's diff reaches the client three ways — the `git.diff.subscribe` reply, each `git.diff.changed` notification after it, and `git.show.diff` for a file in a commit — and all three carry the same `git.DiffResult` (the notification adds the subscription `id`):

```
{ "diff": string, "old_content": string, "new_content": string,
  "omitted"?: "too_large", "size"?: int, "mime"?: string, "limit"?: int,
  "hunk_ids"?: string[] }
```

`hunk_ids` names the hunks for [Staging Hunks](#staging-hunks); a commit's diff never has it.

`old_content` and `new_content` are the two whole versions, sent beside the hunks so the client can highlight them.

**A version over `contents.MaxFileSize` sends none of the three.** They travel in one message, and each version in it is held to the ceiling a file in a `file.get` reply is held to, for the reasons in [file.md](file.md#operations). When either version is over it, `diff`, `old_content` and `new_content` are all empty and the result carries `omitted: "too_large"` with `size`, `mime` and `limit` — the fields and meanings of a `file.get` that refused a file, describing the larger of the two versions. It is not an error, and the client draws the same too-large card the file viewer does ([file.md](file.md#viewer-ui)). A version of exactly the limit is still sent.

- **Sizes are measured before anything is read or diffed.** A blob is sized with `git cat-file -s`, a working-tree file with `fstat`; an oversized version is read only as far as `contents.SniffLen` to name its type, and `git diff` is not run at all. An untracked file's diff is built from the bounded content already read, never from a second read of a file that may have grown since.
- **The limit is per version, not per message.** A full rewrite of a file just within it carries the file roughly four times over: twice as content, twice in the hunks.
- **The check comes before the diff, so it cannot know whether there is one.** A large file whose only changes `-w` hides, or that a commit lists without changing its content, reads as too large rather than as "no changes". Diffing it to find out is the cost the check exists to avoid.
- **`git.diff.changed` compares `omitted` and `size` too.** The three content fields are empty both for a file with no changes and for one over the limit, so without them a file growing past the limit would never be announced. A file over the limit whose size changes is announced as well, since the `size` the client shows has changed.

**A working-tree symlink is diffed as the link, not as what it points at.** Its content is the target path, which is what the index holds and what `git diff` compares — the same reading `git.show.file` gives a link ([Historical File Contents](#historical-file-contents)). Following it would size, or show, an unrelated file.

A version that does not exist — the old side of an added file, the new side of a deleted one — reads as empty. A working-tree file that exists but cannot be read is returned as an error; a git object that cannot be read reads as empty too, since git's exit status does not tell a missing path from any other failure; a repository that is really broken fails the diff itself.

## Merge Commits

`git.show` and `git.show.diff` present a merge as an ordinary diff against its **first parent** (`-m --first-parent`, a no-op on ordinary commits). The `old_content` returned with a diff comes from `hash^`, which is that same parent.

Both must agree on this. Plain `git show` on a merge produces a *combined* diff, which by definition only keeps hunks differing from **every** parent — so a file identical to one side of the merge, the common case, yields nothing. Using it for the file contents while listing files against the first parent is what makes the list offer files that open blank.

`git.log` is not first-parent filtered; history lists merge commits alongside the rest.

## Historical File Contents

`git.show.file` returns one path as it stood in one commit, in the shape `file.get` returns for a file (`contents.FileContent`): same `encoding`, same `omitted`/`limit` for a blob that is binary or over `contents.MaxFileSize`. One shape because the client renders a historical version with the viewer it already has. Media is `encoding: "http"` as on `file.get` — a raster image up to `contents.MaxImageSize` and `too_large` past it, audio and video at any size. A raster image's bytes come from `GET /api/git/show/file?hash=&path=` ([file.md](file.md#transfer)) — the same `<hash>:<path>` read, streamed (`git.OpenFile`). That endpoint also serves any file the user downloads from a commit, with no size ceiling. Audio and video stream through a raw capability instead, which answers the Range requests a player makes ([file.md](file.md#playing-audio-and-video)). An HTML page is ordinary text here, and renders through a raw capability on the commit, so the files it links to come from the same commit ([file.md](file.md#html-pages)).

`ShowFile` reads the blob through `<hash>:<path>` — a rev-spec resolved against the repository root, not a pathspec, so none of the `:(literal)` concerns above apply. Over-sized blobs and media are read only as far as `contents.SniffLen`, enough to name the MIME type; git is stopped there rather than buffered in full. A malformed hash or path is refused before git runs (`git.ErrInvalidArgument`) and answered as invalid params.

A path the commit does not contain is `contents.ErrNotFound`; a path that names a tree or a submodule there is `contents.ErrInvalidPath`, because this method has no listing to fall back on the way `file.get` has for a directory. Both are answered as invalid params, as `file.get`'s are. The not-found error carries git's own message, because a commit that does not exist and a path that does not exist in it arrive as the same non-zero exit and only git can say which happened.

The not-found case is ordinary rather than exceptional: a deleted file is listed by the commit that **deleted** it, so that hash no longer has its content — `hash^` does.

**A symlink is returned as a text file whose content is the path it points at.** git stores a mode-120000 entry as a blob holding the target path, and `cat-file -t` calls it `blob` like any other, so `git.show.file` hands back the link itself where `file.get` hands back what it points at — that side follows the link, for the reasons in [file.md](file.md#security). One path therefore reads as two unrelated files on the two screens, with nothing in either result marking one of them as a link. Accepted rather than fixed: `contents.FileContent` has no field that could say "symlink", recognising one costs a second command to read the mode, and what to show once it is recognised is a question of its own — the target path, or the target's own version in that commit, which the commit need not contain.

## Branches

`git.branches` returns HEAD (branch name, or the short hash it is detached at) together with the local branches and the branches that exist only on a remote. `git.checkout` switches; `git.branch.create` branches from the current HEAD and switches to it.

**Its own method, not a field of `git.status`.** The workspace's top bar has to survive a failing `git.status` — a repository whose status cannot be read still has a branch worth showing — and `Status` recurses into submodules, which have their own HEAD the workspace deliberately does not expose. The two are still refreshed together: `invalidateGitQueries` refetches status, log and branches on the same `git.changed` notification, so this is not a second poll.

**Local branches carry the worktree that occupies them.** Pockode runs in git worktrees and git refuses to check the same branch out twice, so `Branches` joins `git worktree list --porcelain` onto the branch list and the UI disables those rows. The mapping needs no path comparison to exclude the current worktree: a branch lives in at most one worktree, so any entry other than the current branch belongs to a different one.

Linked worktrees are named by their directory, which is the name the worktree switcher gives them. The main checkout is named `main worktree` instead: its directory carries the repository's name, which the switcher never shows — there the main checkout is labelled by its branch, and labelling a branch with the branch occupying it would say nothing. git lists the main worktree first from any worktree of the repository, which is how it is identified.

**Every branch carries its last commit time and its standing against the default branch** (`committed_at`, `vs_default: {ahead, behind}`), and the list names that branch as `default_branch`. The default is the name `origin/HEAD` records (origin, or the only remote there is), else `main`, else `master` — tried in that order, so an `origin/HEAD` naming a branch since pruned falls through to them; the *local* branch of that name is counted against when there is one, else its remote-tracking ref. Local, because it is what work in these worktrees is merged into, and because a count against `origin/main` would change on every fetch without anything here having moved. `vs_default` is absent on the default branch itself and when there is no default.

**The cost does not grow with the branch count.** Times, the list itself and the default all come from one `for-each-ref`; the counts from a second, using `%(ahead-behind:<ref>)`, which walks the history once for every ref together. That atom is git 2.41+, and Apple's git is 2.39, so an older git falls back to one `rev-list --left-right --count` per *local* branch, run side by side; remote branches go uncounted there, because a large repository has hundreds of them and a process each is what the method exists to avoid. The version is read once per process.

**`recent` is what HEAD's reflog says was checked out here** — the `checkout: moving from A to B` entries `git checkout` and `git switch` both write, latest first, kept only for branches that still exist. HEAD's reflog is per worktree, so this is the work done in *this* workspace, which a commit time cannot tell: a branch committed to elsewhere a minute ago is not one the user was just on. The current branch always comes first when there is one (not on a detached HEAD, and not on an unborn branch, where `recent` is empty), put there rather than found: a clone or a `git worktree add` — how Pockode makes its worktrees — starts the reflog without a checkout entry, so in a worktree nobody has switched in, the reflog alone would leave its own branch out. A ref under `refs/remotes` that is not a commit (a tag a refspec maps there) is left out of the whole list rather than failing it.

**Refusals are forwarded verbatim.** A switch is attempted as-is — nothing in the workspace stashes implicitly, for the reason in [git-ui.md](git-ui.md#goals-and-constraints) — and when git refuses, `CommandError` carries its stderr up as the error message so the workspace can name the files that got in the way. Every write added here follows the same rule.

### Deleting a branch

Two calls, because what the user is asked to agree to has to be counted first, and the count is too dear for the list ([git-branches-ui.md](git-branches-ui.md#what-the-list-reads-from-the-server)).

**`git.branch.inspect { name }` → `{ tip, subject, unique, upstream? }`** reads what deleting a local branch would lose. `tip` is the full hash, `subject` its commit's. `unique` counts the commits no other local branch and no remote-tracking ref reaches:

```
git rev-list --count <tip> --not --exclude=<name> --branches --remotes
```

That count is what "merged" means here — zero is merged — and deliberately not `git branch -d`'s merged-into-HEAD-or-upstream test, whose answer depends on which branch is checked out ([why](git-branches-ui.md#what-merged-means-here)). `--exclude` takes the name relative to `refs/heads/`; with the prefix it excludes nothing and every branch reaches itself. `upstream` (`origin/x`) is present only when the branch's configured upstream is a remote-tracking ref that exists: a configured but never-fetched or pruned one keeps nothing on the remote. A read, so it takes no lock.

**`git.branch.delete { name, tip }`** deletes the branch only while it still points at `tip` — `--force-with-lease`'s rule for a local ref: the count the user agreed to is a count of *those* commits. `tip` must be the full hash — it is compared as a string, so an abbreviation would read as a branch that moved — and anything else is `-32602`. Inside the refs lock (`branch-delete`), and in this order, it refuses:

- any operation in progress (`-32006`, [below](#writes-refused-during-an-operation)) — during a rebase HEAD is detached, so the branch being rebased is checked out nowhere by `worktree list`'s reckoning, yet git refuses to delete it;
- the current branch, and a branch another worktree has checked out: `-32010` (`rpc.CodeGitBranchCheckedOut`), with `data.worktree` naming the worktree as `Branches` does, empty for the current branch. git refuses both too; the check is here so the refusal names the worktree in the workspace's words rather than by path, and so the server, not only the UI, is the boundary;
- a branch that is gone, or that no longer points at `tip`: `-32009` (`rpc.CodeGitBranchChanged`), with `data.gone` telling the two apart. A moved branch is inspected again rather than retried; a gone one leaves nothing to inspect, and the client says so. An inspect of a branch that does not exist gets the same `gone` answer. A name starting with `-` is `-32602`, as for checkout and create.

Then it runs `git branch -D`, so the config section and reflog go as they would from the command line. The check and the delete are not atomic against a process outside the server. An agent's own `git commit` on the branch could only come from a worktree that has it checked out, which the refusal above covers; what is left — a `git update-ref` from elsewhere between the check and the delete — is accepted, not designed for. Remote branches are never deleted here.

**Branch names are parsed line by line, not with `-z`.** git rejects control characters in ref names, so no branch name can span two lines — the quoting problem that forces `-z` on path listings (see [Path Encoding](#path-encoding)) does not exist for refs.

## Remote Sync

`git.branches` carries a `sync` object alongside the branch list: the upstream ref, ahead/behind counts, whether HEAD is already contained in the upstream, and when this worktree last fetched. `git.fetch`, `git.pull` and `git.push` are the writes.

**Sync rides with the branch list rather than having a method of its own.** The chip and the branch name are one row of the workspace; from two queries the chip could end up counting a branch the bar is no longer showing. Every read behind it is local and cheap (`for-each-ref`, `rev-list --count`, one `stat`), so it costs nothing to answer them together.

**Ahead/behind come from `rev-list --left-right --count`, and "HEAD is pushed" is just `ahead == 0`** — a commit of ours the upstream lacks is exactly what makes amending a rewrite of published history.

**A configured upstream whose ref is missing locally is its own state** (`upstream_gone`), not zero-and-zero: nothing has been compared, and the branch may well exist on the remote. It happens after a `--prune` that removed a deleted remote branch, or on a branch whose tracking config was set without ever fetching. Detecting it needs the *full* ref from `%(upstream)`, since a local branch could be named `origin/main` and shadow the short form as a revision.

**Last-fetch time is the mtime of `FETCH_HEAD`, located with `rev-parse --git-path`.** That file is per-worktree, so it answers "when did *this* workspace last fetch" — and `--git-path` is what finds a linked worktree's copy, which is not in the repository's main `.git` directory.

**The three network commands run through `execGitNetwork`**, which differs from `execGit` in three ways, each guarding against a way the request could otherwise never come back or leak:

- A `networkTimeout` deadline, enforced as gently as the platform allows. These three are the only operations that wait on a machine other than this one, which is the whole reason a deadline is theirs alone — not that they are the only unbounded ones, since a `pre-commit` hook may take as long as it likes ([Commit](#commit)) but at least fails or finishes on this machine. Without a deadline a wedged connection spins forever: the workspace offers no cancel, so closing the sync sheet only leaves the spinner on the top bar's chip instead ([git-ui.md](git-ui.md#remote-sync)), and this deadline is the only thing that ends the run; without the gentler stop, the timeout would leave `index.lock` or `FETCH_HEAD.lock` behind and break every later git command in the worktree — worse than the hang it was meant to prevent. On unix that stop is SIGTERM, which git answers by removing its lock files, with `WaitDelay` as the backstop for a git that ignores it. Windows has no such request to make: `Process.Signal` fails for anything but `Kill`, and `GenerateConsoleCtrlEvent` reaches only processes sharing the caller's console — which a service, a scheduled task or a detached cluster node does not have — carrying an event git installs no lock-file cleanup for. So there the whole process tree is killed instead: promptly, because git's helpers (`git-remote-https`, `ssh`, a credential helper) hold the stderr pipe and killing git alone would stall until `WaitDelay` anyway, but without cleanup, so a lock file can survive the timeout.
- Every prompt disabled (`GIT_TERMINAL_PROMPT=0`, empty askpass variables, `ssh -o BatchMode=yes` unless the operator set their own `GIT_SSH_COMMAND`). A server process has nobody to answer "Username:", and git will open `/dev/tty` to ask unless told not to. With prompts off, a bad credential fails at once instead of consuming the timeout.
- stderr passes through `redactCredentials`, which strips the userinfo from any URL git echoes back. Pockode keeps its token in a credential helper rather than in the remote URL, so this normally matches nothing; it is the guard for a repository configured elsewhere with the token inline.

**Fetch is `--all --prune`.** Every remote, because the workspace has one fetch button and no remote picker — remote management is out of scope — so a fetch that covered only the current branch's remote would leave the rest of the branch list stale with nothing saying so. Pruned, because a remote-tracking ref that outlives its deleted remote branch stays in that list forever, offering a checkout that cannot work.

**Pull reports how many commits it brought in, counted by the server.** `git pull` fetches before it fast-forwards, so it can bring in more than the workspace's behind count promised — a number taken from the chip would be a figure the workspace never measured. Counting fails softly: a pull that succeeded must not be reported as a failure because the count afterwards could not be read.

**Pull is `--ff-only` and push is at most `--force-with-lease`.** The reasoning is in [git-ui.md](git-ui.md#remote-sync): a merge conflict cannot be resolved from a phone, only aborted or handed to the agent, and a bare `--force` has no safe single-tap form. `Push` reads the upstream itself rather than trusting the client, and adds `--set-upstream` when there is none — the client's copy can be seconds old, and pushing to the wrong place is not a mistake to make on stale data.

## Commit

`git.commit` takes a message and an `amend` flag; what goes into the commit is already settled by the index. It is refused while an operation is in progress ([Writes refused during an operation](#writes-refused-during-an-operation)), as are checkout, branch creation, branch deletion and pull.

**The root repository only.** `git.add` stages a submodule's file in that submodule's index, which a root `git commit` never reaches, so those entries are still staged when the commit returns. The workspace names them rather than letting them sit there unexplained; why committing each submodule as well was rejected is in [git-ui.md](git-ui.md#submodules).

**Failures are read off stdout as well as stderr.** git announces "nothing to commit" and "no changes added to commit" on *stdout*, exiting non-zero with an empty stderr; an error built from stderr alone would reach the user as `exit status 1`. `execGitVerbose` keeps both streams, which also covers hook output — it lands on either one, and a `commit-msg` hook's verdict is the entire explanation of why nothing was committed.

**Hooks and signing are left in force.** No `--no-verify` and no `--no-gpg-sign`: a hook the repository installs is part of what committing means there, and its rejection is for the user to see rather than for the server to route around.

**HEAD's message rides along with `git.branches`** as `head.message` (`git log -1 --no-show-signature --format=%B`), which is what amend prefills the sheet with. It is read from git rather than rebuilt out of the parsed commits `git.log` already returns: rebuilding guesses at the blank line between subject and body, and an amend would then silently rewrite the message it was asked to preserve.

`--no-show-signature` is load-bearing. With `log.showSignature=true` git prints its verification of a signed commit (`gpg: Good signature…`, or an error when the allowed-signers file is missing) *ahead of* the format output, and that text would become part of the prefilled message and get committed. `Log` and `Show` do not need the flag — their format is delimited, and `parseLogOutput` drops anything before the first `---COMMIT_START---` — but a bare `%B` has no delimiter to hide behind.

## Drafting a Commit Message

`git.commit.draft` asks an AI CLI once for a message describing what committing now would record. It is the first AI call Pockode makes outside a session — a one-shot request: no conversation, no history, nothing kept afterwards ([how that differs from a session](code/agent-integration.md#how-it-differs-from-a-session)). The answer only goes into the commit sheet's text box; nothing is committed until the user commits it.

```
git.commit.draft         { draft_id, agent_type, model?, effort?, amend }  ->  { message }
git.commit.draft.cancel  { draft_id }                                      ->  null
```

**The client names the engine.** `agent_type` is required, `model` and `effort` optional (empty lets the CLI decide); the server does not guess, because which engine the user is working with is something the client knows — how it resolves one is in [git-ui.md](git-ui.md). The trio is checked with `session.ValidateEngine`, the same lists a session is held to, and reaches the CLI the way a session's does (claude `--model` / `--effort`; codex `--model` / `-c model_reasoning_effort=`). A combination that fails the check, or an agent type that is not registered or cannot answer one-shot requests, is `InvalidParams`, and no CLI starts.

**What the CLI is shown.** `git.StagedChange` reads it, and `commitdraft.buildPrompt` lays it out:

- The diff is the root repository's index against HEAD (`git diff --cached --no-ext-diff -M`) — the same thing `git.commit` records, so a submodule's own staged files are not in it ([Commit](#commit)). Nothing staged and no amend is the `nothing_staged` failure, and the CLI is not started.
- With `amend` the diff is against HEAD's first parent (the empty tree for a root commit), so it is the whole commit that would replace HEAD: HEAD's own changes plus whatever is staged. That makes an amend with nothing staged — a reword — draftable. HEAD's current message is shown as the one being replaced.
- The full messages of the 10 latest non-merge commits before it (before HEAD's parent when amending), each cut at 2 KiB, for the repository's style. Read with `--no-show-signature` for the reason given under [Commit](#commit).
- `--stat` of every file in the change, so a file whose diff was cut or left out is still named. It is asked for at a width of 1000 columns: without a terminal git fits it to 80 and shortens long paths to `.../name`.
- The instructions: match the recent messages' style — language, prefixes, length, body or none — and only with no history to follow fall back to an imperative title of at most 72 characters; reply with the message alone. The repository's text sits inside tags, and the model is told that everything inside them is data, not instructions.

**Diff size.** A diff over 48 KiB (on the order of 12k tokens) is cut to that, fairly, so a regenerated lockfile staged beside a two-line fix does not push the fix out. Every file shown is first guaranteed its header (up to its first hunk), a few hundred bytes of its changes and room for its note; when the budget cannot give every file that much — thousands of files — those with the smallest such minimum are shown and the rest left out under one closing note. What is left over is split by water-filling: files needing less than an even share are shown whole, the larger ones get the same share each. A file that is cut keeps as many whole lines as fit, then a line saying how many were left out, and the prompt says the diff is incomplete. The notes are counted in the budget, so the diff never exceeds it. The `--stat` list is cut only past 16 KiB. Before any of that, at most 4 MiB of the diff is read at all — the fair split needs every file's size, but a staged database dump should not be held in memory whole — and past it git is stopped: the file it stopped in is marked as incomplete and the files after it are left out under the closing note.

**No tools.** The diff and the earlier messages are repository data, written by whoever wrote the branch; a line in a diff that reads like an instruction must not get to act on anything. The draft runs as a one-shot request, which has no tools — fully for claude, and for codex as far as its switches go ([agent-integration.md](code/agent-integration.md#no-tools) has how each CLI is run and what is left). A tool call either CLI reports kills the run and fails the draft with `tool_use`, discarding the answer. Codex's remaining gap is that its sandbox stops writes but not reads: a prompt injected through the diff could have the model quote a file the user can read into its answer. That answer reaches only the text box, where the user reads it before committing, and the model provider, which a codex session in the same project already sends as much to — but it is the gap between codex's guarantee and claude's.

**Where it runs.** In the worktree, so each CLI reads the project's own instructions (`CLAUDE.md`, `AGENTS.md`) — which is where a repository writes down its commit conventions.

**Ending it.** `draft_id` is the client's name for the draft, and is never reused on a connection (a second draft under a running id is `InvalidParams`; one under an id cancelled earlier is cancelled at once, for the reason below). `git.commit.draft.cancel` names it and is idempotent: an id that already ended, or never ran, succeeds and does nothing. Requests are handled concurrently, so a cancel sent right behind its draft may be handled first; the id is remembered and the draft, when it arrives, ends as `cancelled` before reading anything or starting a CLI; one that lands while git is reading the change still starts none. Cancel needs neither git nor a worktree — the drafts are the connection's — so it is answered in a project that is not a repository, and for a draft whose worktree was deleted or switched away from. The CLI's whole process tree is killed when the draft is cancelled, when the connection closes, or after 90 seconds (`commitdraft.Timeout`: a small change is answered in 3–4 seconds; codex signed out retries for 15–40 seconds before saying so). The draft request's own reply comes only then, so a client's request timeout for it has to be longer than that — and it must not retry: each draft is a paid call.

**Failures** are `CodeCommitDraftFailed` (-32004) with `data.reason` for the client to pick its copy by; the message is English and, for the CLI's failures, the CLI's own words:

| `reason` | Meaning |
|---|---|
| `nothing_staged` | The index matches HEAD and this is no amend |
| `cli_not_found` | The CLI is not installed where the server can see it |
| `auth_failed` | The CLI is not signed in, or its sign-in expired (claude's `authentication_failed` frame; codex's `401 Unauthorized`) |
| `timeout` | No answer within `commitdraft.Timeout` |
| `cancelled` | `git.commit.draft.cancel`, or the connection closed |
| `tool_use` | The model called a tool; the run was stopped and its answer discarded |
| `empty` | The CLI finished with an empty message |
| `failed` | The CLI ended without a message — an error result, a failed turn, an exit before answering, or output the tool check could not read |

`cli_not_found` and `auth_failed` are kept apart, though a sheet may show both as "unavailable": only the second is fixed by signing in. An amend on a branch with no commit yet is `InvalidParams` (the sheet does not offer one there). A git command that fails while reading the change is an internal error, as elsewhere. A model that wraps its answer in a code fence or in quotes despite being told not to has them removed — a quote counts as wrapping only if it occurs nowhere else in the message, so `Revert "Add div"` keeps its own.

## Staging Hunks

`git.hunk.stage` and `git.hunk.unstage` move one hunk of a file between the working tree and the index; the file's other hunks stay where they are.

```
git.hunk.stage    { path, hunk_id }  ->  null   // a hunk of the unstaged diff into the index
git.hunk.unstage  { path, hunk_id }  ->  null   // a hunk of the staged diff back out of it
```

**The client names a hunk by an ID that came with the diff.** Every `git.diff.subscribe` reply and `git.diff.changed` notification carries `hunk_ids`, one per `@@` hunk of `diff`, in order. An ID is a hash of the side, the path and the hunk's own lines — context included — and not of its position: staging one hunk moves the line numbers of every hunk below it, and a client that has not yet seen the refreshed diff must still be able to stage the next one. The context lines are what pin a hunk to its place. Identical hunks in one file are told apart by how many came before them and how many there are, so one more identical hunk appearing makes all of them stale rather than shifting which place an ID names. The price is that staging one of several identical hunks makes the others stale too, so the client rereads the diff before the next.

**What the server applies is the hunk it finds, never one the client sent.** Under the index lock it reads the file's diff again, looks for a hunk with that ID, and applies that hunk to the index with `git apply --cached` (`--reverse` to unstage). The working tree is never written. When no hunk matches — the file was edited since, by the user or an agent; the change was staged or reverted another way; the ID belongs to the other side — nothing is written and the answer is `-32005` (`rpc.CodeGitHunkStale`): the client rereads the diff and lets the user pick again. It does not retry, since what it would retry is no longer on screen. Applying the hunk the user looked at to a file that has moved on would stage something nobody reviewed.

**The diff has to be one `git apply` can take.** So the review's diff is read with its format pinned against the user's config: the file's own content rather than an external driver's or a `textconv`'s rendering of it (applied, a rendered hunk would write the rendering into the index), no colour, `a/` `b/` prefixes, three lines of context, and stdout alone, so a warning git prints cannot land in a hunk. Hunk staging needs it, and the review shows the hunks that are applied. A file with a `textconv` driver is therefore reviewed as its own text, or as binary.

Where a file's diff is not a list of hunks that can be applied as shown, `hunk_ids` is absent, and the file is staged whole with `git.add` as before:

| Case | Why |
|---|---|
| Whitespace hidden (`hide_whitespace`) | `-w` leaves changes out of the hunks it shows, so applying one would stage what is not on screen |
| Binary file, tracked or untracked | git has no hunks for it; an untracked one is drawn as text but staged as the file it is |
| Conflicted file | its diff is git's combined one; a hunk request is refused as staging the whole file is, `-32007` (`rpc.CodeGitConflicted`, [below](#writes-refused-during-an-operation)) |
| A file that became a symlink, or the reverse (status `T`) | git diffs it as a deletion and a creation of one path, neither of which applies without the other; a hunk request is `-32602` (`git.ErrHunkUnsupported`), since rereading would not help |
| A staged rename the diff does not pair as the status did | the diff is the new path added and the old one deleted, and a hunk of the second would write a path the request did not name; `-32602` as above |
| Too large to send, or a mode change alone | no hunks reach the client |
| A commit's diff (`git.show.diff`) | history, not something to stage |

The other edges each keep their meaning:

- **An untracked file** is one hunk, the whole file. It goes in through `git add` so that its mode, a symlink and the repository's clean filters come out as for any staged file, and the blob the add stored is then compared with the content the ID was checked against; a file rewritten in between is taken back out of the index and refused as stale.
- **A new or deleted file** is also one hunk, and its patch keeps the creation or deletion: staging it adds or removes the index entry, unstaging it does the reverse. An intent-to-add entry (`git add -N`) stages like a modification.
- **A mode change is not part of any hunk.** `old mode` / `new mode` describe the file, so they are dropped from the patch: staging a hunk does not stage the mode, unstaging one does not unstage it.
- **A staged rename keeps its rename.** Its hunks are applied to the new path alone, so unstaging part of a renamed file's edits leaves the move staged.
- **No newline at end of file**, and `diff.suppressBlankEmpty`'s empty context lines, are carried through as git wrote them; hunk bodies are read by their header's counts, never up to the next line that looks like a header.

**Partly staged needs no new field.** A file with some hunks staged and some not is in both of `git.status`'s lists, which is what the Changes list already reads as mixed ([git-changes-ui.md](git-changes-ui.md#the-changes-segment)).

Both methods take the index lock as `stage` and `unstage` — the names a `-32001` refusal carries — and announce nothing themselves: the watchers pick the change up like any other ([Real-Time Updates](#real-time-updates)).

## Discard

`git.discard` takes paths and throws away their unstaged state. A tracked path is restored, an untracked one is deleted — and **which of the two a path gets is decided on the server from a fresh `git status`, never taken from the request**. The workspace's file list is only as new as its last refresh, and the branches are not interchangeable: deleting a path that has since been added to the index would destroy work nobody asked to lose, and discarded worktree changes are not in the reflog.

**Restore comes from the index, not from HEAD.** `git restore --worktree` leaves the index alone, so a file that was staged and then edited again keeps what was staged. That matches where the button lives — discard is offered only for a file's unstaged side.

**Untracked files go through `git clean -f`** rather than being removed directly, because clean refuses to touch anything git tracks: a path classified wrongly is a no-op instead of a deletion.

**Paths go to git as `:(literal)` pathspecs**, like every other path the workspace sends back — see [Path Encoding](#path-encoding). Discard is where it matters most: a name carrying pathspec magic turns "delete this file" into "delete the whole untracked tree", exit 0.

**Both commands explain themselves on stderr** (`error: pathspec … did not match`, `warning: failed to remove x: Permission denied`), so `execGit` is enough here — unlike `git commit`, which needs `execGitVerbose`.

**A directory holding its own git repository survives `git clean`** — exit 0, no output — and `git status -uall` lists such a directory as a single untracked entry, so a deletion the user confirmed would appear to do nothing. `Discard` therefore checks that the paths it cleaned are gone and reports the ones that are not. Forcing them through would take `-ff`, which overrides that protection for a repository whose commits may exist nowhere else.

Paths are validated up front, before anything runs, so a rejected path stops the operation instead of being reached halfway through it. **A conflicted path is refused by name** the same way, under the same lock — a directory by the conflicted files in it: it has no version in the index to restore — git says `path is unmerged`, but only for the group it is running, after earlier groups have already been restored or deleted — and picking a side is not something discard offers. The answer is `-32007` (`rpc.CodeGitConflicted`) with `data.action` (`"discard"`) and `data.paths` naming them, and nothing in the batch has been touched — the same refusal staging and unstaging give ([below](#writes-refused-during-an-operation)). Submodule paths resolve into the submodule the way `Add` and `Reset` do, and paths are grouped into one git invocation per (repository, kind) — discarding every unstaged change is a single tap.

## Operations in Progress

The workspace starts no merge, rebase, cherry-pick or revert — those are the AI's to run — but a repository can be left in the middle of one, conflicts and all, by an AI session or by the user elsewhere. `git.status` says so, and `git.abort` is the way back out.

**`conflicted`** lists the paths the index holds unresolved conflicts for, in status order: `UU`, `AA`, `DD`, and a `U` on either side. Each is also in `staged` and `unstaged` under the letters git gave it; the list is there so a client does not have to know which pairs of letters mean a conflict. It is per repository, so a submodule's nested status carries its own. A conflict can exist without an operation — a `git stash pop` that did not apply cleanly leaves one — and is still listed.

**`operation`** is present while the root repository is in the middle of one, and absent otherwise:

```json
{
  "kind": "rebase",
  "commit": { "hash": "1a2b…", "subject": "Add login" },
  "branch": "feature",
  "onto": { "hash": "9f8e…", "subject": "Bump deps", "ref": "main" },
  "step": { "current": 3, "total": 7 }
}
```

| Field | Present for | Meaning |
|-------|-------------|---------|
| `kind` | all | `merge`, `rebase`, `cherry-pick` or `revert` |
| `commit` | all, when there is one | the commit being brought in: merged (`MERGE_HEAD`), replayed (`REBASE_HEAD`), picked or reverted. A sequence of picks or reverts that is between two of its commits has none |
| `branch` | rebase | the branch being rewritten; absent for a detached HEAD |
| `onto` | rebase | the commit being replayed onto |
| `step` | rebase | step `current` of `total` of the rebase's todo list, from 1 — one per commit replayed, unless the list runs commands too (`exec`, or `--rebase-merges`' label/reset/merge lines). A sequence of picks or reverts records what is left rather than what is done, so it has no step |

Each commit carries `ref`, a local or remote-tracking branch pointing exactly at it — local first, symbolic refs such as `origin/HEAD` skipped — absent when none does. git records the commit, not the name that was typed, so this is how "merging `feature`" is told from "merging `1a2b3c4`", and it names the branch that is there *now*.

**How the kind is decided follows `git status`** (`wt-status.c`), with one order: rebase, then merge, cherry-pick, revert. A rebase stopped on a merge it is recreating has `MERGE_HEAD` too, and aborting the merge alone would leave the rebase behind. Both rebase backends are recognised — `rebase-merge/` (the default, and every interactive rebase) counts in `msgnum`/`end`, `rebase-apply/` in `next`/`last` — and so is a sequence of picks or reverts with no `CHERRY_PICK_HEAD` left, from `sequencer/todo`. `git am`, which shares `rebase-apply/` with the apply backend, is not reported: nothing in the workspace leads to it.

**Where the state lives is asked of git, never assumed.** The state directories are located with `git rev-parse --git-path`, because in a linked worktree `.git` is a file and a rebase's state lives in that worktree's own git directory. The `*_HEAD` refs are resolved by name through one `git cat-file --batch-check` rather than read as files, because under the reftable backend only `MERGE_HEAD` still is one. A bare name is not exact, though: when no such ref exists git goes on to try `refs/tags/<name>`, `refs/heads/<name>` and the rest, so a branch called `MERGE_HEAD` would read as a merge in progress and lock commits out. The same batch therefore asks for those shadows too, and a head some shadow exists for is believed only if its file is there. Paths come back with forward slashes and are converted before use.

Only the root repository's operation is read: the abort below is offered for that one alone. The cost is two git processes per status while nothing is in progress, and two more while something is.

**Live updates come for free.** GitWatcher fingerprints the whole `git.status` answer ([Real-Time Updates](#real-time-updates)), so an operation starting, advancing a step or ending elsewhere is a `git.changed` within one poll.

### Writes refused during an operation

`git.commit` (amend included), `git.checkout`, `git.branch.create`, `git.branch.delete` and `git.pull` refuse to run while the root repository is in the middle of an operation, before git is started, with a message naming both — `can't commit during a rebase: finish or abort the rebase first`. Each would finish or derail the operation rather than do what it says: a commit concludes a merge, pick or revert (the `--continue` left to whoever started it) and inserts a stray commit into a rebase; a checkout or a new branch carries the operation's state onto another branch; a pull moves HEAD under it; a delete can take the branch a rebase is rewriting. git refuses some of these itself, in some states, in words that do not say what to do instead; others — a commit mid-rebase, a checkout during a rebase with no conflicts left — it lets through. The check runs inside the write's lock, which `Abort` shares, so the answer holds until the write has run. The workspace disables these controls too ([git-conflict-ui.md](git-conflict-ui.md#what-stops-while-an-operation-is-in-progress)); the server is the boundary for a client that has not yet seen the operation begin. Nothing ran, so the answer is a refusal of its own, not the `-32603` of a git command that failed: `-32006` (`rpc.CodeGitOperationInProgress`) with `data.kind` naming the operation in the way.

Staging and unstaging (whole files or hunks), discarding the files that are not conflicted, fetch and push stay available: none of them moves HEAD, and the operation's result is built from the index they edit.

**A conflicted path is refused by every one of those three**, hunk by hunk too (`git.hunk.stage` / `git.hunk.unstage`), in or out of an operation (a `git stash pop` leaves conflicts with none), because each would end the conflict without resolving it: `git add` records the markers as the resolution, `git restore --staged` drops the conflict stages and exits 0, and discard has nothing in the index to restore ([Discard](#discard)). The client offers none of them on a conflicted row, but it chose the paths from a status that may be older than the merge that conflicted them; the check runs under the write's index lock, one `git ls-files --unmerged` per repository the paths are in (a directory is refused by the conflicted files in it), and the whole batch is refused — `-32007` (`rpc.CodeGitConflicted`) with `data.action` (`"stage"`, `"unstage"`, `"discard"`) and `data.paths`. The one stage of a conflicted path that is meant is the user marking it resolved, so `git.add` takes `"resolve": true` for it (`git.Resolve`), and only then lets a conflicted path through.

### Aborting

`git.abort` takes `{"kind": "<kind>"}` and runs `git <kind> --abort`, which puts the branch, index and working tree back where they were before the operation started — whatever had been resolved is lost, so the client confirms first. It answers `{"head_kept": false}`. It is a write like any other: it takes both locks ([Serialising Writes](#serialising-writes)) and fails with git's own words when git does.

**`head_kept` is the one abort that does not put the branch back.** A sequence of picks or reverts rolls back only while HEAD is still the commit git recorded after its last pick (`sequencer/abort-safety`, checked by `rollback_is_safe` in git's `sequencer.c`). Once something else committed during the sequence — a conflict resolved with a plain `git commit` rather than `--continue`, the usual way to reach the between-commits state above — git ends the sequence, leaves the branch where it is, warns and exits 0. The server makes the same check before running the abort and answers `true`, because the user confirmed losing that work and it is still on the branch; the client has to say so rather than report a rollback that did not happen. A single pick or revert keeps no sequencer state, commits nothing, and is always rolled back.

**The kind is the one the user confirmed, and the server checks it under the lock.** If the operation in progress is no longer of that kind — it was finished or aborted elsewhere, or one of another kind started — nothing runs, and the answer is `-32008` (`rpc.CodeGitOperationChanged`) with `data.current` naming what is in progress now, empty when nothing is. Aborting whatever happens to be there would throw away work the user never agreed to lose. Only the kind is compared: a new operation of the same kind started in the moment between the press and the request is aborted in its place. The client narrows that moment to the request itself — its confirmation closes the instant the status shows a different operation ([git-conflict-ui.md](git-conflict-ui.md#abort)). A kind that is not one of the four is `-32602`.

## Real-Time Updates

Two watchers deliver live updates via the subscription system. Both poll every 3 seconds and only while they have subscribers — see [watcher.md](watcher.md) for the watcher inventory and [code/subscription-system.md](code/subscription-system.md) for why git polls instead of using fsnotify.

- **GitWatcher** — Polls `git rev-parse HEAD` + the `git.status` answer (counts included, see [Status](#status)) and compares the result against the previous one. Subscribers receive `git.changed` notifications when it differs (e.g., after `git add`).
- **GitDiffWatcher** — Recomputes the diff behind each `git.diff.subscribe` subscription and sends `git.diff.changed` to that subscriber when the result changes. Each notification carries the full result described in [Diffs](#diffs), not a delta.

## Projects Without a Repository

A project does not have to be a git repository, and can become one while Pockode is running (`git init`, a clone into the directory) or stop being one (`.git` deleted). What the client needs is one fact — is this project a git repository right now — and one moment — when that changes.

**The worktree registry is the single source.** `Registry` reads `git worktree list --porcelain` in the main checkout; if git answers, the project is a repository, and if it refuses for any reason — no repository, git missing, a directory git will not trust — it is not, since no git feature could work there either way. git's own account of why is logged, once per distinct reason rather than per poll, since the log is the one place a missing repository can be told apart from the rest. A read that was *killed* — a cancelled watcher, the 10-second timeout — has learned nothing and leaves the previous answer in place rather than reporting the repository gone. A timed-out read also keeps that answer for one more cache TTL, so a git stuck on a lock costs one timeout rather than one per request queued behind it.

**The client learns it from the worktree subscription.** `worktree.subscribe` replies `{is_git_repo}`, read fresh rather than from the last poll, because polling pauses while nobody is subscribed. `worktree.changed` carries `is_git_repo` too, and fires when the worktree list changes *or* the repository appears or disappears. `worktree.list` reports `is_git_repo` beside the worktrees it lists, from the same read — a list holding only main is otherwise ambiguous. The watcher polls through the registry (`Registry.Refresh`), so the registry's cache already holds the change by the time the notification goes out: a `worktree.list` sent in answer cannot be served the listing from before it.

**Requests that need git are refused with a code of their own.** In a project that is not a repository every `git.*` method that runs git, and `worktree.create` / `worktree.delete`, answer `-32002` (`rpc.CodeNotGitRepo`) instead of whatever git printed. `git.subscribe`, `git.unsubscribe` and `git.diff.unsubscribe` are exempt: they run no git themselves, so a client may stay subscribed across `git init`. It must not wait for `git.changed` to learn that the repository appeared — an empty directory looks the same to the git watcher before and after — `worktree.changed` is what says so.

**The server's own features ask the same registry.** `command.list` leaves out the Pockode commands that need git and `/pockode-lead` is refused as the user's to fix ([pockode-commands.md](pockode-commands.md#when-the-server-refuses)); both read the cached answer, since a palette a few seconds behind costs nothing. MCP `story_start` refuses a `worktree` argument before pinning it to the story, since a story pinned to a worktree that can never be created would ask for it again on every start. That one reads `Registry.IsGitRepoFresh`, past the cache: the agent asking is often the one that has just run `git init`, and being told there is no repository would send it down the wrong path.

What the client does with the answer — which git surfaces disappear, and what happens to one that is open when the repository goes away — is in [git-ui.md](git-ui.md#projects-without-a-repository).

### Before the first commit

`git init` leaves a repository whose branch has no commit yet, and the workspace has to work there, since that is exactly where a user who just asked for a repository lands. Two operations assume a HEAD and are given a fallback, each taken only after the ordinary command has failed and `rev-parse --verify --quiet HEAD` has exited 1 (resolves to nothing, as opposed to a broken repository, which is fatal):

- **`git.log` answers an empty list** rather than git's `does not have any commits yet`, so History reads as empty instead of failed.
- **`git.reset` falls back to `git rm --cached -f -r`.** `restore --staged` restores from HEAD, and there is none; before the first commit, unstaging *is* dropping the entry from the index. `-f` only lifts rm's refusal of an entry that differs from the file on disk (staged, then edited again) — with `--cached` the file itself is never touched — and an unmatched path still fails, as it does once there are commits.

The rest needs no special case: `worktree list --porcelain` still names the branch, so the switcher shows it, and the first commit goes through `git.commit` like any other. Amend is simply not offered, because there is no HEAD commit for it to sit on ([git-ui.md](git-ui.md#amend)).

## Configuration

Git is opt-in via `-git` flag. When enabled, the server initializes the repo with remote config from command line arguments (`-git-repo-url`, `-git-repo-token`, `-git-user-name`, `-git-user-email`). See `server/AGENTS.md` for the full argument list.
