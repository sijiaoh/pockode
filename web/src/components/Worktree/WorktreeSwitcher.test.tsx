import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useWorktree } from "../../hooks/useWorktree";
import { getDisplayName } from "../../lib/worktreeStore";
import type { WorktreeInfo } from "../../types/message";
import WorktreeSwitcher from "./WorktreeSwitcher";

type WorktreeHook = ReturnType<typeof useWorktree>;

let worktreeHook: Partial<WorktreeHook>;

vi.mock("../../hooks/useWorktree", () => ({
	useWorktree: () => worktreeHook,
}));

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ projectTitle: "my-notes" }),
}));

function main(branch: string): WorktreeInfo {
	return { name: "", path: "/p", branch, is_main: true };
}

function state(overrides: Partial<WorktreeHook>): Partial<WorktreeHook> {
	return {
		current: "",
		worktrees: [],
		isLoading: false,
		isGitRepo: true,
		setupHookSkip: null,
		getDisplayName,
		...overrides,
	};
}

beforeEach(() => {
	worktreeHook = state({});
});

describe("WorktreeSwitcher", () => {
	it("names the project without a switcher outside a git repository", () => {
		worktreeHook = state({ isGitRepo: false, currentWorktree: main("") });
		render(<WorktreeSwitcher />);
		expect(screen.getByText("my-notes")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Select worktree" }),
		).toBeNull();
	});

	it("offers no switcher until the server has said which it is", () => {
		worktreeHook = state({ isGitRepo: null });
		render(<WorktreeSwitcher />);
		expect(
			screen.queryByRole("button", { name: "Select worktree" }),
		).toBeNull();
		expect(screen.queryByText("my-notes")).toBeNull();
	});

	it("reports a list that failed instead of loading forever", () => {
		worktreeHook = state({
			isGitRepo: null,
			error: new Error("Not connected"),
		});
		render(<WorktreeSwitcher />);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Couldn't load worktrees: Not connected",
		);
	});

	// A detached HEAD leaves main without a branch to name; the switcher must
	// still settle rather than stay a skeleton.
	it("calls a main without a branch Default", () => {
		const worktree = main("");
		worktreeHook = state({ worktrees: [worktree], currentWorktree: worktree });
		render(<WorktreeSwitcher />);
		expect(
			screen.getByRole("button", { name: "Select worktree" }),
		).toHaveTextContent("Default");
	});

	// A project inside another repository's directory: git lists that
	// repository's main, which is not this project, so the list has no main.
	it("calls it Default when the list has no main to name", () => {
		render(<WorktreeSwitcher />);
		expect(
			screen.getByRole("button", { name: "Select worktree" }),
		).toHaveTextContent("Default");
	});
});
