import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { contentsQueryKey } from "../hooks/useContents";
import { FILE_SEARCH_QUERY_KEY } from "../hooks/useFileSearch";
import { applyEntryGone } from "./fileCache";

/**
 * Tested here rather than through the components because all three callers —
 * the tree's rename, the tree's delete and the viewer's delete — funnel into
 * this one function, and what it has to get right is which cache entries it
 * touches. Asserting that once beats asserting it three times through three
 * dialogs.
 */
describe("applyEntryGone", () => {
	function seed() {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(contentsQueryKey(""), [
			{ name: "src", type: "dir", path: "src" },
		]);
		queryClient.setQueryData(contentsQueryKey("src"), [
			{ name: "old", type: "dir", path: "src/old" },
		]);
		queryClient.setQueryData(contentsQueryKey("src/old"), []);
		queryClient.setQueryData(contentsQueryKey("src/old/deep.ts"), {
			name: "deep.ts",
		});
		queryClient.setQueryData(contentsQueryKey("src/other.ts"), { name: "o" });
		queryClient.setQueryData([FILE_SEARCH_QUERY_KEY, "old"], { matches: [] });
		return queryClient;
	}

	const isStale = (queryClient: QueryClient, key: readonly unknown[]) =>
		queryClient.getQueryState(key)?.isInvalidated === true;

	it("drops the whole subtree that is no longer at the path", () => {
		const queryClient = seed();

		applyEntryGone(queryClient, "src/old");

		// Removed, not invalidated: refetching would collect one "not found" per
		// folder, and a reopened path must not show what used to be there.
		expect(
			queryClient.getQueryData(contentsQueryKey("src/old")),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(contentsQueryKey("src/old/deep.ts")),
		).toBeUndefined();
		// A sibling whose name merely starts the same way is not under it.
		expect(
			queryClient.getQueryData(contentsQueryKey("src/other.ts")),
		).toBeDefined();
	});

	it("invalidates the folder the entry was in, not the root", () => {
		const queryClient = seed();

		applyEntryGone(queryClient, "src/old");

		// The row to remove is in `src`. Invalidating the root instead leaves it
		// on screen in every folder but the root — which is what the viewer's
		// delete used to do.
		expect(isStale(queryClient, contentsQueryKey("src"))).toBe(true);
		expect(isStale(queryClient, contentsQueryKey(""))).toBe(false);
	});

	it("invalidates the folder an entry at the root was in", () => {
		const queryClient = seed();

		applyEntryGone(queryClient, "src");

		expect(isStale(queryClient, contentsQueryKey(""))).toBe(true);
	});

	it("invalidates the search results, which all carry a path", () => {
		const queryClient = seed();

		applyEntryGone(queryClient, "src/old");

		// Every match is a link to where it was found, so a stale list is one
		// that opens nothing. True of a delete exactly as it is of a rename,
		// which is why both come through here.
		expect(isStale(queryClient, [FILE_SEARCH_QUERY_KEY, "old"])).toBe(true);
	});
});
