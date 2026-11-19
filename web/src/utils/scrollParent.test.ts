import { describe, expect, it } from "vitest";
import { scrollToShow } from "./scrollParent";

function boxed(top: number, height: number): HTMLElement {
	const el = document.createElement("div");
	// jsdom lays nothing out, so its own scrollTop stays 0 whatever is set.
	let scrollTop = 0;
	Object.defineProperty(el, "scrollTop", {
		get: () => scrollTop,
		set: (value: number) => {
			scrollTop = value;
		},
	});
	el.getBoundingClientRect = () =>
		({ top, bottom: top + height, height }) as DOMRect;
	return el;
}

describe("scrollToShow", () => {
	it("scrolls the least that shows the element, from either side", () => {
		const container = boxed(100, 400);
		container.scrollTop = 1000;

		scrollToShow(container, boxed(40, 44));
		expect(container.scrollTop).toBe(940);

		container.scrollTop = 1000;
		scrollToShow(container, boxed(480, 44));
		expect(container.scrollTop).toBe(1024);
	});

	it("leaves an element in view, or one with no layout, where it is", () => {
		const container = boxed(100, 400);
		container.scrollTop = 1000;
		scrollToShow(container, boxed(200, 44));
		scrollToShow(container, boxed(0, 0));
		expect(container.scrollTop).toBe(1000);
	});
});
