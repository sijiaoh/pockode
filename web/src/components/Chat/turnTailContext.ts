import { createContext, useContext } from "react";
import type { TurnTail } from "../../lib/thinking";

export const IDLE_TAIL: TurnTail = {
	phase: "idle",
	thinking: null,
	onToggleThinking: () => {},
};

/**
 * A context rather than props because the reader is one slot inside one
 * memoized bubble, and the thinking text changes several times a second:
 * threading it through would re-render every bubble with it.
 */
export const TurnTailContext = createContext<TurnTail>(IDLE_TAIL);

export function useTurnTail(): TurnTail {
	return useContext(TurnTailContext);
}

/**
 * Thinking rows that settled from a tail line the user had opened. They open
 * as they settle — nothing closes what the user opened — so a list reads its
 * rows' first choice from here (docs/turn-progress-ui.md#13-opening-it).
 */
export const OpenedThoughtsContext = createContext<ReadonlySet<string>>(
	new Set(),
);
