import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClampedContent } from "./ClampedContent";

// jsdom does no layout, so how tall the content is has to be said: every
// element reports `contentHeight` as its own height and the clamp as the box's.
function layOut(contentHeight: number) {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
		contentHeight,
	);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
		Math.min(contentHeight, 320),
	);
}

function box(): HTMLElement {
	const el = screen.getByText("body text").parentElement?.parentElement;
	if (!el) throw new Error("clamp box not found");
	return el;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ClampedContent", () => {
	it("leaves content that fits alone", () => {
		layOut(100);
		render(
			<ClampedContent fullScreenTitle="notes.md">
				<p>body text</p>
			</ClampedContent>,
		);

		expect(box()).not.toHaveAttribute("data-clamped");
		expect(screen.queryByText("Show all")).not.toBeInTheDocument();
		expect(screen.queryByText("Full screen")).not.toBeInTheDocument();
	});

	// A scroll box here would take the drag a phone meant for the transcript;
	// the content is cut instead, and opened where it stands.
	it("cuts long content and opens it in place, without a scroller", async () => {
		const user = userEvent.setup();
		layOut(2000);
		render(
			<ClampedContent>
				<p>body text</p>
			</ClampedContent>,
		);

		expect(box()).toHaveAttribute("data-clamped");
		expect(box()).toHaveClass("max-h-80", "overflow-y-hidden");
		expect(screen.queryByText("Full screen")).not.toBeInTheDocument();

		await user.click(screen.getByText("Show all"));
		expect(box()).not.toHaveAttribute("data-clamped");
		expect(box()).not.toHaveClass("max-h-80");
		expect(screen.queryByText("Show all")).not.toBeInTheDocument();
	});

	it("keeps the tail in view when told to read from the end", () => {
		layOut(2000);
		render(
			<ClampedContent from="end">
				<p>body text</p>
			</ClampedContent>,
		);

		expect(box()).toHaveClass("justify-end");
	});

	it("offers a long file a screen of its own", async () => {
		const user = userEvent.setup();
		layOut(2000);
		render(
			<ClampedContent fullScreenTitle="Read · src/main.ts">
				<p>body text</p>
			</ClampedContent>,
		);

		await user.click(screen.getByText("Full screen"));
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("Read · src/main.ts");
		expect(dialog).toHaveTextContent("body text");

		// Still on offer after the content has been opened in place: being
		// readable inline does not make a whole file comfortable to read there.
		await user.click(screen.getByLabelText("Close"));
		await user.click(screen.getByText("Show all"));
		expect(screen.getByText("Full screen")).toBeInTheDocument();
	});
});
