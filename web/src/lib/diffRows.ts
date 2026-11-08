import type { DiffHunk, DiffHunkLine } from "./diffHunks";

/**
 * Which rows a selection runs over: every row in unified view, and in split
 * view the rows of the one side it was made on
 * (docs/git-changes-ui.md#selecting).
 */
export type LineView = "unified" | "old" | "new";

/** A row of the diff as the review draws it, hunk lines and gap lines alike. */
export interface DiffRow extends DiffHunkLine {
	/** The hunk it belongs to, by index; absent for an unchanged line between hunks. */
	hunk?: number;
	/**
	 * An unchanged line's old text, where it is read from the old content: with
	 * whitespace hidden it can differ from the new text in whitespace.
	 */
	oldText?: string;
}

/** A gutter cell, named the way the rows are: `o41` on the old side, `n41` on the new. */
export interface GutterLine {
	view: LineView;
	key: string;
}

export interface LineRange {
	view: LineView;
	/** Where the selection started: a mouse drag and a far-end tap both keep it. */
	anchor: string;
	focus: string;
}

export type LinePress =
	| { type: "start" | "extend"; line: GutterLine }
	| { type: "drag"; from: GutterLine; line: GutterLine };

function contentLines(content: string): string[] {
	if (content === "") return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

/**
 * Every row of the file in the order unified view draws them: the hunks' own
 * lines, and between them the unchanged lines a gap hides, read from the full
 * contents. The gaps are rows too, because a selection may run across one.
 */
export function buildDiffRows(
	hunks: DiffHunk[],
	content: { old: string; new: string },
): DiffRow[] {
	const oldLines = contentLines(content.old);
	const newLines = contentLines(content.new);
	const rows: DiffRow[] = [];
	let oldNext = 1;
	let newNext = 1;
	const pushGap = (count: number) => {
		for (let k = 0; k < count; k++) {
			const text = newLines[newNext + k - 1];
			if (text === undefined) break;
			rows.push({
				kind: "context",
				old: oldNext + k,
				new: newNext + k,
				text,
				oldText: oldLines[oldNext + k - 1],
			});
		}
	};
	for (const [index, hunk] of hunks.entries()) {
		// A side with no lines in the hunk is numbered by the line before it.
		const oldFirst = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
		const newFirst = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
		pushGap(newFirst - newNext);
		for (const line of hunk.lines) rows.push({ ...line, hunk: index });
		oldNext = oldFirst + hunk.oldCount;
		newNext = newFirst + hunk.newCount;
	}
	pushGap(newLines.length - newNext + 1);
	return rows;
}

/**
 * A row's name in a view, the way the gutter names its cell. In unified view
 * a row carrying a new number is named by it, so context and added lines are
 * `n…` and only removed lines are `o…`.
 */
export function rowKey(row: DiffRow, view: LineView): string | undefined {
	if (view === "old") return row.old === undefined ? undefined : `o${row.old}`;
	if (view === "new") return row.new === undefined ? undefined : `n${row.new}`;
	return row.new !== undefined ? `n${row.new}` : `o${row.old}`;
}

/** The rows a range covers, in order; null when either end is no longer drawn. */
export function resolveRange(
	rows: DiffRow[],
	range: LineRange,
): DiffRow[] | null {
	const inView = rows.filter((row) => rowKey(row, range.view) !== undefined);
	const keys = inView.map((row) => rowKey(row, range.view));
	const a = keys.indexOf(range.anchor);
	const b = keys.indexOf(range.focus);
	if (a < 0 || b < 0) return null;
	return inView.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * What has to stay the same for a selection to outlive a refreshed diff:
 * every row's kind and text, and the numbers the range is named by. The other
 * side's numbers are left out — on the unstaged side the old numbers are the
 * index's, and staging a hunk above the selection moves them while the lines
 * the reader picked have not changed at all.
 */
export function rangeSignature(selected: DiffRow[], view: LineView): string {
	const { side } = describeRange(selected, view);
	return selected.map((row) => rowSignature(row, side)).join("\n");
}

function rowSignature(row: DiffRow, side: "old" | "new"): string {
	return `${row.kind}:${row[side] ?? ""}:${row.text}`;
}

/**
 * A held selection in a refreshed diff: where its ends still name the same
 * rows, those; otherwise the same rows found again where they now are, which
 * an end keyed by an old number needs once that number has moved. Null when
 * the rows are not there as they were.
 */
export function relocateRange(
	rows: DiffRow[],
	range: LineRange,
	signature: string,
	/** Whether the anchor is the range's top end, which the search keeps. */
	anchorFirst: boolean,
): { range: LineRange; selected: DiffRow[] } | null {
	const selected = resolveRange(rows, range);
	if (selected && rangeSignature(selected, range.view) === signature) {
		return { range, selected };
	}
	const wanted = signature.split("\n");
	// The side the numbers are on follows from the rows' kinds alone, so it is
	// the held selection's for any run that matches.
	const removedOnly = wanted.every((line) => line.startsWith("removed:"));
	const side = removedOnly || range.view === "old" ? "old" : "new";
	const inView = rows.filter((row) => rowKey(row, range.view) !== undefined);
	const found = inView.map((row) => rowSignature(row, side));
	for (let start = 0; start + wanted.length <= inView.length; start++) {
		if (wanted.some((line, offset) => found[start + offset] !== line)) {
			continue;
		}
		const candidate = inView.slice(start, start + wanted.length);
		const first = rowKey(candidate[0], range.view) ?? "";
		const last = rowKey(candidate[candidate.length - 1], range.view) ?? "";
		return {
			range: {
				view: range.view,
				anchor: anchorFirst ? first : last,
				focus: anchorFirst ? last : first,
			},
			selected: candidate,
		};
	}
	return null;
}

/** How a press in the gutter changes the selection. */
export function applyPress(
	range: LineRange | null,
	press: LinePress,
): LineRange | null {
	const { line } = press;
	if (press.type === "drag") {
		return { view: line.view, anchor: press.from.key, focus: line.key };
	}
	const sameView = range?.view === line.view;
	// Pressing the only selected line again is how it is put away.
	if (sameView && range.anchor === line.key && range.focus === line.key) {
		return null;
	}
	if (press.type === "extend" && sameView) return { ...range, focus: line.key };
	return { view: line.view, anchor: line.key, focus: line.key };
}

/**
 * A hunk's rows as a range — the hunk bar's Select. In split view it is the
 * new side's, unless the hunk only removes lines and has none there.
 */
export function hunkLineRange(
	rows: DiffRow[],
	hunk: number,
	split: boolean,
): LineRange | null {
	const own = rows.filter((row) => row.hunk === hunk);
	const view: LineView = !split
		? "unified"
		: own.some((row) => row.new !== undefined)
			? "new"
			: "old";
	const keys = own
		.map((row) => rowKey(row, view))
		.filter((key) => key !== undefined);
	if (keys.length === 0) return null;
	return { view, anchor: keys[0], focus: keys[keys.length - 1] };
}

type RangeKind = "lines" | "removed" | "old";

/** `lines 40–48`, `line 40`, `removed lines 41–43`, `old line 41`. */
export function formatRange(kind: RangeKind, first: number, last: number) {
	const prefix = kind === "lines" ? "" : `${kind} `;
	return first === last
		? `${prefix}line ${first}`
		: `${prefix}lines ${first}–${last}`;
}

export function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface RangeDescription {
	/** The version the numbers — and what Copy copies — belong to. */
	side: "old" | "new";
	first: number;
	last: number;
	/** Lower-cased, as the prefill writes it; the bar capitalizes it. */
	label: string;
}

/**
 * A selection's numbers. They are the new side's — from the first to the
 * last selected row that has one — except for a range of removed lines only,
 * or one made on the old side in split view.
 */
export function describeRange(
	selected: DiffRow[],
	view: LineView,
): RangeDescription {
	const removedOnly = selected.every((row) => row.kind === "removed");
	const side = removedOnly || view === "old" ? "old" : "new";
	const numbers = selected
		.map((row) => row[side])
		.filter((n) => n !== undefined);
	const first = numbers[0];
	const last = numbers[numbers.length - 1];
	const kind: RangeKind = removedOnly
		? "removed"
		: view === "old"
			? "old"
			: "lines";
	return { side, first, last, label: formatRange(kind, first, last) };
}

/**
 * The code on the side the range is numbered on, verbatim and without
 * markers, from the full content — so lines a collapsed gap hides are in it.
 */
export function selectionCopyText(
	description: RangeDescription,
	selected: DiffRow[],
	content: { old: string; new: string },
): string {
	const { side, first, last } = description;
	const lines = contentLines(content[side]);
	if (lines.length >= last) return lines.slice(first - 1, last).join("\n");
	return selected
		.filter((row) => row[side] !== undefined)
		.map((row) => (side === "old" ? (row.oldText ?? row.text) : row.text))
		.join("\n");
}

/** Past this many rows the draft names the range and leaves the code out. */
export const PREFILL_MAX_ROWS = 200;

const MARKER = { context: " ", added: "+", removed: "-" } as const;

/**
 * What a diff compares: a side of the working tree's changes in the review,
 * or a commit against its parent in the history.
 */
export type DiffSource =
	| { kind: "review"; staged: boolean }
	| { kind: "commit"; hash: string };

function versionLabel(side: "old" | "new", source: DiffSource): string {
	// A commit's lines are history: said so, or the agent edits the file as
	// though they were what is on disk now.
	if (source.kind === "commit") {
		const at = side === "new" ? "as of" : "before";
		return `${at} commit ${source.hash}, not the working tree`;
	}
	const { staged } = source;
	if (side === "new") return staged ? "staged" : "working tree";
	// The unstaged side's old version is the index, which is HEAD's content
	// when nothing is staged.
	return staged ? "HEAD" : "index";
}

function fenceFor(lines: string[]): string {
	let longest = 0;
	for (const line of lines) {
		for (const run of line.match(/`+/g) ?? []) {
			longest = Math.max(longest, run.length);
		}
	}
	return "`".repeat(Math.max(3, longest + 1));
}

function unchangedLine(count: number): string {
	return `… ${count} unchanged ${count === 1 ? "line" : "lines"} …`;
}

/**
 * What `Ask AI to edit…` puts in the composer
 * (docs/git-changes-ui.md#what-ask-ai-to-edit-writes): the path, the range,
 * the version its numbers are from and the rows as a `diff` fence. A run of
 * rows the reader has not expanded is one line saying how many.
 */
export function selectionPrefillText({
	path,
	selected,
	view,
	description,
	source,
	isShown,
}: {
	path: string;
	selected: DiffRow[];
	view: LineView;
	description: RangeDescription;
	source: DiffSource;
	isShown: (row: DiffRow) => boolean;
}): string {
	const head = `\`${path}\`, ${description.label} (${versionLabel(description.side, source)})`;
	const body: string[] = [];
	let hidden = 0;
	let shown = 0;
	for (const row of selected) {
		if (!isShown(row)) {
			hidden++;
			continue;
		}
		if (hidden > 0) body.push(unchangedLine(hidden));
		hidden = 0;
		shown++;
		const text = view === "old" ? (row.oldText ?? row.text) : row.text;
		body.push(`${MARKER[row.kind]}${text}`);
	}
	if (hidden > 0) body.push(unchangedLine(hidden));
	if (shown > PREFILL_MAX_ROWS) return `${head}.`;
	const fence = fenceFor(body);
	return `${head}:\n\n${fence}diff\n${body.join("\n")}\n${fence}`;
}
