import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { ROW_HEIGHT } from "../../lib/commitHistory";
import { gitCheckoutActions } from "../../lib/gitCheckoutStore";
import { makeBranch, makeBranches } from "../../test/gitFixtures";
import type { GitBranches, GitCommit } from "../../types/git";
import BranchDetail from "./BranchDetail";

// What jsdom cannot say: that the branch's commits share one scroll area with
// the facts and actions above them — the list starts right under its heading,
// and the virtual list asks for the rows actually on screen, before and after
// what is above it changes height (docs/git-branches-ui.md#the-branch).

let branches: GitBranches;
vi.mock("../../hooks/useGitBranches", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitBranches")>()),
	useGitBranches: () => ({ data: branches, isLoading: false, error: null }),
	useGitBranchActions: () => ({
		checkoutMutation: { mutateAsync: vi.fn() },
		createMutation: { mutateAsync: vi.fn() },
		deleteMutation: { mutateAsync: vi.fn() },
	}),
}));
vi.mock("../../lib/wsStore", async (importOriginal) => {
	const state = { actions: { inspectBranch: vi.fn() } };
	return {
		...(await importOriginal<typeof import("../../lib/wsStore")>()),
		useWSStore: Object.assign(
			(selector: (s: unknown) => unknown) => selector(state),
			{ getState: () => state },
		),
	};
});
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: undefined }),
}));

const COUNT = 300;
const commits: GitCommit[] = Array.from({ length: COUNT }, (_, i) => ({
	hash: `${i}`.padStart(40, "0"),
	parents: [`${i + 1}`.padStart(40, "0")],
	subject: `Commit #${i} done`,
	author: "sijiaoh",
	date: new Date().toISOString(),
}));
vi.mock("../../hooks/useGitLog", () => ({
	useGitLog: () => ({
		data: { pages: [{ commits, next: null }] },
		isLoading: false,
		error: null,
		hasNextPage: false,
		isFetching: false,
		isFetchNextPageError: false,
		isRefetchError: false,
		fetchNextPage: () => {},
		refetch: () => {},
	}),
}));
vi.mock("./CommitActions", () => ({ default: () => null }));

const mergeHandoff: BranchMergeHandoff = {
	handingOff: null,
	error: null,
	dismissError: () => {},
	start: () => {},
};

function listing(topic: Parameters<typeof makeBranch>[1] = {}): GitBranches {
	return makeBranches({
		local: [
			makeBranch("main", { current: true }),
			makeBranch("topic", {
				vs_default: { ahead: COUNT, behind: 0 },
				...topic,
			}),
		],
	});
}

function Detail({ width = 360 }: { width?: number }) {
	return (
		<div className="flex flex-col" style={{ width, height: 640 }}>
			<BranchDetail
				branch={{ ref: "topic", remote: false }}
				onLeave={() => {}}
				holdsFailures={true}
				mergeHandoff={mergeHandoff}
				onRepoint={() => {}}
				onBranchDeleted={() => {}}
				onSelectCommit={() => {}}
			/>
		</div>
	);
}

const heading = () =>
	screen.getByRole("heading", { name: `Not on main (${COUNT})` });
const scroller = () => heading().closest(".overflow-y-auto") as HTMLElement;
const list = () => heading().parentElement?.querySelector("ul") as HTMLElement;

/** The indices of the commits mounted, in order. */
function mounted(): number[] {
	return [...list().querySelectorAll("li")]
		.map((li) => li.textContent?.match(/^Commit #(\d+) /)?.[1])
		.filter((n): n is string => n !== undefined)
		.map(Number);
}

async function scrollTo(top: number) {
	await act(async () => {
		scroller().scrollTop = top;
		scroller().dispatchEvent(new Event("scroll"));
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
}

/**
 * The first commit the reader can see, from where the list is actually drawn:
 * what the virtual list has to have mounted, whatever margin it was given.
 */
function firstOnScreen(): number {
	const top = scroller().getBoundingClientRect().top;
	const listTop = list().getBoundingClientRect().top;
	return Math.floor((top - listTop) / ROW_HEIGHT);
}

function expectScreenMounted() {
	const shown = mounted();
	const first = firstOnScreen();
	const last = first + Math.ceil(scroller().clientHeight / ROW_HEIGHT);
	expect(shown[0]).toBeLessThanOrEqual(first);
	expect(shown.at(-1)).toBeGreaterThanOrEqual(Math.min(last, COUNT - 1));
	// Within the overscan: mounted for this scroll position, not for one a
	// stale margin would put it at.
	expect(first - shown[0]).toBe(Math.min(first, 10));
}

beforeEach(() => {
	branches = listing();
	gitCheckoutActions.reset();
});

describe("BranchDetail's commits", () => {
	it("start right under their heading, in the page's one scroll area", () => {
		render(<Detail />);

		// Each row has a subject per layout; the first is the narrow one's.
		const firstRow = screen
			.getAllByText("Commit #0 done")[0]
			.closest("li") as HTMLElement;
		expect(firstRow.getBoundingClientRect().top).toBeCloseTo(
			heading().getBoundingClientRect().bottom,
			0,
		);
		// The facts scroll with the commits: the page has no second scroller.
		expect(list().closest(".overflow-y-auto")).toBe(scroller());
		expect(scroller().scrollHeight).toBeGreaterThan(COUNT * ROW_HEIGHT);
	});

	it("mounts the rows on screen deep in the list, and the end row at the end", async () => {
		render(<Detail />);

		await scrollTo(150 * ROW_HEIGHT + 20);
		expectScreenMounted();

		await scrollTo(scroller().scrollHeight);
		expect(screen.getByText("Older commits are on main too")).toBeVisible();
	});

	// A margin measured once would leave the virtual list counting from where
	// the list used to start.
	it("follows what is above the list as it changes height", async () => {
		const { rerender } = render(<Detail />);
		await scrollTo(150 * ROW_HEIGHT + 20);
		const before = list().getBoundingClientRect().top + scroller().scrollTop;

		// Held elsewhere — a state word, and a reason under two actions — and
		// a switch to it failed, pinned at the top with git's words.
		branches = listing({ worktree: "review-wt" });
		rerender(<Detail />);
		await act(() =>
			gitCheckoutActions.start("", "topic", () =>
				Promise.reject(
					new Error(
						"error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\n\tsrc/b.ts\nPlease commit your changes or stash them before you switch branches.\nAborting",
					),
				),
			),
		);
		await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

		const after = list().getBoundingClientRect().top + scroller().scrollTop;
		expect(after - before).toBeGreaterThan(ROW_HEIGHT);
		await scrollTo(scroller().scrollTop + 1);
		expectScreenMounted();
	});

	describe("in a wide window", () => {
		beforeEach(async () => {
			await page.viewport(1280, 800);
		});
		afterEach(async () => {
			await page.viewport(414, 896);
		});

		// The full hash is the wide layout's column; the narrow one shows only
		// the short one, on the second line.
		const wideHash = () =>
			screen
				.getAllByTitle(commits[0].hash)
				.filter((el) => el.getClientRects().length > 0);

		// Well either side of the threshold: the page's scroll bar, where it
		// takes room, comes out of the list's width.
		it("lays the commits out by the detail's width, not the window's", () => {
			const { unmount } = render(<Detail width={700} />);
			expect(wideHash()).toHaveLength(0);
			unmount();

			render(<Detail width={900} />);
			expect(wideHash()).toHaveLength(1);
		});
	});
});
