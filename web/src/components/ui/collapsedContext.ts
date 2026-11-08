import type { DiffFile } from "@git-diff-view/react";

/*
 * The library draws a gap of unchanged lines as a hunk row: its expand
 * buttons in the narrow number column and git's `@@` header beside them. The
 * row is restyled here rather than replaced (the library has no way to render
 * it ourselves): the header gives way to how many lines the gap hides, and the
 * whole row becomes the target.
 *
 * Split view draws the same row with the same `data-line`, its info under
 * `splitInfo` rather than `unifiedInfo`. Without wrap it draws each side as a
 * table of its own: the buttons and the header are in the old side's row, and
 * the new side's row is one empty placeholder cell beside it. With wrap it is
 * one table, and the row is the unified one with a wider header cell.
 */

const HUNK_ROW = "tr.diff-line-hunk";
const EXPAND_BUTTON = ".diff-line-hunk-action button";
const PLACEHOLDER = ".diff-line-hunk-placeholder";

/** Where `index.css` reads the label from. */
const UNCHANGED_ATTRIBUTE = "data-unchanged";

function unchangedLabel(count: number): string {
	return `${count} unchanged ${count === 1 ? "line" : "lines"}`;
}

/**
 * Writes each gap's hidden-line count onto its row. Run again whenever the
 * rows change: an expansion moves a gap's bounds without telling anyone but
 * the library's own components.
 */
export function labelCollapsedContext(
	root: HTMLElement,
	diffFile: DiffFile,
	split: boolean,
) {
	if (!diffFile.getExpandEnabled()) return;
	for (const row of root.querySelectorAll<HTMLTableRowElement>(HUNK_ROW)) {
		const lineNumber = Number.parseInt(row.dataset.line ?? "", 10);
		// The header cell, or the new side's placeholder: labelled too, though
		// only the header shows it, so the stylesheet knows that row expands.
		const cell = row.cells[1] ?? row.querySelector(PLACEHOLDER);
		if (Number.isNaN(lineNumber) || !cell) continue;
		// A row is `${index + 1}-hunk` when it sits above line `index`, but the
		// gap after the last line is `${length}-hunk` with index `length` — and
		// it is the one row nothing follows.
		const index = row.nextElementSibling ? lineNumber - 1 : lineNumber;
		const info = split
			? diffFile.getSplitHunkLine(index)?.splitInfo
			: diffFile.getUnifiedHunkLine(index)?.unifiedInfo;
		const hidden = info ? info.endHiddenIndex - info.startHiddenIndex : 0;
		if (hidden > 0) {
			const label = unchangedLabel(hidden);
			if (cell.getAttribute(UNCHANGED_ATTRIBUTE) !== label) {
				cell.setAttribute(UNCHANGED_ATTRIBUTE, label);
			}
		} else {
			cell.removeAttribute(UNCHANGED_ATTRIBUTE);
		}
	}
}

/**
 * A press anywhere on a gap's row expands it, as its first button would: the
 * only one at either end of the file, and between hunks the one that carries
 * on from the hunk above, in reading order. The buttons themselves stay where
 * they are for the keyboard and for expanding upwards.
 *
 * Listened for on the viewer's root, which split view's placeholder needs: its
 * buttons are in the other side's table.
 */
export function expandFromRowPress(event: MouseEvent) {
	if (!(event.target instanceof Element)) return;
	if (!(event.currentTarget instanceof Element)) return;
	if (event.target.closest("button")) return;
	const row = event.target.closest<HTMLElement>(HUNK_ROW);
	if (!row) return;
	const button =
		row.querySelector<HTMLButtonElement>(EXPAND_BUTTON) ??
		oldSideTwin(event.currentTarget, row)?.querySelector<HTMLButtonElement>(
			EXPAND_BUTTON,
		);
	button?.click();
}

/**
 * The old side's half of a new-side gap row. Matched by place rather than by
 * `data-line` alone: the gap above the last line and the one after it share
 * `${length}-hunk`, and each side draws its gap rows in the same order.
 */
function oldSideTwin(root: Element, row: HTMLElement): Element | undefined {
	if (row.dataset.side !== "new") return undefined;
	const twins = (side: string) =>
		Array.from(
			root.querySelectorAll(
				`${HUNK_ROW}[data-side="${side}"][data-line="${row.dataset.line}"]`,
			),
		);
	return twins("old")[twins("new").indexOf(row)];
}
