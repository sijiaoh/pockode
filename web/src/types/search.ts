/** What a search query is matched against. */
export type FileSearchMode = "name" | "content";

/**
 * Match position within a `SearchLine.text`, end-exclusive.
 *
 * Offsets are UTF-8 **byte** offsets (ripgrep convention), not JS string
 * indexes, so they cannot be used with `String.prototype.slice` directly.
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
	/** Only present in content mode. */
	lines?: SearchLine[];
}

export interface FileSearchResult {
	matches: FileMatch[];
	/** Limits or the server timeout cut the search short; more matches may exist. */
	truncated: boolean;
}
