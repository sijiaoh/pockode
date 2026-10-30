import { createLayerHistory, type LayerHistory } from "@pockode/shared";
import type {
	HistoryLocation,
	HistoryState,
	RouterHistory,
} from "@tanstack/react-router";
import { entryKeyOf } from "./historyTrail";

/** The layers an entry was pushed for, bottom first (`LayerEntries.layers`). */
const LAYERS_KEY = "pockodeLayers";
/**
 * The key of the page's own entry under a layer's, so that the page is the
 * same visit whichever of them is current (`visitKeyOf`).
 */
const PAGE_KEY = "pockodePage";

interface LayerState {
	[LAYERS_KEY]?: unknown;
	[PAGE_KEY]?: unknown;
}

function layersOf(state: unknown): readonly string[] {
	const layers = (state as LayerState | null)?.[LAYERS_KEY];
	return Array.isArray(layers) ? layers : [];
}

function indexOf(location: HistoryLocation): number | undefined {
	const index: unknown = location.state.__TSR_index;
	return typeof index === "number" ? index : undefined;
}

/**
 * The page a history entry shows, as one visit: a layer's entry is the page
 * under it, so this is the page's own entry key there. What a page remembers
 * of a visit — its scroll — is kept under this, and a sheet going up or down
 * over the page is no new visit.
 */
export function visitKeyOf(location: {
	href: string;
	state: { __TSR_key?: string };
}): string {
	const page = (location.state as LayerState)[PAGE_KEY];
	return typeof page === "string" ? page : entryKeyOf(location);
}

/** The state an entry carries to stay a layer's: the layers and the page. */
function layerStateOf(state: HistoryState): LayerState {
	const layers = layersOf(state);
	if (layers.length === 0) return {};
	return { [LAYERS_KEY]: layers, [PAGE_KEY]: (state as LayerState)[PAGE_KEY] };
}

/** What the router itself leaves out when it asks whether a state changed. */
const ROUTER_KEYS = new Set([
	"key",
	"__TSR_key",
	"__TSR_index",
	"__hashScrollIntoViewOptions",
]);

function sameState(a: HistoryState | undefined, b: HistoryState): boolean {
	const own = (state: HistoryState | undefined) =>
		JSON.stringify(
			Object.entries(state ?? {})
				.filter(([key]) => !ROUTER_KEYS.has(key))
				.sort(([x], [y]) => (x < y ? -1 : 1)),
		);
	return own(a) === own(b);
}

interface NavigationApi {
	currentEntry: { index: number } | null;
	entries(): { key: string }[];
	traverseTo(key: string): {
		committed: Promise<unknown>;
		finished: Promise<unknown>;
	};
}

/**
 * Goes `delta` top-level entries with the Navigation API, where the browser
 * has it — TypeScript's DOM library does not declare it yet. False where it
 * does not.
 *
 * A layer may hold an `<iframe>` the user navigated in (a page in the media
 * viewer), and each of those navigations is an entry of its own after the
 * layer's. They outlive the frame: Chromium and WebKit keep a removed frame's
 * entries, and a Back onto one changes nothing on screen. The Navigation
 * API's entries are the top-level document's alone, so going by them lands
 * on the page however many frame entries follow, and leaves a frame still on
 * the page where its user left it; `history.go()` costs one silent Back per
 * frame entry (docs/media-viewer.md#history).
 */
function navigationGo(delta: number): boolean {
	const navigation = (window as { navigation?: NavigationApi }).navigation;
	const at = navigation?.currentEntry?.index;
	if (!navigation || at === undefined) return false;
	const target = navigation.entries()[at + delta];
	if (!target) return false;
	const result = navigation.traverseTo(target.key);
	// A traversal cut short (another navigation, the tab closing) rejects
	// both; the router hears whatever did happen through `popstate`.
	result.committed.catch(() => {});
	result.finished.catch(() => {});
	return true;
}

function install(history: RouterHistory): LayerHistory {
	const push = history.push.bind(history);
	const replace = history.replace.bind(history);
	const go = history.go.bind(history);
	// Whether the router keeps its entries in the window: one on a memory
	// history (tests) does not.
	const inWindow = () =>
		window.history.state?.__TSR_key !== undefined &&
		window.history.state.__TSR_key === history.location.state.__TSR_key;

	// A reload with a layer up: the layer went with the document, and its entry
	// is now the page's. Left where it is — going back over it would cross
	// into the old document and load the app a second time. On the window the
	// entry keeps its key, which the trail (lib/historyTrail.ts) reads it back
	// by; the router's own replace would give it a new one, and the trail
	// would forget everything behind the page.
	const start = history.location.state;
	if (layersOf(start).length > 0) {
		const {
			[LAYERS_KEY]: _,
			[PAGE_KEY]: __,
			...page
		} = start as LayerState & HistoryState;
		if (inWindow()) window.history.replaceState(page, "");
		else replace(history.location.href, page as HistoryState);
	}

	// A replace made under a layer (below) is carried down: whenever a layer's
	// entry is gone back over, the entry it lands on is brought to the URL of
	// the entry it left, so a setting chosen inside a sheet survives the sheet
	// closing however it closes, and Back never unwinds it. Heard before the
	// layers hear the traversal, so that what they do next — a refusing
	// sheet pushing its entry again — copies the page as carried.
	let previous = history.location;
	history.subscribe(({ location, action }) => {
		const left = previous;
		previous = location;
		if (action.type === "PUSH" || action.type === "REPLACE") return;
		const above = layersOf(left.state);
		const below = layersOf(location.state);
		const from = indexOf(left);
		const to = indexOf(location);
		const sameStack =
			from !== undefined &&
			to !== undefined &&
			below.length < above.length &&
			below.every((id, i) => above[i] === id) &&
			from - to === above.length - below.length;
		if (!sameStack || left.href === location.href) return;
		const landed = entryKeyOf(location);
		// After the router has had the traversal: a navigation from inside the
		// history's own notification would race the one it starts.
		queueMicrotask(() => {
			if (entryKeyOf(history.location) !== landed) return;
			replace(left.href, layerStateOf(history.location.state) as HistoryState);
		});
	});

	const layers = createLayerHistory({
		index: () => indexOf(history.location),
		layers: () => layersOf(history.location.state),
		push: (chain) => {
			const { location } = history;
			push(location.href, {
				...location.state,
				[LAYERS_KEY]: chain,
				[PAGE_KEY]: visitKeyOf(location),
			} as HistoryState);
		},
		go: (delta) => {
			if (!inWindow() || !navigationGo(delta)) go(delta);
		},
		subscribe: (listener) =>
			history.subscribe(({ action }) => {
				if (action.type !== "PUSH" && action.type !== "REPLACE") listener();
			}),
	});

	// A navigation never goes over a layer's entry, which stands for the page
	// under the layer: a page pushed on top would leave it behind as a silent
	// step between the new page and the old one. So a push waits until every
	// layer entry has been gone back over, and is made from the page's own.
	history.push = (path, state, opts) => {
		if (!layers.busy) {
			push(path, state, opts);
			return;
		}
		void layers.unwind().then(() => {
			// The router pushes the page on screen afresh only because the
			// layer's entry it compared against carries more state than the
			// page; landed on the page, that push would be a step to the same
			// place. A row for the session already open, say.
			const { location } = history;
			if (path === location.href && sameState(state, location.state)) {
				replace(path, state, opts);
			} else {
				push(path, state, opts);
			}
		});
	};

	// A replace — a setting of the page changed from a layer — is written to the
	// current entry at once, so the page under the layer shows it, and the
	// entry stays the layer's.
	history.replace = (path, state, opts) => {
		replace(
			path,
			{ ...state, ...layerStateOf(history.location.state) } as HistoryState,
			opts,
		);
	};

	return layers;
}

const installed = new WeakMap<RouterHistory, LayerHistory>();

/**
 * The layers of one history (docs/project-ui.md §5.2), installed on first
 * use: from then on its pushes are held behind the layers' entries and its
 * replaces carried down to the page. The app's router installs it as its
 * history is created, before anything has read the location; a test's router
 * gets it wherever the test asks for it.
 */
export function layerHistoryFor(history: RouterHistory): LayerHistory {
	let layers = installed.get(history);
	if (!layers) {
		layers = install(history);
		installed.set(history, layers);
	}
	return layers;
}
