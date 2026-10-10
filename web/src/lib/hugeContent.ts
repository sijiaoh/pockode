import type { FullScreenContent } from "./fullScreen";
import {
	changePatches,
	changeRowCount,
	type ProposedChangeData,
	patchRows,
} from "./proposedChange";
import { outputLineCount } from "./textLines";

/**
 * Content taller than this many transcripts is huge: it never opens in place,
 * and only the viewer draws it whole (docs/tool-call-ui.md#huge-content).
 * Past three screens, reading in place is worse than reading in the viewer.
 */
export const HUGE_SCREENS = 3;

/**
 * How many lines of huge content the transcript draws: more than the main
 * budget's ceiling (30 rows) plus its 6-line tolerance, so the fade has
 * content under it.
 */
const SLICE_LINES = 40;
/**
 * The slice's ceiling in characters, for content whose lines are long: one
 * line of minified JSON is a megabyte. Generous for 40 rows at any width.
 */
const SLICE_CHARS = 16_000;

/**
 * Whether content of this kind can be huge at all. A file list is capped in
 * the transcript already, and live output is the reducer's last 200 lines —
 * both bound the DOM on their own.
 */
export function canBeHuge(content: FullScreenContent): boolean {
	// A page is drawn by its frame, and never sliced.
	if (content.kind === "files" || content.kind === "html") return false;
	if (content.kind === "output" && content.live) return false;
	// Its slice would be text alone, and what sits between the text — an image,
	// a file — would vanish from the transcript.
	if (content.kind === "output" && content.withAttachments) return false;
	return true;
}

/**
 * The rows `text` wraps to at `charsPerRow` characters a row, counted until
 * past `limit`, without the empty line after a final newline.
 */
function wrappedRows(text: string, charsPerRow: number, limit: number): number {
	let end = text.length;
	while (end > 0 && text[end - 1] === "\n") end--;
	let rows = 0;
	let start = 0;
	while (rows <= limit) {
		const nl = text.indexOf("\n", start);
		const lineEnd = nl === -1 || nl >= end ? end : nl;
		rows += Math.max(1, Math.ceil((lineEnd - start) / charsPerRow));
		if (lineEnd === end) break;
		start = lineEnd + 1;
	}
	return rows;
}

/**
 * The content's height in `text-xs` rows, estimated rather than measured: the
 * point is not to draw ten thousand lines to find out. Stops counting once
 * past `limit`, which is all a caller asks about.
 *
 * Output and Markdown wrap in the transcript, so each of their lines is as
 * many rows as it has characters per `charsPerRow` — rough for Markdown, whose
 * prose is not mono, and enough to tell three screens from one. Code and JSON
 * keep their lines whole.
 */
function estimateRows(
	content: FullScreenContent,
	charsPerRow: number,
	limit: number,
): number {
	switch (content.kind) {
		case "output":
			return wrappedRows(content.text, charsPerRow, limit);
		case "code":
			return outputLineCount(content.text);
		case "markdown":
			return wrappedRows(content.markdown, charsPerRow, limit);
		case "change": {
			let rows = 0;
			for (const patch of changePatches(content.change) ?? []) {
				rows += patchRows(patch);
				if (rows > limit) break;
			}
			return rows;
		}
		case "files":
			return content.paths.length;
		case "html":
			return 0;
	}
}

/**
 * Whether the content is huge in a transcript `transcriptRows` rows tall whose
 * blocks fit `charsPerRow` characters on a row.
 */
export function isHuge(
	content: FullScreenContent,
	{
		transcriptRows,
		charsPerRow,
	}: { transcriptRows: number; charsPerRow: number },
): boolean {
	if (!canBeHuge(content)) return false;
	const limit = HUGE_SCREENS * transcriptRows;
	return estimateRows(content, Math.max(1, charsPerRow), limit) > limit;
}

/** The first or last `SLICE_LINES` lines of `text`, at most `SLICE_CHARS` long. */
function sliceText(text: string, from: "start" | "end"): string {
	if (from === "start") {
		let end = -1;
		for (let n = 0; n < SLICE_LINES; n++) {
			end = text.indexOf("\n", end + 1);
			if (end === -1) break;
		}
		const head = end === -1 ? text : text.slice(0, end);
		return head.slice(0, SLICE_CHARS);
	}
	let trimmed = text.length;
	while (trimmed > 0 && text[trimmed - 1] === "\n") trimmed--;
	let start = trimmed;
	for (let n = 0; n < SLICE_LINES; n++) {
		start = text.lastIndexOf("\n", start - 1);
		if (start === -1) break;
	}
	const tail = text.slice(start + 1, trimmed);
	if (tail.length <= SLICE_CHARS) return tail;
	// Cut inside one long line: an escape sequence the cut falls in is kept
	// whole, or what is left of it is drawn as text (`[31m`).
	const cut = tail.length - SLICE_CHARS;
	const esc = tail.lastIndexOf("\x1b", cut - 1);
	// Near the cut only: a stray ESC far before it must not undo the cap.
	const open =
		esc !== -1 &&
		cut - esc <= MAX_ESCAPE &&
		OPEN_ESCAPE.test(tail.slice(esc, cut));
	return tail.slice(open ? esc : cut);
}

/** The longest escape sequence kept whole at a cut: a link's OSC holds a URL. */
const MAX_ESCAPE = 2048;

/** An escape sequence not yet ended: a CSI (colours) or an OSC (links). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escapes is the point
const OPEN_ESCAPE = /^\x1b(?:\[[0-9;?]*|\][^\x07\x1b]*)?$/;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The fence open after `line`, given the one open before it: a closing fence
 * is the opener's character, at least as long, with nothing after it.
 */
function fenceAfter(line: string, open: string | null): string | null {
	const match = FENCE.exec(line);
	if (!match) return open;
	const [, marker, rest] = match;
	if (open === null) return marker;
	const closes =
		marker[0] === open[0] && marker.length >= open.length && rest.trim() === "";
	return closes ? null : open;
}

/**
 * Markdown's head cut at a whole top-level block: the first blank line past
 * `SLICE_LINES` that is not inside a fence. A fence still open where it is cut
 * regardless is closed, so what follows it is not drawn as code.
 */
function sliceMarkdown(markdown: string): string {
	const lines = markdown.split("\n", SLICE_LINES * 4);
	let fence: string | null = null;
	let cut = Math.min(lines.length, SLICE_LINES);
	let fenceAtCut: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		if (i === SLICE_LINES) fenceAtCut = fence;
		if (i >= SLICE_LINES && fence === null && lines[i].trim() === "") {
			cut = i;
			fenceAtCut = null;
			break;
		}
		fence = fenceAfter(lines[i], fence);
	}
	const text = lines.slice(0, cut).join("\n").slice(0, SLICE_CHARS);
	return fenceAtCut ? `${text}\n${fenceAtCut}` : text;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/**
 * A hunk's first `budget` lines, its header's counts rewritten to match, so
 * the diff library draws them as the hunk they are the start of.
 */
function cutHunk(hunk: string, budget: number): string {
	const [header, ...body] = hunk.split("\n");
	const match = HUNK_HEADER.exec(header);
	if (!match) return hunk;
	const kept = body.slice(0, Math.max(1, budget - 1));
	let before = 0;
	let after = 0;
	for (const line of kept) {
		if (line[0] !== "+") before += line[0] === " " || line[0] === "-" ? 1 : 0;
		if (line[0] !== "-") after += line[0] === " " || line[0] === "+" ? 1 : 0;
	}
	const [, oldStart, newStart, rest] = match;
	return [
		`@@ -${oldStart},${before} +${newStart},${after} @@${rest}`,
		...kept,
	].join("\n");
}

/**
 * A patch's file headers and its first hunks, whole, up to `budget` rows. A
 * hunk that would take the slice far past that — a new file's single hunk —
 * is cut to it instead: drawn whole it would be the whole file.
 */
function slicePatch(patch: string, budget: number): [string, number] {
	const parts = patch.split(/\n(?=@@)/);
	const header = parts[0].startsWith("@@") ? null : parts[0];
	const hunks = header === null ? parts : parts.slice(1);
	const kept: string[] = header === null ? [] : [header];
	let rows = 0;
	for (const [index, hunk] of hunks.entries()) {
		if (index > 0 && rows >= budget) break;
		const hunkRows = patchRows(hunk);
		if (rows + hunkRows > budget && hunkRows > SLICE_LINES) {
			kept.push(cutHunk(hunk, budget - rows));
			rows = budget;
			break;
		}
		kept.push(hunk);
		rows += hunkRows;
	}
	return [kept.join("\n"), rows];
}

/** A change's first whole hunks, file by file, as many as `SLICE_LINES` rows take. */
function sliceChange(change: ProposedChangeData): ProposedChangeData {
	let budget = SLICE_LINES;
	const cut = (patches: string[]): string[] => {
		const kept: string[] = [];
		for (const patch of patches) {
			if (budget <= 0) break;
			const [sliced, rows] = slicePatch(patch, budget);
			kept.push(sliced);
			budget -= rows;
		}
		return kept;
	};
	switch (change.kind) {
		case "edit":
		case "multiEdit":
			return { ...change, patches: cut(change.patches) };
		case "codex": {
			const changes: typeof change.changes = [];
			for (const one of change.changes) {
				if (budget <= 0) break;
				if (!one.patch) {
					changes.push(one);
					continue;
				}
				const [patch, rows] = slicePatch(one.patch, budget);
				changes.push({ ...one, patch });
				budget -= rows;
			}
			return { ...change, changes };
		}
		case "write":
			return change;
	}
}

/**
 * What the transcript draws of huge content: its end that is read first, cut
 * at whole units — lines, a diff's hunks, Markdown's top-level blocks.
 */
export function sliceContent(
	content: FullScreenContent,
	from: "start" | "end",
): FullScreenContent {
	switch (content.kind) {
		case "output":
			// The failure is said in the last lines, which a head does not hold.
			return {
				...content,
				text: sliceText(content.text, from),
				failedTail: from === "end" && content.failedTail,
			};
		case "code":
			return { ...content, text: sliceText(content.text, from) };
		case "markdown":
			return { kind: "markdown", markdown: sliceMarkdown(content.markdown) };
		case "change":
			return { kind: "change", change: sliceChange(content.change) };
		case "files":
		case "html":
			return content;
	}
}

/** What content is counted in, where it has a unit a reader would count in. */
export function contentCount(
	content: FullScreenContent,
): { total: number; noun: "line" | "file" } | undefined {
	switch (content.kind) {
		case "output":
		case "code":
			return { noun: "line", total: outputLineCount(content.text) };
		case "change": {
			const total = changeRowCount(content.change);
			return total ? { noun: "line", total } : undefined;
		}
		case "files":
			return { noun: "file", total: content.paths.length };
		case "markdown":
		case "html":
			return undefined;
	}
}

const formatNumber = new Intl.NumberFormat("en").format;

/** `12,408 lines`, `1 file`. */
export function formatCount(total: number, noun: string): string {
	return `${formatNumber(total)} ${noun}${total === 1 ? "" : "s"}`;
}

/**
 * Block names that are plurals, which a reader opens all of rather than the
 * full one: "Open all results".
 */
const PLURAL_NOUNS = new Set(["matches", "results"]);

/**
 * The button that opens huge content: `Open full output · 12,408 lines`,
 * named without the middot for a screen reader.
 */
export function hugeOpenLabel(
	noun: string,
	content: FullScreenContent,
): { label: string; name: string } {
	const verb = PLURAL_NOUNS.has(noun)
		? `Open all ${noun}`
		: `Open full ${noun}`;
	const count = contentCount(content);
	if (!count) return { label: verb, name: verb };
	const counted = formatCount(count.total, count.noun);
	return { label: `${verb} · ${counted}`, name: `${verb}, ${counted}` };
}
