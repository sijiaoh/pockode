import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Workspace {
	id: string;
	name: string;
	path: string;
	last_accessed?: string;
}

interface WorkspaceState {
	workspaces: Workspace[];
	currentWorkspaceId: string | null;
	isLoading: boolean;
	error: string | null;
}

interface WorkspaceActions {
	setWorkspaces: (workspaces: Workspace[]) => void;
	setCurrentWorkspaceId: (id: string | null) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	addWorkspace: (workspace: Workspace) => void;
	updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
	removeWorkspace: (id: string) => void;
	reset: () => void;
}

const initialState: WorkspaceState = {
	workspaces: [],
	currentWorkspaceId: null,
	isLoading: false,
	error: null,
};

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>()(
	persist(
		(set) => ({
			...initialState,

			setWorkspaces: (workspaces) => set({ workspaces }),

			setCurrentWorkspaceId: (id) => set({ currentWorkspaceId: id }),

			setLoading: (loading) => set({ isLoading: loading }),

			setError: (error) => set({ error }),

			addWorkspace: (workspace) =>
				set((state) => ({
					workspaces: [...state.workspaces, workspace],
				})),

			updateWorkspace: (id, updates) =>
				set((state) => ({
					workspaces: state.workspaces.map((ws) =>
						ws.id === id ? { ...ws, ...updates } : ws,
					),
				})),

			removeWorkspace: (id) =>
				set((state) => ({
					workspaces: state.workspaces.filter((ws) => ws.id !== id),
					currentWorkspaceId:
						state.currentWorkspaceId === id ? null : state.currentWorkspaceId,
				})),

			reset: () => set(initialState),
		}),
		{
			name: "pockode-workspace",
			partialize: (state) => ({
				currentWorkspaceId: state.currentWorkspaceId,
			}),
		},
	),
);

export const workspaceActions = {
	setWorkspaces: (workspaces: Workspace[]) =>
		useWorkspaceStore.getState().setWorkspaces(workspaces),

	setCurrentWorkspaceId: (id: string | null) =>
		useWorkspaceStore.getState().setCurrentWorkspaceId(id),

	getCurrentWorkspaceId: () => useWorkspaceStore.getState().currentWorkspaceId,

	getWorkspace: (id: string) =>
		useWorkspaceStore.getState().workspaces.find((ws) => ws.id === id),

	setLoading: (loading: boolean) =>
		useWorkspaceStore.getState().setLoading(loading),

	setError: (error: string | null) =>
		useWorkspaceStore.getState().setError(error),

	addWorkspace: (workspace: Workspace) =>
		useWorkspaceStore.getState().addWorkspace(workspace),

	updateWorkspace: (id: string, updates: Partial<Workspace>) =>
		useWorkspaceStore.getState().updateWorkspace(id, updates),

	removeWorkspace: (id: string) =>
		useWorkspaceStore.getState().removeWorkspace(id),

	reset: () => useWorkspaceStore.getState().reset(),
};
