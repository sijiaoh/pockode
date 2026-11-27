import { useCallback, useMemo, useState } from "react";
import type { PlanOverview } from "../lib/turnOverview";
import { currentPlan } from "../lib/turnOverview";
import type { Message } from "../types/message";

/**
 * The open turn's plan (docs/turn-progress-ui.md#42-the-plan-line), and
 * whether its checklist is open. Held here, beside the transcript, because the
 * line moves to a new bubble at every read point, which remounts it.
 *
 * Only the user opens or closes the checklist, and it stays open across
 * updates. It closes when its line goes: the turn settling, another session,
 * or the agent clearing its list.
 */
export function usePlanOverview(
	messages: Message[],
	turnOpen: boolean,
	sessionId: string,
): PlanOverview {
	const plan = useMemo(
		() => currentPlan(messages, turnOpen),
		[messages, turnOpen],
	);
	const [expanded, setExpanded] = useState(false);
	const onToggle = useCallback(() => setExpanded((prev) => !prev), []);

	// Closed during the render the line goes in, so a line coming back later
	// starts closed rather than reopening on its own.
	const [closedFor, setClosedFor] = useState({ turnOpen, sessionId });
	if (closedFor.turnOpen !== turnOpen || closedFor.sessionId !== sessionId) {
		setClosedFor({ turnOpen, sessionId });
		if (expanded) setExpanded(false);
	} else if (!plan && expanded) {
		setExpanded(false);
	}

	return useMemo(
		() => ({ plan, expanded: expanded && plan !== undefined, onToggle }),
		[plan, expanded, onToggle],
	);
}
