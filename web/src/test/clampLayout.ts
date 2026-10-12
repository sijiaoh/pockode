import { vi } from "vitest";

/**
 * Lays out every `ClampedContent` for jsdom, which does none: the content is
 * `height` tall, and a box with a max-height stops at the smallest budget, 8
 * lines (+ 6 while uncut). Restored by `vi.restoreAllMocks()`.
 */
export function layOutClamp(height: number) {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
		height,
	);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			if (this.hasAttribute("data-clamped")) return 128;
			return this.style.maxHeight ? Math.min(height, 224) : height;
		},
	);
}
