import type { ScheduleRunItem, ScheduleRunPage } from "../types/schedule";
import { normalizeWorkRow } from "./workStore";

/** The runs a detail page has loaded, newest made first. */
export interface LoadedRuns {
	items: ScheduleRunItem[];
	/** Where the next older page starts; null once there is none. */
	nextCursor: string | null;
	/**
	 * Whether a page older than the newest has been loaded. From then on the
	 * cursor is that page's, and the newest page arriving again must not move it
	 * back to where the first page ended.
	 */
	pagedPastFirst: boolean;
}

export const NO_RUNS: LoadedRuns = {
	items: [],
	nextCursor: null,
	pagedPastFirst: false,
};

function pageCursor(page: ScheduleRunPage): string | null {
	return page.has_more ? (page.next_cursor ?? null) : null;
}

function normalizeRun(run: ScheduleRunItem): ScheduleRunItem {
	return normalizeWorkRow(run) as ScheduleRunItem;
}

/**
 * Nanoseconds since the epoch, exactly: the server orders runs by nanosecond
 * (`session.ListCursor`), and `Date` keeps milliseconds, which would put two
 * runs made in the same millisecond in an order the server does not use.
 */
function createdAtNanos(iso: string): bigint {
	const fraction = /\.(\d+)/.exec(iso)?.[1] ?? "";
	// Cut to milliseconds before parsing: the date-time format `Date.parse` is
	// held to has three fractional digits, and Go writes up to nine.
	const ms = BigInt(Date.parse(iso.replace(/(\.\d{3})\d+/, "$1")));
	const belowMs = BigInt(fraction.slice(3, 9).padEnd(6, "0"));
	return ms * 1_000_000n + belowMs;
}

/**
 * Newest made first, ties to the higher id — the server's run order, and the
 * schedule list's (docs/schedule-ui.md §3.3). A comparator for `sort`.
 */
export function compareNewestFirst(
	a: { created_at: string; id: string },
	b: { created_at: string; id: string },
): number {
	const ta = createdAtNanos(a.created_at);
	const tb = createdAtNanos(b.created_at);
	if (ta !== tb) return ta > tb ? -1 : 1;
	return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

/**
 * The newest page, as the subscription's notifications send it, merged into
 * what is loaded by id (docs/projects/api.md#schedule-runs).
 *
 * The page is the truth for the span it covers: a loaded run inside it that
 * the page no longer holds has been deleted. A run older than that span is kept
 * as loaded — it may have been pushed off the page by a newer one, and older
 * pages are never re-sent.
 */
export function mergeNewestPage(
	loaded: LoadedRuns,
	page: ScheduleRunPage,
): LoadedRuns {
	const items = page.items.map(normalizeRun);
	const oldest = items.at(-1);
	const cursor = pageCursor(page);
	// A page with nothing after it covers every run there is.
	const older =
		cursor === null || oldest === undefined
			? []
			: loaded.items.filter((run) => compareNewestFirst(run, oldest) > 0);
	// Every run was already held, so the ones a new run pushed off the page are
	// among those kept: following the page's cursor would offer a page made only
	// of runs on screen.
	const heldEverything = loaded.items.length > 0 && loaded.nextCursor === null;
	let nextCursor = cursor;
	if (cursor !== null && heldEverything) nextCursor = null;
	else if (cursor !== null && loaded.pagedPastFirst)
		nextCursor = loaded.nextCursor;
	return {
		items: [...items, ...older],
		nextCursor,
		pagedPastFirst: loaded.pagedPastFirst && cursor !== null,
	};
}

/**
 * An older page appended below what is loaded. The newest page moves rows down
 * as runs are made, so an older page can repeat a run already held; the page's
 * copy replaces it where it stands, because a run pushed off the newest page is
 * sent nothing more and the page is the latest word on it
 * (docs/projects/api.md#schedule-runs).
 */
export function appendOlderPage(
	loaded: LoadedRuns,
	page: ScheduleRunPage,
): LoadedRuns {
	const read = new Map(page.items.map((run) => [run.id, normalizeRun(run)]));
	const items = loaded.items.map((run) => {
		const fresh = read.get(run.id);
		if (!fresh) return run;
		read.delete(run.id);
		return fresh;
	});
	return {
		items: [...items, ...read.values()],
		nextCursor: pageCursor(page),
		pagedPastFirst: true,
	};
}
