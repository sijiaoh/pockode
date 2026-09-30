import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getDisplayName,
	resetWorktreeStore,
	worktreeActions,
} from "./worktreeStore";

describe("getDisplayName", () => {
	it("returns branch for main worktree", () => {
		const worktree = {
			name: "",
			path: "/path/to/main",
			branch: "main",
			is_main: true,
		};
		expect(getDisplayName(worktree)).toBe("main");
	});

	it("falls back to Default when main has no branch", () => {
		const worktree = {
			name: "",
			path: "/path/to/main",
			branch: "",
			is_main: true,
		};
		expect(getDisplayName(worktree)).toBe("Default");
	});

	it("returns name for non-main worktree", () => {
		const worktree = {
			name: "feature-x",
			path: "/path/to/feature-x",
			branch: "feature/x",
			is_main: false,
		};
		expect(getDisplayName(worktree)).toBe("feature-x");
	});
});

describe("onGitRepoChange", () => {
	afterEach(() => resetWorktreeStore());

	// Every listener drops a cache; a repeated answer must not drop it again.
	it("fires for each new answer, and not for a repeated one", () => {
		const listener = vi.fn();
		worktreeActions.onGitRepoChange(listener);

		worktreeActions.setIsGitRepo(true);
		worktreeActions.setIsGitRepo(true);
		worktreeActions.setIsGitRepo(false);

		expect(listener.mock.calls).toEqual([[true], [false]]);
	});
});
