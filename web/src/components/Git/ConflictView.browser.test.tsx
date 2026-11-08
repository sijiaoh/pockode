import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { findConflictRegions } from "../../lib/gitOperation";
import type { FileContent } from "../../types/contents";
import ConflictView, { type ConflictFile } from "./ConflictView";

// What jsdom cannot say: that the text is what scrolls, under a conflict row
// that stays put, and that a band spans the full width it scrolls to.

const LONG = `const long = "${"x".repeat(400)}";`;

function text(starts = [20, 120]): string {
	const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
	for (const start of starts) {
		lines[start] = "<<<<<<< HEAD";
		lines[start + 1] = LONG;
		lines[start + 2] = "=======";
		lines[start + 4] = ">>>>>>> theirs";
	}
	return lines.join("\n");
}

function conflictFile(content: string): ConflictFile {
	const data: FileContent = {
		name: "notes.unknownext",
		type: "file",
		path: "notes.unknownext",
		size: content.length,
		mime: "text/plain",
		content,
		encoding: "text",
	};
	return {
		contents: {
			data,
			isLoading: false,
			error: null,
		} as ConflictFile["contents"],
		text: { content, highlight: true },
		regions: findConflictRegions(content),
		resolvable: false,
		confirmResolvable: async () => false,
	};
}

/** The review layer's column, as DiffView lays it out. */
function renderView(wrap: boolean, starts?: number[]) {
	render(
		<div
			data-testid="page"
			className="flex flex-col overflow-hidden"
			style={{ width: 320, height: 480 }}
		>
			<div className="h-11 shrink-0">toolbar</div>
			<ConflictView
				path="notes.unknownext"
				conflict="content"
				file={conflictFile(text(starts))}
				wrap={wrap}
				onOpenFile={() => {}}
			/>
			<div className="h-14 shrink-0">bottom bar</div>
		</div>,
	);
}

const rowOf = (el: HTMLElement) => el.closest("[data-line]") as HTMLElement;
const scrollerOf = (el: HTMLElement) =>
	el.closest(".overflow-auto") as HTMLElement;

describe("ConflictView layout", () => {
	it("scrolls the text under a conflict row that stays in the page", async () => {
		const user = userEvent.setup();
		renderView(false);
		const page = screen.getByTestId("page");
		const [first, second] = screen.getAllByText("<<<<<<< HEAD");
		const scroller = scrollerOf(first);

		expect(page.scrollHeight).toBe(page.clientHeight);
		expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
		expect(screen.getByText("bottom bar").getBoundingClientRect().bottom).toBe(
			page.getBoundingClientRect().bottom,
		);

		await user.click(screen.getByRole("button", { name: "Next conflict" }));
		await user.click(screen.getByRole("button", { name: "Next conflict" }));
		expect(screen.getByText("Conflict 2 of 2")).toBeInTheDocument();
		// At the top, below the padding the text starts under.
		const padding = rowOf(screen.getByText("line 0")).offsetTop;
		expect(
			Math.abs(
				rowOf(second).getBoundingClientRect().top -
					scroller.getBoundingClientRect().top -
					padding,
			),
		).toBeLessThanOrEqual(1);
		expect(
			screen.getByRole("button", { name: "Previous conflict" }),
		).toBeVisible();
	});

	// The padding above the first line must not leave it unreached.
	it("counts a conflict on the first line as the one at the top", () => {
		renderView(false, [0, 120]);

		expect(screen.getByText("Conflict 1 of 2")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Previous conflict" }),
		).toBeDisabled();
	});

	it("bands a marker across the width a long line scrolls to", () => {
		renderView(false);
		const marker = rowOf(screen.getAllByText("<<<<<<< HEAD")[0]);
		const scroller = scrollerOf(marker);

		expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
		expect(marker.getBoundingClientRect().width).toBeGreaterThanOrEqual(
			scroller.scrollWidth - 1,
		);
	});

	it("wraps without scrolling sideways", () => {
		renderView(true);
		const marker = rowOf(screen.getAllByText("<<<<<<< HEAD")[0]);
		const scroller = scrollerOf(marker);

		expect(scroller.scrollWidth).toBe(scroller.clientWidth);
	});
});
