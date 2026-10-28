import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitCheckoutActions } from "../../lib/gitCheckoutStore";
import { makeHead, makeSync } from "../../test/gitFixtures";
import type { GitBranches, GitStatus } from "../../types/git";
import BranchesSection from "./BranchesSection";

const checkout = vi.fn();
const createBranch = vi.fn();
let branches: GitBranches | undefined;
let error: Error | null;
let status: GitStatus | undefined;

vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error }),
	useGitBranchActions: () => ({
		checkoutMutation: { mutateAsync: checkout },
		createMutation: { mutateAsync: createBranch },
	}),
}));

vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));

const BRANCHES: GitBranches = {
	head: makeHead(),
	local: [
		{ name: "main", current: true },
		{ name: "topic", current: false },
	],
	remote_only: [],
	sync: makeSync(),
};

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

beforeEach(() => {
	gitCheckoutActions.reset();
	branches = BRANCHES;
	error = null;
	status = undefined;
	checkout.mockReset();
	createBranch.mockReset();
});

describe("BranchesSection", () => {
	// A switch would carry the operation's state onto another branch; the
	// reason is pinned where a refused switch's would go.
	it("pauses switching and New branch during an operation, and says why", () => {
		status = { staged: [], unstaged: [], operation: { kind: "rebase" } };
		render(<BranchesSection />);

		const reason =
			"Branch switching is paused during the rebase. Abort it, or let the agent finish it.";
		expect(screen.getByText(reason)).toBeInTheDocument();
		expect(rowFor("topic")).toBeDisabled();
		const create = screen.getByText(/New branch/).closest("button");
		expect(create).toBeDisabled();
		expect(create).toHaveAccessibleDescription(reason);
	});

	// A page has no sheet to close on success; the switch shows itself in the
	// list and the top bar instead.
	it("stays on the list after a switch", async () => {
		const user = userEvent.setup();
		checkout.mockResolvedValue(undefined);
		render(<BranchesSection />);

		await user.click(rowFor("topic"));

		expect(checkout).toHaveBeenCalledWith("topic");
		expect(rowFor("topic")).toBeInTheDocument();
	});

	// Closing the sheet used to be what put a refusal away; a page needs a
	// control of its own for it.
	it("puts a refusal away with its own dismiss", async () => {
		const user = userEvent.setup();
		checkout.mockRejectedValue(new Error("error: would be overwritten"));
		render(<BranchesSection />);

		await user.click(rowFor("topic"));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not switch to topic.",
		);

		await user.click(screen.getByRole("button", { name: "Dismiss error" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	// The sheet holds a typed name: it stays, and only Create stops.
	it("keeps an open New branch sheet when an operation begins", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<BranchesSection />);
		await user.click(screen.getByText(/New branch/));
		await user.type(screen.getByRole("textbox", { name: "Name" }), "side");

		status = { staged: [], unstaged: [], operation: { kind: "merge" } };
		rerender(<BranchesSection />);

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
		render(<BranchesSection />);

		await user.click(rowFor("topic"));

		expect(screen.getByText(/New branch/).closest("button")).toBeDisabled();
	});

	it("creates a branch from the sheet and comes back to the list", async () => {
		const user = userEvent.setup();
		createBranch.mockResolvedValue(undefined);
		render(<BranchesSection />);

		await user.click(screen.getByText(/New branch/));
		await user.type(screen.getByRole("textbox"), "feature/x{Enter}");

		expect(createBranch).toHaveBeenCalledWith({ name: "feature/x" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(rowFor("topic")).toBeInTheDocument();
	});

	it("says why there is no list when the branches cannot be read", () => {
		branches = undefined;
		error = new Error("fatal: not a git repository");
		render(<BranchesSection />);

		expect(screen.getByText("Failed to load branches")).toBeInTheDocument();
		expect(screen.getByText("fatal: not a git repository")).toBeInTheDocument();
		// Nothing to fork a new branch from.
		expect(screen.queryByText(/New branch/)).toBeNull();
	});
});

// The rows the list itself tells apart: current, free, held by another
// worktree, and remote-only.
const LIST: GitBranches = {
	head: makeHead(),
	local: [
		{ name: "main", current: true },
		{ name: "topic", current: false },
		{ name: "review", current: false, worktree: "review-wt" },
	],
	remote_only: [{ ref: "origin/colleague", name: "colleague" }],
	sync: makeSync(),
};

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
		const { unmount } = render(<BranchesSection />);
		await user.click(rowFor("topic"));

		unmount();
		render(<BranchesSection />);

		expect(rowFor("topic")).toBeDisabled();
		expect(rowFor("main")).toBeDisabled();
		expect(screen.getByText(/New branch/).closest("button")).toBeDisabled();

		await settle();
		expect(rowFor("topic")).toBeEnabled();
	});

	// The failure settled with the segment off screen (the top bar reported
	// it meanwhile); back here, it is pinned above the rows again.
	it("pins a failure that settled while it was away", async () => {
		const user = userEvent.setup();
		const { settle } = startSwitch();
		const { unmount } = render(<BranchesSection />);
		await user.click(rowFor("topic"));

		unmount();
		await settle(new Error("fatal: boom"));
		render(<BranchesSection />);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not switch to topic.",
		);
	});

	it("puts the last failure away when the next switch starts", async () => {
		const user = userEvent.setup();
		checkout.mockRejectedValueOnce(new Error("fatal: boom"));
		render(<BranchesSection />);
		await user.click(rowFor("topic"));
		await screen.findByRole("alert");

		startSwitch();
		await user.click(rowFor("topic"));

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
		render(<BranchesSection />);

		expect(screen.getByRole("button", { name: /^topic/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^review/ })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^origin\/colleague/ }),
		).toBeInTheDocument();
	});

	it("blocks a branch held by another worktree and names that worktree", async () => {
		const user = userEvent.setup();
		checkout.mockResolvedValue(undefined);
		render(<BranchesSection />);

		const row = rowFor("review");
		expect(row).toBeDisabled();
		expect(row).toHaveTextContent("in review-wt");

		await user.click(row);
		expect(checkout).not.toHaveBeenCalled();
	});

	it("checks out a remote-only branch by its local name", async () => {
		const user = userEvent.setup();
		checkout.mockResolvedValue(undefined);
		render(<BranchesSection />);

		await user.click(rowFor("origin/colleague"));

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
			local: Array.from({ length: 8 }, (_, i) => ({
				name: `topic/${i}`,
				current: i === 0,
			})),
		};

		it("scrolls the rows and leaves New branch out of it", () => {
			branches = many;
			render(<BranchesSection />);

			const scroller = rowFor("topic/7").closest(".overflow-y-auto");
			expect(scroller).not.toBeNull();
			// The footer is the way out when none of these branches are right;
			// inside the scroller it would sit below every row.
			expect(scroller).not.toContainElement(screen.getByText(/New branch/));
		});

		it("pins the filter above the rows", () => {
			branches = many;
			render(<BranchesSection />);

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
			render(<BranchesSection />);

			await user.click(rowFor("topic/7"));

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
		render(<BranchesSection />);

		await user.click(rowFor("topic"));

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
		render(<BranchesSection />);

		await user.click(rowFor("topic"));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Could not switch to topic. This worktree is busy pulling. Try again once it finishes.",
		);
		expect(alert).not.toHaveTextContent("another git operation");
	});
});
