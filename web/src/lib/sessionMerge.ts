import type { SessionListItem } from "../types/message";

/** One source's page, as one round of `session_view.list` returned it. */
export interface SessionSourcePage {
	/** The worktree it was read from; "" is the main worktree. */
	worktree: string;
	sessions: SessionListItem[];
	/** Where this source's next page starts, and null at its end. */
	nextCursor: string | null;
}

/**
 * One round of fetching: a page from every source that still had one.
 *
 * A source drops out of later rounds once it is exhausted, so the last round
 * that mentions a source is the one that says where it stands.
 */
export type SessionViewRound = SessionSourcePage[];

/** A row of the merged list, and the worktree it came out of. */
export interface MergedSessionRow {
	session: SessionListItem;
	worktree: string;
}

/**
 * The order the server lists sessions in: most recently updated first, ties
 * broken by id descending (`session.ListCursor.before`).
 *
 * Merging across worktrees only works because that order is total and the same
 * on every source — the client is re-deriving the comparison the pages were
 * already cut along, not inventing one.
 */
function compareSessions(a: SessionListItem, b: SessionListItem): number {
	// A timestamp that will not parse sorts as the epoch rather than as NaN: a
	// comparator that answers NaN makes the whole sort undefined, which would
	// scramble every other row over one unreadable one.
	const at = timestamp(a.updated_at);
	const bt = timestamp(b.updated_at);
	if (at !== bt) return bt - at;
	if (a.id === b.id) return 0;
	return a.id > b.id ? -1 : 1;
}

function timestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The rows of every source so far, in one order, cut where the merge stops
 * being able to promise there is nothing missing above the cut.
 *
 * Each source is read newest-first, so every row a source has not handed over
 * yet sorts below the last row it has. A merged row is therefore only safe to
 * show once it sits at or above the *last row of every source that still has
 * more* — below that line, another source's next page could still arrive in
 * between, and a list that inserts a row above what the reader has already
 * scrolled past is the one thing paging may not do (docs/list-paging-ui.md
 * §2.4).
 *
 * The line only ever moves down as rounds arrive, so the visible list only
 * grows downwards and never reorders.
 *
 * Rows are deduplicated by id on the way out, the newest copy winning. A
 * session touched between two requests moves in its source's order and can be
 * handed over twice — a cursor removes the systematic error, not every race,
 * and the client dedupes regardless (docs/list-paging-ui.md §3.3). Re-reading a
 * round that has already landed, which is what a refresh does, is the other way
 * two copies arrive.
 */
export function mergeSessionRounds(
	rounds: SessionViewRound[],
): MergedSessionRow[] {
	const rows: MergedSessionRow[] = [];
	/** The last row each source handed over, and whether it has more to give. */
	const tails = new Map<
		string,
		{ last: SessionListItem | null; hasMore: boolean }
	>();

	for (const round of rounds) {
		for (const page of round) {
			for (const session of page.sessions) {
				rows.push({ session, worktree: page.worktree });
			}
			const held = tails.get(page.worktree);
			tails.set(page.worktree, {
				last:
					page.sessions.length > 0
						? page.sessions[page.sessions.length - 1]
						: (held?.last ?? null),
				hasMore: page.nextCursor !== null,
			});
		}
	}

	rows.sort((a, b) => compareSessions(a.session, b.session));

	// After the sort, so the copy kept is the one with the newest timestamp —
	// which is also the one at the position the list would put the session in.
	const seen = new Set<string>();
	const unique = rows.filter((row) => {
		if (seen.has(row.session.id)) return false;
		seen.add(row.session.id);
		return true;
	});

	let watermark: SessionListItem | null = null;
	for (const tail of tails.values()) {
		if (!tail.hasMore) continue;
		// A source with more to come but nothing handed over yet bounds the list
		// at the top: anything it has could belong anywhere, including first.
		if (!tail.last) return [];
		if (!watermark || compareSessions(tail.last, watermark) < 0) {
			watermark = tail.last;
		}
	}
	if (!watermark) return unique;

	const cut = watermark;
	return unique.filter((row) => compareSessions(row.session, cut) <= 0);
}
