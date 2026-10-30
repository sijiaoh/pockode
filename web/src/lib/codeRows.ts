/**
 * Where a line sits in a numbered file view (`CodeHighlighter lineNumbers`),
 * worked out from the block's height rather than found in the DOM: the plain
 * text past the highlight limit is one text node with no element per line, and
 * giving it one costs most of a second at 50k lines. Rows are uniform — every
 * line box the same height, highlighted or not — so line N is N−1 rows down.
 */

/** The `<pre>` of a numbered view; its rows are the file's lines. */
export const NUMBERED_CODE_CLASS = "code-block--numbered";
export const NUMBERED_CODE_SELECTOR = `.${NUMBERED_CODE_CLASS}`;

export interface CodeRows {
	/** From the `<pre>`'s top edge to its first row. */
	top: number;
	/** One row, unrounded: line boxes are fractional (19.1875px at 12px). */
	height: number;
}

/**
 * Measured, not computed from `line-height`, because the engine quantises the
 * line box: a rounded row height drifts by pixels a few thousand lines down.
 * Read off the `<code>` the rows are drawn in — shiki's or the plain one — not
 * the `<pre>`, which the gutter beside it may stretch. `lineCount` is
 * `fileLineCount` of the text the block shows.
 */
export function measureCodeRows(pre: HTMLElement, lineCount: number): CodeRows {
	const code = pre.querySelector("code");
	if (!code) throw new Error("A numbered block draws its rows in a <code>");
	const box = code.getBoundingClientRect();
	return {
		top: box.top - pre.getBoundingClientRect().top,
		height: box.height / lineCount,
	};
}

/** Line `line`'s top (1-based), from the `<pre>`'s top edge. */
export function lineTop(rows: CodeRows, line: number): number {
	return rows.top + (line - 1) * rows.height;
}
