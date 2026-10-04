import { create } from "zustand";

const HIDE_WHITESPACE_KEY = "pockode:hideWhitespace";
const WRAP_LINES_KEY = "pockode:diffWrapLines";

function getStoredFlag(key: string): boolean {
	return localStorage.getItem(key) === "true";
}

interface DiffSettingsState {
	hideWhitespace: boolean;
	/** Wrap long lines in a tool call's diff instead of scrolling them sideways. */
	wrapLines: boolean;
}

export const useDiffSettingsStore = create<DiffSettingsState>(() => ({
	hideWhitespace: getStoredFlag(HIDE_WHITESPACE_KEY),
	wrapLines: getStoredFlag(WRAP_LINES_KEY),
}));

export const diffSettingsActions = {
	setHideWhitespace: (value: boolean) => {
		localStorage.setItem(HIDE_WHITESPACE_KEY, String(value));
		useDiffSettingsStore.setState({ hideWhitespace: value });
	},

	toggleHideWhitespace: () => {
		const current = useDiffSettingsStore.getState().hideWhitespace;
		diffSettingsActions.setHideWhitespace(!current);
	},

	toggleWrapLines: () => {
		const value = !useDiffSettingsStore.getState().wrapLines;
		localStorage.setItem(WRAP_LINES_KEY, String(value));
		useDiffSettingsStore.setState({ wrapLines: value });
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
