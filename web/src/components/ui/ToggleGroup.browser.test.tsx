import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { getSessionModeInfo, SESSION_MODES } from "../../lib/sessionMode";
import ToggleGroup from "./ToggleGroup";

// What jsdom cannot say: whether Settings' three mode segments, glyphs and all,
// fit one line on the narrowest phone (docs/unattended-mode-ui.md §2.3).

afterEach(async () => {
	await page.viewport(414, 896);
});

describe("Settings' default Mode toggle", () => {
	it.each([
		[320, 0],
		[640, 3],
	])("fits one line at a %ipx viewport, with %i glyphs", async (viewport, glyphs) => {
		await page.viewport(viewport, 800);
		// The settings page's own inset around a section.
		render(
			<div className="px-4">
				<ToggleGroup
					label="Mode"
					items={SESSION_MODES}
					selected="default"
					onSelect={() => {}}
					getInfo={getSessionModeInfo}
					compactBelowSm
				/>
			</div>,
		);

		const group = screen.getByRole("group", { name: "Mode" });
		const segments = within(group).getAllByRole("button");
		expect(segments).toHaveLength(3);
		for (const segment of segments) {
			// Squeezed segments do not overflow: the glyph shrinks and the label
			// wraps, so what is measured is that neither happened.
			expect(segment.getBoundingClientRect().height).toBe(44);
			for (const glyph of segment.querySelectorAll("svg")) {
				if (getComputedStyle(glyph).display === "none") continue;
				expect(glyph.getBoundingClientRect().width).toBe(16);
			}
		}
		// All or none: segments that differ would not read as one control.
		const drawn = [...group.querySelectorAll("svg")].filter(
			(glyph) => getComputedStyle(glyph).display !== "none",
		);
		expect(drawn).toHaveLength(glyphs);
		expect(group.scrollWidth).toBeLessThanOrEqual(group.clientWidth);
	});
});
