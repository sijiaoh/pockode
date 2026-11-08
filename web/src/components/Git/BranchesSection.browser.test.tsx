import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { makeBranch, makeBranches } from "../../test/gitFixtures";
import type { GitBranches } from "../../types/git";
import BranchesSection from "./BranchesSection";

// What jsdom cannot say: that a branch row is laid out by the width of the
// list it is in, not the window's — two lines below `--container-git-row`, one
// line with the details and the age as aligned columns from it on — and that
// a hovered row's fill is the whole row's, `⋯` included, since `:hover` is not
// something jsdom computes.

let branches: GitBranches;
vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error: null }),
	useGitBranchActions: () => ({
		checkoutMutation: { mutateAsync: vi.fn() },
		createMutation: { mutateAsync: vi.fn() },
		deleteMutation: { mutateAsync: vi.fn() },
	}),
}));
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: undefined }),
}));

const mergeHandoff: BranchMergeHandoff = {
	handingOff: null,
	error: null,
	dismissError: () => {},
	start: () => {},
};

const LONG = "feature/a-branch-name-long-enough-to-be-cut-in-any-column";

beforeEach(async () => {
	branches = makeBranches({
		local: [
			makeBranch("main", { current: true }),
			makeBranch(LONG, { vs_default: { ahead: 3, behind: 12 } }),
			makeBranch("fix", { vs_default: { ahead: 1, behind: 0 } }),
			makeBranch("plain"),
		],
	});
	// Wider than either list, so the window would call every width here wide.
	await page.viewport(1280, 800);
});

afterEach(async () => {
	await page.viewport(414, 896);
});

function renderAt(width: number) {
	render(
		<div className="flex flex-col" style={{ width, height: 600 }}>
			<BranchesSection
				mergeHandoff={mergeHandoff}
				activeKey={null}
				onSelectBranch={() => {}}
				onBranchDeleted={() => {}}
			/>
		</div>,
	);
}

/** A row's name, details (where it has any) and age, measured. */
function row(name: string) {
	const rect = (el: Element) => el.getBoundingClientRect();
	const nameEl = screen.getByTitle(name);
	const button = nameEl.closest("button") as HTMLElement;
	// Name, then details if any, then age: the row's texts that can be cut.
	const titled = [...button.querySelectorAll("[title]")];
	return {
		name: rect(nameEl),
		details: titled.length === 3 ? rect(titled[1]) : null,
		age: rect(titled[titled.length - 1]),
		button: rect(button),
	};
}

describe("branch row width", () => {
	it("is two lines in a list narrower than the threshold", () => {
		renderAt(599);
		const long = row(LONG);
		expect(long.details?.top).toBeGreaterThanOrEqual(long.name.bottom - 1);
		expect(long.button.height).toBeGreaterThanOrEqual(52);
	});

	it("is one line from the threshold on, with the details and age lined up down the list", () => {
		renderAt(600);
		const long = row(LONG);
		const short = row("fix");
		const plain = row("plain");

		expect(long.details?.top).toBeLessThan(long.name.bottom);
		expect(long.details?.bottom).toBeGreaterThan(long.name.top);
		// Same height as the narrow row, so a resize does not move the scroll.
		expect(long.button.height).toBe(52);

		expect(short.details?.left).toBe(long.details?.left);
		expect(short.age.right).toBe(long.age.right);
		// A row with no details keeps its age in the column, on the same line.
		expect(plain.details).toBeNull();
		expect(plain.age.right).toBe(long.age.right);
		expect(plain.age.top - plain.name.top).toBe(long.age.top - long.name.top);
		// The room the name has in a 320px column today, ≈236px; the threshold
		// is where the one-line row still gives it about that.
		expect(long.name.width).toBeGreaterThanOrEqual(228);
	});
});

describe("branch row hover", () => {
	/** The row around a branch's button: the element that carries its fill. */
	function rowOf(name: string) {
		return screen.getByTitle(name).closest("button")
			?.parentElement as HTMLElement;
	}
	const fill = (el: Element) => getComputedStyle(el).backgroundColor;

	// One fill across the row, `⋯` slot included, so the `⋯` reads as the
	// row's own and the row does not go dark under the pointer on its way there.
	it("fills the whole row, and keeps it while its ⋯ is hovered", async () => {
		renderAt(400);
		const idle = fill(rowOf("plain"));

		await page
			.getByRole("button", { name: `More actions for ${LONG}` })
			.hover();
		await expect.poll(() => fill(rowOf(LONG))).not.toBe(idle);

		await page.getByTitle("fix").hover();
		await expect.poll(() => fill(rowOf("fix"))).not.toBe(idle);
		await expect.poll(() => fill(rowOf(LONG))).toBe(idle);
		// The fill is the row's, not the button's, so it reaches past it.
		expect(fill(rowOf("fix").querySelector("button") as Element)).toBe(
			"rgba(0, 0, 0, 0)",
		);
	});
});
