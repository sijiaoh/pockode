import { describeGitSync, type GitSync } from "../types/git";

/** git's own words when --ff-only meets a diverged branch. */
const DIVERGED = /not possible to fast-forward|divergent branches/i;
/** --force-with-lease when the remote moved since our last fetch. */
const STALE_LEASE = /stale info/i;
/** A plain push whose remote holds commits we do not have. */
const BEHIND_REMOTE = /fetch first|non-fast-forward/i;

export function commits(count: number): string {
	return `${count} ${count === 1 ? "commit" : "commits"}`;
}

export const FETCH_SUCCESS = "Fetched.";

export const FETCH_FAILURE = "Fetch failed.";

/**
 * The count comes back from the pull itself: it fetches first, so it can bring
 * in more than the panel's numbers promised.
 */
export function pullSuccess(pulled: number): string {
	return pulled > 0 ? `Pulled ${commits(pulled)}.` : "Already up to date.";
}

export function pullFailureSummary(detail: string): string {
	return DIVERGED.test(detail)
		? "Could not pull: this branch and its upstream have diverged. Ask the agent in chat to merge or rebase."
		: "Pull failed.";
}

/**
 * What push sends is what the counts say: a push that would send anything else
 * is rejected rather than silently sending more.
 */
export function pushSuccess(sync: GitSync): string {
	return describeGitSync(sync).needsPublish
		? "Branch published."
		: `Pushed ${commits(sync.ahead)}.`;
}

/**
 * Both rejections mean the same thing to the user — the remote moved — but only
 * after a fetch can the panel tell them whether pulling is enough. Anything else
 * gets no guessed summary; git's own message is below it either way.
 */
export function pushFailureSummary(detail: string): string {
	if (STALE_LEASE.test(detail)) {
		return "Push rejected: the remote moved since your last fetch. Fetch, then try again.";
	}
	if (BEHIND_REMOTE.test(detail)) {
		return "Push rejected: the remote has commits you do not have. Fetch, then pull or force push.";
	}
	return "Push failed.";
}
