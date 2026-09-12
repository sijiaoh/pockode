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
