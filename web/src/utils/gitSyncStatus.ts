import type { SyncOperation, SyncRun } from "../lib/gitSyncStore";
import {
	describeGitSync,
	type GitBranches,
	type GitHead,
	type GitSync,
} from "../types/git";

/**
 * The one step the branch most needs, in priority order: the first that holds
 * wins. A diverged branch is its own state rather than "pull" — pulling alone
 * cannot settle it, since pull only fast-forwards.
 */
export type SyncStep =
	| { kind: "publish" }
	| { kind: "diverged"; behind: number; ahead: number }
	| { kind: "pull"; behind: number }
	| { kind: "push"; ahead: number }
	// Zero counts that no fetch ever produced are not "up to date".
	| { kind: "unfetched" }
	| { kind: "synced" };

/**
 * How this branch stands against its upstream, as every place that reports it
 * says it — the sync chip and the sidebar's Git overview. One description so
 * the two cannot disagree about what the branch needs.
 */
export interface SyncStatus {
	step: SyncStep;
	/** A run in flight, manual or automatic; it leads the step without replacing it. */
	running: SyncOperation | null;
	/**
	 * The last automatic fetch failed and nothing has run since. Cleared only by
	 * the next run starting: having seen it does not make the counts fresh.
	 */
	autoFetchFailed: boolean;
	/** The whole state in words, for a screen reader that gets nothing from the arrows. */
	description: string;
}

/**
 * Whether there is a sync state to show at all. A detached HEAD tracks nothing,
 * and a repository without a remote has nothing to sync with.
 */
export function hasSyncStatus(
	head: GitHead | undefined,
	sync: GitSync | undefined,
): sync is GitSync {
	return Boolean(sync?.has_remote) && head?.detached === false;
}

export function describeSyncStatus(sync: GitSync, run: SyncRun): SyncStatus {
	const step = syncStep(sync);
	// Exclusive with running: a new run replaces the outcome it would mark.
	const autoFetchFailed = run.auto && run.outcome?.kind === "error";

	const description = run.running
		? RUNNING_DESCRIPTION[run.running]
		: describeSyncStep(step) +
			(autoFetchFailed ? ", automatic fetch failed" : "");

	return { step, running: run.running, autoFetchFailed, description };
}

function syncStep(sync: GitSync): SyncStep {
	if (describeGitSync(sync).needsPublish) return { kind: "publish" };
	const { behind, ahead } = sync;
	if (behind > 0 && ahead > 0) return { kind: "diverged", behind, ahead };
	if (behind > 0) return { kind: "pull", behind };
	if (ahead > 0) return { kind: "push", ahead };
	return sync.last_fetch === null ? { kind: "unfetched" } : { kind: "synced" };
}

export const RUNNING_DESCRIPTION: Record<SyncOperation, string> = {
	fetch: "fetching…",
	pull: "pulling…",
	push: "pushing…",
};

/**
 * The step as words. The sidebar's overview shows it as its line of text, the
 * chip only speaks it: one sentence per state, wherever it is said.
 */
export function describeSyncStep(step: SyncStep): string {
	switch (step.kind) {
		case "publish":
			return "branch not published";
		case "diverged":
			return `${step.behind} to pull, ${step.ahead} to push`;
		case "pull":
			return `${step.behind} to pull`;
		case "push":
			return `${step.ahead} to push`;
		case "unfetched":
			return "never fetched";
		case "synced":
			return "up to date";
	}
}

/**
 * Counts older than this are refreshed by a fetch the workspace runs on the
 * way in. Long enough that moving in and out of the workspace does not fetch
 * every time; short enough that counts read on arrival are about today.
 */
export const AUTO_FETCH_AFTER_MS = 10 * 60 * 1000;

/**
 * Whether entering the workspace should fetch by itself.
 *
 * Only where the chip is on screen: an automatic fetch reports its failure on
 * the chip — and in the sidebar's Git overview, which reads the same
 * `SyncStatus` and hides it in the same cases — so without one a failure would
 * go unseen.
 * `last_fetch` is the server's clock and `now` the browser's; a skew between
 * them moves the threshold by the same amount, which costs a fetch too many or
 * too few and nothing more.
 */
export function shouldAutoFetch(
	branches: GitBranches,
	running: SyncOperation | null,
	now: number,
): boolean {
	if (running !== null) return false;
	if (!hasSyncStatus(branches.head, branches.sync)) return false;
	const { last_fetch } = branches.sync;
	return (
		last_fetch === null ||
		now - new Date(last_fetch).getTime() > AUTO_FETCH_AFTER_MS
	);
}
