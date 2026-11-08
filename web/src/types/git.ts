import type { OmitReason } from "./contents";
import type { AgentType } from "./settings";

export interface LineStat {
	additions: number;
	deletions: number;
}

/**
 * One side of a file's change: a staged entry compares HEAD with the index, an
 * unstaged one the index with the working tree. A file changed on both sides is
 * in both lists, so its whole change is the sum of the two `lines`.
 *
 * `lines` is absent when the side has nothing to count: `binary` says git
 * treats the file as binary; without it the count is unknown (a conflicted
 * file, or an untracked one too large or unreadable to count — see docs/git.md).
 */
export interface FileStatus {
	path: string;
	/**
	 * git's porcelain letter for the side, as the server passes it on. A path in
	 * `GitStatus.conflicted` carries `U` (or `A`/`D` on both sides). `T` (a file
	 * that turned into a symlink or back) is rarer and reads as a modification
	 * wherever the workspace names the change.
	 */
	status: "M" | "A" | "D" | "R" | "?" | "U" | "T";
	lines?: LineStat;
	binary?: true;
	/**
	 * The path a renamed file had in HEAD. Staged renames only: git reports an
	 * unstaged move as a deletion plus an untracked file.
	 */
	orig_path?: string;
}

export interface GitStatus {
	staged: FileStatus[];
	unstaged: FileStatus[];
	submodules?: Record<string, GitStatus>;
	/**
	 * Paths with unresolved conflicts, in status order. Each is also in
	 * `staged` and `unstaged`, under the letters git gave it.
	 */
	conflicted?: string[];
	/** Root repository only; absent when nothing is in progress. */
	operation?: GitOperation;
}

export type GitOperationKind = "merge" | "rebase" | "cherry-pick" | "revert";

/** A commit an in-progress operation involves. `hash` is the full hash. */
export interface GitOperationCommit {
	hash: string;
	subject: string;
	/** A local or remote-tracking branch pointing exactly at it, if any. */
	ref?: string;
}

/**
 * A merge, rebase, cherry-pick or revert the repository was left in the middle
 * of. Every field but `kind` is absent when git could not say it
 * (docs/git.md, Operations in Progress).
 */
export interface GitOperation {
	kind: GitOperationKind;
	/**
	 * Merge: what is merged in. Rebase: the commit being replayed. Cherry-pick,
	 * revert: the commit picked or reverted — absent between two commits of a
	 * sequence.
	 */
	commit?: GitOperationCommit;
	/** Rebase only: the branch being rewritten; absent for a detached HEAD. */
	branch?: string;
	/** Rebase only. */
	onto?: GitOperationCommit;
	/** Rebase only: the todo list's step, counted from 1. */
	step?: { current: number; total: number };
}

/**
 * A file's diff, or — when either version of the file is over the server's
 * inline limit — a statement that it was withheld. The withheld form keeps the
 * three strings, empty, and describes the larger version in `FileContent`'s
 * words for the same refusal.
 */
export type GitDiffData =
	| {
			diff: string;
			old_content: string;
			new_content: string;
			omitted?: undefined;
			/**
			 * One ID per `@@` hunk of `diff`, in order, for `stageHunk` /
			 * `unstageHunk`. Absent where a hunk cannot be applied as shown:
			 * whitespace hidden, a binary or conflicted file, a commit's diff.
			 */
			hunk_ids?: string[];
	  }
	| {
			diff: "";
			old_content: "";
			new_content: "";
			omitted: Extract<OmitReason, "too_large">;
			size: number;
			mime: string;
			limit: number;
	  };

export type GitDiffChangedNotification = GitDiffData & { id: string };

/** A ref pointing at a commit, whatever range the commit was listed in. */
export interface GitRef {
	/** `HEAD`, `main`, `origin/main`, `v1.2`. */
	name: string;
	type: "head" | "branch" | "remote" | "tag";
	/** The branch HEAD is on; absent while detached. */
	current?: boolean;
}

export interface GitCommit {
	hash: string;
	/** Full hashes, the first parent first; empty for a root, or a shallow clone's edge. */
	parents: string[];
	subject: string;
	body?: string;
	author: string;
	date: string;
	/**
	 * In server order: `HEAD`, the current branch, other local branches, remote
	 * branches, tags.
	 */
	refs?: GitRef[];
	/**
	 * No remote-tracking ref reaches it; always false without a remote.
	 * `git.log` only.
	 */
	unpushed?: boolean;
}

/** Which commits the history lists (docs/git-history-ui.md#range). */
export type GitHistoryScope = "current" | "all" | "mainline";

/**
 * The commits one branch has that the default branch lacks
 * (`<default>..<branch>`): the ones behind the branch list's "ahead N".
 * `branch` is the name the branch list shows — `GitBranch.name` for a
 * local branch, `GitRemoteBranch.ref` for a remote-only one.
 */
export interface GitBranchRange {
	scope: "branch";
	branch: string;
}

/** What `git.log` walks: `branch` comes with the branch scope and only with it. */
export type GitLogRange =
	| { scope?: GitHistoryScope; branch?: never }
	| GitBranchRange;

/** Where a page of history ends, sent back as received for the next one. */
export interface GitHistoryCursor {
	tips: string[];
	skip: number;
	/**
	 * Branch scope: the default branch, pinned so that merging the branch
	 * between pages does not empty the pages still to come.
	 */
	exclude?: string[];
}

export type GitLogParams = GitLogRange & {
	/** Case-insensitive plain text in the commit message. */
	query?: string;
	/** A path relative to the repository root. */
	path?: string;
	limit?: number;
	cursor?: GitHistoryCursor;
};

export interface GitLogResult {
	commits: GitCommit[];
	/** Null on the last page. */
	next: GitHistoryCursor | null;
	/** First page only: the range's commits no remote-tracking ref reaches. */
	unpushed_count?: number;
	/** First page only: the oldest commits' parents are not in this clone. */
	shallow?: boolean;
	/**
	 * First page only, absent when the repository has none git can name. In
	 * the branch scope, the branch the range is taken against.
	 */
	default_branch?: string;
	/**
	 * First page only: the default branch's refs drawn as a line of their own
	 * (walked from, not in HEAD's history), which lane 1 is kept for. Always
	 * empty in the branch scope, which does not walk the default branch.
	 */
	default_line?: string[];
}

export interface FileChange {
	path: string;
	status: "M" | "A" | "D" | "R";
}

export type GitFileStatus = "M" | "A" | "D" | "R" | "?";

export const GIT_STATUS_INFO: Record<
	GitFileStatus,
	{ label: string; color: string }
> = {
	M: { label: "Modified", color: "text-th-warning" },
	A: { label: "Added", color: "text-th-success" },
	D: { label: "Deleted", color: "text-th-error" },
	R: { label: "Renamed", color: "text-th-accent" },
	"?": { label: "Untracked", color: "text-th-text-muted" },
};

export interface GitShowResult extends GitCommit {
	files: FileChange[];
}

export interface GitBranchCreateParams {
	name: string;
	/** The full hash to branch from; HEAD when absent. */
	start?: string;
}

/** What HEAD points at. `branch` is empty while detached. */
export interface GitHead {
	branch: string;
	hash: string;
	detached: boolean;
	/**
	 * The message of the commit HEAD points at, empty before the first commit.
	 * Amend prefills the sheet with it and quotes its first line.
	 */
	message: string;
}

/** How far a branch has moved apart from the default branch. */
export interface GitDivergence {
	/** Commits on the branch the default branch lacks. */
	ahead: number;
	/** Commits on the default branch the branch lacks. */
	behind: number;
}

export interface GitBranch {
	name: string;
	current: boolean;
	/**
	 * The other worktree holding this branch. git refuses to check the same
	 * branch out twice, so such a branch cannot be switched to from here.
	 */
	worktree?: string;
	/** ISO timestamp of the branch's last commit. */
	committed_at: string;
	/** Who committed that commit: the name `committed_at` is the date of. */
	committer: string;
	/** The configured upstream as displayed ("origin/topic"); absent when none is. */
	upstream?: string;
	/**
	 * `upstream` is configured but its remote-tracking ref is missing here — the
	 * per-branch form of `GitSync.upstream_gone`.
	 */
	upstream_gone?: boolean;
	/**
	 * Standing against `default_branch`. Absent on the default branch itself,
	 * when there is no default branch, and where git was too old to count it
	 * cheaply (remote branches on git before 2.41).
	 */
	vs_default?: GitDivergence;
}

export interface GitRemoteBranch {
	/** "origin/topic", what the UI displays. */
	ref: string;
	/** "topic", what checkout takes. */
	name: string;
	/** ISO timestamp of the branch's last commit. */
	committed_at: string;
	/** As on `GitBranch`. */
	committer: string;
	/** As on `GitBranch`. */
	vs_default?: GitDivergence;
}

/** The current branch's standing against its upstream. */
export interface GitSync {
	/** False in a repository with no remote, where the chip has nothing to show. */
	has_remote: boolean;
	/** The tracking branch as displayed ("origin/main"), empty when there is none. */
	upstream: string;
	/**
	 * The upstream is configured but its remote-tracking ref is missing locally —
	 * never fetched, or pruned after the remote branch was deleted. The counts
	 * below are then unknown rather than zero.
	 */
	upstream_gone: boolean;
	ahead: number;
	behind: number;
	/** HEAD is already contained in the upstream, so amending rewrites published history. */
	head_pushed: boolean;
	/** ISO timestamp of this worktree's last fetch, null before the first one. */
	last_fetch: string | null;
}

export interface GitBranches {
	head: GitHead;
	local: GitBranch[];
	remote_only: GitRemoteBranch[];
	sync: GitSync;
	/**
	 * What `vs_default` counts against, as displayed: "main", or "origin/main"
	 * when there is no local copy. Empty when the repository has none.
	 */
	default_branch: string;
	/**
	 * Local branches most recently checked out in this worktree, latest first;
	 * the current branch, when there is one, is always the first.
	 */
	recent: string[];
}

/** A `git.commit.draft` request: who writes the draft, and about what. */
export interface CommitDraftRequest {
	/** The client's name for the draft, which a cancel names it by. Never reused. */
	draftId: string;
	agentType: AgentType;
	/** Empty lets the CLI pick. */
	model: string;
	/** Empty lets the CLI keep its default. */
	effort: string;
	/** Drafts the message of the commit that would replace HEAD. */
	amend: boolean;
}

/** What a pull actually brought in, counted by the server. */
export interface GitPullResult {
	commits: number;
}

/** What deleting a local branch would cost: `git.branch.inspect`'s answer. */
export interface GitBranchInspection {
	/** Full hash; the delete sends it back so only this tip is deleted. */
	tip: string;
	subject: string;
	/**
	 * Commits on the branch no other local branch or remote-tracking ref
	 * reaches — what deleting it loses. Zero is "merged".
	 */
	unique: number;
	/** The remote-tracking upstream ("origin/x") when it exists. */
	upstream?: string;
}

export interface GitAbortResult {
	/**
	 * git ended the operation but left the branch where it was: commits were
	 * made on it during a sequence of picks or reverts.
	 */
	head_kept: boolean;
}

/** What the workspace can actually do with the current sync state. */
export interface GitSyncState {
	/**
	 * Nothing known to track: no upstream, or one whose ref we do not have. Push
	 * publishes and sets it in both cases.
	 */
	needsPublish: boolean;
	/** Both sides hold commits the other lacks, so a plain push is rejected. */
	diverged: boolean;
	canPull: boolean;
	canPush: boolean;
}

export function describeGitSync(sync: GitSync): GitSyncState {
	const needsPublish = !sync.upstream || sync.upstream_gone;

	return {
		needsPublish,
		diverged: !needsPublish && sync.ahead > 0 && sync.behind > 0,
		// Not gated on behind: that count is only as fresh as the last fetch, and
		// the server's pull fetches first anyway (server/git/remote.go), so a
		// worktree that has never fetched would have pulling disabled at exactly
		// the moment it is needed. behind only shapes the label.
		canPull: sync.has_remote && !needsPublish,
		// Without a remote there is nowhere to publish to, however unpublished
		// the branch looks.
		canPush: sync.has_remote && (needsPublish || sync.ahead > 0),
	};
}

/** What the workspace's commit bar offers. */
export interface GitCommitAction {
	label: string;
	enabled: boolean;
	hint: GitCommitHint | null;
}

/** Why the commit button is disabled. */
export interface GitCommitHint {
	text: string;
	/**
	 * Whether the workspace already shows the reason — with nothing staged,
	 * every row in view carries a stage button, wherever the list is scrolled.
	 * The bar keeps such a hint for a screen reader and spends no pixels
	 * repeating on screen what the screen already says; a reason nothing else
	 * accounts for has to be visible.
	 */
	alreadyOnScreen: boolean;
}

/**
 * What the commit bar offers, or null where the bar does not render at all.
 *
 * A clean tree has nothing to commit and nothing on its way to being committed,
 * so a permanently dead primary button would be the loudest thing on a panel
 * that has nothing to say. An unreadable status is not an empty one either —
 * undefined covers both, and the workspace is already showing why.
 *
 * The disabled button, where there are changes but nothing this commit can
 * record, is deliberate: the user is on their way to committing, and a target
 * that appears as they stage the first file is worse than one that is visibly
 * not ready yet.
 */
export function describeCommitAction(
	status: GitStatus | undefined,
): GitCommitAction | null {
	if (!status) return null;

	const staged = stagedCount(status);
	const paused = commitPausedReason(status);
	if (staged > 0 && !paused) {
		// The count is in the label: no `STAGED n` header above says it any more.
		return {
			label: `Commit ${plural(staged, "file")}`,
			enabled: true,
			hint: null,
		};
	}

	// Whether the bar exists at all follows the flattened counts, which is what
	// the list above it shows: with a submodule's files listed as staged
	// and no bar under them, the workspace would offer no account of where the
	// commit button went.
	const flat = flattenGitStatus(status);
	if (flat.staged.length + flat.unstaged.length === 0) return null;

	// Visible: during an operation the banner that says so may be collapsed or
	// scrolled away, and a conflict left by a stash has no banner at all.
	if (paused) {
		return {
			label: "Commit",
			enabled: false,
			hint: { text: paused, alreadyOnScreen: false },
		};
	}

	// Staged, but somewhere this commit cannot reach. Nothing else in the workspace
	// says so — the rows read as staged like any other — so this is the one hint
	// the bar has to spend a line on.
	if (flat.staged.length > 0) {
		return {
			label: "Commit",
			enabled: false,
			hint: {
				text: "Only submodule files are staged; ask the agent in chat to commit them.",
				alreadyOnScreen: false,
			},
		};
	}

	return {
		label: "Commit",
		enabled: false,
		hint: { text: "Stage a file to commit", alreadyOnScreen: true },
	};
}

/**
 * The files a root-repository commit records. Root repository only: git.add
 * stages a submodule's file in that submodule's index, which a root commit
 * does not touch. A conflicted path is listed as staged too, under its
 * conflict letters, and is not something a commit records.
 */
export function stagedCount(status: GitStatus): number {
	return status.staged.length - (status.conflicted?.length ?? 0);
}

/**
 * Why nothing can be committed right now, null when something can. During an
 * operation committing would finish a merge, pick or revert — the continue
 * left to the agent — or insert a stray commit into a rebase
 * (docs/git-conflict-ui.md). Without one, git refuses to commit over
 * unresolved conflicts, such as a `git stash pop` leaves.
 */
export function commitPausedReason(status: GitStatus): string | null {
	if (status.operation)
		return `Can't commit during a ${status.operation.kind}.`;
	if (status.conflicted?.length) return "Resolve the conflicts to commit.";
	return null;
}

/** One submodule's staged files, which a root-repository commit leaves behind. */
export interface StagedSubmodule {
	path: string;
	count: number;
}

/**
 * Staged files inside submodules.
 *
 * `git.add` stages them in the submodule's own index, where a root commit does
 * not reach them, so the commit sheet names them instead of letting them sit
 * staged with no explanation.
 */
export function stagedSubmodules(
	status: GitStatus,
	prefix = "",
): StagedSubmodule[] {
	const result: StagedSubmodule[] = [];
	if (!status.submodules) return result;

	for (const [subPath, subStatus] of Object.entries(status.submodules)) {
		const path = prefix ? `${prefix}/${subPath}` : subPath;
		// A conflict is listed as staged too, and is not what a commit there
		// would record.
		const count = stagedCount(subStatus);
		if (count > 0) result.push({ path, count });
		result.push(...stagedSubmodules(subStatus, path));
	}
	return result;
}

/**
 * Every conflicted path, submodules' included and prefixed as the Changes list
 * shows them — what a handoff of the conflicts has to name. Only the root's
 * stop a root commit, which `commitPausedReason` reads on its own.
 */
export function allConflicted(status: GitStatus, prefix = ""): string[] {
	const prefixed = (p: string) => (prefix ? `${prefix}/${p}` : p);
	const result = (status.conflicted ?? []).map(prefixed);
	for (const [subPath, subStatus] of Object.entries(status.submodules ?? {})) {
		result.push(...allConflicted(subStatus, prefixed(subPath)));
	}
	return result;
}

/**
 * Flatten GitStatus into a list of files with full paths.
 * Submodule files are prefixed with their submodule path.
 */
export function flattenGitStatus(
	status: GitStatus,
	prefix = "",
): { staged: FileStatus[]; unstaged: FileStatus[] } {
	const staged: FileStatus[] = status.staged.map((f) => ({
		...f,
		path: prefix ? `${prefix}/${f.path}` : f.path,
	}));
	const unstaged: FileStatus[] = status.unstaged.map((f) => ({
		...f,
		path: prefix ? `${prefix}/${f.path}` : f.path,
	}));

	if (status.submodules) {
		for (const [subPath, subStatus] of Object.entries(status.submodules)) {
			const subPrefix = prefix ? `${prefix}/${subPath}` : subPath;
			const sub = flattenGitStatus(subStatus, subPrefix);
			staged.push(...sub.staged);
			unstaged.push(...sub.unstaged);
		}
	}

	return { staged, unstaged };
}

/**
 * What a discard confirmation says, and what a failed one reports.
 *
 * Discard is the workspace's one modal-confirmed file action because discarded
 * worktree changes are not in the reflog — "cannot be undone" is literal. The
 * two blast radii get their own wording: a tracked file loses edits, an
 * untracked file stops existing.
 */
export interface DiscardPrompt {
	title: string;
	message: string;
	confirmLabel: string;
	/** Summary line of the error banner when this discard fails. */
	failureSummary: string;
}

const CANNOT_BE_UNDONE = "This cannot be undone.";
const STAGED_ARE_KEPT = "Staged changes are kept.";

/**
 * Summary line when a stage or unstage fails, worded like DiscardPrompt's: the
 * paths are already on screen in the rows the failure came from, and git's own
 * message sits right below this line.
 */
export function stageFailureSummary(staged: boolean): string {
	return staged ? "Unstage failed." : "Stage failed.";
}

/** "1 file" / "3 files". Verb agreement is the caller's, since it varies. */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * `keepsStaged`: the one file in `files` also has a staged side. A discard
 * takes only the unstaged side, so the staged one survives, and "your edits"
 * would claim more than is lost. A batch of several ignores it: its wording
 * already says staged changes are kept.
 */
export function describeDiscard(
	files: FileStatus[],
	keepsStaged = false,
): DiscardPrompt {
	const untracked = files.filter((f) => f.status === "?");
	const tracked = files.filter((f) => f.status !== "?");

	// A batch of one is still one file, and naming it beats counting it — the
	// bottom bar hits this whenever a single file is left unstaged.
	if (files.length === 1) {
		const { path } = files[0];
		if (untracked.length === 1) {
			return {
				title: "Delete file?",
				message: `${path} is not tracked by git and will be permanently deleted. ${CANNOT_BE_UNDONE}`,
				confirmLabel: "Delete",
				failureSummary: "Delete failed.",
			};
		}
		if (keepsStaged) {
			return {
				title: "Discard unstaged changes?",
				message: `Your unstaged edits to ${path} will be lost. Its staged changes are kept. ${CANNOT_BE_UNDONE}`,
				confirmLabel: "Discard",
				failureSummary: "Discard failed.",
			};
		}
		return {
			title: "Discard changes?",
			message: `Your edits to ${path} will be lost. ${CANNOT_BE_UNDONE}`,
			confirmLabel: "Discard",
			failureSummary: "Discard failed.",
		};
	}

	// Several files only ever come from the bottom bar's Discard unstaged, which
	// takes each file's unstaged side: a partly staged file keeps what is
	// staged, so the words say "unstaged", never "all".
	if (tracked.length === 0) {
		return {
			title: "Delete untracked files?",
			message: `${plural(untracked.length, "untracked file")} will be permanently deleted. ${STAGED_ARE_KEPT} ${CANNOT_BE_UNDONE}`,
			confirmLabel: "Delete",
			failureSummary: "Delete failed.",
		};
	}

	const clauses = [
		`The unstaged edits in ${plural(tracked.length, "file")} will be lost`,
	];
	if (untracked.length > 0) {
		clauses.push(
			`${plural(untracked.length, "untracked file")} will be deleted`,
		);
	}

	return {
		title: "Discard unstaged changes?",
		message: `${clauses.join(" and ")}. ${STAGED_ARE_KEPT} ${CANNOT_BE_UNDONE}`,
		confirmLabel: "Discard",
		failureSummary: "Discard failed.",
	};
}
