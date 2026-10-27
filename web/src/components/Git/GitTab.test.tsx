import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitSyncActions } from "../../lib/gitSyncStore";
import { makeHead, makeSync } from "../../test/gitFixtures";
import type { GitBranches } from "../../types/git";
import type { GitSegment } from "../../types/overlay";
import GitTab from "./GitTab";

vi.mock("../Layout", () => ({ useSidebarRefresh: () => ({ isActive: true }) }));

let branches: GitBranches | undefined;
vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error: null }),
}));
let changeCount: number | undefined;
vi.mock("../../hooks/useGitChangeCount", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitChangeCount")>()),
	useGitChangeCount: () => changeCount,
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
	branches = {
		head: makeHead({ branch: "feature/git-workspace" }),
		local: [],
		remote_only: [],
		sync: makeSync({ behind: 2 }),
	};
	changeCount = 5;
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
