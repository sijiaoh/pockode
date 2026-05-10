import { create } from "zustand";

const STORAGE_KEY = "pockode:hideWhitespace";

function getInitialHideWhitespace(): boolean {
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === "true";
}

interface DiffSettingsState {
	hideWhitespace: boolean;
}

export const useDiffSettingsStore = create<DiffSettingsState>(() => ({
	hideWhitespace: getInitialHideWhitespace(),
}));

export const diffSettingsActions = {
	setHideWhitespace: (value: boolean) => {
		localStorage.setItem(STORAGE_KEY, String(value));
		useDiffSettingsStore.setState({ hideWhitespace: value });
	},

	toggleHideWhitespace: () => {
		const current = useDiffSettingsStore.getState().hideWhitespace;
		diffSettingsActions.setHideWhitespace(!current);
	},
};

export function useDiffSettings() {
	const state = useDiffSettingsStore();
	return {
		...state,
		setHideWhitespace: diffSettingsActions.setHideWhitespace,
		toggleHideWhitespace: diffSettingsActions.toggleHideWhitespace,
	};
}
