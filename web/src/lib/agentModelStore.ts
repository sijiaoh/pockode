import { create } from "zustand";
import type { AgentModels, ModelOption } from "../types/message";
import type { AgentType } from "../types/settings";

interface AgentModelState {
	/** Null until `session.models` has answered; still set when a later fetch fails. */
	models: AgentModels | null;
	error: string | null;
}

interface AgentModelActions {
	setModels: (models: AgentModels) => void;
	setError: (error: string) => void;
}

type AgentModelStore = AgentModelState & AgentModelActions;

/**
 * The models each agent offers. Server-wide constants, fetched once per
 * connection rather than per session or per panel open — the selector needs the
 * list of the agent it is *about to* switch to as much as the current one.
 *
 * No `isLoading`: "neither answer has arrived" is exactly `models === null &&
 * error === null`, and a third field would let the three disagree.
 */
export const useAgentModelStore = create<AgentModelStore>((set) => ({
	models: null,
	error: null,
	setModels: (models) => set({ models, error: null }),
	setError: (error) => set({ error }),
}));

export function useModelsForAgent(
	agentType: AgentType,
): ModelOption[] | undefined {
	return useAgentModelStore((s) => s.models?.[agentType]);
}
