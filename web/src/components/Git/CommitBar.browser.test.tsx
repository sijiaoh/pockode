import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitStatus } from "../../types/git";
import CommitBar from "./CommitBar";

// What jsdom cannot say: that `Discard unstaged…`, wider than its half of the
// bar at the sidebar's default width, wraps inside the button instead of being
// cut or pushing the bar taller.

const status: GitStatus = {
	staged: [{ path: "a.ts", status: "M" }],
	unstaged: [{ path: "b.ts", status: "M" }],
};
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));

// Sidebar.tsx's DEFAULT_WIDTH.
const SIDEBAR_WIDTH = 288;

describe("CommitBar width", () => {
	it("wraps the discard's label within the bar's height at the sidebar's width", () => {
		render(
			<div style={{ width: SIDEBAR_WIDTH }}>
				<CommitBar
					discardUnstaged={{
						onDiscard: () => {},
						busy: false,
						nothingUnstaged: false,
					}}
				/>
			</div>,
		);
		const discard = screen.getByRole("button", { name: "Discard unstaged…" });
		const commit = screen.getByRole("button", { name: "Commit 1 file" });

		expect(discard.scrollWidth).toBeLessThanOrEqual(discard.clientWidth);
		expect(discard.getBoundingClientRect().height).toBe(44);
		expect(commit.getBoundingClientRect().height).toBe(44);
	});
});
