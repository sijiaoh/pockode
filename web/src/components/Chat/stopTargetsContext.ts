import { createContext, useContext, useRef } from "react";
import { loadedStopTargets } from "../../lib/taskStop";
import type { Message } from "../../types/message";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The calls a stop points at whose rows are loaded (`loadedStopTargets`). A
 * context for the reason `SubagentResumesContext` is one: the answer is the
 * whole transcript's — the work stopped is usually in an earlier bubble than
 * the stop — and the reader is a row inside one.
 */
export const StopTargetsContext = createContext(EMPTY);

/** Whether the row of the call a stop names is loaded, to be gone to. */
export function useIsStopTargetLoaded(toolUseId: string | undefined): boolean {
	const targets = useContext(StopTargetsContext);
	return toolUseId !== undefined && targets.has(toolUseId);
}

function sameTargets(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}

/**
 * The value to provide, kept the same object while what it says does not
 * change, so a streamed token does not redraw every stop's body.
 */
export function useStopTargetsValue(messages: Message[]): ReadonlySet<string> {
	const previous = useRef<ReadonlySet<string>>(EMPTY);
	const next = loadedStopTargets(messages);
	if (!sameTargets(previous.current, next)) previous.current = next;
	return previous.current;
}
