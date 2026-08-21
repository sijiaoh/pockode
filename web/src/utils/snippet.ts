import { findMatchIndexes } from "./textMatch";

const TAB_REPLACEMENT = "  ";

// A sidebar row is only ~250px wide on mobile, so a match sitting past this
// many characters would never be visible and the snippet is re-anchored on it.
const MAX_LEADING_CHARS = 24;
const LEADING_CONTEXT_CHARS = 16;

// The rest is cut off by CSS truncation anyway; capping keeps the DOM small.
const MAX_SNIPPET_CHARS = 200;

const ELLIPSIS = "…";

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
 * this trims what is left to fit a sidebar row, always keeping the match
 * itself visible.
 */
export function buildSnippet(text: string, query: string): string {
	// Leading indentation is pure noise here and would push the match off screen.
	const normalized = text.split("\t").join(TAB_REPLACEMENT).replace(/^\s+/, "");

	const matchIndex = findMatchIndexes(normalized, query)[0] ?? -1;
	if (matchIndex <= MAX_LEADING_CHARS) {
		return clamp(normalized, MAX_SNIPPET_CHARS);
	}

	let start = matchIndex - LEADING_CONTEXT_CHARS;
	if (isLowSurrogate(normalized.charCodeAt(start))) {
		start -= 1;
	}
	return ELLIPSIS + clamp(normalized.slice(start), MAX_SNIPPET_CHARS);
}

function clamp(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const end = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
	return text.slice(0, end);
}
