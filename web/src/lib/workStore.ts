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

export function collectTaskSessionIds(works: Work[]): Set<string> {
	const ids = new Set<string>();
	for (const w of works) {
		if (w.type === "task" && w.session_id) ids.add(w.session_id);
	}
	return ids;
}
