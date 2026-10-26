import type { SearchRange } from "../types/search";

/**
 * The parts of `ranges` that fall within `[start, end)` of the string they
 * describe, re-based so they index the slice `text.slice(start, end)`.
 *
 * Use this to highlight one piece of a string the server matched as a whole —
 * a path's file name apart from its directory, or a trimmed snippet of a line.
 * A range straddling a cut keeps the part on this side of it.
 */
export function sliceRanges(
	ranges: readonly SearchRange[],
	start: number,
	end: number,
): SearchRange[] {
	const sliced: SearchRange[] = [];
	for (const range of ranges) {
		const from = Math.max(range.start, start);
		const to = Math.min(range.end, end);
		if (from < to) {
			sliced.push({ start: from - start, end: to - start });
		}
	}
	return sliced;
}
