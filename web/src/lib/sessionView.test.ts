import { describe, expect, it } from "vitest";
import type { WorktreeInfo } from "../types/message";
import { resolveSessionView } from "./sessionView";

const worktrees: WorktreeInfo[] = [
	{ name: "main", branch: "trunk", path: "/repo", is_main: true },
	{ name: "feature-x", branch: "feature-x", path: "/repo/x", is_main: false },
];

describe("resolveSessionView", () => {
	it("is no view when the URL carries no parameter", () => {
		expect(resolveSessionView(undefined, "", worktrees)).toBeNull();
	});

	it("is no view when the source is the worktree already in the path", () => {
		// Otherwise "Open there" would flash a read-only screen on its way out of
		// one: it navigates to the source worktree, which for one render is still
		// named by both halves of the URL.
		expect(resolveSessionView("feature-x", "feature-x", worktrees)).toBeNull();
		expect(resolveSessionView("", "", worktrees)).toBeNull();
	});

	it("reads a worktree that still exists, named as it is named elsewhere", () => {
		expect(resolveSessionView("feature-x", "", worktrees)).toEqual({
			worktree: "feature-x",
			exists: true,
			label: "feature-x",
		});
	});

	it("takes the empty string as the main worktree rather than as an absence", () => {
		expect(resolveSessionView("", "feature-x", worktrees)).toEqual({
			worktree: "",
			exists: true,
			// The main worktree is named by its branch everywhere else.
			label: "trunk",
		});
	});

	it("reports a worktree that is gone, keeping the name it left behind", () => {
		expect(resolveSessionView("old-fix", "", worktrees)).toEqual({
			worktree: "old-fix",
			exists: false,
			label: "old-fix",
		});
	});

	it("follows the worktree list, so a same-named rebuild exists again", () => {
		const rebuilt: WorktreeInfo[] = [
			...worktrees,
			{ name: "old-fix", branch: "old-fix", path: "/repo/o", is_main: false },
		];
		expect(resolveSessionView("old-fix", "", rebuilt)?.exists).toBe(true);
	});
});
