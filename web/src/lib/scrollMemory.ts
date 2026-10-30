import type {
	HistoryLocation,
	HistoryState,
	RouterHistory,
} from "@tanstack/react-router";
import { entryKeyOf } from "./historyTrail";

/**
 * Where each page's scrollers were left, per history entry, so that going back
 * to an entry puts the reader where they were — the way a browser does for a
 * page that scrolls the window. The app scrolls inside its own containers, and
 * a page is unmounted when another replaces it, so nothing else remembers.
 *
 * Keyed by the history entry rather than the URL: a fresh push of the same URL
 * is a new entry and starts at the top, as a link does in a browser.
 *
 * Back here is two things. The browser's (and any `history.go()` back, which
 * is what the Git workspace's ← is when its parent is behind) returns to an
 * entry that is still in the history, so its key finds what was saved. The
 * other screens' header Back *pushes* the parent's URL (`overlayToNavigation`),
 * which is a new entry; a push to the URL of the page the reader came down
 * from is taken as that return, and the new entry inherits what the old one
 * saved.
 *
 * A replace is the same visit and keeps the offsets, unless it says it is not
 * (`FRESH_VISIT_STATE`).
 */
export interface ScrollMemory {
	get(entry: string, scroller: string): number | undefined;
	set(entry: string, scroller: string, top: number): void;
}

interface Frame {
	entry: string;
	href: string;
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
	// For each entry, the page the reader came down from to reach it — what a
	// push is compared against to recognise the header's Back. Not the entry
	// behind it in the history (lib/historyTrail.ts): a push taken as that
	// Back stands in for the page it returned to, so what is under it is what
	// was under that page.
	const below = new Map<string, Frame | undefined>();

	const frameOf = (location: HistoryLocation): Frame => ({
		entry: entryKeyOf(location),
		href: location.href,
	});

	let current = frameOf(history.location);

	history.subscribe(({ location, action }) => {
		const frame = frameOf(location);
		const left = current;
		current = frame;
		switch (action.type) {
			case "PUSH": {
				const under = below.get(left.entry);
				if (under?.href !== frame.href) {
					keep(below, frame.entry, left);
					return;
				}
				const saved = positions.get(under.entry);
				if (saved) keep(positions, frame.entry, new Map(saved));
				keep(below, frame.entry, below.get(under.entry));
				return;
			}
			case "REPLACE": {
				// Still the same visit — a side switched, a file renamed — so the
				// offsets move to the new entry; the old one cannot be returned to.
				const saved = positions.get(left.entry);
				positions.delete(left.entry);
				if (saved && !isFreshVisit(location.state)) {
					keep(positions, frame.entry, saved);
				}
				keep(below, frame.entry, below.get(left.entry));
				below.delete(left.entry);
				return;
			}
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
