import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useFilesSearchStore } from "../lib/filesSearchStore";
import { useWSStore } from "../lib/wsStore";
import type { FileSearchMode, FileSearchResult } from "../types/search";
import { useDebouncedValue } from "./useDebouncedValue";

export const FILE_SEARCH_QUERY_KEY = "file-search";

/**
 * Cap on returned files. Sent explicitly rather than relying on the server
 * default, so how much this list can grow is a decision of the UI that has to
 * render it rather than one that shifts under us.
 */
const FILE_SEARCH_MAX_RESULTS = 100;

const DEBOUNCE_MS = 300;

// Scanning file contents is far more expensive than matching names, so it waits
// for a longer query before firing.
const MIN_QUERY_LENGTH: Record<FileSearchMode, number> = {
	name: 1,
	content: 2,
};

type FileSearchQueryKey = readonly [string, string, FileSearchMode, boolean];

export type FileSearchStatus =
	| "idle"
	| "too-short"
	| "loading"
	| "error"
	| "ready";

export interface FileSearchState {
	status: FileSearchStatus;
	result?: FileSearchResult;
	error: Error | null;
	/** A request is in flight; previous results may still be on screen. */
	isFetching: boolean;
	mode: FileSearchMode;
	minQueryLength: number;
	/** The query `result` was produced from — use this for highlighting. */
	matchedQuery: string;
	retry: () => void;
}

/**
 * The query is cached alongside its result so highlighting always describes the
 * results actually on screen. While a new query loads the previous ones stay
 * visible, and a content search can take seconds — long enough for highlights
 * and snippet anchoring computed from the newer query to visibly drift off the
 * older text.
 */
interface FileSearchData {
	query: string;
	result: FileSearchResult;
}

/**
 * @param active Whether the files tab is on screen. A hidden tab keeps its
 *   query state, and without this an invalidation (worktree switch, refresh)
 *   would re-run a full content scan nobody is looking at.
 */
export function useFileSearch(query: string, active: boolean): FileSearchState {
	const searchFiles = useWSStore((state) => state.actions.searchFiles);
	const searchContent = useFilesSearchStore((state) => state.searchContent);
	const respectGitignore = useFilesSearchStore(
		(state) => state.respectGitignore,
	);

	const mode: FileSearchMode = searchContent ? "content" : "name";
	const minQueryLength = MIN_QUERY_LENGTH[mode];

	const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
	const requestedQuery = debouncedQuery.trim();
	const enabled = active && requestedQuery.length >= minQueryLength;

	const { data, error, isError, isFetching, refetch } =
		useQuery<FileSearchData>({
			queryKey: [
				FILE_SEARCH_QUERY_KEY,
				requestedQuery,
				mode,
				respectGitignore,
			] satisfies FileSearchQueryKey,
			queryFn: async () => ({
				query: requestedQuery,
				result: await searchFiles({
					query: requestedQuery,
					mode,
					respect_gitignore: respectGitignore,
					max_results: FILE_SEARCH_MAX_RESULTS,
				}),
			}),
			enabled,
			// Backspacing to an earlier query should feel instant.
			staleTime: 30_000,
			// The global default retries three times, which is a long wait to see a
			// failure while typing.
			retry: false,
			// Keep the previous results visible while a new query loads, but only
			// while the options are unchanged: showing name-mode results in the
			// content-mode layout (or ignored files after the gitignore chip was
			// flipped) would misrepresent what was searched.
			placeholderData: (previousData, previousQuery) => {
				const previousKey = previousQuery?.queryKey as
					| FileSearchQueryKey
					| undefined;
				if (!previousKey) {
					return undefined;
				}
				return previousKey[2] === mode && previousKey[3] === respectGitignore
					? previousData
					: undefined;
			},
		});

	const retry = useCallback(() => {
		refetch();
	}, [refetch]);

	return {
		status: resolveStatus({
			liveQuery: query.trim(),
			minQueryLength,
			isError,
			hasResult: data !== undefined,
		}),
		result: data?.result,
		error,
		isFetching,
		mode,
		minQueryLength,
		matchedQuery: data?.query ?? requestedQuery,
		retry,
	};
}

function resolveStatus({
	liveQuery,
	minQueryLength,
	isError,
	hasResult,
}: {
	liveQuery: string;
	minQueryLength: number;
	isError: boolean;
	hasResult: boolean;
}): FileSearchStatus {
	if (liveQuery.length === 0) {
		return "idle";
	}
	// Derived from the live query, not the debounced one, so shortening a query
	// below the minimum reports it immediately instead of after the debounce.
	if (liveQuery.length < minQueryLength) {
		return "too-short";
	}
	if (isError) {
		return "error";
	}
	return hasResult ? "ready" : "loading";
}
