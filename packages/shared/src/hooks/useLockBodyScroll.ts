import { useEffect, useSyncExternalStore } from "react";

let openOverlays = 0;
let overflowBeforeFirstOverlay = "";
const coverListeners = new Set<() => void>();

function setOpenOverlays(count: number) {
	openOverlays = count;
	for (const listener of coverListeners) listener();
}

/**
 * Locks body scroll while any overlay is open.
 *
 * Counted rather than saved-and-restored per overlay, because overlays overlap:
 * a sheet replaces another sheet in a single commit, and a confirmation is
 * raised from inside an open sheet. With a per-overlay restore, the second one
 * to mount records "hidden" as the value to go back to, and — cleanups run
 * child-first — writes it back *after* the first one has restored the real
 * value. The page is then unscrollable until a reload. That is not theoretical:
 * it is what Escape did to `web`'s force-push confirmation, which is a
 * `ConfirmDialog` inside a `SyncSheet`, before both were moved onto this hook.
 *
 * So every overlay in this package has to use it. One that locks the body by
 * hand is not merely inconsistent — it is the second writer that makes the
 * count wrong.
 */
export function useLockBodyScroll(): void {
	useEffect(() => {
		if (openOverlays === 0) {
			overflowBeforeFirstOverlay = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}
		setOpenOverlays(openOverlays + 1);

		return () => {
			setOpenOverlays(openOverlays - 1);
			if (openOverlays === 0) {
				document.body.style.overflow = overflowBeforeFirstOverlay;
			}
		};
	}, []);
}

function subscribeToCover(listener: () => void) {
	coverListeners.add(listener);
	return () => coverListeners.delete(listener);
}

function isPageCovered() {
	return openOverlays > 0;
}

/**
 * Whether a shared overlay — a `Sheet` or a `ConfirmDialog` — is drawn over
 * the page. Read from the same count that locks the body, so it cannot
 * disagree with what the user sees and nothing has to register to be counted.
 *
 * For a `document` listener that must stand down under an overlay: the
 * overlay's `stopPropagation` does not silence a sibling on the same target,
 * and one registered earlier runs before the overlay has marked anything.
 */
export function useIsPageCovered(): boolean {
	return useSyncExternalStore(subscribeToCover, isPageCovered);
}
