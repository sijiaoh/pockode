import { create } from "zustand";
import type { Settings } from "../types/settings";

interface SettingsState {
	settings: Settings | null;
	/**
	 * Why there is no snapshot, once that is known. Null while one is still on
	 * its way: the controls that wait on the snapshot read the two apart to say
	 * whether they are waiting or broken.
	 */
	error: string | null;
	/**
	 * Resubscribes. Kept here because the subscription is mounted at the top of
	 * the app while the Retry that calls it sits beside each waiting control, and
	 * a failed subscribe on a live socket has nothing else to trigger it.
	 */
	refresh: (() => void) | null;
}

interface SettingsActions {
	setSettings: (settings: Settings) => void;
	setError: (error: string) => void;
	setRefresh: (refresh: (() => void) | null) => void;
	reset: () => void;
}

export type SettingsStore = SettingsState & SettingsActions;

export const useSettingsStore = create<SettingsStore>((set) => ({
	settings: null,
	error: null,
	refresh: null,
	setSettings: (settings) => set({ settings, error: null }),
	// The snapshot goes with the error: a subscribe that failed leaves whatever
	// was on screen unbacked, which is the same reason `reset` clears it.
	setError: (error) => set({ settings: null, error }),
	setRefresh: (refresh) => set({ refresh }),
	reset: () => set({ settings: null, error: null }),
}));
