import { type RefObject, useEffect } from "react";

const STUCK_ATTR = "data-stuck";

function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if (overflowY === "auto" || overflowY === "scroll") return node;
	}
	return null;
}

/**
 * Marks a `row-bar` with `data-stuck` while it is pinned to the top of its
 * scroller, which CSS cannot ask: the hairline under a pinned bar, and an
 * outer bar giving way to an inner one, both hang on it (`row-bar` in
 * `src/index.css`).
 *
 * Pinned means the row has started above the scroller's top edge and the bar
 * still sits at that edge: one the end of its row has begun to carry out is no
 * longer pinned, so a bar it covered shows again under it as it leaves. Only
 * read while `active`, so a transcript of closed rows listens to nothing. Read
 * on scroll, on the row changing size — a row folded away by its parent
 * closing is `display: none`, and the flag it held must not outlive it — and
 * on the scroller's content changing size: a row above this one growing inside
 * the same Process moves it without a scroll, since nothing inside a body is
 * an anchor the view is held by.
 *
 * The bar is expected to be its row's first child, the row being the box it
 * sticks inside.
 */
export function useStuckBar(
	ref: RefObject<HTMLElement | null>,
	active: boolean,
) {
	useEffect(() => {
		const bar = ref.current;
		const row = bar?.parentElement;
		if (!active || !bar || !row) return;
		const scroller = scrollParent(row);
		if (!scroller) return;

		const update = () => {
			const edge = scroller.getBoundingClientRect().top;
			const box = row.getBoundingClientRect();
			// No height is a row that is not displayed, whose box reads as zeros.
			const stuck =
				box.height > 0 &&
				box.top < edge &&
				// Half a pixel of slack: a pinned bar's top is the scroller's,
				// and both are laid out in fractions.
				bar.getBoundingClientRect().top > edge - 0.5;
			bar.toggleAttribute(STUCK_ATTR, stuck);
		};

		// Called directly rather than on the next frame: a scroll event is
		// already dispatched once per frame, and a resize is delivered after
		// layout and before paint, so either way the flag is right in the
		// frame that needs it — a frame later, an outer bar would flash blank
		// over a Process that had just folded.
		update();
		scroller.addEventListener("scroll", update, { passive: true });
		const resize = new ResizeObserver(update);
		resize.observe(row);
		for (const content of scroller.children) resize.observe(content);
		return () => {
			scroller.removeEventListener("scroll", update);
			resize.disconnect();
			bar.removeAttribute(STUCK_ATTR);
		};
	}, [ref, active]);
}
