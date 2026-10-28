import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitSyncActions, useGitSyncStore } from "../lib/gitSyncStore";
import { resetWorktreeStore, worktreeActions } from "../lib/worktreeStore";
import { makeBranches, makeSync } from "../test/gitFixtures";
import type { GitBranches, GitSync } from "../types/git";
import { AUTO_FETCH_AFTER_MS } from "../utils/gitSyncStatus";
import { useAutoFetch } from "./useGitSync";

const fetchRemote = vi.fn();
const wsState = { actions: { fetchRemote, pull: vi.fn(), push: vi.fn() } };
const inFlight = vi.fn(() => false);
vi.mock("../lib/wsStore", () => ({
	isWorktreeSwitchInFlight: () => inFlight(),
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
}));

let query: {
	data: GitBranches | undefined;
	isFetching: boolean;
	isError?: boolean;
};
vi.mock("./useGitBranches", () => ({ useGitBranches: () => query }));

function branches(sync: Partial<GitSync>): GitBranches {
	return makeBranches({ sync: makeSync(sync) });
}

const stale = () =>
	branches({
		last_fetch: new Date(Date.now() - AUTO_FETCH_AFTER_MS - 1000).toISOString(),
	});

/**
 * Read from the store, which the run marks synchronously; the RPC itself goes
 * out a microtask later, from inside react-query's mutation.
 */
const autoFetching = (worktree = "") => {
	const run = useGitSyncStore.getState().runs[worktree];
	return run?.running === "fetch" && run.auto;
};

function renderAutoFetch() {
	const client = new QueryClient();
	return renderHook(() => useAutoFetch(), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
}

describe("useAutoFetch", () => {
	beforeEach(() => {
		gitSyncActions.reset();
		resetWorktreeStore();
		fetchRemote.mockReset();
		fetchRemote.mockReturnValue(new Promise(() => {}));
		query = { data: stale(), isFetching: false };
		inFlight.mockReset();
		inFlight.mockReturnValue(false);
	});

	it("fetches once on the way in when the counts are stale", async () => {
		const { rerender } = renderAutoFetch();

		expect(autoFetching()).toBe(true);
		await vi.waitFor(() => expect(fetchRemote).toHaveBeenCalledTimes(1));

		// A refetch landing once the run is over is not a second arrival.
		gitSyncActions.reset();
		query = { data: stale(), isFetching: false };
		rerender();
		expect(autoFetching()).toBe(false);
	});

	it("leaves counts fetched within ten minutes alone", () => {
		query = { data: branches({}), isFetching: false };
		renderAutoFetch();

		expect(autoFetching()).toBe(false);
	});

	// The cache may still be the answer from before the workspace was entered.
	it("decides only on branch data that has finished loading", () => {
		query = { data: branches({}), isFetching: true };
		const { rerender } = renderAutoFetch();
		expect(autoFetching()).toBe(false);

		query = { data: stale(), isFetching: false };
		rerender();
		expect(autoFetching()).toBe(true);
	});

	it("does not start a second run on top of one already going", () => {
		gitSyncActions.start(
			"",
			"pull",
			() => new Promise(() => {}),
			() => "",
		);
		renderAutoFetch();

		expect(useGitSyncStore.getState().runs[""]?.running).toBe("pull");
		expect(autoFetching()).toBe(false);
	});

	// Until the switch settles, the cache and the connection both still belong
	// to the worktree being left. The query is a stand-in here: that settling
	// refetches it is queryClient's, and is taken as given.
	it("decides again for a worktree switched to, once the switch settles and its branches refetch", () => {
		query = { data: branches({}), isFetching: false };
		const { rerender } = renderAutoFetch();
		expect(autoFetching()).toBe(false);

		act(() => worktreeActions.setCurrent("feature"));
		query = { data: stale(), isFetching: false };
		rerender();
		expect(autoFetching()).toBe(false);

		query = { data: stale(), isFetching: true };
		act(() => worktreeActions.notifyWorktreeSwitchEnd());
		expect(autoFetching()).toBe(false);

		query = { data: stale(), isFetching: false };
		rerender();
		expect(autoFetching("feature")).toBe(true);
	});

	it("waits out a switch that was already under way when it mounted", () => {
		inFlight.mockReturnValue(true);
		const { rerender } = renderAutoFetch();
		expect(autoFetching()).toBe(false);

		act(() => worktreeActions.notifyWorktreeSwitchEnd());
		rerender();
		expect(autoFetching()).toBe(true);
	});

	// A refetch that failed leaves the previous answer, which may be another
	// worktree's.
	it("does not decide on branch data whose refetch failed", () => {
		query = { data: stale(), isFetching: false, isError: true };
		const { rerender } = renderAutoFetch();
		expect(autoFetching()).toBe(false);

		query = { data: stale(), isFetching: false };
		rerender();
		expect(autoFetching()).toBe(true);
	});

	it("notices a switch that settled between its first render and listening", () => {
		// In flight for the render that seeds the state, settled by the time the
		// effect subscribes: no event will ever say so.
		inFlight.mockReturnValueOnce(true).mockReturnValue(false);
		renderAutoFetch();

		expect(autoFetching()).toBe(true);
	});
});
