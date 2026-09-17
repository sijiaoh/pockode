import { create } from "zustand";

/**
 * Which half of the project list is on screen: the work to triage, or the
 * archive (docs/project-ui.md §2.1).
 */
export type WorkSegment = "current" | "closed";

interface ProjectPanelState {
	segment: WorkSegment;
}

/**
 * The chosen segment, following `gitPanelStore`'s precedent.
 *
 * Not the list component's own state, because the screen unmounts on the way
 * into a work detail and a user browsing the archive would be handed back
 * `Current` by the trip out and back. Not the URL either: it filters one screen
 * rather than naming a place, and in the URL every tap would be a history
 * entry, so Back would walk the user through their own filter changes instead
 * of leaving the list (docs/project-ui.md §5).
 */
export const useProjectPanelStore = create<ProjectPanelState>(() => ({
	segment: "current",
}));

export const projectPanelActions = {
	setSegment: (segment: WorkSegment) =>
		useProjectPanelStore.setState({ segment }),

	reset: () => useProjectPanelStore.setState({ segment: "current" }),
};
