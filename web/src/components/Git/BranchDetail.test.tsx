import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import type { GitLogQuery } from "../../hooks/useGitLog";
import { gitCheckoutActions } from "../../lib/gitCheckoutStore";
import {
	makeBranch,
	makeBranches,
	makeRemoteBranch,
} from "../../test/gitFixtures";
import type {
	GitBranches,
	GitCommit,
	GitLogResult,
	GitStatus,
} from "../../types/git";
import type { BranchRef } from "../../types/overlay";
import BranchDetail from "./BranchDetail";
import type { CommitMenuTarget } from "./CommitActions";

const checkout = vi.fn();
const deleteBranch = vi.fn();
const inspectBranch = vi.fn();
let branches: GitBranches | undefined;
let error: Error | null;
let status: GitStatus | undefined;

vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error }),
	useGitBranchActions: () => ({
		checkoutMutation: { mutateAsync: checkout },
		createMutation: { mutateAsync: vi.fn() },
		deleteMutation: { mutateAsync: deleteBranch },
	}),
}));

const wsState = { actions: { inspectBranch } };
vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
}));

vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));

interface LogState {
	pages?: GitLogResult[];
	isLoading?: boolean;
	error?: Error | null;
}
let log: LogState;
const gitLog =
	vi.fn<(query: GitLogQuery, opts?: { enabled?: boolean }) => void>();
vi.mock("../../hooks/useGitLog", () => ({
	useGitLog: (query: GitLogQuery, opts?: { enabled?: boolean }) => {
		gitLog(query, opts);
		return {
			data: log.pages && { pages: log.pages },
			isLoading: log.isLoading ?? false,
			error: log.error ?? null,
			hasNextPage: false,
			isFetching: false,
			isFetchNextPageError: false,
			isRefetchError: false,
			fetchNextPage: vi.fn(),
			refetch: vi.fn(),
		};
	},
}));

// The menu is CommitActions' to test; here only which commit it is opened
// for, and what is known about it.
vi.mock("./CommitActions", () => ({
	default: ({ target }: { target: CommitMenuTarget | null }) =>
		target && (
			<div role="dialog">
				{`Menu for ${target.commit.subject}, in HEAD's history: ${String(target.inHeadHistory)}`}
			</div>
		),
}));

function commit(hash: string, subject: string): GitCommit {
	return {
		hash: hash.padEnd(40, "0"),
		parents: ["f".repeat(40)],
		subject,
		author: "sijiaoh",
		date: new Date().toISOString(),
	};
}

/** The range `git.log` was last asked for, and whether it was asked at all. */
function lastLogAsk() {
	const call = gitLog.mock.calls.at(-1);
	return call && { query: call[0], enabled: call[1]?.enabled ?? true };
}

/** jsdom lays nothing out: give the page's scroll area a phone's screen. */
function layOut() {
	const isScroller = (el: HTMLElement) =>
		el.classList.contains("overflow-y-auto");
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return isScroller(this) ? 600 : 0;
		},
	);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
		function (this: HTMLElement) {
			return isScroller(this) ? 300 : 0;
		},
	);
}

const TIP = "9692fc9d0b1e2a3c4d5e6f708192a3b4c5d6e7f8";
const startMerge = vi.fn<(rowKey: string, text: string) => void>();
const onBack = vi.fn();
const onLeave = vi.fn();
const onRepoint = vi.fn<(to: BranchRef) => void>();
const onBranchDeleted = vi.fn();
const onSelectCommit = vi.fn();
let mergeHandoff: BranchMergeHandoff;

function Detail({
	branch = { ref: "topic", remote: false },
	holdsFailures = true,
}: {
	branch?: BranchRef;
	holdsFailures?: boolean;
}) {
	return (
		<BranchDetail
			branch={branch}
			onBack={onBack}
			onLeave={onLeave}
			holdsFailures={holdsFailures}
			mergeHandoff={mergeHandoff}
			onRepoint={onRepoint}
			onBranchDeleted={onBranchDeleted}
			onSelectCommit={onSelectCommit}
		/>
	);
}

const action = (label: RegExp) => screen.getByRole("button", { name: label });

beforeEach(() => {
	gitCheckoutActions.reset();
	branches = makeBranches({
		local: [
			makeBranch("main", { current: true }),
			makeBranch("topic", {
				committer: "Rebaser",
				upstream: "origin/topic",
				vs_default: { ahead: 3, behind: 12 },
			}),
			makeBranch("review", { worktree: "review-wt" }),
		],
		remote_only: [makeRemoteBranch("colleague")],
	});
	error = null;
	status = undefined;
	log = { pages: [{ commits: [], next: null }] };
	layOut();
	for (const fn of [
		checkout,
		deleteBranch,
		inspectBranch,
		startMerge,
		onBack,
		onLeave,
		onRepoint,
		onBranchDeleted,
		onSelectCommit,
		gitLog,
	]) {
		fn.mockReset();
	}
	mergeHandoff = {
		handingOff: null,
		error: null,
		dismissError: vi.fn(),
		start: startMerge,
	};
});

describe("BranchDetail", () => {
	it("says what the branch is, where it lives and who last moved it", () => {
		render(<Detail />);

		expect(screen.getByText("Tracks origin/topic")).toBeInTheDocument();
		expect(screen.getByText("3 ahead of main · 12 behind")).toBeInTheDocument();
		expect(screen.getByText(/^Last commit .* by Rebaser$/)).toBeInTheDocument();
	});

	// The row has room for one word; the detail says every one that holds.
	it("says every state word of a branch held elsewhere", () => {
		branches = makeBranches({
			local: [
				makeBranch("topic", { current: true }),
				makeBranch("main", { worktree: "main worktree" }),
			],
		});
		render(<Detail branch={{ ref: "main", remote: false }} />);

		expect(screen.getByText("in main worktree · default")).toBeInTheDocument();
		expect(
			screen.getByText(
				"The default branch — other branches are compared with it",
			),
		).toBeInTheDocument();
	});

	it("says what switching to a remote-only branch does, and offers no delete", () => {
		render(<Detail branch={{ ref: "origin/colleague", remote: true }} />);

		expect(
			screen.getByText(
				"Only on origin. Switching to it creates a local colleague that tracks it.",
			),
		).toBeInTheDocument();
		expect(action(/^Switch to this branch/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Delete branch/ })).toBeNull();
	});

	// Every one would be unavailable for the same reason.
	it("offers no actions on the current branch", () => {
		render(<Detail branch={{ ref: "main", remote: false }} />);

		expect(screen.getByText("current · default")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Switch to this branch/ }),
		).toBeNull();
	});

	// Inline, every reason is visible without a press.
	it("says why each action is unavailable", () => {
		render(<Detail branch={{ ref: "review", remote: false }} />);

		expect(action(/^Switch to this branch/)).toHaveTextContent(
			"Checked out in review-wt.",
		);
		expect(action(/^Delete branch/)).toHaveTextContent(
			"Checked out in review-wt.",
		);
		expect(action(/^Ask AI to merge/)).not.toHaveAttribute("aria-disabled");
	});

	// The detail stays: the facts turning to `current` are the report.
	it("switches to the branch and stays", async () => {
		const user = userEvent.setup();
		let settle: () => void = () => {};
		checkout.mockReturnValue(
			new Promise<void>((resolve) => {
				settle = resolve;
			}),
		);
		render(<Detail />);

		await user.click(action(/^Switch to this branch/));

		expect(checkout).toHaveBeenCalledWith("topic");
		expect(action(/^Switch to this branch/)).toHaveAttribute("aria-busy");
		await act(async () => settle());
		expect(screen.getByText("Tracks origin/topic")).toBeInTheDocument();
	});

	it("hands the merge to the agent", async () => {
		const user = userEvent.setup();
		render(<Detail />);

		await user.click(action(/^Ask AI to merge/));

		expect(startMerge).toHaveBeenCalledWith(
			"local:topic",
			expect.stringMatching(/^Merge topic into main/),
		);
	});

	it("deletes the branch after asking, then hands the detail back", async () => {
		const user = userEvent.setup();
		inspectBranch.mockResolvedValue({ tip: TIP, subject: "s", unique: 0 });
		let settle: () => void = () => {};
		deleteBranch.mockReturnValue(
			new Promise<void>((resolve) => {
				settle = resolve;
			}),
		);
		const { rerender } = render(<Detail />);

		await user.click(action(/^Delete branch/));
		const dialog = await screen.findByRole("dialog", { name: "Delete topic?" });
		await user.click(
			within(dialog).getByRole("button", { name: "Delete branch" }),
		);
		expect(deleteBranch).toHaveBeenCalledWith({ name: "topic", tip: TIP });

		// The delete refreshes the list before it answers: the row can be gone
		// while it runs, and the page keeps what it had rather than saying the
		// branch does not exist.
		branches = makeBranches({
			local: [makeBranch("main", { current: true })],
		});
		rerender(<Detail />);
		expect(screen.getByText("Tracks origin/topic")).toBeInTheDocument();
		expect(onBranchDeleted).not.toHaveBeenCalled();

		await act(async () => settle());
		await waitFor(() =>
			expect(onBranchDeleted).toHaveBeenCalledWith(
				expect.objectContaining({ key: "local:topic" }),
			),
		);
		// Still the last row until the page is handed back, not a flash of
		// the gone notice once the delete has stopped running.
		expect(screen.getByText("Tracks origin/topic")).toBeInTheDocument();
		expect(screen.queryByText(/No branch named/)).toBeNull();
	});

	// A narrow detail covers the list, so it is the one place they are seen.
	it("pins the branch failures at its top where it holds them", async () => {
		const user = userEvent.setup();
		inspectBranch.mockResolvedValue({ tip: TIP, subject: "s", unique: 0 });
		deleteBranch.mockRejectedValue(new Error("error: cannot lock ref"));
		const { rerender } = render(<Detail />);

		await user.click(action(/^Delete branch/));
		const dialog = await screen.findByRole("dialog", { name: "Delete topic?" });
		await user.click(
			within(dialog).getByRole("button", { name: "Delete branch" }),
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not delete topic.");
		expect(alert.closest(".sticky")).not.toBeNull();
		expect(onBranchDeleted).not.toHaveBeenCalled();

		// Beside the list, the list's pinned area holds them.
		rerender(<Detail holdsFailures={false} />);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows a failure to read the cost above the actions", async () => {
		const user = userEvent.setup();
		inspectBranch.mockRejectedValue(new Error("fatal: bad object"));
		render(<Detail />);

		await user.click(action(/^Delete branch/));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not read what deleting topic would lose.",
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// Gone some other way: said, and left to the user.
	it("says when there is no such branch, and waits to be left", async () => {
		const user = userEvent.setup();
		render(<Detail branch={{ ref: "nope", remote: false }} />);

		const notice = screen.getByText("No branch named nope.");
		expect(onLeave).not.toHaveBeenCalled();

		await user.click(
			within(notice.parentElement as HTMLElement).getByRole("button", {
				name: "Back to branches",
			}),
		);
		expect(onLeave).toHaveBeenCalled();
	});

	// A local branch named like the remote one is another row.
	it("tells a local branch from a remote one of the same name", () => {
		render(<Detail branch={{ ref: "topic", remote: true }} />);

		expect(screen.getByText("No branch named topic.")).toBeInTheDocument();
	});

	it("follows a remote-only branch to the local branch that now tracks it", () => {
		const { rerender } = render(
			<Detail branch={{ ref: "origin/colleague", remote: true }} />,
		);

		branches = makeBranches({
			local: [makeBranch("main"), makeBranch("colleague", { current: true })],
		});
		rerender(<Detail branch={{ ref: "origin/colleague", remote: true }} />);

		expect(onRepoint).toHaveBeenCalledTimes(1);
		expect(onRepoint).toHaveBeenCalledWith({ ref: "colleague", remote: false });
		expect(screen.queryByText(/No branch named/)).toBeNull();
	});

	// Opened after the change — a commit's `Back to branch`, a link — the page
	// never saw the remote row, and finds the local branch by its upstream.
	it("follows a remote-only branch it never saw to the branch tracking it", () => {
		branches = makeBranches({
			local: [
				makeBranch("main"),
				makeBranch("mine", { current: true, upstream: "origin/colleague" }),
			],
		});
		render(<Detail branch={{ ref: "origin/colleague", remote: true }} />);

		expect(onRepoint).toHaveBeenCalledTimes(1);
		expect(onRepoint).toHaveBeenCalledWith({ ref: "mine", remote: false });
		expect(screen.queryByText(/No branch named/)).toBeNull();
	});

	it("goes back to the list it was opened from", async () => {
		const user = userEvent.setup();
		render(<Detail />);

		await user.click(screen.getByRole("button", { name: "Back to branches" }));
		expect(onBack).toHaveBeenCalled();
	});

	it("says why there is nothing to show when the branches cannot be read", () => {
		branches = undefined;
		error = new Error("fatal: not a git repository");
		render(<Detail />);

		expect(screen.getByText("Failed to load branches")).toBeInTheDocument();
	});

	describe("commits not on the default branch", () => {
		it("lists the branch's own range under the default branch's name", async () => {
			const user = userEvent.setup();
			log = {
				pages: [
					{
						commits: [
							commit("a1", "Draw the detail layer"),
							commit("b2", "Add the branch route"),
						],
						next: null,
						// The clone's, not the range's: `main..topic` is still whole.
						shallow: true,
					},
				],
			};
			render(<Detail />);

			expect(lastLogAsk()).toEqual({
				query: { scope: "branch", branch: "topic" },
				enabled: true,
			});
			const section = screen.getByRole("region", { name: "Not on main (3)" });
			expect(
				within(section).getByText("Older commits are on main too"),
			).toBeInTheDocument();

			await user.click(
				within(section).getByRole("button", { name: /Draw the detail layer/ }),
			);
			expect(onSelectCommit).toHaveBeenCalledWith("a1".padEnd(40, "0"));
		});

		// The range is cut wherever it meets the default branch: lanes would
		// run on to commits that are never listed.
		it("draws dots without lines", () => {
			log = {
				pages: [
					{ commits: [commit("a1", "Draw the detail layer")], next: null },
				],
			};
			const { container } = render(<Detail />);

			expect(container.querySelector("section path")).toBeNull();
		});

		// HEAD is a tip of the range only on the current branch.
		it.each([
			[false, "undefined"],
			[true, "true"],
		])("on a branch current: %s, knows HEAD reaches a commit: %s", async (current, known) => {
			const user = userEvent.setup();
			branches = makeBranches({
				local: [
					makeBranch("main", { current: !current }),
					makeBranch("topic", {
						current,
						vs_default: { ahead: 1, behind: 0 },
					}),
				],
			});
			log = { pages: [{ commits: [commit("a1", "Fix it")], next: null }] };
			render(<Detail />);

			await user.click(
				screen.getByRole("button", { name: /^Actions for commit/ }),
			);
			expect(screen.getByRole("dialog")).toHaveTextContent(
				`Menu for Fix it, in HEAD's history: ${known}`,
			);
		});

		it.each([
			[
				"the default branch itself",
				{ ref: "main", remote: false },
				() => {},
				"This is the default branch.",
			],
			[
				"a repository with no default branch",
				{ ref: "topic", remote: false },
				() => {
					branches = { ...(branches as GitBranches), default_branch: "" };
				},
				"No default branch to compare with.",
			],
			[
				"a branch with nothing of its own",
				{ ref: "topic", remote: false },
				() => {
					branches = makeBranches({
						local: [
							makeBranch("main", { current: true }),
							makeBranch("topic", { vs_default: { ahead: 0, behind: 2 } }),
						],
					});
				},
				"Nothing here that main doesn't have.",
			],
			[
				"a remote branch a local one shadows",
				{ ref: "origin/x", remote: true },
				() => {
					branches = makeBranches({
						local: [
							makeBranch("main", { current: true }),
							makeBranch("origin/x"),
						],
						remote_only: [makeRemoteBranch("x")],
					});
				},
				"Can't list these commits: a local branch is also named origin/x.",
			],
		])("asks nothing for %s", (_, branch, arrange, text) => {
			arrange();
			render(<Detail branch={branch} />);

			expect(screen.getByText(text)).toBeInTheDocument();
			expect(lastLogAsk()?.enabled).toBe(false);
		});

		it("says the branch has nothing of its own when the range is empty", () => {
			render(<Detail />);

			expect(
				screen.getByText("Nothing here that main doesn't have."),
			).toBeInTheDocument();
		});

		it("says why the commits could not be read", () => {
			log = { error: new Error("fatal: bad revision") };
			render(<Detail />);

			expect(screen.getByText("Failed to load commits")).toBeInTheDocument();
			expect(screen.getByText("fatal: bad revision")).toBeInTheDocument();
		});

		// `git.log` refuses a branch that is not there: a page kept for a
		// delete still answering must not turn that into a failure.
		it("stops asking once the branch has left the list", async () => {
			const user = userEvent.setup();
			inspectBranch.mockResolvedValue({ tip: TIP, subject: "s", unique: 0 });
			deleteBranch.mockReturnValue(new Promise<void>(() => {}));
			const { rerender } = render(<Detail />);
			await user.click(action(/^Delete branch/));
			const dialog = await screen.findByRole("dialog", {
				name: "Delete topic?",
			});
			await user.click(
				within(dialog).getByRole("button", { name: "Delete branch" }),
			);

			branches = makeBranches({
				local: [makeBranch("main", { current: true })],
			});
			rerender(<Detail />);

			expect(screen.getByText("Tracks origin/topic")).toBeInTheDocument();
			expect(lastLogAsk()?.enabled).toBe(false);
		});

		it("asks for nothing on a branch that is not there", () => {
			render(<Detail branch={{ ref: "nope", remote: false }} />);

			expect(gitLog).not.toHaveBeenCalled();
		});
	});
});
