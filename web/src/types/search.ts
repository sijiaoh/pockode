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
	ranges: SearchRange[];
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
	/** Only present in content mode. */
	lines?: SearchLine[];
}

export interface FileSearchResult {
	matches: FileMatch[];
	/** Limits or the server timeout cut the search short; more matches may exist. */
	truncated: boolean;
}
