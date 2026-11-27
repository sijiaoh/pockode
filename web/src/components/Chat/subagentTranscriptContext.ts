import { createContext, useContext } from "react";

/**
 * Opens a subagent's work as a transcript of its own, over the chat's
 * (docs/subagent-transcript-ui.md). `opener` is the ⤢ that was pressed, for
 * focus to come back to.
 */
export type OpenSubagentTranscript = (
	toolUseId: string,
	opener: HTMLElement,
) => void;

/**
 * A context because the ⤢ is in a row inside a memoized bubble, and the layer
 * is the chat's. Null where there is no layer to open: outside a chat, where a
 * Process heading offers no ⤢.
 */
export const SubagentTranscriptContext =
	createContext<OpenSubagentTranscript | null>(null);

export function useOpenSubagentTranscript(): OpenSubagentTranscript | null {
	return useContext(SubagentTranscriptContext);
}

/**
 * Marks a ⤢ with the run it opens, so focus coming back can find the one now
 * standing for that run when the bubble was redrawn under the layer.
 */
export const SUBAGENT_OPENER_ATTR = "data-subagent-opener";

/**
 * The ⤢ for focus to go back to: `opener` itself, or — when its bubble was
 * redrawn while it was out of reach — the one in `within` now standing for
 * the same run.
 */
export function openerOrSuccessor(
	opener: HTMLElement,
	within: ParentNode | null | undefined,
): HTMLElement | undefined {
	if (opener.isConnected) return opener;
	const runId = opener.getAttribute(SUBAGENT_OPENER_ATTR);
	return Array.from(
		within?.querySelectorAll<HTMLElement>(`[${SUBAGENT_OPENER_ATTR}]`) ?? [],
	).find((el) => el.getAttribute(SUBAGENT_OPENER_ATTR) === runId);
}
