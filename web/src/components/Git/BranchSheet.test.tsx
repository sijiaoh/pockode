import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("BranchSheet", () => {
	it("switches to the branch that was tapped", async () => {
		const user = userEvent.setup();
		const { onCheckout } = renderSheet();

		await user.click(screen.getByRole("button", { name: /topic/ }));

		expect(onCheckout).toHaveBeenCalledWith("topic");
	});

	it("blocks a branch held by another worktree and names that worktree", async () => {
		const user = userEvent.setup();
		const { onCheckout } = renderSheet();

		const row = screen.getByRole("button", { name: /review/ });
		expect(row).toBeDisabled();
		expect(row).toHaveTextContent("in review-wt");

		await user.click(row);
		expect(onCheckout).not.toHaveBeenCalled();
	});

	it("checks out a remote-only branch by its local name", async () => {
		const user = userEvent.setup();
		const { onCheckout } = renderSheet();

		await user.click(screen.getByRole("button", { name: /origin\/colleague/ }));

		expect(onCheckout).toHaveBeenCalledWith("colleague");
	});

	// Sheet caps its own height (Sheet.test.tsx); what belongs here is that the
	// branch list is what scrolls inside that cap, and that the way out of a long
	// list does not scroll away with it.
	describe("with more branches than fit on screen", () => {
		const many = {
			...branches,
			local: Array.from({ length: 60 }, (_, i) => ({
				name: `topic/${i}`,
				current: i === 0,
			})),
		};

		it("scrolls the rows and leaves the footer out of it", () => {
			renderSheet({ branches: many });

			const scroller = screen.getByRole("button", { name: /topic\/59/ })
				.parentElement as HTMLElement;
			expect(scroller).toHaveClass("overflow-y-auto");
			// The footer is the way out when none of these branches are right;
			// inside the scroller it would sit below 60 rows.
			expect(scroller).not.toContainElement(
				screen.getByRole("button", { name: /New branch/ }),
			);
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

			await user.click(screen.getByRole("button", { name: /topic\/59/ }));

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

		await user.click(screen.getByRole("button", { name: /topic/ }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not switch to topic.");
		expect(alert).toHaveTextContent("Commit or discard these changes first.");
		expect(alert).toHaveTextContent("docs/git.md");
	});
});
