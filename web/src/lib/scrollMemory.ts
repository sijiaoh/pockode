import type { HistoryState, RouterHistory } from "@tanstack/react-router";
import { visitKeyOf } from "./layerHistory";

/**
 * Where each page's scrollers were left, per history entry, so that going back
 * to an entry puts the reader where they were — the way a browser does for a
 * page that scrolls the window. The app scrolls inside its own containers, and
 * a page is unmounted when another replaces it, so nothing else remembers.
 *
 * Keyed by the history entry rather than the URL: a fresh push of the same URL
 * is a new entry and starts at the top, as a link does in a browser. A layer's
 * entry is the page's under it (`visitKeyOf`): a sheet going up or down over
 * the page is no new visit. Every
 * return is a move back to an entry still in the history — the browser's Back,
 * and an in-app ← whose parent is behind (`useGoToParent`) — so its key finds
 * what was saved; nothing that pushes is a return.
 *
 * A replace is the same visit and keeps the offsets, unless it says it is not
 * (`FRESH_VISIT_STATE`).
 */
export interface ScrollMemory {
	get(entry: string, scroller: string): number | undefined;
	set(entry: string, scroller: string, top: number): void;
}

const FRESH_VISIT_KEY = "freshVisit";

/**
 * The history state of a replace that puts another page in place of the one
 * on screen — a parent standing in for its child, the next file for one just
 * discarded — rather than showing the same page otherwise. It starts at the
 * top: the offsets left on the page it replaced are not this page's, and every
 * page's scroller is named alike.
 *
 * Cast because the router's HistoryState is declared in @tanstack/history,
 * which this package does not depend on directly and so cannot augment.
 */
export const FRESH_VISIT_STATE = { [FRESH_VISIT_KEY]: true } as HistoryState;

function isFreshVisit(state: unknown): boolean {
	return (
		typeof state === "object" &&
		state !== null &&
		(state as Record<string, unknown>)[FRESH_VISIT_KEY] === true
	);
}

/** Plenty for any trail a reader walks back along; older entries are dropped. */
const MAX_ENTRIES = 100;

/** Sets `key` last, dropping the oldest once the map holds more than allowed. */
function keep<V>(map: Map<string, V>, key: string, value: V) {
	map.delete(key);
	map.set(key, value);
	if (map.size > MAX_ENTRIES) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
}

function createScrollMemory(history: RouterHistory): ScrollMemory {
	const positions = new Map<string, Map<string, number>>();
	let current = visitKeyOf(history.location);

	history.subscribe(({ location, action }) => {
		const left = current;
		current = visitKeyOf(location);
		// Still the same visit — a side switched, a file renamed — so the
		// offsets move to the new entry; the old one cannot be returned to.
		if (action.type !== "REPLACE") return;
		const saved = positions.get(left);
		positions.delete(left);
		if (saved && !isFreshVisit(location.state)) {
			keep(positions, current, saved);
		}
	});

	return {
		get: (entry, scroller) => positions.get(entry)?.get(scroller),
		set: (entry, scroller, top) => {
			let saved = positions.get(entry);
			if (!saved) {
				saved = new Map();
				keep(positions, entry, saved);
			}
			saved.set(scroller, top);
		},
	};
}

const memories = new WeakMap<RouterHistory, ScrollMemory>();

/**
 * One memory per history, created on first use. The app's router asks for it
 * as soon as it exists, so that it has seen the first page; a test's
 * router gets one when its first scroller mounts.
 */
export function scrollMemoryFor(history: RouterHistory): ScrollMemory {
	let memory = memories.get(history);
	if (!memory) {
		memory = createScrollMemory(history);
		memories.set(history, memory);
	}
	return memory;
}
