import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { useTranscriptView } from "./transcriptViewContext";

const FOLD_PLACE_ATTR = "data-fold-place";

/**
 * Marks what a row folds back into when folding it also takes it out of sight:
 * a tool group's summary, for a row the user kept open while its group was
 * closed. Spread onto the summary's wrapper, ahead of its members.
 */
export const foldPlaceProps = { [FOLD_PLACE_ATTR]: "" };

/**
 * The height of the bar the innermost open row around this one pins at the
 * view's top. Every bar sticks to the same top, so that is all the outer rows
 * can cover.
 */
function coveredAbove(row: HTMLElement): number {
	const outerBar = row.parentElement
		?.closest(".row-bar ~ *")
		?.parentElement?.querySelector(":scope > .row-bar");
	return outerBar ? outerBar.getBoundingClientRect().height : 0;
}

/**
 * Where a row whose fold hid it went: the summary of the group it folded
 * into, which precedes its hidden slot among the list's slots.
 */
function foldPlace(slot: Element): HTMLElement | null {
	for (
		let el = slot.previousElementSibling;
		el;
		el = el.previousElementSibling
	) {
		if (el instanceof HTMLElement && el.hasAttribute(FOLD_PLACE_ATTR))
			return el;
	}
	return null;
}

interface Measured {
	row: HTMLElement;
	title: HTMLElement;
	/** Where the open rows around this one leave the view uncovered. */
	visibleFrom: number;
	rowOffset: number;
	titleOffset: number;
}

/**
 * Where an open row folding leaves the reader
 * (docs/tool-call-ui.md#folding-from-the-bar). Folded from its pinned bar —
 * the row starting above what can be seen — it lands with its top at the top
 * of the view, just under any outer row still pinned there; folded with its
 * title on screen, the title stays exactly where it was. Without this the body
 * vanishes under the reader, and whatever followed it is what they are left
 * on.
 *
 * Stated as a place for the transcript's own anchor rather than written to
 * `scrollTop` here, so nothing else holding the view undoes it — and so a
 * reader following the tail goes on following it when that place is the end.
 *
 * The title is held rather than the row's top because the two do not move
 * together: an open bar centres the first line in the row's floor, and a
 * closed two-line row puts it at the top of the box, a few pixels higher.
 *
 * Returns what to call just before the fold is asked for, while the open row
 * can still be measured; the landing happens once the fold has been laid out.
 */
export function useFoldLanding(
	barRef: RefObject<HTMLElement | null>,
	titleRef: RefObject<HTMLElement | null>,
	expanded: boolean,
): () => void {
	const view = useTranscriptView();
	const measuredRef = useRef<Measured | null>(null);

	useLayoutEffect(() => {
		const measured = measuredRef.current;
		measuredRef.current = null;
		if (expanded || !measured || !view) return;
		const { row, title, visibleFrom, rowOffset, titleOffset } = measured;
		const hiddenIn = row.closest("[hidden]");
		if (!hiddenIn) {
			// Half a pixel of slack: a row whose bar has just reached the edge
			// has not started above it, and both are laid out in fractions.
			if (rowOffset < visibleFrom - 0.5) view.holdAt(row, visibleFrom);
			else view.holdAt(title, titleOffset);
			return;
		}
		// Folded out of sight into its group. A hidden row measures as sitting
		// at the very top, so it is the group's summary that is landed on — and
		// only when that is above what can be seen, since the transcript's own
		// anchor already keeps whatever is above the reader still.
		const place = foldPlace(hiddenIn);
		if (
			place &&
			place.getBoundingClientRect().top - view.top() < visibleFrom - 0.5
		) {
			view.holdAt(place, visibleFrom);
		}
	}, [expanded, view]);

	return useCallback(() => {
		const row = barRef.current?.parentElement;
		const title = titleRef.current;
		if (!view || !row || !title) return;
		const edge = view.top();
		measuredRef.current = {
			row,
			title,
			visibleFrom: coveredAbove(row),
			rowOffset: row.getBoundingClientRect().top - edge,
			titleOffset: title.getBoundingClientRect().top - edge,
		};
	}, [view, barRef, titleRef]);
}
