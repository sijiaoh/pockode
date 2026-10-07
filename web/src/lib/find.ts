import { findMatchIndexes } from "../utils/textMatch";

/**
 * Find in the full screen viewer (docs/tool-call-ui.md#full-screen): literal,
 * case-insensitive, and line by line — `findMatchIndexes` finds nothing in a
 * string whose lowercasing changes its length, and one `İ` must cost only its
 * own line, not the whole log.
 */

/** A match on one line of a content's lines. */
export interface LineMatch {
	/** The line's index in the lines searched. */
	index: number;
	start: number;
	end: number;
}

/** Every match in `lines`, in reading order. */
export function findInLines(lines: string[], query: string): LineMatch[] {
	const matches: LineMatch[] = [];
	if (!query) return matches;
	for (let index = 0; index < lines.length; index++) {
		for (const start of findMatchIndexes(lines[index], query)) {
			matches.push({ index, start, end: start + query.length });
		}
	}
	return matches;
}

/**
 * Every match in a text that may hold several lines — a block of rendered
 * text — as `[start, end)` offsets into the whole text, searched a line at a
 * time.
 */
export function findInText(text: string, query: string): [number, number][] {
	const found: [number, number][] = [];
	if (!query) return found;
	let lineStart = 0;
	for (const line of text.split("\n")) {
		for (const start of findMatchIndexes(line, query)) {
			found.push([lineStart + start, lineStart + start + query.length]);
		}
		lineStart += line.length + 1;
	}
	return found;
}

/**
 * The first match at or after `start` on line `index`, or -1 when every match
 * comes before it. `matches` is in reading order.
 */
export function matchAtOrAfter(
	matches: LineMatch[],
	index: number,
	start = 0,
): number {
	let low = 0;
	let high = matches.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		const match = matches[mid];
		if (match.index < index || (match.index === index && match.start < start)) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low < matches.length ? low : -1;
}

/** One step through `total` matches, wrapping around at either end. */
export function stepMatch(
	current: number | null,
	total: number,
	delta: 1 | -1,
): number | null {
	if (total === 0) return null;
	if (current === null) return delta === 1 ? 0 : total - 1;
	return (current + delta + total) % total;
}

/** What the find bar shows and a screen reader is told of where find is. */
export function findStatus(
	current: number | null,
	total: number,
): { shown: string; spoken: string } {
	if (total === 0) return { shown: "No matches", spoken: "No matches" };
	const at = current === null ? "–" : String(current + 1);
	return {
		shown: `${at} / ${total}`,
		spoken:
			current === null
				? `${total} ${total === 1 ? "match" : "matches"}`
				: `${current + 1} of ${total} ${total === 1 ? "match" : "matches"}`,
	};
}
