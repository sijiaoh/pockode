/** What a search query is matched against. */
export type FileSearchMode = "name" | "content";

/**
 * Match position within a `SearchLine.text` or a `FileMatch.path`, end-exclusive.
 *
 * Offsets are UTF-16 code units, the unit JS string indexes count, so they can
 * be used with `String.prototype.slice` on the string they belong to directly.
 */
export interface SearchRange {
	start: number;
	end: number;
}

export interface SearchLine {
	/** 1-based line number within the file. */
	number: number;
	/** Line content, clipped by the server to a window around the first match. */
	text: string;
	/** Matched characters of `text`, ascending and merged; a fuzzy match may leave gaps. */
	ranges: SearchRange[];
	/**
	 * This line's place among the file's lines by score, 0 for the best. Lines
	 * arrive in line-number order; a view showing only some of them shows the
	 * lowest ranks, which earned the file its place in `matches`.
	 */
	rank: number;
}

export interface FileMatch {
	/** Path relative to the work directory, slash separated. */
	path: string;
	name: string;
	/**
	 * Matched characters of `path`, ascending and merged. Name mode only,
	 * and absent when the query matched no characters (only `!exclusions`).
	 */
	path_ranges?: SearchRange[];
	/** Only present in content mode, in line-number order; `rank` orders them by score. */
	lines?: SearchLine[];
}

export interface FileSearchResult {
	/** Ranked by the server, best first; shown in this order. */
	matches: FileMatch[];
	/** Limits or the server timeout cut the search short; more matches may exist. */
	truncated: boolean;
}
