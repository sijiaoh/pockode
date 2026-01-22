import { create } from "zustand";
import type { WorktreeInfo } from "../types/message";

interface WorktreeState {
	/** Current worktree name (empty string = main). URL is source of truth. */
	current: string;
	/** Whether current project is a git repository */
	isGitRepo: boolean;
}

export const useWorktreeStore = create<WorktreeState>(() => ({
	current: "",
	isGitRepo: true,
}));

type WorktreeChangeListener = (prev: string, next: string) => void;
const changeListeners = new Set<WorktreeChangeListener>();

type WorktreeSwitchListener = () => void;
const switchStartListeners = new Set<WorktreeSwitchListener>();
const switchEndListeners = new Set<WorktreeSwitchListener>();

export const worktreeActions = {
	setCurrent: (name: string) => {
		const prev = useWorktreeStore.getState().current;
		if (prev === name) return;

		for (const listener of switchStartListeners) {
			listener();
		}

		useWorktreeStore.setState({ current: name });

		for (const listener of changeListeners) {
			listener(prev, name);
		}
	},

	notifyWorktreeSwitchEnd: () => {
		for (const listener of switchEndListeners) {
			listener();
		}
	},

	onWorktreeSwitchStart: (listener: WorktreeSwitchListener) => {
		switchStartListeners.add(listener);
		return () => switchStartListeners.delete(listener);
	},

	onWorktreeSwitchEnd: (listener: WorktreeSwitchListener) => {
		switchEndListeners.add(listener);
		return () => switchEndListeners.delete(listener);
	},

	onWorktreeChange: (listener: WorktreeChangeListener) => {
		changeListeners.add(listener);
		return () => changeListeners.delete(listener);
	},

	// TODO: .git deletion is not handled - user stays on worktree URL even after .git is removed
	setIsGitRepo: (isGitRepo: boolean) => {
		useWorktreeStore.setState({ isGitRepo });
	},

	getCurrent: () => useWorktreeStore.getState().current,

	reset: () => {
		useWorktreeStore.setState({ current: "", isGitRepo: true });
	},
};

export function useIsGitRepo(): boolean {
	return useWorktreeStore((state) => state.isGitRepo);
}

export function getDisplayName(worktree: WorktreeInfo): string {
	return worktree.is_main ? worktree.branch : worktree.name;
}

export function resetWorktreeStore() {
	worktreeActions.reset();
	changeListeners.clear();
	switchStartListeners.clear();
	switchEndListeners.clear();
}
