import type { QueryClient } from "@tanstack/react-query";

export const gitStatusQueryKey = ["git-status"] as const;
export const gitLogQueryKey = ["git-log"] as const;
export const gitBranchesQueryKey = ["git-branches"] as const;

/**
 * Refetch everything the git panel reads.
 *
 * Mutations call this on success instead of waiting out GitWatcher's 3-second
 * poll, and moving HEAD invalidates all three at once — a checkout changes the
 * status, the history and the branch list together.
 */
export function invalidateGitQueries(queryClient: QueryClient): Promise<void> {
	const refetched = [
		gitStatusQueryKey,
		gitLogQueryKey,
		gitBranchesQueryKey,
	].map((queryKey) => queryClient.invalidateQueries({ queryKey }));

	// Awaitable so PullToRefresh's spinner can track the refetch rather than
	// stopping the moment the request is sent. Settles rather than rejects: a
	// failed refetch is already surfaced by that query's own error state, and an
	// awaiting caller only needs to know the refresh finished.
	return Promise.allSettled(refetched).then(() => undefined);
}

/**
 * Drop everything the git panel read, for a project that has just stopped
 * being a repository.
 *
 * Not invalidateGitQueries: the listener that learns the news runs before React
 * re-renders, while the readers still hold `enabled: true`, so an invalidation
 * would send every one of them off to be refused with -32002 — and retried.
 * Removing also cancels whatever is in flight, and leaves no error behind to
 * flash up if a later `git init` brings the panel back.
 */
export function removeGitQueries(queryClient: QueryClient): void {
	for (const queryKey of [
		gitStatusQueryKey,
		gitLogQueryKey,
		gitBranchesQueryKey,
	]) {
		queryClient.removeQueries({ queryKey });
	}
}
