import { create } from "zustand";

interface GitPanelState {
	/**
	 * null while History still follows the change count; a boolean once the user
	 * has toggled it by hand, which then stands for the rest of the session.
	 *
	 * It lives here rather than in DiffTab's own state so that the choice does
	 * not depend on the panel staying mounted. Tabs and the mobile drawer hide
	 * with a class today, but that is a scroll-preservation detail, and the
	 * layout does remount across the desktop breakpoint — either way, silently
	 * re-deciding for a user who has already decided is the one outcome this
	 * must not have.
	 */
	historyExpandedOverride: boolean | null;
}

export const useGitPanelStore = create<GitPanelState>(() => ({
	historyExpandedOverride: null,
}));

export const gitPanelActions = {
	setHistoryExpanded: (expanded: boolean) =>
		useGitPanelStore.setState({ historyExpandedOverride: expanded }),

	reset: () => useGitPanelStore.setState({ historyExpandedOverride: null }),
};

/**
 * History is expanded when there is nothing else to look at, and collapsed out
 * of the way of a diff when there is one — unless the user has said otherwise.
 */
export function useHistoryExpanded(changeCount: number): boolean {
	const override = useGitPanelStore((s) => s.historyExpandedOverride);
	return override ?? changeCount === 0;
}
