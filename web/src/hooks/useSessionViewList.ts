import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
	type MergedSessionRow,
	mergeSessionRounds,
	type SessionViewRound,
} from "../lib/sessionMerge";
import { useWSStore } from "../lib/wsStore";
import { SESSION_VIEW_LIST_KEY } from "./sessionViewQueries";

/** Which page of each source the next round asks for; null is its first. */
type SourceCursors = Record<string, string | null>;

export interface SessionViewList {
	rows: MergedSessionRow[];
	/** Nothing to show yet, and something is on its way. */
	isLoading: boolean;
	/** Why the first page failed, and null while it has not. */
	loadError: string | null;
	hasMore: boolean;
	isLoadingMore: boolean;
	/** Why the last page failed; the sentinel's Retry clears it by retrying. */
	pageError: string | null;
	hasPaged: boolean;
	loadMore: () => void;
}

/**
 * The session lists of worktrees the connection is not bound to, merged into
 * one list in the order the sidebar shows.
 *
 * One source or several is the same machinery, because `session_view.list`
 * names a single worktree and there is no request for "all of them": a round
 * asks every source that still has a page for its next one, and
 * `mergeSessionRounds` decides how much of what came back can be shown without
 * risking a row appearing above one the reader has already passed.
 *
 * Nothing here subscribes — `session_view.*` pushes nothing — so this list does
 * not update itself, and deliberately does not re-fetch in the background
 * either: installing a round replaces the list and would throw away the depth a
 * reader had scrolled to. It is re-read when the user does something that says
 * so: opening the sidebar, pulling to refresh, changing the filter, deleting a
 * row. All of those but the filter go through `invalidateSessionViewQueries`,
 * which asks again for every round the reader had pulled in rather than
 * dropping back to a first page — there is no store holding these rows, so a
 * drop would blank the sidebar every time it opened.
 *
 * @param sources The worktrees to read, or null for "the current worktree",
 * which is the live subscribed list and not this hook's business.
 */
export function useSessionViewList(
	sources: string[] | null,
	excludeWorkSessions: boolean,
): SessionViewList | null {
	const sessionViewList = useWSStore((s) => s.actions.sessionViewList);

	// Sorted so that two selections of the same worktrees share one cache entry
	// whatever order they arrived in.
	const key = useMemo(
		() => [
			SESSION_VIEW_LIST_KEY,
			{ excludeWorkSessions, sources: sources ? [...sources].sort() : null },
		],
		[excludeWorkSessions, sources],
	);

	const query = useInfiniteQuery({
		queryKey: key,
		enabled: sources !== null,
		staleTime: Number.POSITIVE_INFINITY,
		initialPageParam: Object.fromEntries(
			(sources ?? []).map((worktree) => [worktree, null]),
		) as SourceCursors,
		queryFn: async ({ pageParam }): Promise<SessionViewRound> =>
			Promise.all(
				Object.entries(pageParam).map(async ([worktree, cursor]) => {
					const page = await sessionViewList(
						worktree,
						excludeWorkSessions,
						cursor ?? undefined,
					);
					return {
						worktree,
						sessions: page.sessions ?? [],
						nextCursor: page.has_more ? (page.next_cursor ?? null) : null,
					};
				}),
			),
		getNextPageParam: (round: SessionViewRound) => {
			const next: SourceCursors = {};
			for (const page of round) {
				if (page.nextCursor !== null) next[page.worktree] = page.nextCursor;
			}
			return Object.keys(next).length > 0 ? next : undefined;
		},
	});

	const { data, fetchNextPage } = query;
	const rows = useMemo(
		() => (data ? mergeSessionRounds(data.pages) : []),
		[data],
	);

	const loadMore = useCallback(() => {
		void fetchNextPage();
	}, [fetchNextPage]);

	const isEnabled = sources !== null;
	return useMemo(() => {
		// A disabled query still hands back whatever is cached under its key, and
		// answering at all for a sidebar that is showing its own worktree is how
		// that would leak onto it.
		if (!isEnabled) return null;
		const reason = readError(query.error);
		return {
			rows,
			isLoading: query.isPending,
			loadError: query.data === undefined ? reason : null,
			hasMore: query.hasNextPage,
			isLoadingMore: query.isFetchingNextPage,
			pageError: query.isFetchNextPageError
				? `Failed to load earlier conversations: ${reason ?? "Unknown error"}`
				: null,
			hasPaged: (query.data?.pages.length ?? 0) > 1,
			loadMore,
		};
	}, [
		isEnabled,
		rows,
		query.isPending,
		query.error,
		query.data,
		query.hasNextPage,
		query.isFetchingNextPage,
		query.isFetchNextPageError,
		loadMore,
	]);
}

function readError(error: unknown): string | null {
	if (!error) return null;
	return error instanceof Error && error.message
		? error.message
		: "Unknown error";
}
