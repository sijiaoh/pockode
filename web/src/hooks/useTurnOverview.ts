import { useCallback, useMemo, useState } from "react";
import type { AgentsOverview, TurnPanel } from "../lib/turnOverview";
import { currentPlan, overviewMessageId } from "../lib/turnOverview";
import type { Message, ToolRunPlan } from "../types/message";
import { useAgentsOverview } from "./useAgentsOverview";

export interface TurnOverview {
	plan?: ToolRunPlan;
	agents: AgentsOverview;
	panel: TurnPanel;
	/** See `overviewMessageId` in lib/turnOverview.ts. */
	overviewMessageId?: string;
}

/**
 * Everything the status line reads besides the phase and the thinking: the
 * open turn's plan, its agents, and whether the one panel is open
 * (docs/turn-progress-ui.md#4-what-is-running-and-the-plan). Held here, beside
 * the transcript, because the line moves to a new bubble at every read point,
 * and to the last reply's turn-end row after the turn, which remounts it.
 *
 * Only the user opens the panel. It closes when the turn settles, when the
 * next turn opens, on another session, and when its last section goes — not
 * when one of several does, such as the agent clearing its plan. A panel left
 * open with nothing in it would open by itself on whatever came next: the
 * next thought, around nearly every codex call.
 */
export function useTurnOverview(
	messages: Message[],
	turnOpen: boolean,
	sessionId: string,
	/** The panel has a thinking section: the agent is thinking, with text. */
	thinkingSection: boolean,
): TurnOverview {
	const [expanded, setExpanded] = useState(false);
	const onToggle = useCallback(() => setExpanded((prev) => !prev), []);
	// Closed during the render that moves the line, not in an effect after it:
	// that commit already draws the line in its new slot, and an effect would
	// paint the open panel there for a frame first.
	const [closedFor, setClosedFor] = useState({ turnOpen, sessionId });
	const reset =
		closedFor.turnOpen !== turnOpen || closedFor.sessionId !== sessionId;
	if (reset) {
		setClosedFor({ turnOpen, sessionId });
		if (expanded) setExpanded(false);
	}
	const open = expanded && !reset;

	const plan = useMemo(
		() => currentPlan(messages, turnOpen),
		[messages, turnOpen],
	);
	const agents = useAgentsOverview(messages, open);
	const empty =
		!plan &&
		!thinkingSection &&
		agents.liveCount === 0 &&
		agents.entries.length === 0;
	if (open && empty) setExpanded(false);
	const shown = open && !empty;
	const panel = useMemo(
		() => ({ expanded: shown, onToggle }),
		[shown, onToggle],
	);
	return {
		plan,
		agents,
		panel,
		overviewMessageId: overviewMessageId(
			messages,
			turnOpen,
			agents.liveCount > 0 || shown,
		),
	};
}
