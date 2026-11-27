import { createContext } from "react";
import type { TurnTail } from "../../lib/thinking";
import { createSelectableContext } from "./selectableContext";

export const IDLE_TAIL: TurnTail = {
	phase: "idle",
	thinking: null,
	agents: { liveCount: 0, entries: [] },
	panel: { expanded: false, onToggle: () => {} },
};

/**
 * A context rather than props because the reader is one slot inside one
 * memoized bubble, and the thinking text changes several times a second:
 * threading it through would re-render every bubble with it. Selectable,
 * because the agents in it change on every record a subagent writes, and a
 * plain context changing walks every bubble of the transcript for its readers.
 */
const [TurnTailContext, useSelectTurnTail] =
	createSelectableContext<TurnTail>(IDLE_TAIL);

export { TurnTailContext };

/** The whole tail, for the slot of the reply being written. */
export function useTurnTail(): TurnTail {
	return useSelectTurnTail(whole);
}

/**
 * The tail if this reply's turn-end slot draws the agents
 * (`overviewMessageId`), else the idle one: a settled reply redraws only when
 * it becomes or stops being that reply, or while it is.
 */
export function useOverviewTail(messageId: string): TurnTail {
	return useSelectTurnTail((tail) =>
		tail.overviewMessageId === messageId ? tail : IDLE_TAIL,
	);
}

function whole(tail: TurnTail): TurnTail {
	return tail;
}

/**
 * Thinking rows that settled under a panel the user had opened. They open
 * as they settle — nothing closes what the user opened — so a list reads its
 * rows' first choice from here (docs/turn-progress-ui.md#13-opening-it).
 */
export const OpenedThoughtsContext = createContext<ReadonlySet<string>>(
	new Set(),
);
