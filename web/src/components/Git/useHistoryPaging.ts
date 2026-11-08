import { useCallback } from "react";
import type { useGitLog } from "../../hooks/useGitLog";
import { errorMessage } from "../../utils/errorMessage";
import type { HistoryFooter } from "./HistoryList";

/**
 * A history listing's paging: when the next page is asked for, what Retry
 * does, and what the list's last row says (docs/git-history-ui.md#paging-and-states).
 * Shared by every list of commits read a page at a time — History, and a
 * branch's commits — so that they page and fail alike.
 *
 * `endText` is what the last row says once there is nothing older to list.
 * The server's `shallow` marks the clone, not the walk, so whether it is the
 * reason the list ends is the caller's to say.
 */
export function useHistoryPaging(
	log: ReturnType<typeof useGitLog>,
	endText: string,
): {
	footer: HistoryFooter;
	loadMore: () => void;
	retry: () => void;
} {
	const {
		error,
		hasNextPage,
		isFetching,
		isFetchNextPageError,
		isRefetchError,
		fetchNextPage,
		refetch,
	} = log;

	// Not while anything is fetching: `fetchNextPage` cancels a fetch in flight,
	// and a re-read after `git.changed` would be dropped for a page appended
	// to the old ones. A new identity once it settles asks again.
	const loadMore = useCallback(() => {
		if (hasNextPage && !isFetching) void fetchNextPage();
	}, [hasNextPage, isFetching, fetchNextPage]);
	// From the top rather than the failed page again: a cursor whose commits
	// were garbage-collected fails the same way every time, and the re-read
	// takes fresh cursors (docs/git.md, History). The next page follows on its
	// own once the reader is still near the end.
	const retry = useCallback(() => void refetch(), [refetch]);

	// A re-read from the top (`git.changed`, Retry) that failed keeps the old
	// rows on screen, which are then not current: said where Retry is. The
	// failed footer also asks for no next page, which would hang off the stale
	// pages and hide the failure once it arrived.
	const footer: HistoryFooter = isFetchNextPageError
		? {
				kind: "failed",
				text: "Couldn't load older commits.",
				reason: errorMessage(error),
			}
		: isRefetchError && !isFetching
			? {
					kind: "failed",
					text: "Couldn't refresh history.",
					reason: errorMessage(error),
				}
			: hasNextPage
				? { kind: "loading" }
				: { kind: "end", text: endText };

	return { footer, loadMore, retry };
}
