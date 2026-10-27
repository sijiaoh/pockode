import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiffViewer } from "./DiffViewer";

// The library measures its line-number column on a canvas, which jsdom lacks.
beforeAll(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		() =>
			({
				font: "",
				measureText: () => ({ width: 8 }),
			}) as unknown as CanvasRenderingContext2D,
	);
});

afterAll(() => {
	vi.restoreAllMocks();
});

function file(length: number, edits: Record<number, string> = {}): string {
	const lines = Array.from(
		{ length },
		(_, i) => edits[i + 1] ?? `line ${i + 1}`,
	);
	return `${lines.join("\n")}\n`;
}

/** A one-line change at `at`, with git's three lines of context. */
function hunk(at: number, oldText: string, newText: string): string {
	const context = (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, i) => ` line ${from + i}`);
	return [
		`@@ -${at - 3},7 +${at - 3},7 @@`,
		...context(at - 3, at - 1),
		`-${oldText}`,
		`+${newText}`,
		...context(at + 1, at + 3),
	].join("\n");
}

function patch(...hunks: string[]): string {
	return `--- a/a.txt\n+++ b/a.txt\n${hunks.join("\n")}\n`;
}

function gapLabels(container: HTMLElement): (string | null)[] {
	return Array.from(
		container.querySelectorAll(".diff-line-hunk-content"),
		(cell) => cell.getAttribute("data-unchanged"),
	);
}

function gapCell(container: HTMLElement, label: string): HTMLElement {
	const cell = container.querySelector<HTMLElement>(
		`[data-unchanged="${label}"]`,
	);
	if (!cell) throw new Error(`no gap labelled ${label}`);
	return cell;
}

describe("DiffViewer", () => {
	const oldContent = file(60);
	const newContent = file(60, { 30: "line thirty" });
	const hunks = [patch(hunk(30, "line 30", "line thirty"))];

	it("says how many unchanged lines each collapsed gap hides", async () => {
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
			/>,
		);

		await waitFor(() =>
			expect(gapLabels(container)).toEqual([
				"26 unchanged lines",
				"27 unchanged lines",
			]),
		);
		expect(screen.queryByText("line 1")).toBeNull();
	});

	it("expands a gap from a press anywhere on its row", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
			/>,
		);

		await user.click(
			await waitFor(() => gapCell(container, "26 unchanged lines")),
		);

		expect(await screen.findByText("line 1")).toBeTruthy();
		expect(gapLabels(container)).toEqual(["27 unchanged lines"]);
	});

	it("counts down a long gap between hunks as it is revealed", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={[
					patch(hunk(10, "line 10", "ten"), hunk(100, "line 100", "hundred")),
				]}
				oldContent={file(110)}
				newContent={file(110, { 10: "ten", 100: "hundred" })}
			/>,
		);

		// Lines 14 to 96 lie between the two hunks; a press reveals the
		// library's step of 40 from the hunk above.
		await user.click(
			await waitFor(() => gapCell(container, "83 unchanged lines")),
		);

		expect(await screen.findByText("line 14")).toBeTruthy();
		await waitFor(() =>
			expect(gapLabels(container)).toContain("43 unchanged lines"),
		);
	});

	it("keeps what was expanded when only the wrap changes", async () => {
		const user = userEvent.setup();
		const { container, rerender } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
			/>,
		);
		await user.click(
			await waitFor(() => gapCell(container, "26 unchanged lines")),
		);
		await screen.findByText("line 1");

		// A fresh array of the same hunks, as a caller building it in render
		// passes: still the same diff.
		rerender(
			<DiffViewer
				fileName="a.txt"
				hunks={[...hunks]}
				oldContent={oldContent}
				newContent={newContent}
				wrap
			/>,
		);

		expect(screen.getByText("line 1")).toBeTruthy();
	});

	it("marks the changed words within a modified line", async () => {
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
			/>,
		);

		await waitFor(() =>
			expect(container.querySelectorAll("[data-range-start]")).toHaveLength(2),
		);
	});

	it("offers no expansion without both files", async () => {
		const { container } = render(<DiffViewer fileName="a.txt" hunks={hunks} />);

		await screen.findByText("line 31");
		expect(container.querySelector(".diff-line-hunk-action button")).toBeNull();
		expect(gapLabels(container).every((label) => label === null)).toBe(true);
	});

	describe.each([
		["", false],
		[" and wrapped", true],
	])("side by side%s", (_, wrap) => {
		const renderSplit = () =>
			render(
				<DiffViewer
					fileName="a.txt"
					hunks={hunks}
					oldContent={oldContent}
					newContent={newContent}
					wrap={wrap}
					split
				/>,
			);

		it("says how many unchanged lines each gap hides, and expands it", async () => {
			const user = userEvent.setup();
			const { container } = renderSplit();

			await user.click(
				await waitFor(() => gapCell(container, "26 unchanged lines")),
			);

			// Once per side.
			expect(await screen.findAllByText("line 1")).toHaveLength(2);
			expect(gapLabels(container)).toEqual(["27 unchanged lines"]);
		});

		it("keeps the word highlight", async () => {
			const { container } = renderSplit();

			await waitFor(() =>
				expect(container.querySelectorAll("[data-range-start]")).toHaveLength(
					2,
				),
			);
		});
	});

	// The toggle switches a viewer already on screen: the labels must follow
	// the rows the new mode draws, read from that mode's own bookkeeping.
	it("labels the gaps again when switched to side by side", async () => {
		const user = userEvent.setup();
		const props = { fileName: "a.txt", hunks, oldContent, newContent };
		const { container, rerender } = render(<DiffViewer {...props} />);
		await user.click(
			await waitFor(() => gapCell(container, "26 unchanged lines")),
		);
		await screen.findByText("line 1");

		rerender(<DiffViewer {...props} split />);

		await waitFor(() =>
			expect(container.querySelector(".split-diff-view")).not.toBeNull(),
		);
		// Split view keeps its own record of what is expanded.
		await waitFor(() =>
			expect(gapLabels(container)).toEqual([
				"26 unchanged lines",
				"27 unchanged lines",
			]),
		);
		await user.click(gapCell(container, "27 unchanged lines"));
		await waitFor(() =>
			expect(gapLabels(container)).toEqual(["26 unchanged lines"]),
		);
	});

	// Unwrapped, each side is a table of its own: the new side's half of a gap
	// row has no button, and is still the row.
	it("expands a gap from the new side's half of its row", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
				split
			/>,
		);
		await waitFor(() => gapCell(container, "26 unchanged lines"));
		const placeholder = container.querySelector<HTMLElement>(
			".new-diff-table .diff-line-hunk-placeholder",
		);
		if (!placeholder) throw new Error("no placeholder for the first gap");

		await user.click(placeholder);

		expect(await screen.findAllByText("line 1")).toHaveLength(2);
	});
});
