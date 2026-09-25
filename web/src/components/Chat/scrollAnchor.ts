/**
 * Where a reader is looking, when they are not reading the tail.
 *
 * An anchor is an element plus how far below the container's top edge it sat,
 * and holding that pair still is the whole of "read somewhere": a page landing
 * above, a diagram settling, the keyboard opening and the container shrinking
 * are then all the same event — something moved the element, put it back.
 *
 * Positions are read through `offsetTop` rather than `getBoundingClientRect`,
 * because `offsetTop` does not change while the view scrolls and can therefore
 * be compared with a `scrollTop` recorded in an earlier frame. It is measured
 * against the nearest positioned ancestor, so every candidate has to be a node
 * the transcript itself owns and leaves unpositioned (the row wrapper in
 * `MessageList`, the part wrapper in `MessageItem`) — a component's own root may
 * be `relative` and would be measured against itself.
 */

const ANCHOR_ATTR = "data-scroll-anchor";

/**
 * Marks a node as something the view can be held still over. Spread onto the
 * wrapper: `<div {...anchorCandidateProps}>`.
 */
export const anchorCandidateProps = { [ANCHOR_ATTR]: "" };

export interface ScrollAnchor {
	el: HTMLElement;
	/** How far below the container's top edge the element's top edge sat. */
	offset: number;
}

/**
 * The elements the view may be held still over, in document order.
 *
 * Message rows *and* the top-level parts inside them: one assistant turn is a
 * single row and can be several screens tall, so a row anchor says nothing about
 * where inside it the reader is — a tool result that lands in the same bubble
 * above their eyes would push what they are reading down. Nothing inside a
 * collapsible body is a candidate, since collapsing it leaves the anchor with no
 * position at all.
 *
 * The first row and its first part are not candidates: when an older page's last
 * message is the other half of that turn the two are spliced into one bubble
 * that keeps this row's identity (see `prependHistoryPage`), so both the row and
 * its first part grow from the inside and holding either of them still holds
 * nothing still. Every candidate below them moves with that growth, which is
 * exactly what makes it measurable.
 */
export function anchorCandidates(container: HTMLElement): HTMLElement[] {
	const found = [
		...container.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}]`),
	];
	const [firstRow, next] = found;
	if (!firstRow) return found;
	return found.slice(next && firstRow.contains(next) ? 2 : 1);
}

/**
 * Takes the anchor for where the view sits now: the last candidate to start at
 * or above the top edge of the view.
 *
 * "Last" is what picks the part over the row containing it — both start above
 * the edge, and the part is the one whose movement tracks what the reader can
 * see. When the view is above every candidate (reading the very top of the
 * loaded history) the first candidate is used instead, which is the one the
 * paging seam leaves alone.
 */
export function pickAnchor(container: HTMLElement): ScrollAnchor | null {
	const candidates = anchorCandidates(container);
	if (candidates.length === 0) return null;
	const viewTop = container.scrollTop;
	// Searched rather than walked: this runs on every scroll event, and a long
	// session has thousands of candidates — a walk would read that many offsets
	// per event while the reader's finger is still moving. Document order is
	// top-to-bottom order, which is what makes the search sound; a row and its
	// first part start at the same offset, so what is wanted is the *last* index
	// at or above the edge.
	let low = 0;
	let high = candidates.length - 1;
	let chosen = 0;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (candidates[mid].offsetTop <= viewTop) {
			chosen = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	const el = candidates[chosen];
	return { el, offset: el.offsetTop - viewTop };
}

/**
 * The candidate `el` sits in, or `el` itself when it is not inside one.
 *
 * What a jump anchors to: the card asked for is inside a part wrapper, and the
 * wrapper is the node whose `offsetTop` can be trusted (see the note on
 * measuring above).
 */
export function enclosingCandidate(el: HTMLElement): HTMLElement {
	return el.closest<HTMLElement>(`[${ANCHOR_ATTR}]`) ?? el;
}

/** Where the view has to sit for the anchored element to be back in place. */
export function anchorScrollTop(anchor: ScrollAnchor): number {
	return anchor.el.offsetTop - anchor.offset;
}
