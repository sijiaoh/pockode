import { useInfiniteQuery } from "@tanstack/react-query";
import { useIsGitRepo } from "../lib/worktreeStore";
import { useWSStore } from "../lib/wsStore";
import type { GitHistoryCursor } from "../types/git";
import type { HistoryQuery } from "../types/overlay";
import { gitLogQueryKey } from "./gitQueries";

/** docs/git-history-ui.md#paging-and-states; the server allows up to 200. */
export const HISTORY_PAGE_SIZE = 100;

/**
 * The History segment's commits, a page at a time.
 *
 * Under `gitLogQueryKey`, so a `git.changed` re-reads the list on screen and
 * leaves every other range and filter stale for when it is next shown. An
 * infinite query re-reads its pages from the first, each cursor
 * taken from the page re-read before it, so rewritten history (an amend, a
 * pull) never leaves a page continuing from commits that no longer exist.
 */
export function useGitLog(query: HistoryQuery) {
	const getLog = useWSStore((state) => state.actions.getLog);
	const isGitRepo = useIsGitRepo();
	const { scope, q = "", file = "" } = query;

	return useInfiniteQuery({
		queryKey: [...gitLogQueryKey, scope, q, file],
		queryFn: ({ pageParam }) =>
			getLog({
				scope,
				...(q ? { query: q } : {}),
				...(file ? { path: file } : {}),
				limit: HISTORY_PAGE_SIZE,
				...(pageParam ? { cursor: pageParam } : {}),
			}),
		initialPageParam: null as GitHistoryCursor | null,
		getNextPageParam: (page) => page.next ?? undefined,
		enabled: isGitRepo === true,
		staleTime: 30_000, // 30 seconds - commits change less frequently
	});
}
