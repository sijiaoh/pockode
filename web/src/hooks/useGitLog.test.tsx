import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worktreeActions } from "../lib/worktreeStore";
import type { GitLogParams, GitLogResult } from "../types/git";
import { type GitLogQuery, HISTORY_PAGE_SIZE, useGitLog } from "./useGitLog";

const getLog = vi.fn<(params: GitLogParams) => Promise<GitLogResult>>();

vi.mock("../lib/wsStore", () => {
	const state = { actions: { getLog: (p: GitLogParams) => getLog(p) } };
	return {
		useWSStore: (selector: (s: unknown) => unknown) => selector(state),
	};
});

function renderLog(queries: GitLogQuery[]) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return renderHook(() => queries.map((query) => useGitLog(query)), {
		wrapper,
	});
}

beforeEach(() => {
	worktreeActions.setIsGitRepo(true);
});

afterEach(() => {
	worktreeActions.reset();
	getLog.mockReset();
});

describe("useGitLog", () => {
	it("asks for a branch's range, and sends its cursor back unchanged", async () => {
		const cursor = {
			tips: ["a".repeat(40)],
			skip: 100,
			exclude: ["b".repeat(40)],
		};
		getLog
			.mockResolvedValueOnce({ commits: [], next: cursor })
			.mockResolvedValueOnce({ commits: [], next: null });
		const { result } = renderLog([
			{ scope: "branch", branch: "origin/topic", q: "fix" },
		]);

		await waitFor(() => expect(result.current[0].hasNextPage).toBe(true));
		await act(() => result.current[0].fetchNextPage());

		expect(getLog.mock.calls.map(([params]) => params)).toEqual([
			{
				scope: "branch",
				branch: "origin/topic",
				query: "fix",
				limit: HISTORY_PAGE_SIZE,
			},
			{
				scope: "branch",
				branch: "origin/topic",
				query: "fix",
				limit: HISTORY_PAGE_SIZE,
				cursor,
			},
		]);
	});

	it("keeps each branch's range apart from the others and from the History ranges", async () => {
		getLog.mockImplementation(async (params) => ({
			commits: [],
			next: null,
			default_branch: params.branch ?? params.scope,
		}));
		const { result } = renderLog([
			{ scope: "branch", branch: "a" },
			{ scope: "branch", branch: "b" },
			{ scope: "current" },
		]);

		await waitFor(() =>
			expect(
				result.current.map((log) => log.data?.pages[0].default_branch),
			).toEqual(["a", "b", "current"]),
		);
		expect(getLog).toHaveBeenCalledTimes(3);
	});
});
