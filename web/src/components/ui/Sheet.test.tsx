import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Sheet from "./Sheet";

/** The full-viewport flex container that parks the content box. */
function overlay(): HTMLElement {
	return screen.getByRole("dialog");
}

/** The flex column the header, body and footer live in. */
function contentBox(): HTMLElement {
	const box = screen.getByRole("heading", { name: "Long" }).parentElement
		?.parentElement;
	if (!box) throw new Error("content box not found");
	return box;
}

function body(): HTMLElement {
	const el = screen.getByText("row 0").parentElement;
	if (!el) throw new Error("body not found");
	return el;
}

function renderTall() {
	render(
		<Sheet
			title="Long"
			onClose={() => {}}
			footer={<button type="button">Footer action</button>}
		>
			{Array.from({ length: 60 }, (_, i) => `row ${i}`).map((row) => (
				<p key={row}>{row}</p>
			))}
		</Sheet>,
	);
}

// jsdom does no layout, so the cap is asserted as the class contract that
// produces it: an uncapped column is exactly as tall as its content, which
// leaves the body's overflow nothing to scroll and pushes the footer past both
// edges of a centered modal.
const CAPPED = /max-h-\[\d+dvh\]/;

describe("Sheet", () => {
	it("caps its height against the viewport as a mobile drawer", () => {
		renderTall();

		expect(contentBox().className).toMatch(CAPPED);
	});

	// A tablet held upright is below the expanded tier and keeps the drawer, so
	// the sheet stays under the thumb instead of floating out of reach in the
	// middle of the screen.
	it("sits at the bottom of the viewport as a drawer", () => {
		renderTall();

		expect(overlay()).toHaveClass("items-end");
		expect(overlay()).not.toHaveClass("items-center");
	});

	describe("as a desktop modal", () => {
		// useIsExpanded reads (min-width: 1024px), which the setup's matchMedia
		// stub answers false for, so the default in tests is the mobile layout.
		// One hook decides both the class strings and the drag handle; there is
		// deliberately no width prefix restating it, so flipping this stub is
		// enough to move the whole component between its two forms.
		const original = window.matchMedia;
		const set = (value: typeof window.matchMedia) =>
			Object.defineProperty(window, "matchMedia", { writable: true, value });

		beforeEach(() => {
			set(((query: string) => ({
				matches: query.includes("min-width"),
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => true,
			})) as unknown as typeof window.matchMedia);
		});
		afterEach(() => set(original));

		it("caps its height against the viewport", () => {
			renderTall();

			expect(contentBox().className).toMatch(CAPPED);
		});

		it("sits in the middle of the viewport", () => {
			renderTall();

			expect(overlay()).toHaveClass("items-center");
			expect(overlay()).not.toHaveClass("items-end");
		});

		it("scrolls the body while the footer stays put", () => {
			renderTall();

			expect(body()).toHaveClass("overflow-y-auto");
			// Without min-h-0 the body refuses to shrink below its content inside
			// the flex column, so the cap would be overflowed, not scrolled.
			expect(body()).toHaveClass("min-h-0");
			expect(body()).not.toContainElement(
				screen.getByRole("button", { name: "Footer action" }),
			);
		});
	});
});
