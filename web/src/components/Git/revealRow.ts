import { type RefObject, useLayoutEffect } from "react";

/**
 * Scrolls `scroller` the least that shows `top`–`bottom` of its content
 * (offsets from the content's top edge), below whatever its own children pin
 * to its top — the Changes header, the branch filter — which a row scrolled
 * up to the edge would sit under.
 */
export function scrollSpanIntoView(
	scroller: HTMLElement,
	top: number,
	bottom: number,
) {
	let pinned = 0;
	for (const child of scroller.children) {
		if (getComputedStyle(child).position === "sticky") {
			pinned = Math.max(pinned, (child as HTMLElement).offsetHeight);
		}
	}
	const viewTop = scroller.scrollTop + pinned;
	const viewBottom = scroller.scrollTop + scroller.clientHeight;
	if (top < viewTop) scroller.scrollTop -= viewTop - top;
	else if (bottom > viewBottom) scroller.scrollTop += bottom - viewBottom;
}

/**
 * While `reveal` is given, scrolls the lit row (`aria-current="true"`) under
 * `scrollerRef` into view and calls `reveal` once it has. Checked on every
 * render, so a row that arrives with data later than the request is still
 * found.
 */
export function useRevealLitRow(
	scrollerRef: RefObject<HTMLElement | null>,
	reveal: (() => void) | undefined,
) {
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		if (!reveal || !scroller) return;
		const row = scroller.querySelector<HTMLElement>('[aria-current="true"]');
		if (!row) return;
		const top =
			row.getBoundingClientRect().top -
			scroller.getBoundingClientRect().top +
			scroller.scrollTop;
		scrollSpanIntoView(scroller, top, top + row.offsetHeight);
		reveal();
	});
}
