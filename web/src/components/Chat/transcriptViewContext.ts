import { createContext, useContext } from "react";
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
