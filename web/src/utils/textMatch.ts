/**
 * Start indexes of every case-insensitive literal occurrence of `query`.
 *
 * Literal (not regex) matching, so query metacharacters need no escaping.
 *
 * Returns an empty list when lowercasing changes a string's length (e.g.
 * `"İ".toLowerCase()` is two code units): indexes taken from the lowercased
 * copy would no longer line up with the original and slicing by them would cut
 * mid-character. Not highlighting is better than rendering mangled text.
 */
export function findMatchIndexes(text: string, query: string): number[] {
	if (query.length === 0) {
		return [];
	}

	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();
	if (haystack.length !== text.length || needle.length !== query.length) {
		return [];
	}

	const indexes: number[] = [];
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) {
			return indexes;
		}
		indexes.push(index);
		from = index + needle.length;
	}
}
