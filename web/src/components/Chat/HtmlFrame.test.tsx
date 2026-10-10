import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HtmlFrame } from "./HtmlFrame";

describe("HtmlFrame", () => {
	// The card and the full screen viewer both draw a page through this frame,
	// so this is the one place the security floor is held.
	it("lets scripts and popups run, and never same-origin or modals", () => {
		render(<HtmlFrame html="<p>hi</p>" title="Page" />);
		const tokens =
			screen.getByTitle("Page").getAttribute("sandbox")?.split(/\s+/) ?? [];

		expect(tokens).not.toContain("allow-same-origin");
		expect(tokens).not.toContain("allow-modals");
		expect(tokens).toEqual(
			expect.arrayContaining([
				"allow-scripts",
				"allow-popups",
				"allow-popups-to-escape-sandbox",
			]),
		);
	});
});
