import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { CanvasViewSwitch } from "./CanvasViewSwitch";

// What jsdom cannot say: that the pressed toggle still looks pressed under a
// mouse. Its fill is every header button's hover, so the accent glyph is the
// only thing telling "on" from "pointed at" — and it shares a property with
// the header class's own hover colour, which only the cascade decides.

/** The colour a theme class resolves to here, read off a throwaway probe. */
function resolved(className: string) {
	const probe = document.createElement("span");
	probe.className = className;
	document.body.append(probe);
	const value = getComputedStyle(probe).color;
	probe.remove();
	return value;
}

/**
 * The header class transitions every property, so a colour read straight
 * after a change can be the one it is leaving: wait for whatever it started.
 */
async function settled(element: Element) {
	await Promise.all(element.getAnimations().map((a) => a.finished));
}

describe("CanvasViewSwitch", () => {
	it("keeps the pressed accent while hovered, and only while pressed", async () => {
		const accent = resolved("text-th-accent");
		const { rerender } = render(
			<CanvasViewSwitch view="chat" onSelect={() => {}} />,
		);
		const button = screen.getByRole("button", { name: "Chat view" });
		const style = getComputedStyle(button);
		expect(style.color).toBe(accent);

		await page.getByRole("button", { name: "Chat view" }).hover();
		await expect.poll(() => button.matches(":hover")).toBe(true);
		await settled(button);
		expect(style.color).toBe(accent);

		// Still hovered, now not pressed: the class's own hover colour.
		rerender(<CanvasViewSwitch view="canvas" onSelect={() => {}} />);
		await settled(button);
		expect(style.color).toBe(resolved("text-th-text-primary"));
	});
});
