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
	/**
	 * Adds a role this client just created, from the create reply. The list
	 * notification is sent from the server's watcher on its own schedule and
	 * can land after the reply, so a page opened on the new role would find
	 * nothing. Never replaces: by the time the reply lands the subscription may
	 * already hold a newer record of the role.
	 */
	addCreatedRole: (role: AgentRole) => void;
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
	addCreatedRole: (role) =>
		set((state) =>
			state.roles.some((r) => r.id === role.id)
				? state
				: { roles: [...state.roles, role] },
		),
	setWorkRefCounts: (workRefCounts) => set({ workRefCounts }),
	setError: (error) => set({ isLoading: false, error }),
	reset: () =>
		set({ roles: [], workRefCounts: {}, isLoading: true, error: null }),
}));
