import { useMemo, useRef, useState } from "react";
import { liveResumes, resumedRun } from "../lib/subagentRun";
import type { AgentsOverview } from "../lib/turnOverview";
import { liveIds, topLevelAgentRuns } from "../lib/turnOverview";
import type { Message, ToolRun } from "../types/message";

/**
 * What the agents chip and the panel's agents section draw from
 * (docs/turn-progress-ui.md#43-the-agents). Held here, beside the
 * transcript, because the line moves between bubbles and slots, which remounts
 * it.
 *
 * While the panel is open (`expanded`, the panel's one flag) it keeps the runs
 * it lists whatever their status since, so an entry that settles stays where
 * it is under a finger.
 */
export function useAgentsOverview(
	messages: Message[],
	expanded: boolean,
): AgentsOverview {
	// Each run as its row draws it: a resumed subagent is running again, on the
	// call that resumed it (`resumedRun`), so it counts and is named as live.
	//
	// Kept while every run and every resume is the same object: the reducer
	// leaves a run it did not touch as it was, so a record that changes no agent
	// hands back the same overview, and the tail context it goes into stays put
	// on every streamed record.
	const sourceRef = useRef<{ run: ToolRun; resume?: ToolRun }[]>([]);
	const agentRunsRef = useRef<ToolRun[]>([]);
	const agentRuns = useMemo(() => {
		const resumes = liveResumes(messages);
		const next = topLevelAgentRuns(messages).map((run) => ({
			run,
			resume: resumes.get(run.id),
		}));
		const prev = sourceRef.current;
		if (
			next.length === prev.length &&
			next.every(
				(entry, index) =>
					entry.run === prev[index].run && entry.resume === prev[index].resume,
			)
		) {
			return agentRunsRef.current;
		}
		sourceRef.current = next;
		agentRunsRef.current = next.map(({ run, resume }) =>
			resume ? resumedRun(run, resume) : run,
		);
		return agentRunsRef.current;
	}, [messages]);
	const live = useMemo(() => liveIds(agentRuns), [agentRuns]);
	// Null while the panel is closed. Kept in step during render, not in an
	// effect after it, so no frame paints the panel open over the wrong list:
	// opening takes the live runs, an agent started while it is open joins and
	// then stays too, and closing lets them all go.
	const [held, setHeld] = useState<ReadonlySet<string> | null>(null);
	if (!expanded) {
		if (held) setHeld(null);
	} else if (!held) {
		setHeld(new Set(live));
	} else if (!live.every((id) => held.has(id))) {
		setHeld(new Set([...held, ...live]));
	}

	return useMemo(() => {
		const liveSet = new Set(live);
		const liveRuns = agentRuns.filter((run) => liveSet.has(run.id));
		return {
			liveCount: liveRuns.length,
			named: liveRuns.at(-1),
			entries: expanded
				? agentRuns.filter((run) => held?.has(run.id) || liveSet.has(run.id))
				: [],
		};
	}, [agentRuns, live, held, expanded]);
}
