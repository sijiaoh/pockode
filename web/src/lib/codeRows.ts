/**
 * Where a line sits in a numbered file view (`CodeHighlighter lineNumbers`),
 * for the landing's scroll and the flash drawn over the line.
 *
 * Unwrapped, it is worked out from the block's height rather than found in the
 * DOM: the plain text past the highlight limit is one text node with no element
 * per line, and giving it one costs most of a second at 50k lines. Rows are
 * uniform there — every line box the same height, highlighted or not — so line
 * N is N−1 rows down.
 *
 * Wrapped, a line takes as many rows as its width needs, so no arithmetic
 * finds it; but a wrapped block is only ever drawn with an element per line
 * (shiki's `.line`, or the placeholder shaped like it), and the line is
 * measured off that element — the same one whose counter draws its number.
 */

/** The `<pre>` of a numbered view; its rows are the file's lines. */
export const NUMBERED_CODE_CLASS = "code-block--numbered";
export const NUMBERED_CODE_SELECTOR = `.${NUMBERED_CODE_CLASS}`;

/**
 * On the `.code-block-wrapper` of a numbered view whose long lines wrap: what
 * the stylesheet lays out by, and what `lineBox` measures by.
 */
export const WRAPPED_NUMBERED_CLASS = "code-block-wrapper--numbered-wrap";

/** A line's rows, from the `<pre>`'s top edge; unrounded, as line boxes are. */
export interface LineBox {
	top: number;
	height: number;
}

/**
 * Where line `line` (1-based) is drawn in the numbered `pre`. `lineCount` is
 * `fileLineCount` of the text the block shows; only the unwrapped arithmetic
 * needs it.
 */
export function lineBox(
	pre: HTMLElement,
	line: number,
	lineCount: number,
): LineBox {
	const code = pre.querySelector("code");
	if (!code) throw new Error("A numbered block draws its rows in a <code>");
	const preTop = pre.getBoundingClientRect().top;
	return pre.closest(`.${WRAPPED_NUMBERED_CLASS}`)
		? wrappedLineBox(code, line, preTop)
		: uniformLineBox(code, line, lineCount, preTop);
}

/**
 * Measured, not computed from `line-height`, because the engine quantises the
 * line box: a rounded row height drifts by pixels a few thousand lines down.
 * Read off the `<code>` the rows are drawn in — shiki's or the plain one — not
 * the `<pre>`, which the gutter beside it may stretch.
 */
function uniformLineBox(
	code: Element,
	line: number,
	lineCount: number,
	preTop: number,
): LineBox {
	const box = code.getBoundingClientRect();
	const height = box.height / lineCount;
	return { top: box.top - preTop + (line - 1) * height, height };
}

/**
 * One client rect per row the line's inline box is broken across. A rect is
 * the font's content area, not the line box, so the rows' edges are taken from
 * the rects' middles, half a line box either way — from the line's own font,
 * so a CJK or emoji fallback in it does not skew them.
 */
function wrappedLineBox(code: Element, line: number, preTop: number): LineBox {
	const element = code.children[line - 1];
	if (!element)
		throw new Error(`A wrapped block has no element for line ${line}`);
	const rects = element.getClientRects();
	const half = Number.parseFloat(getComputedStyle(code).lineHeight) / 2;
	const middle = (rect: DOMRect) => rect.top + rect.height / 2;
	const top = middle(rects[0]) - half;
	const bottom = middle(rects[rects.length - 1]) + half;
	return { top: top - preTop, height: bottom - top };
}

/**
 * The flash on the line a file was opened at (docs/file.md#where-the-viewer-opens).
 * `top` and `height` are the `lineBox` the landing scrolled by, so the mark
 * sits where the scroll put the line, over every row of it.
 */
export interface LineMark extends LineBox {
	line: number;
	/** Remounts the mark — restarting its animation — for each landing. */
	key: string;
}

/**
 * The line drawn at `y` px below the `pre`'s top edge — the last line whose
 * top is at or above it, so a `y` in the padding above line 1 is line 1. A
 * binary search over `lineBox`, so it reads about log₂(lineCount) lines
 * whichever way the block is laid out.
 */
export function lineAt(pre: HTMLElement, y: number, lineCount: number): number {
	let low = 1;
	let high = lineCount;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (lineBox(pre, mid, lineCount).top <= y) low = mid;
		else high = mid - 1;
	}
	return low;
}
