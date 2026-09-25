import { useEffect, useSyncExternalStore } from "react";

let coveringLayers = 0;
const listeners = new Set<() => void>();

function setCoveringLayers(count: number) {
	coveringLayers = count;
	for (const listener of listeners) listener();
}

/**
 * Counts this component, while `active`, as a layer drawn over the page — what
 * `useIsPageCovered` answers.
 *
 * Kept apart from `useLockBodyScroll` because the two are different facts: a
 * dropdown or a drawer that leaves the page scrollable still sits between the
 * user and the page, and a `document` listener behind it has to stand down all
 * the same. `useLockBodyScroll` registers through this, so `Sheet` and
 * `ConfirmDialog` are counted; a panel that does not lock the body calls it
 * itself.
 *
 * One count for every caller, balanced by the effect's own cleanup, so layers
 * that overlap or replace each other in one commit cannot leave it wrong.
 * Anything that tracks "a panel is open" some other way is a second answer to
 * the same question, and the one listener reading this will not hear it.
 *
 * Not the `covered` of `CoveredSurface`: that is a surface taken off the
 * screen because the user moved over it; this is a layer on top of a page that
 * is still there.
 */
export function useCoverPage(active: boolean): void {
	useEffect(() => {
		if (!active) return;
		setCoveringLayers(coveringLayers + 1);
		return () => setCoveringLayers(coveringLayers - 1);
	}, [active]);
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function isPageCovered() {
	return coveringLayers > 0;
}

/**
 * Whether anything that called `useCoverPage` — every `Sheet` and
 * `ConfirmDialog`, and any panel registered by hand — is drawn over the page.
 *
 * For a `document` listener that must stand down under an overlay: the
 * overlay's `stopPropagation` does not silence a sibling on the same target,
 * and one registered earlier runs before the overlay has marked anything.
 */
export function useIsPageCovered(): boolean {
	return useSyncExternalStore(subscribe, isPageCovered);
}
