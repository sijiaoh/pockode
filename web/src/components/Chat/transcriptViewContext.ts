import { createContext, useContext } from "react";

/**
 * The transcript's scroll position, for the rows inside it that move the
 * reader on purpose — an open row folding from its pinned bar. Null outside a
 * transcript, where nothing is anchored and a row only folds.
 */
export interface TranscriptView {
	/** The view's top edge, in client coordinates. */
	top: () => number;
	/**
	 * Puts `el`'s top `offset` pixels below the view's top edge and reads from
	 * there, through the transcript's own anchor (`useTranscriptScroll`).
	 */
	holdAt: (el: HTMLElement, offset: number) => void;
}

export const TranscriptViewContext = createContext<TranscriptView | null>(null);

export function useTranscriptView(): TranscriptView | null {
	return useContext(TranscriptViewContext);
}
