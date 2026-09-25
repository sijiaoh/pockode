import { create } from "zustand";
import type { AgentRole } from "../types/agentRole";

interface AgentRoleState {
	roles: AgentRole[];
	/** Work items naming each role, keyed by role id; absent means none. */
	workRefCounts: Record<string, number>;
	isLoading: boolean;
	error: string | null;
}

interface AgentRoleActions {
	setRoles: (roles: AgentRole[]) => void;
	updateRoles: (updater: (old: AgentRole[]) => AgentRole[]) => void;
	setWorkRefCounts: (counts: Record<string, number>) => void;
	setError: (error: string) => void;
	reset: () => void;
}

type AgentRoleStore = AgentRoleState & AgentRoleActions;

export const useAgentRoleStore = create<AgentRoleStore>((set) => ({
	roles: [],
	workRefCounts: {},
	isLoading: true,
	error: null,
	setRoles: (roles) => set({ roles, isLoading: false, error: null }),
	updateRoles: (updater) => set((state) => ({ roles: updater(state.roles) })),
	setWorkRefCounts: (workRefCounts) => set({ workRefCounts }),
	setError: (error) => set({ isLoading: false, error }),
	reset: () =>
		set({ roles: [], workRefCounts: {}, isLoading: true, error: null }),
}));
