/** The nearest ancestor of `el` that scrolls vertically. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if (overflowY === "auto" || overflowY === "scroll") return node;
	}
	return null;
}

/**
 * Scrolls `container` the least that shows all of `el`, and nothing when it
 * is already in view or nothing is laid out (a hidden tab or drawer).
 * `scrollIntoView` would also scroll every ancestor that can scroll, the app
 * shell included.
 */
export function scrollToShow(container: HTMLElement, el: HTMLElement): void {
	const box = container.getBoundingClientRect();
	const rect = el.getBoundingClientRect();
	if (rect.height === 0) return;
	if (rect.top < box.top) {
		container.scrollTop -= box.top - rect.top;
	} else if (rect.bottom > box.bottom) {
		container.scrollTop += Math.min(
			rect.bottom - box.bottom,
			rect.top - box.top,
		);
	}
}
