import type {
	GitBranches,
	GitBranchInspection,
	GitDivergence,
	GitHead,
	GitOperationKind,
} from "../types/git";
import { shortHash } from "./gitOperation";

/** At most this many branches the list fits on screen: no filter, no Recent. */
export const FILTER_THRESHOLD = 8;

/** The current branch plus this many others (docs/git-branches-ui.md#groups). */
const RECENT_OTHERS = 4;

/** A local or remote-only branch, as one row of the list draws it. */
export interface BranchRow {
	key: string;
	/** What the row shows and the filter matches: `topic`, `origin/topic`. */
	label: string;
	/** What checkout takes. */
	name: string;
	current: boolean;
	/** A remote-only branch: it can be merged from, never deleted here. */
	remote: boolean;
	/** The other worktree holding it; only local branches can be held. */
	worktree?: string;
	isDefault: boolean;
	committed_at: string;
	committer: string;
	/** Local rows only, as on `GitBranch`. */
	upstream?: string;
	upstream_gone?: boolean;
	vs_default?: GitDivergence;
}

export interface BranchGroup {
	/** Null for the one headerless group of a list that fits on screen. */
	title: "Recent" | "Local" | "Remote" | null;
	rows: BranchRow[];
}

/**
 * The list's groups, filtered by name. Groups are formed before filtering, so
 * a branch never moves group as the filter is typed; a group the filter empties
 * is dropped. Within Local and Remote the server's order — current first, then
 * last commit, newest first — is kept as it comes.
 */
export function groupBranches(
	branches: GitBranches,
	filter: string,
): BranchGroup[] {
	const local: BranchRow[] = branches.local.map((b) => ({
		key: `local:${b.name}`,
		label: b.name,
		name: b.name,
		current: b.current,
		remote: false,
		worktree: b.worktree,
		isDefault: b.name === branches.default_branch,
		committed_at: b.committed_at,
		committer: b.committer,
		upstream: b.upstream,
		upstream_gone: b.upstream_gone,
		vs_default: b.vs_default,
	}));
	const remote: BranchRow[] = branches.remote_only.map((b) => ({
		key: `remote:${b.ref}`,
		label: b.ref,
		name: b.name,
		current: false,
		remote: true,
		isDefault: b.ref === branches.default_branch,
		committed_at: b.committed_at,
		committer: b.committer,
		vs_default: b.vs_default,
	}));

	const groups: BranchGroup[] = [];
	if (local.length + remote.length <= FILTER_THRESHOLD) {
		groups.push({ title: null, rows: local });
	} else {
		const byName = new Map(local.map((row) => [row.name, row]));
		const current = local.find((row) => row.current);
		const others = branches.recent
			.filter((name) => name !== current?.name)
			.flatMap((name) => byName.get(name) ?? [])
			.slice(0, RECENT_OTHERS);
		const recent = current ? [current, ...others] : others;
		const inRecent = new Set(recent);
		groups.push(
			{ title: "Recent", rows: recent },
			{ title: "Local", rows: local.filter((row) => !inRecent.has(row)) },
		);
	}
	groups.push({ title: "Remote", rows: remote });

	const needle = filter.trim().toLowerCase();
	return groups
		.map((group) => ({
			...group,
			rows: needle
				? group.rows.filter((row) => row.label.toLowerCase().includes(needle))
				: group.rows,
		}))
		.filter((group) => group.rows.length > 0);
}

/** The row `key` names, among every row the list could show; null when gone. */
export function findBranchRow(
	branches: GitBranches,
	key: string,
): BranchRow | null {
	return (
		groupBranches(branches, "")
			.flatMap((group) => group.rows)
			.find((row) => row.key === key) ?? null
	);
}

/**
 * Every state word that holds, most telling first: being where HEAD is, or
 * where another worktree's HEAD is, says more than being the default.
 */
export function branchStateWords(row: BranchRow): string[] {
	const words: string[] = [];
	if (row.current) words.push("current");
	if (row.worktree) words.push(`in ${row.worktree}`);
	if (row.isDefault) words.push("default");
	return words;
}

/**
 * The one state word a row has room for, the first that holds: `in <worktree>`
 * comes before `default` because it is why the branch cannot be switched to.
 */
export function branchStateWord(row: BranchRow): string | null {
	return branchStateWords(row)[0] ?? null;
}

/**
 * Where the branch lives, as the detail says it
 * (docs/git-branches-ui.md#the-branch). A remote-only branch is switched to
 * by creating a local one that tracks it, which is said here because the
 * label `Switch to this branch` does not.
 */
export function branchUpstreamLine(row: BranchRow): string {
	if (row.remote) {
		// The ref is `<remote>/<name>`; the remote's own name may have slashes.
		const remote = row.label.slice(0, -(row.name.length + 1));
		return `Only on ${remote}. Switching to it creates a local ${row.name} that tracks it.`;
	}
	if (!row.upstream) return "Local only — not published";
	if (row.upstream_gone) {
		return `Tracks ${row.upstream}, which is missing here — not fetched yet, or deleted on the remote`;
	}
	return `Tracks ${row.upstream}`;
}

/**
 * The row's counts in a sentence, the default named once since the detail
 * has no `Compared with` line; null where there is nothing to compare.
 */
export function branchVsDefaultLine(
	row: BranchRow,
	defaultBranch: string,
): string | null {
	if (row.isDefault) {
		return "The default branch — other branches are compared with it";
	}
	if (!row.vs_default) return null;
	const { ahead, behind } = row.vs_default;
	if (!ahead && !behind) return `Up to date with ${defaultBranch}`;
	if (!behind) return `${ahead} ahead of ${defaultBranch}`;
	if (!ahead) return `${behind} behind ${defaultBranch}`;
	return `${ahead} ahead of ${defaultBranch} · ${behind} behind`;
}

/** Line 2's words before the age: state word, then counts, none that are 0. */
export function branchDetails(row: BranchRow): string[] {
	const parts: string[] = [];
	const word = branchStateWord(row);
	if (word) parts.push(word);
	if (row.vs_default?.ahead) parts.push(`${row.vs_default.ahead} ahead`);
	if (row.vs_default?.behind) parts.push(`${row.vs_default.behind} behind`);
	return parts;
}

/**
 * The row's accessible name: line 2 with the default branch spelled in, since
 * the `Compared with…` line above the list is not something a screen reader
 * user can be relied on to have passed.
 */
export function branchRowLabel(
	row: BranchRow,
	defaultBranch: string,
	age: string,
): string {
	const parts = [row.label];
	const word = branchStateWord(row);
	if (word) parts.push(word);
	const ahead = row.vs_default?.ahead ?? 0;
	const behind = row.vs_default?.behind ?? 0;
	if (ahead) parts.push(`${ahead} ahead of ${defaultBranch}`);
	if (behind) {
		parts.push(
			ahead ? `${behind} behind` : `${behind} behind ${defaultBranch}`,
		);
	}
	parts.push(`last commit ${age}`);
	return parts.join(", ");
}

/**
 * Why `Switch to this branch` cannot run now, the first reason that holds, or
 * null when it can (docs/git-branches-ui.md#the-branchs-menu-). The operation's
 * reason is the pinned line's first sentence: the way out is on the banner.
 */
export function branchSwitchUnavailableReason(
	row: BranchRow,
	state: {
		operation: GitOperationKind | null;
		switching: boolean;
		/** This row's branch is the one being deleted. */
		deleting: boolean;
		handingOff: boolean;
	},
): string | null {
	if (state.operation) {
		return `Branch switching is paused during the ${state.operation}.`;
	}
	if (row.worktree) return `Checked out in ${row.worktree}.`;
	if (state.switching) return "Wait for the branch switch to finish.";
	if (state.deleting) return "Wait for the branch delete to finish.";
	if (state.handingOff) return "Wait for the new chat to open.";
	return null;
}

/**
 * Why `Delete branch` cannot run now, the first reason that holds, or null
 * when it can (docs/git-branches-ui.md#the-branchs-menu-). Any operation in
 * progress stops it, not only one on this branch: during a rebase the branch
 * being rebased is neither current nor occupied by the list's reckoning.
 */
export function branchDeleteUnavailableReason(
	row: BranchRow,
	state: {
		operation: GitOperationKind | null;
		switching: boolean;
		deleting: boolean;
	},
): string | null {
	if (state.operation) return `Finish or abort the ${state.operation} first.`;
	if (row.worktree) return `Checked out in ${row.worktree}.`;
	if (state.switching) return "Wait for the branch switch to finish.";
	if (state.deleting) return "Wait for the branch delete to finish.";
	return null;
}

/**
 * Why `Ask AI to merge into current branch` cannot be offered now, the first
 * reason that holds, or null when it can
 * (docs/git-branches-ui.md#the-branchs-menu-). An operation comes before a
 * detached HEAD: a rebase detaches HEAD, and "switch to a branch" is not the
 * way out of a rebase.
 */
export function branchMergeUnavailableReason(
	head: GitHead,
	state: {
		operation: GitOperationKind | null;
		switching: boolean;
		/** This row's branch is the one being deleted. */
		deleting: boolean;
		handingOff: boolean;
	},
): string | null {
	if (state.operation) return `Finish or abort the ${state.operation} first.`;
	if (head.detached) return "Switch to a branch to merge into.";
	if (state.switching) return "Wait for the branch switch to finish.";
	if (state.deleting) return "Wait for the branch delete to finish.";
	if (state.handingOff) return "Wait for the new chat to open.";
	return null;
}

/**
 * What `Ask AI to merge into current branch` puts in the composer
 * (docs/git-branches-ui.md#asking-the-agent-to-merge): built from the branches
 * at the press, never from what the menu rendered. Null while HEAD is
 * detached, when there is no branch to merge into.
 *
 * The UI never runs the merge itself: it can stop on conflicts, so the prompt
 * tells the agent how to get through them — or to stop and say why.
 */
export function describeMergePrompt(
	row: BranchRow,
	branches: GitBranches,
): string | null {
	const { head } = branches;
	if (head.detached) return null;
	const sentences = [
		`Merge ${row.label} into ${head.branch}, the branch checked out in this worktree.`,
	];
	// A local default is often checked out in the main worktree, where nothing
	// here can bring it up to date; a condition, because the list does not know
	// whether it tracks anything.
	if (row.isDefault && !row.remote && branches.sync.has_remote) {
		sentences.push(
			`If ${row.label} tracks a remote branch that is ahead of it, fetch and merge that branch instead.`,
		);
	}
	sentences.push(
		"If the merge stops on conflicts, resolve them keeping what both sides meant, then finish the merge. If a conflict cannot be resolved safely, stop and explain it instead of guessing.",
	);
	return sentences.join(" ");
}

export interface BranchDeleteConfirm {
	title: string;
	message: string;
	confirmLabel: string;
	variant: "default" | "danger";
}

function commits(n: number): string {
	return n === 1 ? "1 commit" : `${n} commits`;
}

/**
 * The confirm for deleting `name`, worded by what is lost
 * (docs/git-branches-ui.md#copy). On the danger dialog the button names the
 * commits rather than the branch: they are what is being agreed to.
 */
export function describeBranchDelete(
	name: string,
	inspection: GitBranchInspection,
): BranchDeleteConfirm {
	const upstream = inspection.upstream
		? ` ${inspection.upstream} stays on the remote.`
		: "";
	if (inspection.unique === 0) {
		return {
			title: `Delete ${name}?`,
			message: `Its commits are all on other branches, so nothing is lost.${upstream}`,
			confirmLabel: "Delete branch",
			variant: "default",
		};
	}
	const lost = commits(inspection.unique);
	const are = inspection.unique === 1 ? "is" : "are";
	return {
		title: `Delete ${name} and ${lost}?`,
		message: `${lost} on ${name} ${are} on no other branch and no remote, and will be lost. Latest: ${shortHash(inspection.tip)} "${inspection.subject}"${upstream}`,
		confirmLabel: `Delete ${lost}`,
		variant: "danger",
	};
}
