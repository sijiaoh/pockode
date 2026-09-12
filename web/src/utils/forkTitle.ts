/**
 * The ` (fork)` / ` (fork 2)` suffix this module adds and strips. Anchored at
 * the end, and the number is optional because the first fork carries none.
 */
const FORK_SUFFIX = /\s*\(fork(?: (\d+))?\)$/;

/**
 * The title to pre-fill a fork's name field with: the parent's title plus a
 * `(fork)` suffix, numbered up to the lowest number not already taken.
 *
 * A fork's subject is its parent's subject, so the name says so rather than
 * being derived from the anchor message the way a first message titles a new
 * chat — losing the lineage in the name costs more than a sharper title gains,
 * and the field is editable anyway. The suffix a parent already carries is
 * stripped first, so forks of forks do not stack `(fork) (fork)`.
 *
 * Numbering keeps the sidebar legible: sorted by recency, a parent and its fork
 * sit next to each other, and forking the same conversation twice would
 * otherwise produce two rows with one identical name.
 */
export function buildForkTitle(
	parentTitle: string,
	existingTitles: readonly string[],
): string {
	const base = parentTitle.replace(FORK_SUFFIX, "").trim() || parentTitle;
	const taken = new Set(existingTitles);

	for (let n = 1; ; n++) {
		const candidate = n === 1 ? `${base} (fork)` : `${base} (fork ${n})`;
		if (!taken.has(candidate)) return candidate;
	}
}
