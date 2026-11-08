import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SyncRun } from "../../lib/gitSyncStore";
import { makeSync } from "../../test/gitFixtures";
import type { GitSync } from "../../types/git";
import { describeSyncStatus } from "../../utils/gitSyncStatus";
import SyncChip from "./SyncChip";

const IDLE: SyncRun = { running: null, outcome: null, auto: false };

function renderChip(sync: Partial<GitSync> = {}, run: Partial<SyncRun> = {}) {
	render(
		<SyncChip
			status={describeSyncStatus(makeSync(sync), { ...IDLE, ...run })}
			onClick={vi.fn()}
		/>,
	);
	return screen.getByRole("button");
}

// Which step the chip names, and in what order of priority, is
// describeSyncStatus's; these cover how each is drawn and announced.
describe("SyncChip", () => {
	it("shows both counts when the branch has diverged", () => {
		const chip = renderChip({ ahead: 1, behind: 2 });

		// Behind first, then ahead; the arrows beside them are decorative.
		expect(chip.textContent).toBe("21");
		// The arrows say nothing to a screen reader, so the label spells them out.
		expect(chip).toHaveAccessibleName("Sync with remote, 2 to pull, 1 to push");
	});

	it("names the step and its count in one direction", () => {
		expect(renderChip({ behind: 2 }).textContent).toBe("Pull2");
	});

	it("stays a button with nothing to do, since fetch lives behind it", () => {
		const chip = renderChip();

		expect(chip).toHaveTextContent("Synced");
		expect(chip).toHaveAccessibleName("Sync with remote, up to date");
		expect(chip).toBeEnabled();
	});

	it("offers to publish a branch with no upstream", () => {
		expect(renderChip({ upstream: "" })).toHaveTextContent("Publish");
	});

	// Where a run whose sheet has been closed reports that it is still going.
	// The counts stay put: nothing has refreshed them yet.
	it("spins and says which operation runs", () => {
		const chip = renderChip({ ahead: 1, behind: 2 }, { running: "pull" });

		expect(chip).toHaveAccessibleName("Sync with remote, pulling…");
		expect(chip.textContent).toBe("21");
		expect(within(chip).getByRole("status")).toBeInTheDocument();
	});

	it("marks a failed automatic fetch and says so", () => {
		const chip = renderChip(
			{ behind: 2 },
			{
				auto: true,
				outcome: {
					kind: "error",
					summary: "Automatic fetch failed.",
					detail: "x",
				},
			},
		);

		expect(chip).toHaveAccessibleName(
			"Sync with remote, 2 to pull, automatic fetch failed",
		);
		expect(chip.querySelector("svg.text-th-warning")).not.toBeNull();
	});
});
