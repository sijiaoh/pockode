import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeListResult } from "../types/message";
import { fetchWorktrees } from "./worktreeQuery";
import { useWorktreeStore, worktreeActions } from "./worktreeStore";

let listResult: WorktreeListResult = { worktrees: [] };

vi.mock("./wsStore", () => ({
	wsActions: {
		listWorktrees: () => Promise.resolve(listResult),
	},
}));

afterEach(() => {
	worktreeActions.reset();
	listResult = { worktrees: [] };
});

describe("fetchWorktrees", () => {
	// The whole point of the feature is that a skipped setup script reaches the
	// user, so the wire field name is worth pinning: a mismatch would silently
	// leave every warning unrendered.
	it("publishes a skipped setup script to the store", async () => {
		listResult = {
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
});
