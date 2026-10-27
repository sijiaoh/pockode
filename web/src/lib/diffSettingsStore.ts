import { useIsExpanded } from "@pockode/shared";
import { create } from "zustand";

const HIDE_WHITESPACE_KEY = "pockode:hideWhitespace";
const WRAP_LINES_KEY = "pockode:diffWrapLines";
const GIT_REVIEW_WRAP_KEY = "pockode:gitReviewWrap";
const GIT_REVIEW_SPLIT_KEY = "pockode:gitReviewSplit";

function getStoredFlag(key: string): boolean {
	return localStorage.getItem(key) === "true";
}

/** A choice the reader may not have made yet, which `null` says. */
function getStoredChoice(key: string): boolean | null {
	const value = localStorage.getItem(key);
	return value === null ? null : value === "true";
}

interface DiffSettingsState {
	hideWhitespace: boolean;
	/** Wrap long lines in a tool call's diff instead of scrolling them sideways. */
	wrapLines: boolean;
	/**
	 * Wrap long lines in a Git file diff. `null` until the reader chooses, and
	 * then the width tier decides — see `useGitDiffWrap`.
	 */
	gitDiffWrap: boolean | null;
	/** Show a Git file diff side by side; only ever applied at `expanded`. */
	gitDiffSplit: boolean;
}

export const useDiffSettingsStore = create<DiffSettingsState>(() => ({
	hideWhitespace: getStoredFlag(HIDE_WHITESPACE_KEY),
	wrapLines: getStoredFlag(WRAP_LINES_KEY),
	gitDiffWrap: getStoredChoice(GIT_REVIEW_WRAP_KEY),
	gitDiffSplit: getStoredFlag(GIT_REVIEW_SPLIT_KEY),
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

	setGitDiffWrap: (value: boolean) => {
		localStorage.setItem(GIT_REVIEW_WRAP_KEY, String(value));
		useDiffSettingsStore.setState({ gitDiffWrap: value });
	},

	toggleGitDiffSplit: () => {
		const value = !useDiffSettingsStore.getState().gitDiffSplit;
		localStorage.setItem(GIT_REVIEW_SPLIT_KEY, String(value));
		useDiffSettingsStore.setState({ gitDiffSplit: value });
	},
};

export function useDiffSettings() {
	const hideWhitespace = useDiffSettingsStore((s) => s.hideWhitespace);
	return {
		hideWhitespace,
		setHideWhitespace: diffSettingsActions.setHideWhitespace,
		toggleHideWhitespace: diffSettingsActions.toggleHideWhitespace,
	};
}

/**
 * Whether a Git file diff wraps, and the switch for it.
 *
 * Until the reader chooses, it wraps below `expanded` — on a phone, sideways
 * scrolling inside a vertically scrolling page fights the page — and not at
 * `expanded`, where wide lines read better unbroken. Once chosen, the choice
 * holds at every width. Separate from the chat's `wrapLines`, whose tool-call
 * snippets are short and default the other way (docs/git-changes-ui.md).
 */
export function useGitDiffWrap() {
	const chosen = useDiffSettingsStore((s) => s.gitDiffWrap);
	const isExpanded = useIsExpanded();
	const wrap = chosen ?? !isExpanded;
	return {
		wrap,
		toggleWrap: () => diffSettingsActions.setGitDiffWrap(!wrap),
	};
}

/**
 * Whether the review shows its diff side by side, and the switch for it.
 *
 * `available` only at `expanded`: below it there is no width for two columns,
 * so the choice is kept but not applied — it follows the tier, as the
 * workspace's layout does, not the measured width (docs/git-changes-ui.md).
 */
export function useGitDiffSplit() {
	const chosen = useDiffSettingsStore((s) => s.gitDiffSplit);
	const available = useIsExpanded();
	return {
		available,
		split: available && chosen,
		toggleSplit: diffSettingsActions.toggleGitDiffSplit,
	};
}
