/**
 * The two heights a scrolling container is made of. jsdom measures nothing, so
 * anything that reasons about where the view sits has to be told.
 */
export interface ScrollBox {
	/** `scrollHeight`: how tall the content is. */
	contentHeight: number;
	/** `clientHeight`: how much of it is on screen. */
	viewportHeight: number;
}

/**
 * Gives `el` a pair of heights that a test can move.
 *
 * The returned box stays live: writing to it is how a test says the output grew
 * or the software keyboard took half the screen. Both heights are read through
 * getters for that reason, and because `scrollTop` clamps against them (see
 * `src/test/setup.ts`) — a box whose content height lies makes the clamp lie
 * with it, which is the one thing these stubs exist to prevent.
 */
export function stubScrollBox(el: HTMLElement, box: ScrollBox): ScrollBox {
	Object.defineProperty(el, "scrollHeight", {
		configurable: true,
		get: () => box.contentHeight,
	});
	Object.defineProperty(el, "clientHeight", {
		configurable: true,
		get: () => box.viewportHeight,
	});
	return box;
}

/**
 * The offset the bottom of the content sits at — what a browser clamps a
 * scroll-to-the-end write down to, and therefore what "pinned to the tail"
 * means in an assertion.
 */
export function maxScrollTop(box: ScrollBox): number {
	return Math.max(0, box.contentHeight - box.viewportHeight);
}
