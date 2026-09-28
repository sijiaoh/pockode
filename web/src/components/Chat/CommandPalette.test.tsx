import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette";

// jsdom has no layout, and the palette scrolls the selected row into view.
Element.prototype.scrollIntoView = vi.fn();

describe("CommandPalette", () => {
	// Three kinds a user has to tell apart: the CLI's own, their custom ones,
	// and Pockode's, which alone say what they do.
	it("marks each kind of command", () => {
		render(
			<CommandPalette
				commands={[
					{
						name: "pockode-lead",
						isBuiltin: false,
						isPockode: true,
						description: "Lead the work just discussed",
					},
					{ name: "compact", isBuiltin: true, isPockode: false },
					{ name: "deploy", isBuiltin: false, isPockode: false },
				]}
				selectedIndex={0}
				onSelect={vi.fn()}
				filter=""
			/>,
		);

		const [pockode, builtin, custom] = screen.getAllByRole("option");
		expect(pockode).toHaveTextContent("Pockode");
		expect(pockode).toHaveTextContent("Lead the work just discussed");
		expect(pockode).not.toHaveTextContent("(custom)");
		expect(builtin).toHaveTextContent(/^\/compact$/);
		expect(custom).toHaveTextContent("(custom)");
		expect(custom).not.toHaveTextContent("Pockode");
	});
});
