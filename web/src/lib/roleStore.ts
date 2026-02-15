import { create } from "zustand";
import type { AgentRole } from "../types/message";

interface RoleState {
	roles: AgentRole[];
	isLoading: boolean;
	isSuccess: boolean;
}

interface RoleActions {
	setRoles: (roles: AgentRole[]) => void;
	addRole: (role: AgentRole) => void;
	updateRole: (role: AgentRole) => void;
	removeRole: (roleId: string) => void;
	reset: () => void;
}

export type RoleStore = RoleState & RoleActions;

export const selectRoleById = (roleId: string) => (state: RoleState) =>
	state.roles.find((r) => r.id === roleId);

export const useRoleStore = create<RoleStore>((set) => ({
	roles: [],
	isLoading: true,
	isSuccess: false,
	setRoles: (roles) => set({ roles, isLoading: false, isSuccess: true }),
	addRole: (role) => set((state) => ({ roles: [...state.roles, role] })),
	updateRole: (role) =>
		set((state) => ({
			roles: state.roles.map((r) => (r.id === role.id ? role : r)),
		})),
	removeRole: (roleId) =>
		set((state) => ({
			roles: state.roles.filter((r) => r.id !== roleId),
		})),
	reset: () => set({ roles: [], isLoading: false, isSuccess: false }),
}));
