import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { describe, expect, it, vi } from "vitest";
import { makeHead, makeSync } from "../../test/gitFixtures";
import type { GitBranches } from "../../types/git";
import BranchSheet from "./BranchSheet";

const branches: GitBranches = {
	head: makeHead(),
	local: [
		{ name: "main", current: true },
		{ name: "topic", current: false },
		{ name: "review", current: false, worktree: "review-wt" },
	],
	remote_only: [{ ref: "origin/colleague", name: "colleague" }],
	sync: makeSync(),
};

function renderSheet(
	overrides: Partial<Parameters<typeof BranchSheet>[0]> = {},
) {
	const onCheckout = vi.fn().mockResolvedValue(undefined);

	render(
		<BranchSheet
			branches={branches}
			onClose={vi.fn()}
			onCheckout={onCheckout}
			onNewBranch={vi.fn()}
			{...overrides}
		/>,
	);

	return { onCheckout };
}

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

describe("BranchSheet", () => {
	// A row's hint ("current", "in <worktree>") trails the branch in its name,
	// so what is pinned is the branch leading it.
	it("names each row by its branch", () => {
		renderSheet();

		expect(screen.getByRole("button", { name: /^topic/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^review/ })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^origin\/colleague/ }),
		).toBeInTheDocument();
	});

	it("switches to the branch that was tapped", async () => {
		const user = userEvent.setup();
		const { onCheckout } = renderSheet();

		await user.click(rowFor("topic"));

		expect(onCheckout).toHaveBeenCalledWith("topic");
	});

	it("blocks a branch held by another worktree and names that worktree", async () => {
		const user = userEvent.setup();
		const { onCheckout } = renderSheet();

		const row = rowFor("review");
		expect(row).toBeDisabled();
		expect(row).toHaveTextContent("in review-wt");

		await user.click(row);
		expect(onCheckout).not.toHaveBeenCalled();
	});

	it("checks out a remote-only branch by its local name", async () => {
		const user = userEvent.setup();
		const { onCheckout } = renderSheet();

		await user.click(rowFor("origin/colleague"));

		expect(onCheckout).toHaveBeenCalledWith("colleague");
	});

	// Sheet caps its own height (Sheet.test.tsx); what belongs here is that the
	// branch list is what scrolls inside that cap, and that the way out of a long
	// list does not scroll away with it.
	describe("with more branches than fit on screen", () => {
		// The smallest list the component itself calls "more than fits": jsdom has
		// no layout, so its filter threshold is the only thing here a row count
		// can change, and that threshold counts remote branches too — `branches`
		// already carries one, so eight local rows are what crosses it. Rows past
		// that buy nothing but render time. Raising the threshold and not this
		// count turns "pins the filter above the rows" red, which is the right
		// place to hear about it.
		const many = {
			...branches,
			local: Array.from({ length: 8 }, (_, i) => ({
				name: `topic/${i}`,
				current: i === 0,
			})),
		};

		it("scrolls the rows and leaves the footer out of it", () => {
			renderSheet({ branches: many });

			const scroller = rowFor("topic/7").parentElement as HTMLElement;
			expect(scroller).toHaveClass("overflow-y-auto");
			// The footer is the way out when none of these branches are right;
			// inside the scroller it would sit below every row.
			expect(scroller).not.toContainElement(screen.getByText(/New branch/));
		});

		it("pins the filter above the rows", () => {
			renderSheet({ branches: many });

			expect(
				screen.getByLabelText("Filter branches").closest(".sticky"),
			).not.toBeNull();
		});

		// A refusal that lands off the top of the sheet is indistinguishable from
		// a row that did nothing, and the user tapped that row from halfway down.
		it("pins a failed switch above the rows", async () => {
			const user = userEvent.setup();
			renderSheet({
				branches: many,
				onCheckout: vi.fn().mockRejectedValue(new Error("boom")),
			});

			await user.click(rowFor("topic/7"));

			const alert = await screen.findByRole("alert");
			expect(alert.closest(".sticky")).not.toBeNull();
		});
	});

	// Uncommitted changes are never stashed, so the user has to be able to read
	// which files got in the way without the sheet closing on them.
	it("keeps git's refusal on screen when a switch fails", async () => {
		const user = userEvent.setup();
		const stderr =
			"error: Your local changes to the following files would be overwritten by checkout:\n\tdocs/git.md";
		renderSheet({ onCheckout: vi.fn().mockRejectedValue(new Error(stderr)) });

		await user.click(rowFor("topic"));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not switch to topic.");
		expect(alert).toHaveTextContent("Commit or discard these changes first.");
		expect(alert).toHaveTextContent("docs/git.md");
	});

	// A refusal is the server's own sentence about a request that never ran, so
	// there is no git output under it — but it also cannot name the row it was
	// about, and in a list taller than the sheet that row has scrolled away.
	it("names the branch a refused switch was about", async () => {
		const user = userEvent.setup();
		renderSheet({
			onCheckout: vi
				.fn()
				.mockRejectedValue(
					new JSONRPCErrorException(
						"another git operation is running in this worktree: pull",
						-32001,
						{ operation: "pull" },
					),
				),
		});

		await user.click(rowFor("topic"));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Could not switch to topic. This worktree is busy pulling. Try again once it finishes.",
		);
		expect(alert).not.toHaveTextContent("another git operation");
	});
});
