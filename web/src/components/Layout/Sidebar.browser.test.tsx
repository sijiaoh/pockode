import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import Sidebar from "./Sidebar";

// What jsdom cannot say: how wide the drawer is drawn against the viewport,
// and that a strip of the chat is always left showing beside it.

afterEach(async () => {
	await page.viewport(414, 896);
});

function drawerWidth(): number {
	const panel = screen.getByText("sessions").closest("[tabindex='-1']");
	if (!panel) throw new Error("drawer panel not found");
	return panel.getBoundingClientRect().width;
}

describe("Sidebar drawer", () => {
	it.each([
		[320, 264],
		[390, 334],
		[456, 400],
		[700, 400],
	])("at a %ipx viewport is %ipx wide", async (viewport, expected) => {
		await page.viewport(viewport, 800);
		render(
			<Sidebar isOpen onClose={() => {}} isExpanded={false}>
				<p>sessions</p>
			</Sidebar>,
		);

		expect(drawerWidth()).toBe(expected);
	});
});
