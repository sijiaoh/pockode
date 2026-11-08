import type { LayerEntries } from "@pockode/shared";

/** The layers an entry was pushed for, bottom first (`LayerEntries.layers`). */
const LAYERS_KEY = "pockodeLayers";
/** The entry's position, which `window.history` does not tell a page. */
const INDEX_KEY = "pockodeIndex";

interface EntryState {
	[LAYERS_KEY]?: unknown;
	[INDEX_KEY]?: unknown;
}

function stateOf(win: Window): EntryState {
	const state: unknown = win.history.state;
	return typeof state === "object" && state !== null ? state : {};
}

/**
 * The layers' history entries over `window.history` (docs/project-ui.md
 * §5.2): this app has no router, and a layer is all that ever pushes. Every
 * entry carries its own position, since the browser keeps that from a page.
 *
 * Starting on an entry that carries layers is a reload with one up: the layer
 * went with the document, so the entry is made the page's again and left
 * where it is — going back over it would load the app a second time.
 */
export function windowLayerEntries(win: Window = window): LayerEntries {
	const start = stateOf(win);
	if (typeof start[INDEX_KEY] !== "number" || LAYERS_KEY in start) {
		win.history.replaceState(
			{
				[INDEX_KEY]:
					typeof start[INDEX_KEY] === "number" ? start[INDEX_KEY] : 0,
			},
			"",
		);
	}

	return {
		index: () => {
			const index = stateOf(win)[INDEX_KEY];
			return typeof index === "number" ? index : undefined;
		},
		layers: () => {
			const layers = stateOf(win)[LAYERS_KEY];
			return Array.isArray(layers) ? layers : [];
		},
		push: (layers) => {
			const index = stateOf(win)[INDEX_KEY];
			win.history.pushState(
				{
					[INDEX_KEY]: typeof index === "number" ? index + 1 : 0,
					[LAYERS_KEY]: layers,
				},
				"",
			);
		},
		go: (delta) => win.history.go(delta),
		subscribe: (listener) => {
			win.addEventListener("popstate", listener);
			return () => win.removeEventListener("popstate", listener);
		},
	};
}
