import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorktreeStore, worktreeActions } from "../lib/worktreeStore";
import type { WorktreeChangedNotification } from "../types/message";
import { useWorktree } from "./useWorktree";

let notify: ((params: WorktreeChangedNotification) => void) | null = null;
const listWorktrees = vi.fn();

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../lib/wsStore", () => {
	const state = {
		status: "connected",
		actions: {
			worktreeSubscribe: async (
				callback: (params: WorktreeChangedNotification) => void,
			) => {
				notify = callback;
				return { id: "sub", initial: { is_git_repo: false } };
			},
			worktreeUnsubscribe: async () => {},
		},
	};
	return {
		useWSStore: (selector: (s: unknown) => unknown) => selector(state),
		wsActions: { listWorktrees: () => listWorktrees() },
		setWorktreeDeletedListener: () => {},
		setWorktreeNotFoundListener: () => {},
	};
});

function renderWorktree() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return renderHook(() => useWorktree(), { wrapper });
}

afterEach(() => {
	worktreeActions.reset();
	notify = null;
	listWorktrees.mockReset();
});

describe("useWorktree", () => {
	// The subscription is what reports a `git init`, so it has to be open in a
	// project that is not a repository yet — and what it says is what the UI
	// shows, with no reload.
	it("follows the project into and out of being a git repository", async () => {
		const main = { name: "", path: "/p", branch: "", is_main: true };
		listWorktrees.mockResolvedValue({ is_git_repo: false, worktrees: [main] });
		const { result } = renderWorktree();

		await waitFor(() => expect(result.current.isGitRepo).toBe(false));
		expect(notify).not.toBeNull();

		listWorktrees.mockResolvedValue({
			is_git_repo: true,
			worktrees: [{ ...main, branch: "main" }],
		});
		act(() => notify?.({ is_git_repo: true }));

		expect(useWorktreeStore.getState().isGitRepo).toBe(true);
		// The list is read again, which is where the branch name comes from.
		await waitFor(() =>
			expect(result.current.currentWorktree?.branch).toBe("main"),
		);

		listWorktrees.mockResolvedValue({ is_git_repo: false, worktrees: [main] });
		act(() => notify?.({ is_git_repo: false }));
		expect(result.current.isGitRepo).toBe(false);
	});

	// The server answers out of order: the page's first list request can be
	// answered after a `git init` has already been reported.
	it("does not let an older list reply undo a newer answer", async () => {
		const main = { name: "", path: "/p", branch: "", is_main: true };
		let answerFirstList: (value: unknown) => void = () => {};
		listWorktrees.mockReturnValueOnce(
			new Promise((resolve) => {
				answerFirstList = resolve;
			}),
		);
		listWorktrees.mockResolvedValue({
			is_git_repo: true,
			worktrees: [{ ...main, branch: "main" }],
		});
		const { result } = renderWorktree();
		await waitFor(() => expect(notify).not.toBeNull());

		act(() => notify?.({ is_git_repo: true }));
		await act(async () => {
			answerFirstList({ is_git_repo: false, worktrees: [main] });
		});

		await waitFor(() =>
			expect(result.current.currentWorktree?.branch).toBe("main"),
		);
		expect(useWorktreeStore.getState().isGitRepo).toBe(true);
	});
});
