import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
	describe("a fenced code block", () => {
		it("names its language and copies from a header above the code", async () => {
			// user-event puts a clipboard of its own on `navigator` at setup, so the
			// spy goes on after it.
			const user = userEvent.setup();
			const writeText = vi.spyOn(navigator.clipboard, "writeText");
			render(<MarkdownContent content={"```ts\nconst a = 1;\n```"} />);

			expect(screen.getByText("ts")).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Copy code" }));
			expect(writeText).toHaveBeenCalledWith("const a = 1;");
		});

		// react-markdown's own <pre> around the block would be a box of its own,
		// one that scrolls the header away with the code.
		it("is not wrapped in a second pre", () => {
			const { container } = render(
				<MarkdownContent content={"```\nplain\n```"} />,
			);

			expect(container.querySelectorAll("pre")).toHaveLength(1);
			expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(
				1,
			);
		});
	});

	it("leaves inline code in its sentence, with no block chrome", () => {
		render(<MarkdownContent content={"Run `make` now"} />);

		expect(screen.getByText("make").tagName).toBe("CODE");
		expect(screen.getByText(/Run/).tagName).toBe("P");
		expect(
			screen.queryByRole("button", { name: "Copy code" }),
		).not.toBeInTheDocument();
	});

	// The transcript clips sideways, so a table wider than a phone has to scroll
	// in a box of its own or lose its right columns.
	it("puts a table in a box that scrolls sideways", () => {
		render(<MarkdownContent content={"| a | b |\n| - | - |\n| 1 | 2 |"} />);

		const table = screen.getByRole("table");
		expect(table.parentElement).toHaveClass("overflow-x-auto");
		expect(within(table).getByRole("cell", { name: "2" })).toBeInTheDocument();
	});
});
