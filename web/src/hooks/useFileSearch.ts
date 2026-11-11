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

/**
 * Exported because `FilesTab.test.tsx` types against a fake clock and has to
 * run exactly this wait out. A copy of the number there would keep passing
 * while drifting from this one, and then assert nothing.
 */
export const FILE_SEARCH_DEBOUNCE_MS = 300;

// A fuzzy content query matches any line holding its characters in order, so at
// two characters nearly every line of code matches: the server scores all of
// them, and the ranked list it returns is mostly ties. Three is where a fuzzy
// query starts to pick lines out. Matching names is cheap by comparison, so name
// mode starts at one.
const MIN_QUERY_WEIGHT: Record<FileSearchMode, number> = {
	name: 1,
	content: 3,
};

// What the minimum guards is selectivity, not length. Two Latin letters occur in
// order on nearly every line; two CJK characters rarely do, because a script
// with thousands of characters spreads them thin — 超时, 検索 or 설정 already
// picks lines out. Weighing each at 1.5 lets a two-character word reach three
// while a single character, which still matches too broadly, stays short.
const CJK_CHARACTER_WEIGHT = 1.5;
const CJK_CHARACTER =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Iterates code points, so a character outside the BMP weighs once. Composed
 * first because a decomposed Hangul syllable — text pasted from a macOS file
 * name — is two or three jamo, which would let one syllable pass as a word.
 */
function queryWeight(query: string): number {
	let weight = 0;
	for (const character of query.normalize("NFC")) {
		weight += CJK_CHARACTER.test(character) ? CJK_CHARACTER_WEIGHT : 1;
	}
	return weight;
}

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
	/** Characters a query needs to search in this mode… */
	minQueryLength: number;
	/** …or, when written in Chinese, Japanese or Korean, this many. */
	minCjkQueryLength: number;
	/** The query `result` was produced from — use this to describe `result`. */
	matchedQuery: string;
	retry: () => void;
}

/**
 * The query is cached alongside its result so whatever names the query describes
 * the results actually on screen. While a new query loads the previous ones stay
 * visible, and a content search can take seconds — long enough for "No matches
 * for …" to name a query that never produced the list below it. Highlights need
 * no such care: their ranges arrive inside the result.
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
	const minQueryWeight = MIN_QUERY_WEIGHT[mode];

	const debouncedQuery = useDebouncedValue(query, FILE_SEARCH_DEBOUNCE_MS);
	const requestedQuery = debouncedQuery.trim();
	const enabled = active && queryWeight(requestedQuery) >= minQueryWeight;

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
			minQueryWeight,
			isError,
			hasResult: data !== undefined,
		}),
		result: data?.result,
		error,
		isFetching,
		mode,
		minQueryLength: minQueryWeight,
		minCjkQueryLength: Math.ceil(minQueryWeight / CJK_CHARACTER_WEIGHT),
		matchedQuery: data?.query ?? requestedQuery,
		retry,
	};
}

function resolveStatus({
	liveQuery,
	minQueryWeight,
	isError,
	hasResult,
}: {
	liveQuery: string;
	minQueryWeight: number;
	isError: boolean;
	hasResult: boolean;
}): FileSearchStatus {
	if (liveQuery.length === 0) {
		return "idle";
	}
	// Derived from the live query, not the debounced one, so shortening a query
	// below the minimum reports it immediately instead of after the debounce.
	if (queryWeight(liveQuery) < minQueryWeight) {
		return "too-short";
	}
	if (isError) {
		return "error";
	}
	return hasResult ? "ready" : "loading";
}
