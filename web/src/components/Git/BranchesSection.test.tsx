import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { gitCheckoutActions } from "../../lib/gitCheckoutStore";
import {
	makeBranch,
	makeBranches,
	makeHead,
	makeRemoteBranch,
} from "../../test/gitFixtures";
import type { GitBranches, GitStatus } from "../../types/git";
import BranchesSection from "./BranchesSection";

const checkout = vi.fn();
const createBranch = vi.fn();
const deleteBranch = vi.fn();
const inspectBranch = vi.fn();
let branches: GitBranches | undefined;
let error: Error | null;
let status: GitStatus | undefined;

vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error }),
	useGitBranchActions: () => ({
		checkoutMutation: { mutateAsync: checkout },
		createMutation: { mutateAsync: createBranch },
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

// The workspace's (hooks/useBranchMergeHandoff.ts), handed in.
const startMerge = vi.fn<(rowKey: string, text: string) => void>();
const dismissHandoffError = vi.fn();
let mergeHandoff: BranchMergeHandoff;

const selectBranch = vi.fn();
const branchDeleted = vi.fn();
let activeKey: string | null;

const Section = () => (
	<BranchesSection
		mergeHandoff={mergeHandoff}
		activeKey={activeKey}
		onSelectBranch={selectBranch}
		onBranchDeleted={branchDeleted}
	/>
);

const BRANCHES: GitBranches = makeBranches({
	local: [makeBranch("main", { current: true }), makeBranch("topic")],
});

/**
 * Against this project's preference for `getByRole`, and deliberately:
 * filtering a role query by accessible name is charged per button on the page
 * and per query, and in this file that has cost whole seconds per query
 * (docs/testing.md#a-test-that-really-is-slow). What a row is called is held
 * once, by "names each row by its branch"; everything else needs a row, not
 * its name, so it need not pay for one.
 */
const rowFor = (name: string) =>
	screen.getByText(name).closest("button") as HTMLElement;

/** The row's `⋯`, opened. */
async function openMenu(
	user: ReturnType<typeof userEvent.setup>,
	name: string,
) {
	await user.click(
		screen.getByRole("button", { name: `More actions for ${name}` }),
	);
}

/** A switch is an action of the branch's: the row only opens it. */
async function switchVia(
	user: ReturnType<typeof userEvent.setup>,
	name: string,
) {
	await openMenu(user, name);
	await user.click(
		screen.getByRole("button", { name: /^Switch to this branch/ }),
	);
}

beforeEach(() => {
	gitCheckoutActions.reset();
	branches = BRANCHES;
	error = null;
	status = undefined;
	checkout.mockReset();
	createBranch.mockReset();
	deleteBranch.mockReset();
	inspectBranch.mockReset();
	startMerge.mockReset();
	dismissHandoffError.mockReset();
	selectBranch.mockReset();
	branchDeleted.mockReset();
	activeKey = null;
	mergeHandoff = {
		handingOff: null,
		error: null,
		dismissError: dismissHandoffError,
		start: startMerge,
	};
});

describe("BranchesSection", () => {
	// A switch would carry the operation's state onto another branch; the
	// reason is pinned where a refused switch's would go.
	it("pauses switching and New branch during an operation, and says why", async () => {
		const user = userEvent.setup();
		status = { staged: [], unstaged: [], operation: { kind: "rebase" } };
		render(<Section />);

		const reason =
			"Branch switching is paused during the rebase. Abort it, or let the agent finish it.";
		expect(screen.getByText(reason)).toBeInTheDocument();
		const create = screen.getByText(/New branch/).closest("button");
		expect(create).toBeDisabled();
		expect(create).toHaveAccessibleDescription(reason);
		// Reading a branch writes nothing, so its row stays open to press.
		expect(rowFor("topic")).toBeEnabled();

		await openMenu(user, "topic");
		const item = screen.getByRole("button", { name: /^Switch to this branch/ });
		expect(item).toHaveTextContent(
			"Branch switching is paused during the rebase.",
		);
		await user.click(item);
		expect(checkout).not.toHaveBeenCalled();
	});

	// On a phone a stray tap while scrolling used to move HEAD.
	it("opens a branch from its row, never switching to it", async () => {
		const user = userEvent.setup();
		render(<Section />);

		await user.click(rowFor("topic"));

		expect(selectBranch).toHaveBeenCalledWith(
			expect.objectContaining({ key: "local:topic" }),
		);
		expect(checkout).not.toHaveBeenCalled();
	});

	it("lights the row whose branch is open beside it", () => {
		activeKey = "local:topic";
		render(<Section />);

		expect(rowFor("topic")).toHaveAttribute("aria-current", "true");
		expect(rowFor("main")).not.toHaveAttribute("aria-current");
	});

	// A page has no sheet to close on success; the switch shows itself in the
	// list and the top bar instead.
	it("stays on the list after a switch", async () => {
		const user = userEvent.setup();
		checkout.mockResolvedValue(undefined);
		render(<Section />);

		await switchVia(user, "topic");

		expect(checkout).toHaveBeenCalledWith("topic");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(rowFor("topic")).toBeInTheDocument();
	});

	// Closing the sheet used to be what put a refusal away; a page needs a
	// control of its own for it.
	it("puts a refusal away with its own dismiss", async () => {
		const user = userEvent.setup();
		checkout.mockRejectedValue(new Error("error: would be overwritten"));
		render(<Section />);

		await switchVia(user, "topic");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not switch to topic.",
		);

		await user.click(screen.getByRole("button", { name: "Dismiss error" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	// The sheet holds a typed name: it stays, and only Create stops.
	it("keeps an open New branch sheet when an operation begins", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<Section />);
		await user.click(screen.getByText(/New branch/));
		await user.type(screen.getByRole("textbox", { name: "Name" }), "side");

		status = { staged: [], unstaged: [], operation: { kind: "merge" } };
		rerender(<Section />);

		expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("side");
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Create" }),
		).toHaveAccessibleDescription(
			"Branch switching is paused during the merge. Abort it, or let the agent finish it.",
		);
	});

	it("holds New branch while a switch is running", async () => {
		const user = userEvent.setup();
		checkout.mockReturnValue(new Promise(() => {}));
		render(<Section />);

		await switchVia(user, "topic");

		expect(screen.getByText(/New branch/).closest("button")).toBeDisabled();
		expect(
			screen.getByRole("status", { name: "Switching to topic" }),
		).toBeInTheDocument();
	});

	it("creates a branch from the sheet and comes back to the list", async () => {
		const user = userEvent.setup();
		createBranch.mockResolvedValue(undefined);
		render(<Section />);

		await user.click(screen.getByText(/New branch/));
		await user.type(screen.getByRole("textbox"), "feature/x{Enter}");

		expect(createBranch).toHaveBeenCalledWith({ name: "feature/x" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(rowFor("topic")).toBeInTheDocument();
	});

	it("says why there is no list when the branches cannot be read", () => {
		branches = undefined;
		error = new Error("fatal: not a git repository");
		render(<Section />);

		expect(screen.getByText("Failed to load branches")).toBeInTheDocument();
		expect(screen.getByText("fatal: not a git repository")).toBeInTheDocument();
		// Nothing to fork a new branch from.
		expect(screen.queryByText(/New branch/)).toBeNull();
	});
});

// The rows the list itself tells apart: current, free, held by another
// worktree, and remote-only.
const LIST: GitBranches = makeBranches({
	local: [
		makeBranch("main", { current: true }),
		makeBranch("topic"),
		makeBranch("review", { worktree: "review-wt" }),
	],
	remote_only: [makeRemoteBranch("colleague")],
});

// A page can be walked away from mid-switch, where a sheet that would not
// close could not; the switch has to be where the user left it.
describe("BranchesSection after leaving mid-switch", () => {
	function startSwitch() {
		let settle!: (error?: Error) => void;
		checkout.mockReturnValueOnce(
			new Promise<void>((resolve, reject) => {
				settle = (error) => (error ? reject(error) : resolve());
			}),
		);
		return { settle: (error?: Error) => act(async () => settle(error)) };
	}

	it("is still switching when it is come back to", async () => {
		const user = userEvent.setup();
		const { settle } = startSwitch();
		const { unmount } = render(<Section />);
		await switchVia(user, "topic");

		unmount();
		render(<Section />);

		const create = () => screen.getByText(/New branch/).closest("button");
		expect(create()).toBeDisabled();
		expect(
			screen.getByRole("status", { name: "Switching to topic" }),
		).toBeInTheDocument();

		await settle();
		expect(create()).toBeEnabled();
	});

	// The failure settled with the segment off screen (the top bar reported
	// it meanwhile); back here, it is pinned above the rows again.
	it("pins a failure that settled while it was away", async () => {
		const user = userEvent.setup();
		const { settle } = startSwitch();
		const { unmount } = render(<Section />);
		await switchVia(user, "topic");

		unmount();
		await settle(new Error("fatal: boom"));
		render(<Section />);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not switch to topic.",
		);
	});

	it("puts the last failure away when the next switch starts", async () => {
		const user = userEvent.setup();
		checkout.mockRejectedValueOnce(new Error("fatal: boom"));
		render(<Section />);
		await switchVia(user, "topic");
		await screen.findByRole("alert");

		startSwitch();
		await switchVia(user, "topic");

		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("BranchList", () => {
	beforeEach(() => {
		branches = LIST;
	});

	// A row's hint ("current", "in <worktree>") trails the branch in its name,
	// so what is pinned is the branch leading it.
	it("names each row by its branch", () => {
		render(<Section />);

		expect(screen.getByRole("button", { name: /^topic/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^review/ })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^origin\/colleague/ }),
		).toBeInTheDocument();
	});

	// The state word says it on the row; the switch says why it cannot run.
	it("names the worktree holding a branch, and switches to it from nowhere", async () => {
		const user = userEvent.setup();
		render(<Section />);

		const row = rowFor("review");
		expect(row).toBeEnabled();
		expect(row).toHaveTextContent("in review-wt");

		await openMenu(user, "review");
		const item = screen.getByRole("button", { name: /^Switch to this branch/ });
		expect(item).toHaveTextContent("Checked out in review-wt.");
		await user.click(item);
		expect(checkout).not.toHaveBeenCalled();
	});

	it("says each row's standing against the default branch and its age", () => {
		const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
		branches = {
			...LIST,
			local: [
				makeBranch("main", { current: true }),
				makeBranch("topic", {
					committed_at: twoDaysAgo,
					vs_default: { ahead: 3, behind: 0 },
				}),
			],
		};
		render(<Section />);

		expect(screen.getByText("Compared with main")).toBeInTheDocument();
		expect(rowFor("topic")).toHaveTextContent("3 ahead");
		expect(rowFor("topic")).toHaveTextContent("2d ago");
		expect(rowFor("topic")).not.toHaveTextContent("behind");
		// One state word per row: being current says more than being the default.
		expect(rowFor("main")).toHaveTextContent("current");
		expect(rowFor("main")).not.toHaveTextContent("default");
	});

	it("checks out a remote-only branch by its local name", async () => {
		const user = userEvent.setup();
		checkout.mockResolvedValue(undefined);
		render(<Section />);

		await switchVia(user, "origin/colleague");

		expect(checkout).toHaveBeenCalledWith("colleague");
	});

	// The way out of a long list does not scroll away with it.
	describe("with more branches than fit on screen", () => {
		// The smallest list the component itself calls "more than fits": jsdom has
		// no layout, so its filter threshold is the only thing here a row count
		// can change, and that threshold counts remote branches too — `branches`
		// already carries one, so eight local rows are what crosses it. Rows past
		// that buy nothing but render time. Raising the threshold and not this
		// count turns "pins the filter above the rows" red, which is the right
		// place to hear about it.
		const many = {
			...LIST,
			local: Array.from({ length: 8 }, (_, i) =>
				makeBranch(`topic/${i}`, { current: i === 0 }),
			),
		};

		it("scrolls the rows and leaves New branch out of it", () => {
			branches = many;
			render(<Section />);

			const scroller = rowFor("topic/7").closest(".overflow-y-auto");
			expect(scroller).not.toBeNull();
			// The footer is the way out when none of these branches are right;
			// inside the scroller it would sit below every row.
			expect(scroller).not.toContainElement(screen.getByText(/New branch/));
		});

		it("groups the rows under Recent, Local and Remote", () => {
			branches = { ...many, recent: ["topic/0", "topic/3"] };
			render(<Section />);

			const headers = ["Recent", "Local", "Remote"].map((t) =>
				screen.getByText(t),
			);
			const [recent, local, remote] = headers.map((h) => h.parentElement);
			// The current branch leads Recent, and a branch is listed once.
			expect(recent?.querySelector("button")).toBe(rowFor("topic/0"));
			expect(recent).toContainElement(rowFor("topic/3"));
			expect(local).toContainElement(rowFor("topic/1"));
			expect(local).not.toContainElement(rowFor("topic/3"));
			expect(remote).toContainElement(rowFor("origin/colleague"));
		});

		it("pins the filter above the rows", () => {
			branches = many;
			render(<Section />);

			expect(
				screen.getByLabelText("Filter branches").closest(".sticky"),
			).not.toBeNull();
		});

		// A refusal that lands off the top of the page is indistinguishable from
		// a row that did nothing, and the user tapped that row from halfway down.
		it("pins a failed switch above the rows", async () => {
			const user = userEvent.setup();
			branches = many;
			checkout.mockRejectedValue(new Error("boom"));
			render(<Section />);

			await switchVia(user, "topic/7");

			const alert = await screen.findByRole("alert");
			expect(alert.closest(".sticky")).not.toBeNull();
		});
	});

	// Uncommitted changes are never stashed, so the user has to be able to read
	// which files got in the way without the page moving on.
	it("keeps git's refusal on screen when a switch fails", async () => {
		const user = userEvent.setup();
		const stderr =
			"error: Your local changes to the following files would be overwritten by checkout:\n\tdocs/git.md";
		checkout.mockRejectedValue(new Error(stderr));
		render(<Section />);

		await switchVia(user, "topic");

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not switch to topic.");
		expect(alert).toHaveTextContent("Commit or discard these changes first.");
		expect(alert).toHaveTextContent("docs/git.md");
	});

	// A refusal is the server's own sentence about a request that never ran, so
	// there is no git output under it — but it also cannot name the row it was
	// about, and in a list taller than the screen that row has scrolled away.
	it("names the branch a refused switch was about", async () => {
		const user = userEvent.setup();
		checkout.mockRejectedValue(
			new JSONRPCErrorException(
				"another git operation is running in this worktree: pull",
				-32001,
				{ operation: "pull" },
			),
		);
		render(<Section />);

		await switchVia(user, "topic");

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Could not switch to topic. This worktree is busy pulling. Try again once it finishes.",
		);
		expect(alert).not.toHaveTextContent("another git operation");
	});
});

describe("deleting a branch", () => {
	const TIP = "9692fc9d0b1e2a3c4d5e6f708192a3b4c5d6e7f8";

	beforeEach(() => {
		branches = makeBranches({
			local: [
				makeBranch("main", { current: true }),
				makeBranch("old-spike"),
				makeBranch("review", { worktree: "review-wt" }),
			],
			remote_only: [makeRemoteBranch("colleague")],
		});
	});

	async function openDelete(name: string) {
		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: `More actions for ${name}` }),
		);
		await user.click(screen.getByRole("button", { name: /^Delete branch/ }));
		return user;
	}

	// The current branch's every action would be unavailable.
	it("offers no menu on the current branch", () => {
		render(<Section />);

		expect(
			screen.getByRole("button", { name: "More actions for old-spike" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "More actions for main" }),
		).toBeNull();
	});

	// Absent, not disabled: deleting a remote branch never applies here.
	it("offers no delete on a remote branch", async () => {
		const user = userEvent.setup();
		render(<Section />);

		await user.click(
			screen.getByRole("button", { name: "More actions for origin/colleague" }),
		);

		expect(
			screen.getByRole("button", { name: /^Ask AI to merge/ }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Delete branch/ })).toBeNull();
	});

	it("asks plainly before deleting a merged branch, then deletes that tip", async () => {
		inspectBranch.mockResolvedValue({
			tip: TIP,
			subject: "Try a new layout",
			unique: 0,
		});
		deleteBranch.mockResolvedValue(undefined);
		render(<Section />);

		const user = await openDelete("old-spike");

		const dialog = await screen.findByRole("dialog", {
			name: "Delete old-spike?",
		});
		expect(dialog).toHaveTextContent("nothing is lost");
		await user.click(screen.getByRole("button", { name: "Delete branch" }));

		expect(inspectBranch).toHaveBeenCalledWith("old-spike");
		expect(deleteBranch).toHaveBeenCalledWith({ name: "old-spike", tip: TIP });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// So that a detail of it, open beside the list, leaves for the list.
		expect(branchDeleted).toHaveBeenCalledWith(
			expect.objectContaining({ key: "local:old-spike" }),
		);
	});

	it("names the commits an unmerged branch takes with it", async () => {
		inspectBranch.mockResolvedValue({
			tip: TIP,
			subject: "Try a new layout",
			unique: 2,
		});
		render(<Section />);

		await openDelete("old-spike");

		const dialog = await screen.findByRole("dialog", {
			name: "Delete old-spike and 2 commits?",
		});
		expect(dialog).toHaveTextContent('Latest: 9692fc9 "Try a new layout"');
		expect(
			screen.getByRole("button", { name: "Delete 2 commits" }),
		).toBeInTheDocument();
	});

	// The menu says why it cannot go.
	it("says why a branch checked out elsewhere cannot be deleted", async () => {
		const user = userEvent.setup();
		render(<Section />);

		await user.click(
			screen.getByRole("button", { name: "More actions for review" }),
		);
		const item = screen.getByRole("button", { name: /^Delete branch/ });
		expect(item).toHaveTextContent("Checked out in review-wt.");
		await user.click(item);
		expect(inspectBranch).not.toHaveBeenCalled();
	});

	it("waits for an operation in progress to finish", async () => {
		const user = userEvent.setup();
		status = { staged: [], unstaged: [], operation: { kind: "merge" } };
		render(<Section />);

		await user.click(
			screen.getByRole("button", { name: "More actions for old-spike" }),
		);
		expect(
			screen.getByRole("button", { name: /^Delete branch/ }),
		).toHaveTextContent("Finish or abort the merge first.");
	});

	// Dismissing the sheet mid-inspect is the user changing their mind.
	it("opens no confirm when the sheet was closed before the cost came back", async () => {
		let answer: (value: unknown) => void = () => {};
		inspectBranch.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		render(<Section />);

		const user = await openDelete("old-spike");
		await user.click(screen.getByRole("button", { name: "Close" }));
		await act(async () => {
			answer({ tip: TIP, subject: "s", unique: 0 });
		});

		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// The list refreshes under an open menu; what it offers follows.
	it("follows the row as the list refreshes under the menu", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<Section />);
		await user.click(
			screen.getByRole("button", { name: "More actions for old-spike" }),
		);

		branches = makeBranches({
			local: [
				makeBranch("main", { current: true }),
				makeBranch("old-spike", { worktree: "review-wt" }),
			],
		});
		rerender(<Section />);
		expect(
			screen.getByRole("button", { name: /^Delete branch/ }),
		).toHaveTextContent("Checked out in review-wt.");

		branches = makeBranches({ local: [makeBranch("main", { current: true })] });
		rerender(<Section />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// The sheet stays: the failure is about what the user just pressed.
	it("keeps the sheet open when the cost cannot be read", async () => {
		inspectBranch.mockRejectedValue(new Error("fatal: bad object"));
		render(<Section />);

		await openDelete("old-spike");

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Could not read what deleting old-spike would lose.",
		);
		expect(
			screen.queryByRole("dialog", { name: /Delete old-spike/ }),
		).toBeNull();
	});

	// git's words are not for the dialog's one-line error, and retrying from
	// it cannot help: the dialog closes and the failure is pinned.
	it("closes the confirm on failure and pins why above the list", async () => {
		inspectBranch.mockResolvedValue({ tip: TIP, subject: "s", unique: 0 });
		deleteBranch.mockRejectedValue(
			new JSONRPCErrorException("changed", -32009),
		);
		render(<Section />);

		const user = await openDelete("old-spike");
		await screen.findByRole("dialog", { name: "Delete old-spike?" });
		await user.click(screen.getByRole("button", { name: "Delete branch" }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"old-spike has changed since. Open its menu again to see what deleting it would lose.",
		);
		expect(alert.closest(".sticky")).not.toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(branchDeleted).not.toHaveBeenCalled();
	});
});

describe("asking the agent to merge", () => {
	const onFeature = (head = makeHead({ branch: "feature/ui" })) =>
		makeBranches({
			head,
			local: [
				makeBranch("feature/ui", { current: !head.detached }),
				makeBranch("old-spike"),
				makeBranch("topic"),
				makeBranch("review", { worktree: "review-wt" }),
			],
		});

	beforeEach(() => {
		branches = onFeature();
	});

	async function openMerge(name: string) {
		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: `More actions for ${name}` }),
		);
		return {
			user,
			item: screen.getByRole("button", { name: /^Ask AI to merge/ }),
		};
	}

	// The workspace never merges: the agent can get through the conflicts a
	// merge stops on.
	it("hands the merge to the agent and closes the menu", async () => {
		render(<Section />);

		const { user, item } = await openMerge("old-spike");
		await user.click(item);

		expect(startMerge).toHaveBeenCalledTimes(1);
		const [key, text] = startMerge.mock.calls[0];
		expect(key).toBe("local:old-spike");
		expect(text).toMatch(
			/^Merge old-spike into feature\/ui, the branch checked out in this worktree\./,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// Merged from, not switched to: the branch is not touched in its worktree.
	it("offers the merge on a branch checked out elsewhere", async () => {
		render(<Section />);

		const { user, item } = await openMerge("review");
		await user.click(item);

		expect(startMerge.mock.calls[0][1]).toMatch(
			/^Merge review into feature\/ui/,
		);
	});

	it("says why there is nothing to merge into while HEAD is detached", async () => {
		branches = onFeature(makeHead({ detached: true }));
		render(<Section />);

		const { user, item } = await openMerge("old-spike");
		expect(item).toHaveTextContent("Switch to a branch to merge into.");
		await user.click(item);
		expect(startMerge).not.toHaveBeenCalled();
	});

	// The prompt names the current branch; a switch now would make it wrong.
	it("holds switching while a new chat is being created for the merge", async () => {
		mergeHandoff = { ...mergeHandoff, handingOff: "local:old-spike" };
		render(<Section />);

		// Reading a branch changes nothing the prompt names.
		expect(rowFor("topic")).toBeEnabled();
		expect(screen.getByText(/New branch/).closest("button")).toBeDisabled();
		expect(
			screen.getByRole("status", { name: "Opening a new chat" }),
		).toBeInTheDocument();

		const { item } = await openMerge("topic");
		expect(item).toHaveTextContent("Wait for the new chat to open.");
		expect(
			screen.getByRole("button", { name: /^Switch to this branch/ }),
		).toHaveTextContent("Wait for the new chat to open.");
	});

	it("waits for a delete of the same branch to finish", async () => {
		const user = userEvent.setup();
		inspectBranch.mockResolvedValue({
			tip: "a".repeat(40),
			subject: "s",
			unique: 0,
		});
		deleteBranch.mockReturnValue(new Promise(() => {}));
		render(<Section />);

		await user.click(
			screen.getByRole("button", { name: "More actions for old-spike" }),
		);
		await user.click(screen.getByRole("button", { name: /^Delete branch/ }));
		await screen.findByRole("dialog", { name: "Delete old-spike?" });
		await user.click(screen.getByRole("button", { name: "Delete branch" }));
		await user.keyboard("{Escape}");

		const { item } = await openMerge("old-spike");
		expect(item).toHaveTextContent("Wait for the branch delete to finish.");
		await user.click(screen.getByRole("button", { name: "Close" }));
		const other = await openMerge("topic");
		expect(other.item).not.toHaveAttribute("aria-disabled");
	});

	it("pins a failed create above the list", async () => {
		const user = userEvent.setup();
		mergeHandoff = {
			...mergeHandoff,
			error: { summary: "Couldn't start a new chat", detail: "boom" },
		};
		render(<Section />);

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("Couldn't start a new chat");
		expect(alert.closest(".sticky")).not.toBeNull();
		await user.click(screen.getByRole("button", { name: "Dismiss error" }));
		expect(dismissHandoffError).toHaveBeenCalled();
	});
});
