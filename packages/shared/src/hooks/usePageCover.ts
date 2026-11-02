import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { LayerHistory } from "../utils/layerHistory.ts";

/** A layer `useCoverPage` registered, known only by its identity. */
export type CoverLayer = object;

/** Every layer up, in the order they went up. */
let coveringLayers: readonly CoverLayer[] = [];
const listeners = new Set<() => void>();

/** The layer each layer is drawn in, if any (`CoverLayerContext`). */
const drawnIn = new WeakMap<CoverLayer, CoverLayer>();

function setCoveringLayers(layers: readonly CoverLayer[]) {
	coveringLayers = layers;
	for (const listener of listeners) listener();
}

/**
 * The layer a component is drawn in, for `useIsDrawnOver`. `Sheet` gives it
 * around its content.
 */
export const CoverLayerContext = createContext<CoverLayer | null>(null);

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
 * One registry for every caller, balanced by the effect's own cleanup, so layers
 * that overlap or replace each other in one commit cannot leave it wrong.
 * Anything that tracks "a panel is open" some other way is a second answer to
 * the same question, and the listener reading this will not hear it.
 *
 * Not the `covered` of `CoveredSurface`: that is a surface taken off the
 * screen because the user moved over it; this is a layer on top of a page that
 * is still there.
 *
 * Returns the layer, for a caller that draws content in it to give in
 * `CoverLayerContext`.
 */
export function useCoverPage(active: boolean, back: CoverPageBack): CoverLayer {
	const [layer] = useState<CoverLayer>(() => ({}));
	const parent = useContext(CoverLayerContext);
	const history = useContext(LayerHistoryContext);
	// Read at the Back, not at the open: callers pass an inline close.
	const backRef = useRef(back);
	useLayoutEffect(() => {
		backRef.current = back;
	});

	useEffect(() => {
		if (!active) return;
		if (parent !== null) drawnIn.set(layer, parent);
		// A child's effect runs before its parent's, so a layer opened inside a
		// sheet in the sheet's own first commit is up already: the sheet goes
		// under it, not over it.
		const under = coveringLayers.findIndex((up) => drawnIn.get(up) === layer);
		setCoveringLayers(
			under === -1
				? [...coveringLayers, layer]
				: [
						...coveringLayers.slice(0, under),
						layer,
						...coveringLayers.slice(under),
					],
		);
		const close = history?.open({
			onBack: () => backRef.current.onBack(),
			refuse: () => backRef.current.refuse ?? false,
		});
		return () => {
			setCoveringLayers(coveringLayers.filter((up) => up !== layer));
			close?.();
		};
	}, [active, history, layer, parent]);
	return layer;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function isPageCovered() {
	return coveringLayers.length > 0;
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

/**
 * Whether a layer is drawn over this component. On the page, that is any
 * layer. Inside a layer (`CoverLayerContext`, which a `Sheet` gives), only one
 * that went up after it: its own layer is counted by `useIsPageCovered` too.
 *
 * For what has to stand down under a layer from inside a surface that may be
 * one: a page's frame, which shielded by its own sheet could never be pressed
 * at all.
 */
export function useIsDrawnOver(): boolean {
	const own = useContext(CoverLayerContext);
	return useSyncExternalStore(subscribe, () => {
		if (own === null) return coveringLayers.length > 0;
		const at = coveringLayers.indexOf(own);
		// Not up yet, its own registration still to run: nothing is over it.
		return at !== -1 && at < coveringLayers.length - 1;
	});
}
