import type { HistoryLocation, RouterHistory } from "@tanstack/react-router";

/**
 * What the tab's history holds, as far as this app has seen it: the entry at
 * each position, by the index the router writes into every entry's state
 * (`__TSR_index`). The browser does not let a page read its own history, and
 * an in-app ← has to know what is behind the page to go up without leaving
 * the page it left behind it (`useGoToParent`).
 *
 * Kept in sessionStorage where it is given one, which lives exactly as long as
 * the tab's history, so that a reload still knows what is behind it. What was
 * stored is believed only if the entry on screen is the one stored at its
 * index: a URL typed into the address bar starts a document whose first entry
 * the router numbers 0 again, and the trail then knows that entry alone. Not
 * knowing is always safe — ← then puts the parent in place of the page.
 */
export interface HistoryTrail {
	/** The current entry's position, undefined if the router wrote none. */
	readonly index: number | undefined;
	/** Which document this is, as each entry it writes says (`TrailEntry.doc`). */
	readonly document: string;
	/** The entry at `index`, undefined where nothing is known. */
	at(index: number): TrailEntry | undefined;
	/**
	 * Puts `href` in place of the entry `key` once the history arrives at it,
	 * should that arrival load the app afresh — an entry from before a reload
	 * is another document's. Kept in storage, and read as the next document's
	 * trail starts; an arrival this document sees is its own to handle, and
	 * it cancels this.
	 */
	rewriteOnArrival(key: string, href: string): void;
	cancelRewrite(): void;
}

export interface TrailEntry {
	key: string;
	href: string;
	/**
	 * The document that wrote the entry. One written before a reload is
	 * another document's, and going to it loads the app afresh — which may
	 * take a while to begin.
	 */
	doc?: string;
}

const STORAGE_KEY = "pockode:history-trail";
const ARRIVAL_KEY = "pockode:history-arrival";

/** Plenty for any walk up; entries further behind are forgotten. */
const MAX_BEHIND = 200;

/** Takes the router's location as well as the history's: both carry these. */
export function entryKeyOf(location: {
	href: string;
	state: { __TSR_key?: string };
}): string {
	return location.state.__TSR_key ?? location.href;
}

function indexOf(location: HistoryLocation): number | undefined {
	// Typed as always present; an entry the router has not written has none.
	const index: unknown = location.state.__TSR_index;
	return typeof index === "number" ? index : undefined;
}

function readStored(storage: Storage | undefined): (TrailEntry | null)[] {
	try {
		const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function readArrival(
	storage: Storage | undefined,
): { key: string; href: string } | undefined {
	try {
		const parsed: unknown = JSON.parse(storage?.getItem(ARRIVAL_KEY) ?? "null");
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"key" in parsed &&
			"href" in parsed &&
			typeof parsed.key === "string" &&
			typeof parsed.href === "string"
		) {
			return { key: parsed.key, href: parsed.href };
		}
	} catch {
		// Unreadable is nothing to rewrite.
	}
	return undefined;
}

function createHistoryTrail(
	history: RouterHistory,
	storage: Storage | undefined,
): HistoryTrail {
	let entries: (TrailEntry | null)[] = [];
	let index: number | undefined;
	const doc = Math.random().toString(36).slice(2);

	const entryOf = (location: HistoryLocation): TrailEntry => ({
		key: entryKeyOf(location),
		href: location.href,
		doc,
	});

	// Only the current entry is known.
	const restart = (location: HistoryLocation) => {
		entries = [];
		index = indexOf(location);
		if (index !== undefined) entries[index] = entryOf(location);
	};

	const save = () => {
		if (!storage) return;
		if (index !== undefined && index > MAX_BEHIND) {
			entries.fill(null, 0, index - MAX_BEHIND);
		}
		try {
			storage.setItem(STORAGE_KEY, JSON.stringify(entries));
		} catch {
			// Full or refused: the trail still serves this document from memory.
		}
	};

	const start = history.location;
	const startIndex = indexOf(start);
	const stored = readStored(storage);
	if (
		startIndex !== undefined &&
		stored[startIndex]?.key === entryKeyOf(start)
	) {
		entries = stored;
		index = startIndex;
		entries[startIndex] = entryOf(start);
	} else {
		restart(start);
	}
	save();

	history.subscribe(({ location, action }) => {
		const at = indexOf(location);
		if (at === undefined) {
			restart(location);
		} else if (action.type === "PUSH") {
			entries.length = at;
			entries[at] = entryOf(location);
			index = at;
		} else if (action.type === "REPLACE") {
			entries[at] = entryOf(location);
			index = at;
		} else if (entries[at]?.key === entryKeyOf(location)) {
			index = at;
		} else {
			restart(location);
		}
		save();
	});

	const arrival = readArrival(storage);
	storage?.removeItem(ARRIVAL_KEY);
	if (arrival?.key === entryKeyOf(history.location)) {
		history.replace(arrival.href);
	}

	return {
		get index() {
			return index;
		},
		document: doc,
		at: (i) => entries[i] ?? undefined,
		rewriteOnArrival: (key, href) => {
			try {
				storage?.setItem(ARRIVAL_KEY, JSON.stringify({ key, href }));
			} catch {
				// As for the trail: this document still rewrites what it sees.
			}
		},
		cancelRewrite: () => storage?.removeItem(ARRIVAL_KEY),
	};
}

const trails = new WeakMap<RouterHistory, HistoryTrail>();

/**
 * One trail per history, created on first use — before the router, so that
 * it starts with the page the app was opened on, and so that a rewrite owed
 * to this arrival is made before the router reads the location. `storage` is
 * read only then: the app hands it sessionStorage, and a test's memory
 * history keeps its trail in memory.
 */
export function historyTrailFor(
	history: RouterHistory,
	storage?: Storage,
): HistoryTrail {
	let trail = trails.get(history);
	if (!trail) {
		trail = createHistoryTrail(history, storage);
		trails.set(history, trail);
	}
	return trail;
}
