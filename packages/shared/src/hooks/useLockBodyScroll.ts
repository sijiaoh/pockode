import { useEffect } from "react";
import { useCoverPage } from "./usePageCover.ts";

let openOverlays = 0;
let overflowBeforeFirstOverlay = "";

/**
 * Locks body scroll while any overlay is open.
 *
 * Counted rather than saved-and-restored per overlay, because overlays overlap:
 * a confirmation is raised from inside an open sheet, and a second sheet can go
 * up over the first. With a per-overlay restore, the second one to mount
 * records "hidden" as the value to go back to, and the page is left on it
 * whenever that one restores after the first: closed together, cleanups run
 * parent-first, so the inner one writes last and the page stays unscrollable
 * until a reload; closed in mount order, the page unlocks under the one still
 * open and then locks for good. That is not theoretical: it is what Escape did to `web`'s force-push
 * confirmation, which is a `ConfirmDialog` inside a `SyncSheet`, before both
 * were moved onto this hook.
 *
 * So every overlay in this package has to use it. One that locks the body by
 * hand is not merely inconsistent — it is the second writer that makes the
 * count wrong.
 *
 * Whatever locks the page is drawn over it, so this also counts as covering
 * it (`useCoverPage`).
 */
export function useLockBodyScroll(): void {
	useCoverPage(true);
	useEffect(() => {
		if (openOverlays === 0) {
			overflowBeforeFirstOverlay = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}
		openOverlays += 1;

		return () => {
			openOverlays -= 1;
			if (openOverlays === 0) {
				document.body.style.overflow = overflowBeforeFirstOverlay;
			}
		};
	}, []);
}
