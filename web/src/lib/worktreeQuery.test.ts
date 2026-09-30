import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeListResult } from "../types/message";
import { fetchWorktrees } from "./worktreeQuery";
import { useWorktreeStore, worktreeActions } from "./worktreeStore";

let listResult: WorktreeListResult = { is_git_repo: true, worktrees: [] };

vi.mock("./wsStore", () => ({
	wsActions: {
		listWorktrees: () => Promise.resolve(listResult),
	},
}));

afterEach(() => {
	worktreeActions.reset();
	listResult = { is_git_repo: true, worktrees: [] };
});

describe("fetchWorktrees", () => {
	// The whole point of the feature is that a skipped setup script reaches the
	// user, so the wire field name is worth pinning: a mismatch would silently
	// leave every warning unrendered.
	it("publishes a skipped setup script to the store", async () => {
		listResult = {
			is_git_repo: true,
			worktrees: [],
			setup_hook_skip: { reason: "no bash.exe found", hint: "install it" },
		};

		await fetchWorktrees();

		expect(useWorktreeStore.getState().setupHookSkip).toEqual({
			reason: "no bash.exe found",
			hint: "install it",
		});
	});

	it("clears the skip once the setup script can run again", async () => {
		worktreeActions.setSetupHookSkip({ reason: "stale", hint: "stale" });

		const worktrees = await fetchWorktrees();

		expect(useWorktreeStore.getState().setupHookSkip).toBeNull();
		expect(worktrees).toEqual([]);
	});

	// Same reason: the Git tab, the switcher and every git read hang off it.
	it("publishes whether the project is a git repository", async () => {
		listResult = { is_git_repo: false, worktrees: [] };

		await fetchWorktrees();

		expect(useWorktreeStore.getState().isGitRepo).toBe(false);
	});

	// Out-of-order replies: a request worktree.changed cancelled can answer after
	// the newer one, and must not put the older answer back.
	it("leaves the store alone for a request that was cancelled", async () => {
		worktreeActions.setIsGitRepo(true);
		listResult = { is_git_repo: false, worktrees: [] };
		const controller = new AbortController();
		controller.abort();

		await fetchWorktrees({ signal: controller.signal });

		expect(useWorktreeStore.getState().isGitRepo).toBe(true);
	});
});
