import { create } from "zustand";
import type { AgentEfforts, AgentModels, AgentOption } from "../types/message";
import type { AgentType } from "../types/settings";

interface AgentOptionsState {
	/** Null until the fetch has answered; still set when a later fetch fails. */
	models: AgentModels | null;
	efforts: AgentEfforts | null;
	error: string | null;
}

interface AgentOptionsActions {
	setModels: (models: AgentModels) => void;
	setEfforts: (efforts: AgentEfforts) => void;
	setError: (error: string) => void;
}

type AgentOptionsStore = AgentOptionsState & AgentOptionsActions;

/**
 * What each agent offers: its models and its effort levels. Server-wide
 * constants, fetched once per connection rather than per session or per panel
 * open — the selector needs the lists of the agent it is *about to* switch to as
 * much as the current one's.
 *
 * Both lists in one store behind one error, because they are fetched together:
 * an effort list missing on its own and an agent that simply has no effort
 * levels are indistinguishable in the UI (each leaves only Auto), so the two
 * halves must never be able to disagree about whether an answer arrived at all.
 *
 * No `isLoading`: "no answer has arrived" is exactly `models === null &&
 * error === null`, and a third field would let the three disagree.
 */
export const useAgentOptionsStore = create<AgentOptionsStore>((set) => ({
	models: null,
	efforts: null,
	error: null,
	setModels: (models) => set({ models, error: null }),
	setEfforts: (efforts) => set({ efforts, error: null }),
	setError: (error) => set({ error }),
}));

// A stable empty list: a fresh one per selector call would never compare equal
// and would re-render on every store read.
const NO_OPTIONS: AgentOption[] = [];

export function useModelsForAgent(
	agentType: AgentType,
): AgentOption[] | undefined {
	return useAgentOptionsStore((s) => s.models?.[agentType]);
}

/**
 * Undefined until the lists arrive; an empty list means this agent has no effort
 * setting at all, which the server reports by leaving it out of the map. The two
 * have to stay apart: one is "we do not know yet", the other is an answer.
 */
export function useEffortsForAgent(
	agentType: AgentType,
): AgentOption[] | undefined {
	return useAgentOptionsStore((s) =>
		s.efforts ? (s.efforts[agentType] ?? NO_OPTIONS) : undefined,
	);
}
