import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SyncOperation } from "../../lib/gitSyncStore";
import { makeSync } from "../../test/gitFixtures";
import type { GitSync } from "../../types/git";
import SyncChip from "./SyncChip";

function renderChip(
	sync: Partial<GitSync> = {},
	running: SyncOperation | null = null,
) {
	render(
		<SyncChip sync={makeSync(sync)} running={running} onClick={vi.fn()} />,
	);
	return screen.getByRole("button");
}

describe("SyncChip", () => {
	it("shows both counts when the branch has diverged", () => {
		const chip = renderChip({ ahead: 1, behind: 2 });

		// Behind first, then ahead; the arrows beside them are decorative.
		expect(chip.textContent).toBe("21");
		// The arrows say nothing to a screen reader, so the label spells them out.
		expect(chip).toHaveAccessibleName("Sync with remote, 2 to pull, 1 to push");
	});

	it("stays a button with nothing to do, since fetch lives behind it", () => {
		const chip = renderChip();

		expect(chip).toHaveAccessibleName("Sync with remote, up to date");
		expect(chip).toBeEnabled();
	});

	it("offers to publish a branch with no upstream", () => {
		expect(renderChip({ upstream: "" })).toHaveTextContent("Publish");
	});

	// The counts behind a missing upstream ref are unknown, not zero.
	it("offers to publish when the upstream ref is missing locally", () => {
		expect(renderChip({ upstream_gone: true })).toHaveTextContent("Publish");
	});

	// Where a run whose sheet has been closed reports that it is still going.
	// The counts stay put: nothing has refreshed them yet.
	it("spins and says which operation runs", () => {
		const chip = renderChip({ ahead: 1, behind: 2 }, "pull");

		expect(chip).toHaveAccessibleName("Sync with remote, pulling…");
		expect(chip.textContent).toBe("21");
		expect(within(chip).getByRole("status")).toBeInTheDocument();
	});
});
