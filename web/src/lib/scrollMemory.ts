import type { HistoryLocation, RouterHistory } from "@tanstack/react-router";

/**
 * Where each page's scrollers were left, per history entry, so that going back
 * to an entry puts the reader where they were — the way a browser does for a
 * page that scrolls the window. The app scrolls inside its own containers, and
 * a page is unmounted when another replaces it, so nothing else remembers.
 *
 * Keyed by the history entry rather than the URL: a fresh push of the same URL
 * is a new entry and starts at the top, as a link does in a browser.
 *
 * Back here is two things. The browser's (and `history.back()`) returns to an
 * entry that is still in the history, so its key finds what was saved. The
 * page header's Back *pushes* the parent's URL (`overlayToNavigation`), which
 * is a new entry; a push to the URL of the entry just under the current one is
 * taken as that return, and the new entry inherits what the old one saved.
 */
export interface ScrollMemory {
	get(entry: string, scroller: string): number | undefined;
	set(entry: string, scroller: string, top: number): void;
}

interface Frame {
	entry: string;
	href: string;
}

/** Plenty for any trail a reader walks back along; older entries are dropped. */
const MAX_ENTRIES = 100;

/** Takes the router's location as well as the history's: both carry these. */
export function entryKeyOf(location: {
	href: string;
	state: { __TSR_key?: string };
}): string {
	return location.state.__TSR_key ?? location.href;
}

function createScrollMemory(history: RouterHistory): ScrollMemory {
	const positions = new Map<string, Map<string, number>>();
	// The pages the reader came down through to reach the current one, current
	// last — what a push is compared against to recognise the header's Back.
	const trail: Frame[] = [];

	const frameOf = (location: HistoryLocation): Frame => ({
		entry: entryKeyOf(location),
		href: location.href,
	});

	// An entry is added last, so the first in the map is the oldest.
	const keep = (entry: string, saved: Map<string, number>) => {
		positions.set(entry, saved);
		if (positions.size > MAX_ENTRIES) {
			const oldest = positions.keys().next().value;
			if (oldest !== undefined) positions.delete(oldest);
		}
	};

	trail.push(frameOf(history.location));

	history.subscribe(({ location, action }) => {
		const frame = frameOf(location);
		switch (action.type) {
			case "PUSH": {
				const below = trail.at(-2);
				if (below?.href !== frame.href) {
					trail.push(frame);
					return;
				}
				const saved = positions.get(below.entry);
				if (saved) keep(frame.entry, new Map(saved));
				trail.splice(-2, 2, frame);
				return;
			}
			case "REPLACE": {
				// Still the same visit — a side switched, a file renamed — so the
				// offsets move to the new entry; the old one cannot be returned to.
				const replaced = trail.at(-1);
				const saved = replaced && positions.get(replaced.entry);
				if (replaced && saved) {
					positions.delete(replaced.entry);
					keep(frame.entry, saved);
				}
				trail.splice(-1, 1, frame);
				return;
			}
			default: {
				const at = trail.findIndex((f) => f.entry === frame.entry);
				if (at >= 0) trail.length = at + 1;
				else trail.push(frame);
			}
		}
	});

	return {
		get: (entry, scroller) => positions.get(entry)?.get(scroller),
		set: (entry, scroller, top) => {
			let saved = positions.get(entry);
			if (!saved) {
				saved = new Map();
				keep(entry, saved);
			}
			saved.set(scroller, top);
		},
	};
}

const memories = new WeakMap<RouterHistory, ScrollMemory>();

/**
 * One memory per history, created on first use. The app's router asks for it
 * as soon as it exists, so that the trail starts with the first page; a test's
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
