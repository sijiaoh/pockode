import { type QueryClient, useQuery } from "@tanstack/react-query";
import type { SessionViewWorktree } from "../lib/rpc/sessionView";
import { useWSStore } from "../lib/wsStore";

/** Where every `session_view.list` round in the cache hangs. */
export const SESSION_VIEW_LIST_KEY = "session-view-list";
/** Where the answer to "which worktrees still have sessions" hangs. */
const SESSION_VIEW_SOURCES_KEY = ["session-view-worktrees"];

/**
 * Re-reads everything `session_view.*` answered.
 *
 * The namespace pushes nothing, so a change made through it — a session deleted
 * out of another worktree — is only visible once whoever made it says so, and
 * neither is anything somebody else changed meanwhile. Both reads go together
 * because one delete can move both: the row goes from the list, and the
 * worktree goes out of the filter entirely when it was the last one.
 *
 * Invalidated rather than reset: an active list keeps its rows on screen and is
 * asked again for every round the reader had pulled in, so a refresh neither
 * blanks the sidebar nor costs them their depth.
 *
 * Returns when both re-reads have landed, so a pull-to-refresh holds its
 * spinner for as long as the refresh actually takes rather than snapping back
 * on a list that has not changed yet.
 */
export function invalidateSessionViewQueries(
	queryClient: QueryClient,
): Promise<void> {
	return Promise.all([
		queryClient.invalidateQueries({ queryKey: [SESSION_VIEW_LIST_KEY] }),
		queryClient.invalidateQueries({ queryKey: SESSION_VIEW_SOURCES_KEY }),
	]).then(() => undefined);
}

export interface SessionViewSources {
	sources: SessionViewWorktree[];
	isLoading: boolean;
	/**
	 * Whether the list on hand is the server's answer.
	 *
	 * Not "has been asked": a read that failed has been asked and knows nothing,
	 * and the empty list it leaves behind would read as "no worktree has any
	 * sessions" — a claim strong enough to move the user's filter.
	 */
	isAnswered: boolean;
	/** Why the read failed, and null while it has not. */
	error: string | null;
}

/**
 * The worktrees that still have sessions — the ones that exist, and the deleted
 * ones whose data the server kept.
 *
 * Fetched only while something is asking (the filter panel is open, or the
 * sidebar is already showing another worktree's list): on a machine with one
 * worktree this question never needs asking at all.
 */
export function useSessionViewSources(enabled: boolean): SessionViewSources {
	const sessionViewWorktrees = useWSStore(
		(s) => s.actions.sessionViewWorktrees,
	);
	const { data, isLoading, isSuccess, error } = useQuery({
		queryKey: SESSION_VIEW_SOURCES_KEY,
		queryFn: sessionViewWorktrees,
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
	});
	return {
		sources: data ?? [],
		isLoading: enabled && isLoading,
		isAnswered: enabled && isSuccess,
		error: enabled && error ? readError(error) : null,
	};
}

function readError(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "Unknown error";
}
