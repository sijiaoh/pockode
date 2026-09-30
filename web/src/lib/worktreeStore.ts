import { create } from "zustand";
import type { SetupHookSkip, WorktreeInfo } from "../types/message";

interface WorktreeState {
	/** Current worktree name (empty string = main). URL is source of truth. */
	current: string;
	/**
	 * Whether the project is a git repository; null until the server has said.
	 * Written from the worktree list and subscription replies and updated by
	 * worktree.changed — never inferred from a failing git request, since only
	 * the server's own read decides it (docs/git.md).
	 */
	isGitRepo: boolean | null;
	/**
	 * Why the setup script would not run for a new worktree, or null if it runs.
	 * Reported by the server alongside the worktree list, since only the server
	 * knows whether its machine has a shell to run the script with.
	 */
	setupHookSkip: SetupHookSkip | null;
}

export const useWorktreeStore = create<WorktreeState>(() => ({
	current: "",
	isGitRepo: null,
	setupHookSkip: null,
}));

type WorktreeChangeListener = (prev: string, next: string) => void;
const changeListeners = new Set<WorktreeChangeListener>();

type GitRepoChangeListener = (isGitRepo: boolean) => void;
const gitRepoChangeListeners = new Set<GitRepoChangeListener>();

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

	setIsGitRepo: (isGitRepo: boolean) => {
		if (useWorktreeStore.getState().isGitRepo === isGitRepo) return;
		useWorktreeStore.setState({ isGitRepo });
		for (const listener of gitRepoChangeListeners) {
			listener(isGitRepo);
		}
	},

	/**
	 * Called whenever the server's answer differs from the one held, the first
	 * answer included: what was cached before it belongs to a repository that
	 * is gone, or to none.
	 */
	onGitRepoChange: (listener: GitRepoChangeListener) => {
		gitRepoChangeListeners.add(listener);
		return () => gitRepoChangeListeners.delete(listener);
	},

	setSetupHookSkip: (setupHookSkip: SetupHookSkip | null) => {
		useWorktreeStore.setState({ setupHookSkip });
	},

	getCurrent: () => useWorktreeStore.getState().current,

	reset: () => {
		useWorktreeStore.setState({
			current: "",
			isGitRepo: null,
			setupHookSkip: null,
		});
	},
};

export function useIsGitRepo(): boolean | null {
	return useWorktreeStore((state) => state.isGitRepo);
}

export function getDisplayName(worktree: WorktreeInfo): string {
	// Main has no branch to name in a detached HEAD or a project without git.
	return worktree.is_main ? worktree.branch || "Default" : worktree.name;
}

export function resetWorktreeStore() {
	worktreeActions.reset();
	changeListeners.clear();
	gitRepoChangeListeners.clear();
	switchStartListeners.clear();
	switchEndListeners.clear();
}
