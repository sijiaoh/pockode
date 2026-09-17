import { create } from "zustand";
import type { WorkListItem } from "../types/work";
import { normalizeActivity } from "./activity";

interface WorkState {
	works: WorkListItem[];
	isLoading: boolean;
	error: string | null;
}

interface WorkActions {
	setWorks: (works: WorkListItem[]) => void;
	updateWorks: (updater: (old: WorkListItem[]) => WorkListItem[]) => void;
	setError: (error: string) => void;
	reset: () => void;
}

export type WorkStore = WorkState & WorkActions;

export const useWorkStore = create<WorkStore>((set) => ({
	works: [],
	isLoading: true,
	error: null,
	setWorks: (works) =>
		set({ works: works.map(normalizeWorkRow), isLoading: false, error: null }),
	updateWorks: (updater) =>
		set((state) => ({ works: updater(state.works).map(normalizeWorkRow) })),
	setError: (error) => set({ isLoading: false, error }),
	reset: () => set({ works: [], isLoading: true, error: null }),
}));

/**
 * One row as it arrived from the server, with its activity folded to a leaf this
 * build knows (see normalizeActivity).
 *
 * Both writers run it over what they are about to store, so the boundary is the
 * store itself rather than each call site's memory of it — and a row it leaves
 * alone is returned unchanged, so the rows React is diffing keep their identity.
 */
export function normalizeWorkRow(row: WorkListItem): WorkListItem {
	const activity = normalizeActivity(row.activity);
	return activity === row.activity ? row : { ...row, activity };
}

/** The only fields needed to walk a work up to its root. */
type WorkNode = Pick<WorkListItem, "id" | "parent_id" | "status">;

/**
 * Whether a work's worktree is already decided and can no longer change.
 *
 * A work that is no longer `open` is frozen: the backend only ever rewrites
 * works that are still `open`. An open work instead waits on its *root* — only a
 * top-level work captures a worktree when it starts, and that same moment
 * rewrites every still-open descendant to match. So an open work is decided as
 * soon as its root has started, and undecided before that.
 */
export function isWorktreeBound(
	works: WorkListItem[],
	work: WorkNode,
): boolean {
	if (work.status !== "open") return true;
	return findRootWork(works, work).status !== "open";
}

function findRootWork(works: WorkListItem[], work: WorkNode): WorkNode {
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
