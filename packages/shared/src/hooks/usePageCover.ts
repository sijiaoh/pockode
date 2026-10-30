import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import type { LayerHistory } from "../utils/layerHistory.ts";

let coveringLayers = 0;
const listeners = new Set<() => void>();

function setCoveringLayers(count: number) {
	coveringLayers = count;
	for (const listener of listeners) listener();
}

/**
 * Where a layer holds its history entry, given by the app around everything
 * that can open one (`createLayerHistory`). Without it — a unit test — a layer
 * holds no entry, and is counted and closed as ever.
 */
export const LayerHistoryContext = createContext<LayerHistory | null>(null);

export interface CoverPageBack {
	/**
	 * What Back does: the layer's plain close, the one ✕ or Cancel calls. A
	 * held navigation calls it too, so it must close and do nothing else.
	 */
	onBack: () => void;
	/**
	 * True while the layer refuses to close — a sheet mid-operation. Back then
	 * leaves it up, and the next Back is caught the same way.
	 */
	refuse?: boolean;
}

/**
 * Registers this component, while `active`, as a layer drawn over the page:
 * counted for `useIsPageCovered`, and one step of Back (docs/project-ui.md
 * §5.2) — it holds a history entry of its own, so the back gesture closes the
 * topmost layer and leaves the page where it was. Every other close takes the
 * entry back again.
 *
 * One registry for both, because they are one fact — "something the user
 * opened is between them and the page" — and a layer counted by one and not
 * the other is the bug in either direction: the chat's interrupt firing under
 * a menu, or Back leaving the page under a sheet. `Sheet` and
 * `ConfirmDialog` call it themselves; a panel of a project's own calls it
 * with its close.
 *
 * One count for every caller, balanced by the effect's own cleanup, so layers
 * that overlap or replace each other in one commit cannot leave it wrong.
 * Anything that tracks "a panel is open" some other way is a second answer to
 * the same question, and the listener reading this will not hear it.
 *
 * Not the `covered` of `CoveredSurface`: that is a surface taken off the
 * screen because the user moved over it; this is a layer on top of a page that
 * is still there.
 */
export function useCoverPage(active: boolean, back: CoverPageBack): void {
	const history = useContext(LayerHistoryContext);
	// Read at the Back, not at the open: callers pass an inline close.
	const backRef = useRef(back);
	useLayoutEffect(() => {
		backRef.current = back;
	});

	useEffect(() => {
		if (!active) return;
		setCoveringLayers(coveringLayers + 1);
		const close = history?.open({
			onBack: () => backRef.current.onBack(),
			refuse: () => backRef.current.refuse ?? false,
		});
		return () => {
			setCoveringLayers(coveringLayers - 1);
			close?.();
		};
	}, [active, history]);
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
