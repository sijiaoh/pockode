import type { QueryClient } from "@tanstack/react-query";
import { contentsQueryKey } from "../hooks/useContents";
import { FILE_SEARCH_QUERY_KEY } from "../hooks/useFileSearch";
import { isAtOrUnder, parentDir } from "../utils/path";

/**
 * Drops every `contents` query at or under `path`.
 *
 * Removed rather than invalidated: those listings are about something that is
 * no longer at that path, so refetching them would only collect one "not found"
 * per folder. A file is its own one-entry subtree here, and dropping its cache
 * is what keeps the path, if it is opened again, from showing what used to be
 * there.
 */
function removeContentsUnder(queryClient: QueryClient, path: string): void {
	queryClient.removeQueries({
		predicate: ({ queryKey }) => {
			const [scope, key] = queryKey;
			if (scope !== "contents" || typeof key !== "string") return false;
			return isAtOrUnder(key, path);
		},
	});
}

/**
 * Brings the cache in line with an entry that is no longer at `path` — renamed
 * away from it, or deleted.
 *
 * One function for both because the cache cannot tell them apart: either way
 * the folder around it has one fewer row under that name, everything cached at
 * or under it describes something that is not there, and every search result
 * holding that path has become a link that opens nothing. Splitting it per
 * action is what let a rename invalidate the search cache while a delete did
 * not, and what let one caller invalidate the wrong folder's listing.
 *
 * Only the vacated path is needed, even for a rename: a rename never leaves its
 * own directory, so the listing invalidated here is the one the new name
 * appears in too. Nothing is prefetched under a new path, which is read when it
 * is opened.
 *
 * Search results are dropped wholesale rather than filtered: every match
 * carries the path it was found at, and telling which of them sat under this
 * one would mean re-running the search regardless.
 */
export function applyEntryGone(queryClient: QueryClient, path: string): void {
	queryClient.invalidateQueries({
		queryKey: contentsQueryKey(parentDir(path)),
	});
	removeContentsUnder(queryClient, path);
	queryClient.invalidateQueries({ queryKey: [FILE_SEARCH_QUERY_KEY] });
}
