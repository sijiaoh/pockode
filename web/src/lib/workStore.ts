import { create } from "zustand";
import type { Work } from "../types/work";

interface WorkState {
	works: Work[];
	isLoading: boolean;
	error: string | null;
}

interface WorkActions {
	setWorks: (works: Work[]) => void;
	updateWorks: (updater: (old: Work[]) => Work[]) => void;
	setError: (error: string) => void;
	reset: () => void;
}

export type WorkStore = WorkState & WorkActions;

export const useWorkStore = create<WorkStore>((set) => ({
	works: [],
	isLoading: true,
	error: null,
	setWorks: (works) => set({ works, isLoading: false, error: null }),
	updateWorks: (updater) => set((state) => ({ works: updater(state.works) })),
	setError: (error) => set({ isLoading: false, error }),
	reset: () => set({ works: [], isLoading: true, error: null }),
}));

/** The only fields needed to walk a work up to its root. */
type WorkNode = Pick<Work, "id" | "parent_id" | "status">;

/**
 * Whether a work's worktree is already decided and can no longer change.
 *
 * A work that is no longer `open` is frozen: the backend only ever rewrites
 * works that are still `open`. An open work instead waits on its *root* — only a
 * top-level work captures a worktree when it starts, and that same moment
 * rewrites every still-open descendant to match. So an open work is decided as
 * soon as its root has started, and undecided before that.
 */
export function isWorktreeBound(works: Work[], work: WorkNode): boolean {
	if (work.status !== "open") return true;
	return findRootWork(works, work).status !== "open";
}

function findRootWork(works: Work[], work: WorkNode): WorkNode {
	const seen = new Set<string>([work.id]);
	let current = work;
	while (current.parent_id) {
		const parentId = current.parent_id;
		const parent = works.find((w) => w.id === parentId);
		// An ancestor missing from the list (not synced yet) or a cycle stops the
		// walk instead of looping forever; the deepest known node acts as root.
		if (!parent || seen.has(parent.id)) break;
		seen.add(parent.id);
		current = parent;
	}
	return current;
}

export function collectWorkSessionIds(works: Work[]): Set<string> {
	const ids = new Set<string>();
	for (const w of works) {
		if (w.session_id) ids.add(w.session_id);
	}
	return ids;
}
