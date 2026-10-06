import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Section } from "./ToolSection";

// jsdom does no layout: the content is 2000px tall, and a box with a
// max-height stops at the supporting budget's 8 lines (+ 6 while uncut).
function layOut() {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(2000);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			if (this.hasAttribute("data-clamped")) return 128;
			return this.style.maxHeight ? 224 : 2000;
		},
	);
}

function header(): Element {
	const el = screen
		.getByText("Output")
		.closest(".tool-section")?.firstElementChild;
	if (!el) throw new Error("section header not found");
	return el;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Section", () => {
	it("pins its header with a way to close the block only while it is open past its budget", async () => {
		const user = userEvent.setup();
		layOut();
		render(
			<Section label="Output" count={{ noun: "line", total: 125 }}>
				<p>body text</p>
			</Section>,
		);

		expect(header()).not.toHaveClass("section-bar");
		expect(
			screen.queryByRole("button", { name: "Show less of output" }),
		).not.toBeInTheDocument();

		const show = screen.getByRole("button", {
			name: "Show 117 more lines of output",
		});
		await user.click(show);
		expect(header()).toHaveClass("section-bar");
		const [collapse, less] = screen.getAllByRole("button", {
			name: "Show less of output",
		});
		expect(less).toBe(show);
		expect(collapse).toHaveAttribute("aria-expanded", "true");
		expect(collapse).toHaveAttribute(
			"aria-controls",
			show.getAttribute("aria-controls"),
		);

		// Closed from the header, the block is cut again, the header let go,
		// and focus left on the block's own button rather than the page.
		await user.click(collapse);
		expect(header()).not.toHaveClass("section-bar");
		expect(collapse).not.toBeInTheDocument();
		expect(show).toHaveAccessibleName("Show 117 more lines of output");
		expect(show).toHaveFocus();
	});

	it("lets the header go when the open block is folded away", async () => {
		const user = userEvent.setup();
		layOut();
		render(
			<Section label="Output" collapsible={{ defaultOpen: true }}>
				<p>body text</p>
			</Section>,
		);
		await user.click(
			screen.getByRole("button", { name: "Show all of output" }),
		);
		expect(header()).toHaveClass("section-bar");

		await user.click(screen.getByRole("button", { name: "Output" }));
		expect(header()).not.toHaveClass("section-bar");
		expect(
			screen.getAllByRole("button", {
				name: "Show less of output",
				hidden: true,
			}),
		).toHaveLength(1);
	});
});
