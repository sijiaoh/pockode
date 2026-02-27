import { create } from "zustand";
import type { AgentRole } from "../types/agentRole";

interface AgentRoleState {
	roles: AgentRole[];
	isLoading: boolean;
	error: string | null;
}

interface AgentRoleActions {
	setRoles: (roles: AgentRole[]) => void;
	updateRoles: (updater: (old: AgentRole[]) => AgentRole[]) => void;
	setError: (error: string) => void;
	reset: () => void;
}

type AgentRoleStore = AgentRoleState & AgentRoleActions;

export const useAgentRoleStore = create<AgentRoleStore>((set) => ({
	roles: [],
	isLoading: true,
	error: null,
	setRoles: (roles) => set({ roles, isLoading: false, error: null }),
	updateRoles: (updater) => set((state) => ({ roles: updater(state.roles) })),
	setError: (error) => set({ isLoading: false, error }),
	reset: () => set({ roles: [], isLoading: true, error: null }),
}));
