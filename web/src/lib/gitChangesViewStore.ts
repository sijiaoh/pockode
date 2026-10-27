import { create } from "zustand";
import type { ChangesView } from "./gitChanges";

const VIEW_KEY = "pockode:gitChangesView";

function getStoredView(): ChangesView {
	return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "flat";
}

interface GitChangesViewState {
	/**
	 * Flat or tree, per browser rather than per worktree: it is a reading
	 * preference. The review reads it too, since it walks the list's order.
	 */
	view: ChangesView;
	/**
	 * Collapsed folder rows by worktree. In memory only: it is a navigation
	 * state of this visit, not a preference, and it outlives the list, which
	 * unmounts whenever another segment is chosen.
	 */
	collapsed: Record<string, string[]>;
}

export const useGitChangesViewStore = create<GitChangesViewState>(() => ({
	view: getStoredView(),
	collapsed: {},
}));

export const gitChangesViewActions = {
	setView: (view: ChangesView) => {
		localStorage.setItem(VIEW_KEY, view);
		useGitChangesViewStore.setState({ view });
	},

	toggleFolder: (worktree: string, folder: string) => {
		useGitChangesViewStore.setState((s) => {
			const current = s.collapsed[worktree] ?? [];
			return {
				collapsed: {
					...s.collapsed,
					[worktree]: current.includes(folder)
						? current.filter((f) => f !== folder)
						: [...current, folder],
				},
			};
		});
	},
};

const NONE: string[] = [];

export function useCollapsedFolders(worktree: string): string[] {
	return useGitChangesViewStore((s) => s.collapsed[worktree] ?? NONE);
}
