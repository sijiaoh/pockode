import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitSyncActions } from "../../lib/gitSyncStore";
import { makeBranches, makeHead, makeSync } from "../../test/gitFixtures";
import type { GitBranches, GitStatus, LineStat } from "../../types/git";
import type { GitLayer, GitSegment } from "../../types/overlay";
import GitTab, { type GitNavigation } from "./GitTab";

let tabActive: boolean;
vi.mock("../Layout", () => ({
	useSidebarRefresh: () => ({ isActive: tabActive }),
}));
// jsdom lays nothing out, and the scrolling is revealRow.test.tsx's: what is
// recorded here is which row the drawer asked to bring into view.
let revealed: string[];
vi.mock("./revealRow", async () => {
	const { useLayoutEffect } = await import("react");
	return {
		useRevealLitRow: (
			scrollerRef: { current: HTMLElement | null },
			reveal: (() => void) | undefined,
		) => {
			useLayoutEffect(() => {
				const row = scrollerRef.current?.querySelector('[aria-current="true"]');
				if (!reveal || !row) return;
				revealed.push(row.getAttribute("aria-label") ?? "");
				reveal();
			});
		},
	};
});

let branches: GitBranches | undefined;
vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error: null }),
}));
let changeCount: number | undefined;
let changeLines: LineStat | null;
let status: GitStatus | undefined;
let statusError: Error | null;
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status, error: statusError }),
}));
vi.mock("../../hooks/useGitChangeCount", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitChangeCount")>()),
	useGitChangeCount: () => changeCount,
	useGitChangeLines: () => changeLines,
}));

vi.mock("../../hooks/useBranchMergeHandoff", () => ({
	useSharedMergeHandoff: () => ({
		handingOff: null,
		error: null,
		dismissError: () => {},
		start: () => {},
	}),
}));
// Has tests of its own (hooks/useGitSync.test.tsx).
vi.mock("../../hooks/useGitSync", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitSync")>()),
	useAutoFetch: () => {},
}));
// At `expanded` what is under test is which list the tab stands at and what
// it lights; the bar, the banner and the lists have tests of their own.
vi.mock("./BranchBar", async (importOriginal) => ({
	...(await importOriginal<typeof import("./BranchBar")>()),
	default: () => <div>branch bar</div>,
}));
vi.mock("./OperationBanner", () => ({
	default: ({ compact }: { compact: boolean }) => (
		<div>{compact ? "compact banner" : "whole banner"}</div>
	),
}));
vi.mock("./GitSegmentList", async (importOriginal) => ({
	...(await importOriginal<typeof import("./GitSegmentList")>()),
	default: ({
		segment,
		history,
		activeFile,
		activeHash,
		activeBranchKey,
		reveal,
		onSelectSegment,
		onSelectCommit,
		onShowHistory,
		onShowFileHistory,
	}: {
		segment: GitSegment;
		history: { q?: string; file?: string };
		activeFile: { path: string } | null;
		activeHash: string | null;
		activeBranchKey: string | null;
		reveal?: () => void;
		onSelectSegment: (segment: GitSegment) => void;
		onSelectCommit: (hash: string) => void;
		onShowHistory?: (next: { scope: "current"; q: string }) => void;
		onShowFileHistory?: (path: string) => void;
	}) => (
		<div>
			<div>
				{segment} list{history.q ? ` matching ${history.q}` : ""}
				{history.file ? ` of ${history.file}` : ""}, lit{" "}
				{[activeFile?.path, activeHash, activeBranchKey]
					.filter(Boolean)
					.join(" ") || "none"}
			</div>
			{(["changes", "history", "branches"] as const).map((s) => (
				<button key={s} type="button" onClick={() => onSelectSegment(s)}>
					segment {s}
				</button>
			))}
			<button type="button" onClick={() => onSelectCommit("abc1234")}>
				open commit
			</button>
			{onShowHistory && (
				<button
					type="button"
					onClick={() => onShowHistory({ scope: "current", q: "fix" })}
				>
					search fix in place
				</button>
			)}
			{onShowFileHistory && (
				<button type="button" onClick={() => onShowFileHistory("src/a.ts")}>
					history of src/a.ts in place
				</button>
			)}
			{reveal && (
				<button type="button" onClick={reveal}>
					reveal lit row
				</button>
			)}
		</div>
	),
}));

function makeNavigation(): GitNavigation {
	return {
		onSelectSegment: vi.fn(),
		onSelectFile: vi.fn(),
		onCloseFile: vi.fn(),
		onSelectCommit: vi.fn(),
		onSelectBranch: vi.fn(),
		onRepointBranch: vi.fn(),
	};
}

function renderTab(activeSegment: GitSegment | null = null) {
	const navigation = makeNavigation();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<GitTab
				isExpanded={false}
				isOpen
				layer={activeSegment && { type: "git", segment: activeSegment }}
				navigation={navigation}
			/>
		</QueryClientProvider>,
	);
	return { onOpenSegment: navigation.onSelectSegment };
}

function renderDrawer(layer: GitLayer | null, { isOpen = true } = {}) {
	const navigation = makeNavigation();
	const client = new QueryClient();
	const tab = (layer: GitLayer | null, isOpen: boolean) => (
		<QueryClientProvider client={client}>
			<GitTab
				isExpanded={false}
				isOpen={isOpen}
				layer={layer}
				navigation={navigation}
			/>
		</QueryClientProvider>
	);
	let open = isOpen;
	const { rerender } = render(tab(layer, isOpen));
	return {
		navigation,
		setOpen: (next: boolean) => {
			open = next;
			act(() => rerender(tab(layer, next)));
		},
		/** Renders again, as a new status or a tab switch would. */
		refresh: () => act(() => rerender(tab(layer, open))),
	};
}

/** A status of plain unstaged modifications, one per path. */
function modified(...paths: string[]): GitStatus {
	return {
		staged: [],
		unstaged: paths.map((path) => ({ path, status: "M" as const })),
	};
}

/** Seven files, one more than the drawer shows before `Show all`. */
function paths7(): string[] {
	return ["a", "b", "c", "d", "e", "f", "g"].map((p) => `${p}.ts`);
}

/** The paths the drawer lists, top to bottom. */
function listedPaths(): string[] {
	const list = screen.getByRole("list", { name: "Changed files" });
	return within(list)
		.getAllByRole("button")
		.map((b) => (b.getAttribute("aria-label") ?? "").replace(/^Review /, ""));
}

function renderExpanded(layer: GitLayer | null, { isOpen = true } = {}) {
	const navigation = makeNavigation();
	const onListShownChange = vi.fn();
	const client = new QueryClient();
	const tab = (layer: GitLayer | null, isOpen: boolean) => (
		<QueryClientProvider client={client}>
			<GitTab
				isExpanded
				isOpen={isOpen}
				layer={layer}
				navigation={navigation}
				onListShownChange={onListShownChange}
			/>
		</QueryClientProvider>
	);
	const { rerender } = render(tab(layer, isOpen));
	return {
		navigation,
		onListShownChange,
		route: (next: GitLayer | null) => act(() => rerender(tab(next, isOpen))),
		collapse: () => act(() => rerender(tab(layer, false))),
		setOpen: (next: GitLayer | null, open: boolean) =>
			act(() => rerender(tab(next, open))),
	};
}

beforeEach(() => {
	branches = makeBranches({
		head: makeHead({ branch: "feature/git-workspace" }),
		sync: makeSync({ behind: 2 }),
	});
	changeCount = 5;
	changeLines = null;
	status = undefined;
	statusError = null;
	tabActive = true;
	revealed = [];
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

	// Every write lives once, in the workspace: past the changed files the
	// tab is the three doors — the branch and its sync state are read, not
	// pressed.
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

describe("GitTab's changed files below expanded", () => {
	it("lists them in the review's order, and opens one where the list would", async () => {
		const user = userEvent.setup();
		status = {
			staged: [{ path: "src/b.ts", status: "M" }],
			unstaged: [
				{ path: "src/b.ts", status: "M" },
				{ path: "a.ts", status: "M" },
				{ path: "new.ts", status: "?" },
			],
		};
		const { navigation } = renderDrawer(null);

		expect(listedPaths()).toEqual(["a.ts", "new.ts", "src/b.ts"]);
		// A partly staged file opens unstaged, as from the Changes list.
		await user.click(screen.getByRole("button", { name: "Review src/b.ts" }));
		expect(navigation.onSelectFile).toHaveBeenCalledWith("src/b.ts", false);
	});

	// Every write lives once, in the workspace.
	it("offers nothing that writes", () => {
		status = modified("a.ts", "b.ts");
		renderDrawer(null);

		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByRole("button", { name: /^More actions/ })).toBeNull();
	});

	it("marks a conflicted file, which opens like any other", async () => {
		const user = userEvent.setup();
		status = {
			staged: [{ path: "merge.go", status: "U" }],
			unstaged: [{ path: "merge.go", status: "U" }],
			conflicted: ["merge.go"],
			operation: { kind: "merge" },
		};
		const { navigation } = renderDrawer(null);

		await user.click(
			screen.getByRole("button", { name: "Review merge.go, conflicted" }),
		);
		expect(navigation.onSelectFile).toHaveBeenCalledWith("merge.go", false);
	});

	it("lists nothing for a clean tree, which the door already says", () => {
		changeCount = 0;
		status = modified();
		renderDrawer(null);

		expect(screen.queryByRole("list", { name: "Changed files" })).toBeNull();
		expect(screen.queryByText("Changes unavailable")).toBeNull();
	});

	// Left blank, a failed read would look like a clean tree that forgot to
	// say so.
	it("says a failed read while nothing is known", () => {
		changeCount = undefined;
		statusError = new Error("git status failed");
		renderDrawer(null);

		expect(screen.getByText("Changes unavailable")).toBeInTheDocument();
		expect(screen.queryByRole("list", { name: "Changed files" })).toBeNull();
	});

	it("keeps the files known through a failed refresh", () => {
		statusError = new Error("git status failed");
		status = modified("a.ts");
		renderDrawer(null);

		expect(listedPaths()).toEqual(["a.ts"]);
		expect(screen.queryByText("Changes unavailable")).toBeNull();
	});

	describe("the cap", () => {
		const paths = paths7();

		it("shows five and offers the rest, which take the focus once shown", async () => {
			const user = userEvent.setup();
			status = modified(...paths);
			renderDrawer(null);

			expect(listedPaths()).toEqual(paths.slice(0, 5));
			await user.click(
				screen.getByRole("button", { name: "Show all 7 files" }),
			);

			expect(listedPaths()).toEqual(paths);
			expect(screen.getByRole("button", { name: "Review f.ts" })).toHaveFocus();
			expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
		});

		// A button standing in for a single row would save nothing.
		it("draws a sixth file rather than a button in its place", () => {
			status = modified(...paths.slice(0, 6));
			renderDrawer(null);

			expect(listedPaths()).toEqual(paths.slice(0, 6));
			expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
		});

		it("starts over each time the drawer opens", async () => {
			const user = userEvent.setup();
			status = modified(...paths);
			const { setOpen } = renderDrawer(null);
			await user.click(
				screen.getByRole("button", { name: "Show all 7 files" }),
			);

			setOpen(false);
			setOpen(true);

			expect(listedPaths()).toEqual(paths.slice(0, 5));
		});

		it("shows them all when the file under review is past it", () => {
			status = modified(...paths);
			renderDrawer({ type: "diff", path: "g.ts", staged: false });

			expect(listedPaths()).toEqual(paths);
			expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
		});

		// Only the drawer closing starts it over: a look at another tab is
		// still the same visit.
		it("stays shown across a switch to another tab and back", async () => {
			const user = userEvent.setup();
			status = modified(...paths);
			const { refresh } = renderDrawer(null);
			await user.click(
				screen.getByRole("button", { name: "Show all 7 files" }),
			);

			tabActive = false;
			refresh();
			tabActive = true;
			refresh();

			expect(listedPaths()).toEqual(paths);
		});
	});

	describe("the file under review", () => {
		// One thing lit in the tab: the review is the file, not the list.
		it("is lit in place of the Changes door", () => {
			status = modified("a.ts", "b.ts");
			renderDrawer({ type: "diff", path: "b.ts", staged: false });

			expect(
				screen.getByRole("button", { name: "Review b.ts" }),
			).toHaveAttribute("aria-current", "true");
			expect(
				screen.getByRole("button", { name: /^Changes/ }),
			).not.toHaveAttribute("aria-current");
		});

		it("is brought into view each time the drawer opens on the tab", () => {
			status = modified(...paths7());
			const { setOpen } = renderDrawer(
				{ type: "diff", path: "g.ts", staged: false },
				{ isOpen: false },
			);
			expect(revealed).toEqual([]);

			setOpen(true);
			expect(revealed).toEqual(["Review g.ts"]);

			setOpen(false);
			setOpen(true);
			expect(revealed).toEqual(["Review g.ts", "Review g.ts"]);
		});

		it("is brought into view when the tab is switched to", () => {
			status = modified(...paths7());
			tabActive = false;
			const { refresh } = renderDrawer({
				type: "diff",
				path: "g.ts",
				staged: false,
			});
			expect(revealed).toEqual([]);

			tabActive = true;
			refresh();
			expect(revealed).toEqual(["Review g.ts"]);
		});

		it("waits for a status still on its way", () => {
			const { refresh } = renderDrawer({
				type: "diff",
				path: "g.ts",
				staged: false,
			});
			expect(revealed).toEqual([]);

			status = modified(...paths7());
			refresh();
			expect(revealed).toEqual(["Review g.ts"]);
		});

		// Pressing it only closes the drawer; it must not flip the review back
		// to the unstaged side.
		it("is opened again on the side being read", async () => {
			const user = userEvent.setup();
			status = {
				staged: [{ path: "a.ts", status: "M" }],
				unstaged: [{ path: "a.ts", status: "M" }],
			};
			const { navigation } = renderDrawer({
				type: "diff",
				path: "a.ts",
				staged: true,
			});

			await user.click(screen.getByRole("button", { name: "Review a.ts" }));
			expect(navigation.onSelectFile).toHaveBeenCalledWith("a.ts", true);
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

describe("GitTab at expanded", () => {
	// The tab is the workspace's list, its writes included; the doors and the
	// read-only overview would only repeat the bar over it.
	it("is the workspace's list, with the bar and the whole banner over it", () => {
		renderExpanded(null);
		expect(screen.getByText("branch bar")).toBeInTheDocument();
		expect(screen.getByText("whole banner")).toBeInTheDocument();
		expect(screen.getByText("changes list, lit none")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Changes, 5 changed files" }),
		).toBeNull();
	});

	it("stands at the route's list and lights what the main area has open", () => {
		const { route } = renderExpanded({
			type: "diff",
			path: "src/a.ts",
			staged: false,
		});
		expect(screen.getByText("changes list, lit src/a.ts")).toBeInTheDocument();

		route({ type: "commit-file", hash: "abc1234", path: "src/a.ts" });
		expect(screen.getByText("history list, lit abc1234")).toBeInTheDocument();

		route({
			type: "commit",
			hash: "abc1234",
			branch: { ref: "topic", remote: false },
		});
		expect(
			screen.getByText("branches list, lit abc1234 local:topic"),
		).toBeInTheDocument();
	});

	// A session or a file opened from elsewhere is not a reason to lose the
	// reader's place in the list beside it.
	it("stays at the list it was left at once the route names no Git layer", () => {
		const { route } = renderExpanded({
			type: "git",
			segment: "history",
			history: { scope: "current", q: "fix" },
		});
		route(null);
		expect(
			screen.getByText("history list matching fix, lit none"),
		).toBeInTheDocument();
	});

	describe("turning to another segment", () => {
		// The segment is the sidebar's: whatever the main area has open stays.
		it.each<[string, GitLayer | null]>([
			["a review", { type: "diff", path: "src/a.ts", staged: false }],
			["a commit", { type: "commit", hash: "abc1234" }],
			["no Git layer", null],
		])("leaves %s in the main area", async (_, layer) => {
			const user = userEvent.setup();
			const { navigation } = renderExpanded(layer);

			await user.click(
				screen.getByRole("button", { name: "segment branches" }),
			);
			expect(screen.getByText(/^branches list/)).toBeInTheDocument();
			expect(navigation.onSelectSegment).not.toHaveBeenCalled();
		});

		// With only the list on screen the URL names it, so Back walks the
		// segments and a reload lands on the one turned to.
		it("moves the list URL along while it is the route", async () => {
			const user = userEvent.setup();
			const { navigation } = renderExpanded({
				type: "git",
				segment: "changes",
			});

			await user.click(screen.getByRole("button", { name: "segment history" }));
			expect(navigation.onSelectSegment).toHaveBeenCalledWith("history");
			expect(screen.getByText("history list, lit none")).toBeInTheDocument();
		});

		it("keeps the segment while the detail beside it moves on", async () => {
			const user = userEvent.setup();
			const { route } = renderExpanded({
				type: "diff",
				path: "src/a.ts",
				staged: false,
			});
			await user.click(screen.getByRole("button", { name: "segment history" }));

			route({ type: "diff", path: "src/b.ts", staged: false });
			expect(screen.getByText(/^history list/)).toBeInTheDocument();
			// Back to the chat from the review is not a new place either.
			route({ type: "git", segment: "changes" });
			expect(screen.getByText(/^history list/)).toBeInTheDocument();
		});

		// A search beside a review is the sidebar's too; one on a History
		// layer stays in the URL, which names that list.
		it("keeps History's query in the tab beside a detail of another list", async () => {
			const user = userEvent.setup();
			const { route } = renderExpanded({
				type: "diff",
				path: "src/a.ts",
				staged: false,
			});
			await user.click(screen.getByRole("button", { name: "segment history" }));
			await user.click(
				screen.getByRole("button", { name: "search fix in place" }),
			);
			expect(
				screen.getByText(/^history list matching fix/),
			).toBeInTheDocument();

			// A commit of the default History arrives at that list, whose
			// query the URL carries from then on.
			route({ type: "commit", hash: "abc1234" });
			expect(screen.getByText("history list, lit abc1234")).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "search fix in place" }),
			).toBeNull();
		});

		it("turns to a file's history in the tab beside a review", async () => {
			const user = userEvent.setup();
			const { navigation } = renderExpanded({
				type: "diff",
				path: "src/a.ts",
				staged: false,
			});
			await user.click(
				screen.getByRole("button", { name: "history of src/a.ts in place" }),
			);
			expect(
				screen.getByText(/^history list of src\/a.ts/),
			).toBeInTheDocument();
			expect(navigation.onSelectSegment).not.toHaveBeenCalled();
		});

		// Beside a commit of the unfiltered History, the filter is the tab's,
		// and a commit picked from the filtered list carries the filter.
		it("opens a commit carrying the filter held in the tab", async () => {
			const user = userEvent.setup();
			const { navigation } = renderExpanded({
				type: "commit",
				hash: "abc1234",
			});
			await user.click(screen.getByRole("button", { name: "segment changes" }));
			await user.click(
				screen.getByRole("button", { name: "history of src/a.ts in place" }),
			);
			// Not the route's to carry: written there it would be the commit's.
			expect(
				screen.getByRole("button", { name: "search fix in place" }),
			).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "open commit" }));
			expect(navigation.onSelectCommit).toHaveBeenCalledWith("abc1234", {
				history: { scope: "current", file: "src/a.ts" },
			});
		});

		// Back to the chat names the review's list, and a review opened from
		// the chat then names it again: arriving, it turns the tab to its row.
		it("turns back to a detail's list when one is opened from its list URL", async () => {
			const user = userEvent.setup();
			const { route } = renderExpanded({
				type: "diff",
				path: "src/a.ts",
				staged: false,
			});
			await user.click(screen.getByRole("button", { name: "segment history" }));
			route({ type: "git", segment: "changes" });
			expect(screen.getByText(/^history list/)).toBeInTheDocument();

			route({ type: "diff", path: "src/b.ts", staged: false });
			expect(
				screen.getByText("changes list, lit src/b.ts"),
			).toBeInTheDocument();
		});

		// With only the list on screen there is nothing to keep, and the URL
		// names the list: the lists write it as the page's do.
		it("leaves the URL to the lists while the route is the bare list", () => {
			renderExpanded({ type: "git", segment: "changes" });
			expect(
				screen.queryByRole("button", { name: "history of src/a.ts in place" }),
			).toBeNull();
			expect(
				screen.queryByRole("button", { name: "search fix in place" }),
			).toBeNull();
		});

		it("comes back to the route's own list at the route's query", async () => {
			const user = userEvent.setup();
			renderExpanded({
				type: "commit",
				hash: "abc1234",
				history: { scope: "current", q: "fix" },
			});
			await user.click(
				screen.getByRole("button", { name: "segment branches" }),
			);
			await user.click(screen.getByRole("button", { name: "segment history" }));
			expect(
				screen.getByText("history list matching fix, lit abc1234"),
			).toBeInTheDocument();
		});

		it("follows the route again once it opens something in another list", async () => {
			const user = userEvent.setup();
			const { navigation, route } = renderExpanded({
				type: "diff",
				path: "src/a.ts",
				staged: false,
			});
			await user.click(screen.getByRole("button", { name: "segment history" }));

			route({ type: "branch", ref: "topic", remote: false });
			expect(
				screen.getByText("branches list, lit local:topic"),
			).toBeInTheDocument();

			// A commit picked from the list turned to carries that list.
			await user.click(screen.getByRole("button", { name: "segment history" }));
			await user.click(screen.getByRole("button", { name: "open commit" }));
			expect(navigation.onSelectCommit).toHaveBeenCalledWith("abc1234", {
				history: { scope: "current" },
			});
		});
	});

	// The detail beside it pins its own failures whenever the list cannot.
	it("says whether the list is on screen", () => {
		const { onListShownChange, collapse } = renderExpanded(null);
		expect(onListShownChange).toHaveBeenLastCalledWith(true);

		collapse();
		expect(onListShownChange).toHaveBeenLastCalledWith(false);
	});

	it("opens a commit carrying the list it was picked from", async () => {
		const user = userEvent.setup();
		const { navigation, route } = renderExpanded({
			type: "git",
			segment: "history",
			history: { scope: "current", q: "fix" },
		});
		route(null);

		await user.click(screen.getByRole("button", { name: "open commit" }));
		expect(navigation.onSelectCommit).toHaveBeenCalledWith("abc1234", {
			history: { scope: "current", q: "fix" },
		});
	});

	describe("bringing the lit row into view", () => {
		const commit: GitLayer = { type: "commit", hash: "abc1234" };
		const revealButton = () =>
			screen.queryByRole("button", { name: "reveal lit row" });
		/** What the list does once it has scrolled to the row. */
		const revealed = () => act(() => revealButton()?.click());

		it("asks for it when a link opens with a detail", () => {
			renderExpanded(commit);
			expect(revealButton()).toBeInTheDocument();

			revealed();
			expect(revealButton()).toBeNull();
		});

		it("asks for it when a detail is opened from outside the list", () => {
			const { route } = renderExpanded(null);
			expect(revealButton()).toBeNull();

			route({ type: "diff", path: "src/a.ts", staged: false });
			expect(revealButton()).toBeInTheDocument();
			revealed();

			// The detail stepping on to the next file moves the lit row.
			route({ type: "diff", path: "src/b.ts", staged: false });
			expect(revealButton()).toBeInTheDocument();
		});

		it("does not ask for a row the user just pressed in the list", async () => {
			const user = userEvent.setup();
			const { route } = renderExpanded({ type: "git", segment: "history" });

			await user.click(screen.getByRole("button", { name: "open commit" }));
			route(commit);
			expect(revealButton()).toBeNull();
		});

		it("drops a request still waiting once the user reaches for the list", () => {
			renderExpanded(commit);
			act(() => {
				screen
					.getByText(/history list/)
					.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
			});
			expect(revealButton()).toBeNull();
		});

		// Hidden, the list loses its scroll position; it asks once it can act.
		it("holds the request while the list is off screen, and asks again when it comes back", () => {
			const { setOpen } = renderExpanded(null, { isOpen: false });
			setOpen(commit, false);
			expect(revealButton()).toBeNull();

			setOpen(commit, true);
			expect(revealButton()).toBeInTheDocument();
			revealed();

			setOpen(commit, false);
			setOpen(commit, true);
			expect(revealButton()).toBeInTheDocument();
		});

		it("asks for nothing while no row is lit", () => {
			const { setOpen } = renderExpanded(null);
			setOpen(null, false);
			setOpen(null, true);
			expect(revealButton()).toBeNull();
		});
	});
});
