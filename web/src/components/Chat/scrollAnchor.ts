import { coveredAbove, foldPlace } from "./useFoldLanding";

/**
 * Where a reader is looking, when they are not reading the tail.
 *
 * An anchor is an element plus how far below the container's top edge it sat,
 * and holding that pair still is almost the whole of "read somewhere": a
 * diagram settling, a card expanding, the keyboard opening and the container
 * shrinking are then all the same event — something moved the element, put it
 * back. The one exception is a page landing above, which is held by the seam
 * instead (`Seam`).
 *
 * The element is the finest thing at the top edge along a path: the row, the
 * part inside it, the top-level block of that part's Markdown, the section of
 * an open tool row. One part can be several screens of prose, so anything
 * coarser lets a diagram or an image settling above the reader inside the same
 * part push them away. The rest of the path is kept beside it, each level with
 * its own offset, because it is what the anchor falls back on.
 *
 * Positions are read from the layout (`getBoundingClientRect`) and turned into
 * transcript coordinates — distance below the top of the content, which does
 * not change while the view scrolls and can therefore be compared with a
 * `scrollTop` recorded in an earlier frame. That works for any element, so a
 * candidate can be whatever node is natural to mark, positioned or not.
 */

const ANCHOR_ATTR = "data-scroll-anchor";
const BLOCKS_ATTR = "data-scroll-anchor-blocks";
/** Anything that is, or holds, a candidate. */
const MARKED = `[${ANCHOR_ATTR}], [${BLOCKS_ATTR}]`;

/**
 * Marks a node as something the view can be held still over. Spread onto it:
 * `<div {...anchorCandidateProps}>`.
 */
export const anchorCandidateProps = { [ANCHOR_ATTR]: "" };

/**
 * Marks a node whose children are each a candidate — a Markdown root, whose
 * top-level blocks are rendered by a library that offers no hook on each.
 */
export const anchorBlocksProps = { [BLOCKS_ATTR]: "" };

/**
 * Half a pixel: positions read from the layout are fractional, and an element
 * flush with the edge has not started below it.
 */
const EDGE_SLACK = 0.5;

interface Hold {
	el: HTMLElement;
	/** How far below the container's top edge the element's top edge sat. */
	offset: number;
}

export interface ScrollAnchor {
	/**
	 * The row first, the anchored element last, every level between them.
	 * Never empty.
	 */
	path: Hold[];
}

function isCandidate(el: HTMLElement): boolean {
	return (
		el.hasAttribute(ANCHOR_ATTR) ||
		(el.parentElement?.hasAttribute(BLOCKS_ATTR) ?? false)
	);
}

function holdsCandidates(el: HTMLElement): boolean {
	return el.hasAttribute(BLOCKS_ATTR) || el.querySelector(MARKED) !== null;
}

/**
 * The candidates one level below `parent`, in document order: the nearest
 * marked descendants, none inside another or a `hidden` subtree.
 */
function candidatesIn(parent: HTMLElement): HTMLElement[] {
	const found: HTMLElement[] = [];
	const visit = (el: HTMLElement) => {
		for (const child of el.children) {
			if (!(child instanceof HTMLElement) || child.hidden) continue;
			if (isCandidate(child)) found.push(child);
			// Asked natively before walking: the deepest levels hold no candidates
			// and can be thousands of nodes — a highlighted code block, a long diff
			// — which this runs over on every scroll event.
			else if (holdsCandidates(child)) visit(child);
		}
	};
	visit(parent);
	return found;
}

function laidOut(container: HTMLElement, el: HTMLElement): boolean {
	// An element that is not displayed has no boxes, and measures as sitting at
	// the top of the loaded transcript: holding it still would carry the reader
	// there.
	return container.contains(el) && el.getClientRects().length > 0;
}

/**
 * Where `el`'s top edge sits in the transcript, or null when it is not laid
 * out.
 */
function transcriptTop(container: HTMLElement, el: HTMLElement): number | null {
	if (el.getClientRects().length === 0) return null;
	return (
		el.getBoundingClientRect().top -
		container.getBoundingClientRect().top -
		container.clientTop +
		container.scrollTop
	);
}

/**
 * The last of `list` to start at or above `edge`, skipping any that are not
 * laid out.
 *
 * Searched rather than walked: this runs on every scroll event, and a long
 * session has thousands of rows — a walk would read that many positions per
 * event while the reader's finger is still moving. Document order is
 * top-to-bottom order, which is what makes the search sound.
 */
function lastAtOrAbove(
	container: HTMLElement,
	list: HTMLElement[],
	edge: number,
): Hold | null {
	let low = 0;
	let high = list.length - 1;
	let found: Hold | null = null;
	while (low <= high) {
		const mid = (low + high) >> 1;
		let probe = mid;
		let top = transcriptTop(container, list[probe]);
		while (top === null && probe < high) {
			probe++;
			top = transcriptTop(container, list[probe]);
		}
		if (top === null || top > edge + EDGE_SLACK) {
			high = mid - 1;
		} else {
			found = { el: list[probe], offset: top - edge };
			low = probe + 1;
		}
	}
	return found;
}

function firstLaidOut(
	container: HTMLElement,
	list: HTMLElement[],
	edge: number,
): Hold | null {
	for (const el of list) {
		const top = transcriptTop(container, el);
		if (top !== null) return { el, offset: top - edge };
	}
	return null;
}

/**
 * Takes the anchor for where the view sits now: from the rows down, at each
 * level the last candidate to start at or above the top edge of the view, as
 * deep as the path goes. When the view is above every row (reading the very top
 * of the loaded history, over the reserve above it), the first row is used
 * instead, from below the edge.
 *
 * Every row is a candidate, the first one too: a page landing above is not held
 * by the anchor at all (`takeSeam`), so a row growing from the inside as a page
 * splices into it never has to be held still by.
 */
export function pickAnchor(container: HTMLElement): ScrollAnchor | null {
	const rows = candidatesIn(container);
	const edge = container.scrollTop;

	const path: Hold[] = [];
	let level = rows;
	for (;;) {
		const found = lastAtOrAbove(container, level, edge);
		if (!found) break;
		path.push(found);
		level = candidatesIn(found.el);
	}
	if (path.length > 0) return { path };

	const below = firstLaidOut(container, rows, edge);
	return below && { path: [below] };
}

/**
 * The anchor for `el` where it sits now, with the candidates around it as the
 * path above it. What a jump anchors to: the card asked for need not be a
 * candidate itself.
 */
export function anchorOn(
	container: HTMLElement,
	el: HTMLElement,
): ScrollAnchor {
	const edge = container.scrollTop;
	const path: Hold[] = [];
	for (
		let node: HTMLElement | null = el;
		node && node !== container;
		node = node.parentElement
	) {
		if (node !== el && !isCandidate(node)) continue;
		path.unshift({
			el: node,
			offset: (transcriptTop(container, node) ?? 0) - edge,
		});
	}
	return { path };
}

/**
 * What of `anchor` can still say where the reader is, as the anchor to hold
 * from now on — `anchor` itself while its element holds, null once nothing on
 * its path does.
 *
 * An element can leave the container — a tool row replaced by the card that
 * took its place — or stay in it without being laid out: a row folded into a
 * tool group is only `hidden`. A row folded into a group stands in for itself
 * by the group's summary (`foldPlaceProps`), kept where the row's top was but
 * never above the view's top or under a bar pinned there, just as a fold the
 * reader made lands (`useFoldLanding`). Anything else lost gives way to the
 * next level up, held where that level sat.
 *
 * Never a fresh anchor taken from where the view sits to put this look right:
 * the commit that lost the anchor has already moved everything, so what is at
 * the edge now is not what the reader was looking at — one is taken there only
 * for the next look (`useTranscriptScroll`). That is how a lost anchor used to become a reader
 * stuck at the top of the history.
 */
export function holdingAnchor(
	container: HTMLElement,
	anchor: ScrollAnchor,
): ScrollAnchor | null {
	const { path } = anchor;
	for (let i = path.length - 1; i >= 0; i--) {
		const { el, offset } = path[i];
		const parent = path[i - 1]?.el ?? container;
		if (laidOut(container, el)) {
			return i === path.length - 1 ? anchor : { path: path.slice(0, i + 1) };
		}
		const foldedIn =
			container.contains(el) && el.closest<HTMLElement>("[hidden]");
		if (!foldedIn || foldedIn === parent || !parent.contains(foldedIn)) {
			continue;
		}
		const place = foldPlace(foldedIn);
		if (place && laidOut(container, place)) {
			return {
				path: [
					...path.slice(0, i),
					{ el: place, offset: Math.max(offset, coveredAbove(place)) },
				],
			};
		}
	}
	return null;
}

/**
 * Where a page landing is held: the first loaded row and where its bottom edge
 * sat in the transcript.
 *
 * A page only ever adds content above that edge — rows before the first one, or
 * the older half of its turn spliced into it from the top (`prependHistoryPage`
 * keeps the row's identity, so it is the same node). The rows sit on the
 * bottom edge of their track, so nothing added above the edge moves it: what
 * does, in the commit a page lands in, is output landing at the end, which
 * carries the reader by as much wherever they are reading. How far the edge
 * moved is therefore how far the reader was carried.
 *
 * Neither of the two other measures says that. The content's total height
 * counts the page and that output together. The anchor says it only of an
 * element the page left alone, which inside a spliced row it may not have: the
 * part it names can have grown above its own top edge.
 */
export interface Seam {
	row: HTMLElement;
	/** Where the row's bottom edge sat, in transcript coordinates. */
	bottom: number;
}

/** The seam as it sits now, to hold if the next commit is a page landing. */
export function takeSeam(container: HTMLElement): Seam | null {
	// The first marked node in document order is the first row: a row comes
	// before everything marked inside it.
	const row = container.querySelector<HTMLElement>(`[${ANCHOR_ATTR}]`);
	const top = row && transcriptTop(container, row);
	if (!row || top === null) return null;
	return { row, bottom: top + row.getBoundingClientRect().height };
}

/**
 * Where the view would sit had it moved with `seam` since it was taken, or
 * null when its row is no longer laid out.
 */
export function seamScrollTop(
	container: HTMLElement,
	seam: Seam,
): number | null {
	if (!laidOut(container, seam.row)) return null;
	const top = transcriptTop(container, seam.row) ?? 0;
	const bottom = top + seam.row.getBoundingClientRect().height;
	return container.scrollTop + bottom - seam.bottom;
}

/** Where the view has to sit for the anchored element to be back in place. */
export function anchorScrollTop(
	container: HTMLElement,
	anchor: ScrollAnchor,
): number {
	const { el, offset } = anchor.path[anchor.path.length - 1];
	return (transcriptTop(container, el) ?? 0) - offset;
}
