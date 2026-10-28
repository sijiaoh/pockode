import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitSyncActions } from "../../lib/gitSyncStore";
import { makeBranches, makeHead, makeSync } from "../../test/gitFixtures";
import type { GitBranches, GitStatus, LineStat } from "../../types/git";
import type { GitSegment } from "../../types/overlay";
import GitTab from "./GitTab";

vi.mock("../Layout", () => ({ useSidebarRefresh: () => ({ isActive: true }) }));

let branches: GitBranches | undefined;
vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error: null }),
}));
let changeCount: number | undefined;
let changeLines: LineStat | null;
let status: GitStatus | undefined;
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));
vi.mock("../../hooks/useGitChangeCount", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitChangeCount")>()),
	useGitChangeCount: () => changeCount,
	useGitChangeLines: () => changeLines,
}));

function renderTab(activeSegment: GitSegment | null = null) {
	const onOpenSegment = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<GitTab onOpenSegment={onOpenSegment} activeSegment={activeSegment} />
		</QueryClientProvider>,
	);
	return { onOpenSegment };
}

beforeEach(() => {
	branches = makeBranches({
		head: makeHead({ branch: "feature/git-workspace" }),
		sync: makeSync({ behind: 2 }),
	});
	changeCount = 5;
	changeLines = null;
	status = undefined;
	gitSyncActions.reset();
});

describe("GitTab", () => {
	it.each([
		["Changes, 5 changed files", "changes"],
		["History", "history"],
		["Branches", "branches"],
	] as const)("opens %s at its segment", async (name, segment) => {
		const user = userEvent.setup();
		const { onOpenSegment } = renderTab();

		await user.click(screen.getByRole("button", { name }));

		expect(onOpenSegment).toHaveBeenCalledWith(segment);
	});

	// Every write lives once, in the workspace: the tab is the three doors and
	// nothing else — the branch and its sync state are read, not pressed.
	it("offers nothing but the three entries", () => {
		renderTab();

		expect(screen.getAllByRole("button")).toHaveLength(3);
		expect(screen.getByText("feature/git-workspace")).toBeInTheDocument();
	});

	it("marks the entry for the segment on screen", () => {
		renderTab("history");

		expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(
			screen.getByRole("button", { name: "Branches" }),
		).not.toHaveAttribute("aria-current");
	});

	describe("the change count", () => {
		it("says a clean tree in words rather than as a 0", () => {
			changeCount = 0;
			renderTab();

			expect(
				screen.getByRole("button", { name: /^Changes/ }),
			).toHaveTextContent("No changes");
		});

		it("carries the lines added and removed beside the count", () => {
			changeLines = { additions: 142, deletions: 37 };
			renderTab();

			const entry = screen.getByRole("button", {
				name: "Changes, 5 changed files, 142 lines added, 37 removed",
			});
			expect(entry).toHaveTextContent("5+142 −37");
		});

		// Every file binary or too large: nothing to sum, which is not `+0 −0`.
		it("leaves the lines out when nothing could be counted", () => {
			changeLines = { additions: 0, deletions: 0 };
			renderTab();

			expect(
				screen.getByRole("button", { name: "Changes, 5 changed files" }),
			).toHaveTextContent(/^Changes5$/);
		});

		// Like the tab's badge, this is not where a failed read is reported.
		it("says nothing while the status has no answer", () => {
			changeCount = undefined;
			renderTab();

			expect(
				screen.getByRole("button", { name: /^Changes/ }),
			).toHaveTextContent(/^Changes$/);
		});
	});

	describe("the sync state", () => {
		it("reads the same step the workspace's sync chip shows", () => {
			renderTab();

			expect(screen.getByText("2 to pull")).toBeInTheDocument();
		});

		it("shows a run in flight beside the step", async () => {
			gitSyncActions.start(
				"",
				"pull",
				() => new Promise(() => {}),
				() => "Pull failed.",
			);
			renderTab();

			expect(screen.getByText("2 to pull")).toBeInTheDocument();
			expect(screen.getByText("Pulling…")).toBeInTheDocument();
		});

		// Nobody started it, so the chip and this line are all it has.
		it("marks an automatic fetch that failed", async () => {
			await gitSyncActions.startAutoFetch("", () =>
				Promise.reject(new Error("fatal: unable to access")),
			);
			renderTab();

			expect(screen.getByText("Automatic fetch failed")).toBeInTheDocument();
		});

		// A detached HEAD tracks nothing, so there is no step to name.
		it("is left out on a detached HEAD, which is named by its commit", () => {
			branches = {
				...(branches as GitBranches),
				head: makeHead({ detached: true, hash: "9692fc9" }),
			};
			renderTab();

			expect(screen.getByText("detached @ 9692fc9")).toBeInTheDocument();
			expect(screen.queryByText(/to pull/)).toBeNull();
		});

		it("is left out where there is no remote", () => {
			branches = {
				...(branches as GitBranches),
				sync: makeSync({ has_remote: false }),
			};
			renderTab();

			expect(screen.getByText("feature/git-workspace")).toBeInTheDocument();
			expect(screen.queryByText(/to pull/)).toBeNull();
		});
	});
});

describe("GitTab overview during an operation", () => {
	// A repository stuck mid-rebase is what the doorplate has to say.
	it("says the operation in place of the sync line, and names the rebased branch", () => {
		branches = makeBranches({
			head: makeHead({ branch: "", detached: true, hash: "4be1f20" }),
			sync: makeSync({ behind: 2 }),
		});
		status = {
			staged: [],
			unstaged: [],
			conflicted: ["a.ts"],
			operation: { kind: "rebase", branch: "feature/git-ui" },
		};
		renderTab();

		expect(screen.getByText("Rebase stopped on conflicts")).toBeInTheDocument();
		expect(screen.getByText("feature/git-ui")).toBeInTheDocument();
		expect(screen.getByText("· rebasing")).toBeInTheDocument();
		expect(screen.queryByText(/behind/i)).toBeNull();
	});
});
