import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentsOverview } from "../lib/turnOverview";
import { liveIds, topLevelAgentRuns } from "../lib/turnOverview";
import type { Message, ToolRun } from "../types/message";

/**
 * What the agents line draws from (docs/turn-progress-ui.md#43-the-agents-line),
 * and whether its list is open. Held here, beside the transcript, because the
 * line moves between bubbles and slots, which remounts it.
 *
 * While the list is open it keeps the runs it shows whatever their status
 * since, so an entry that settles stays where it is under a finger. It closes
 * when its line moves or goes: the turn settling takes it out of the tail
 * slot, and a turn opening takes it off the turn-end row it stood above after
 * the last one.
 */
export function useAgentsOverview(
	messages: Message[],
	turnOpen: boolean,
	sessionId: string,
): AgentsOverview {
	// Kept while every run is the same object: the reducer leaves a run it did
	// not touch as it was, so a record that changes no agent hands back the same
	// overview, and the tail context it goes into stays put on every streamed
	// record.
	const agentRunsRef = useRef<ToolRun[]>([]);
	const agentRuns = useMemo(() => {
		const next = topLevelAgentRuns(messages);
		const prev = agentRunsRef.current;
		if (
			next.length === prev.length &&
			next.every((run, index) => run === prev[index])
		) {
			return prev;
		}
		agentRunsRef.current = next;
		return next;
	}, [messages]);
	const live = useMemo(() => liveIds(agentRuns), [agentRuns]);
	const liveRef = useRef(live);
	liveRef.current = live;
	// Null while the list is closed.
	const [held, setHeld] = useState<ReadonlySet<string> | null>(null);

	const onToggle = useCallback(() => {
		setHeld((prev) => (prev ? null : new Set(liveRef.current)));
	}, []);

	// An agent started while the list is open joins it, and then stays too.
	useLayoutEffect(() => {
		if (!held || live.every((id) => held.has(id))) return;
		setHeld((prev) => prev && new Set([...prev, ...live]));
	}, [held, live]);

	// Closed during the render that moves the line, not in an effect after it:
	// that commit already draws the line in its new slot, and an effect would
	// paint the open list there for a frame first.
	const [closedFor, setClosedFor] = useState({ turnOpen, sessionId });
	if (closedFor.turnOpen !== turnOpen || closedFor.sessionId !== sessionId) {
		setClosedFor({ turnOpen, sessionId });
		if (held) setHeld(null);
	}

	return useMemo(() => {
		const liveSet = new Set(live);
		const liveRuns = agentRuns.filter((run) => liveSet.has(run.id));
		return {
			liveCount: liveRuns.length,
			named: liveRuns.at(-1),
			entries: held
				? agentRuns.filter((run) => held.has(run.id) || liveSet.has(run.id))
				: [],
			expanded: held !== null,
			onToggle,
		};
	}, [agentRuns, live, held, onToggle]);
}
