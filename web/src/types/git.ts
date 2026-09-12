export interface FileStatus {
	path: string;
	status: "M" | "A" | "D" | "R" | "?";
}

export interface GitStatus {
	staged: FileStatus[];
	unstaged: FileStatus[];
	submodules?: Record<string, GitStatus>;
}

export interface GitDiffData {
	diff: string;
	old_content: string;
	new_content: string;
}

export interface GitDiffSubscribeResult extends GitDiffData {
	id: string;
}

export interface GitDiffChangedNotification extends GitDiffData {
	id: string;
}

export interface GitCommit {
	hash: string;
	subject: string;
	body?: string;
	author: string;
	date: string;
}

export interface GitLogResult {
	commits: GitCommit[];
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

export interface GitBranch {
	name: string;
	current: boolean;
	/**
	 * The other worktree holding this branch. git refuses to check the same
	 * branch out twice, so such a branch cannot be switched to from here.
	 */
	worktree?: string;
}

export interface GitRemoteBranch {
	/** "origin/topic", what the UI displays. */
	ref: string;
	/** "topic", what checkout takes. */
	name: string;
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
}

/** What a pull actually brought in, counted by the server. */
export interface GitPullResult {
	commits: number;
}

/** What the panel can actually do with the current sync state. */
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

/** What the panel's commit bar offers. */
export interface GitCommitAction {
	label: string;
	enabled: boolean;
	hint: GitCommitHint | null;
}

/** Why the commit button is disabled. */
export interface GitCommitHint {
	text: string;
	/**
	 * Whether the panel already shows the reason — the stage buttons the usual
	 * hint points at sit right above the bar. The bar keeps such a hint for a
	 * screen reader and spends no pixels repeating on screen what the screen
	 * already says; a reason nothing else accounts for has to be visible.
	 */
	alreadyOnScreen: boolean;
}

/**
 * What the commit bar offers, or null where the bar does not render at all.
 *
 * A clean tree has nothing to commit and nothing on its way to being committed,
 * so a permanently dead primary button would be the loudest thing on a panel
 * that has nothing to say. An unreadable status is not an empty one either —
 * undefined covers both, and the panel is already showing why.
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

	// Root repository only: git.add stages a submodule's file in that
	// submodule's index, which a root commit does not touch.
	const staged = status.staged.length;
	if (staged > 0) {
		return { label: `Commit (${staged})`, enabled: true, hint: null };
	}

	// Whether the bar exists at all follows the flattened counts, which is what
	// the file groups above it show: with a submodule's files listed as staged
	// and no bar under them, the panel would offer no account of where the
	// commit button went.
	const flat = flattenGitStatus(status);
	if (flat.staged.length + flat.unstaged.length === 0) return null;

	// Staged, but somewhere this commit cannot reach. Nothing else on the panel
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
		if (subStatus.staged.length > 0) {
			result.push({ path, count: subStatus.staged.length });
		}
		result.push(...stagedSubmodules(subStatus, path));
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
 * Discard is the panel's one modal-confirmed file action because discarded
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

/** "1 file" / "3 files". Verb agreement is the caller's, since it varies. */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function describeDiscard(files: FileStatus[]): DiscardPrompt {
	const untracked = files.filter((f) => f.status === "?");
	const tracked = files.filter((f) => f.status !== "?");

	// A batch of one is still one file, and naming it beats counting it — the
	// group header hits this whenever a single file is unstaged.
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
		return {
			title: "Discard changes?",
			message: `Your edits to ${path} will be lost. ${CANNOT_BE_UNDONE}`,
			confirmLabel: "Discard",
			failureSummary: "Discard failed.",
		};
	}

	if (tracked.length === 0) {
		return {
			title: "Delete all files?",
			message: `${plural(untracked.length, "untracked file")} will be permanently deleted. ${CANNOT_BE_UNDONE}`,
			confirmLabel: "Delete",
			failureSummary: "Delete failed.",
		};
	}

	const clauses = [
		`${plural(tracked.length, "file")} will lose ${tracked.length === 1 ? "its" : "their"} edits`,
	];
	if (untracked.length > 0) {
		clauses.push(
			`${plural(untracked.length, "untracked file")} will be deleted`,
		);
	}

	return {
		title: "Discard all changes?",
		message: `${clauses.join(" and ")}. ${CANNOT_BE_UNDONE}`,
		confirmLabel: "Discard",
		failureSummary: "Discard failed.",
	};
}
