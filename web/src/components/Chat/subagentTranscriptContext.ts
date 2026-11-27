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
 * Marks an opener with the run it opens — a ⤢, an agents-list entry, a strip
 * task — so focus coming back can find what now stands for that run when the
 * opener itself is gone: its bubble was redrawn under the layer, or its list
 * closed meanwhile.
 */
export const SUBAGENT_OPENER_ATTR = "data-subagent-opener";

function shown(el: HTMLElement): boolean {
	return el.closest("[hidden]") === null;
}

/**
 * Where focus goes back to: `opener` itself; or, when it has gone, the ⤢ in
 * `within` now standing for the same run; or, when that ⤢ is in a body that is
 * closed — and an opener from outside the row, such as an agents-list entry,
 * never needed it open — the run's row.
 */
export function openerOrSuccessor(
	opener: HTMLElement,
	within: ParentNode | null | undefined,
): HTMLElement | undefined {
	if (opener.isConnected) return opener;
	const runId = opener.getAttribute(SUBAGENT_OPENER_ATTR);
	if (runId === null || !within) return undefined;
	const successor = Array.from(
		within.querySelectorAll<HTMLElement>(`[${SUBAGENT_OPENER_ATTR}]`),
	).find((el) => el.getAttribute(SUBAGENT_OPENER_ATTR) === runId && shown(el));
	if (successor) return successor;
	const row = Array.from(
		within.querySelectorAll<HTMLElement>("[data-tool-use-id]"),
	).find((el) => el.dataset.toolUseId === runId && shown(el));
	return row?.querySelector<HTMLElement>("button") ?? undefined;
}
