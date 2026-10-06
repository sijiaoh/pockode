import { createContext, type RefObject, useContext, useMemo } from "react";
import type { ClampView } from "../ui";

/**
 * The transcript's scroll position, for the rows inside it that move the
 * reader on purpose — an open row folding from its pinned bar, a cut block
 * opening or closing. Null outside a transcript, where nothing is anchored and
 * a row only folds.
 *
 * The same shape as `ClampView`, which is declared beside the clamp because
 * `ui` cannot reach into `Chat`; this is the transcript's
 * (`useTranscriptScroll`).
 */
export type TranscriptView = ClampView;

export const TranscriptViewContext = createContext<TranscriptView | null>(null);

export function useTranscriptView(): TranscriptView | null {
	return useContext(TranscriptViewContext);
}

/**
 * The same view over a box that scrolls on its own inside the transcript — a
 * thought's — for the blocks read in it: their place is the box's scroll
 * position, which the transcript's anchor knows nothing of. No bar is pinned
 * over it, and nothing else holds it, so a place is written straight to its
 * `scrollTop`.
 */
export function useScrollerView(
	ref: RefObject<HTMLElement | null>,
): TranscriptView {
	return useMemo(
		() => ({
			top: () => ref.current?.getBoundingClientRect().top ?? 0,
			bottom: () => ref.current?.getBoundingClientRect().bottom ?? 0,
			scrollTop: () => ref.current?.scrollTop ?? 0,
			coveredAbove: () => 0,
			holdAt: (el, offset) => {
				const scroller = ref.current;
				if (!scroller) return;
				scroller.scrollTop +=
					el.getBoundingClientRect().top -
					scroller.getBoundingClientRect().top -
					offset;
			},
		}),
		[ref],
	);
}
