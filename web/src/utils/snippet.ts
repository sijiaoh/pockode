import type { SearchRange } from "../types/search";
import { sliceRanges } from "./searchRange";

const TAB_REPLACEMENT = "  ";

// A sidebar row is only ~250px wide on mobile, so a match sitting past this
// many characters would never be visible and the snippet is re-anchored on it.
const MAX_LEADING_CHARS = 24;
const LEADING_CONTEXT_CHARS = 16;

// The rest is cut off by CSS truncation anyway; capping keeps the DOM small.
const MAX_SNIPPET_CHARS = 200;

const ELLIPSIS = "…";

export interface Snippet {
	text: string;
	/** The match ranges moved along with the text they mark. */
	ranges: SearchRange[];
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Prepare a matching line for display in the narrow result list.
 *
 * The server already clips very long lines to a window around the first match;
 * this trims what is left to fit a sidebar row, always keeping the first of
 * `ranges` visible.
 */
export function buildSnippet(
	text: string,
	ranges: readonly SearchRange[],
): Snippet {
	const normalized = normalize(text, ranges);

	const matchIndex = normalized.ranges[0]?.start ?? -1;
	if (matchIndex <= MAX_LEADING_CHARS) {
		return clamp(normalized, 0, "");
	}

	let start = matchIndex - LEADING_CONTEXT_CHARS;
	if (isLowSurrogate(normalized.text.charCodeAt(start))) {
		start -= 1;
	}
	return clamp(normalized, start, ELLIPSIS);
}

/**
 * Drops leading indentation — pure noise here, and it would push the match off
 * screen — and expands tabs, carrying each range to where its characters end up.
 */
function normalize(text: string, ranges: readonly SearchRange[]): Snippet {
	const indent = text.length - text.trimStart().length;
	// position[i] is where original offset i lands; one past the end too, so
	// end-exclusive offsets map like any other.
	const position: number[] = new Array(text.length + 1).fill(0);
	let out = "";
	for (let i = indent; i < text.length; i++) {
		position[i] = out.length;
		out += text[i] === "\t" ? TAB_REPLACEMENT : text[i];
	}
	position[text.length] = out.length;

	const moved: SearchRange[] = [];
	for (const range of ranges) {
		const start = position[range.start];
		const end = position[range.end];
		if (start < end) {
			moved.push({ start, end });
		}
	}
	return { text: out, ranges: moved };
}

/** Takes up to `MAX_SNIPPET_CHARS` from `from`, never splitting a surrogate pair. */
function clamp(snippet: Snippet, from: number, prefix: string): Snippet {
	let end = Math.min(snippet.text.length, from + MAX_SNIPPET_CHARS);
	if (
		end < snippet.text.length &&
		isHighSurrogate(snippet.text.charCodeAt(end - 1))
	) {
		end -= 1;
	}
	return {
		text: prefix + snippet.text.slice(from, end),
		ranges: sliceRanges(snippet.ranges, from, end).map((range) => ({
			start: range.start + prefix.length,
			end: range.end + prefix.length,
		})),
	};
}
