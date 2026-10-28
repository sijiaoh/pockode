import type { GutterLine, LinePress, LineView } from "../../lib/diffRows";

/*
 * The library's line-number cells as the control that selects lines
 * (docs/git-changes-ui.md#selecting). Unified view draws one cell per row with
 * both numbers in it, as `data-line-old-num` / `data-line-new-num` spans;
 * split view draws a cell per side, its number in `data-line-num`. Without
 * wrap, split view is two tables, one per side; with it, one.
 */

const UNIFIED_CELL = "td.diff-line-num";
const SPLIT_CELL = { old: "td.diff-line-old-num", new: "td.diff-line-new-num" };
const GUTTER_CELL = `${UNIFIED_CELL}, ${SPLIT_CELL.old}, ${SPLIT_CELL.new}`;

/** A row holding a line, as against a gap, extend or widget row. */
const LINE_ROW = 'tr[data-state="diff"], tr[data-state="plain"]';

/** Where `index.css` draws a selected cell or gap row from. */
const SELECTED_ATTRIBUTE = "data-line-selected";

function lineOfCell(cell: Element): GutterLine | null {
	if (cell.matches(UNIFIED_CELL)) {
		const number = (attribute: string) =>
			cell.querySelector(`[${attribute}]`)?.getAttribute(attribute) || null;
		const added = number("data-line-new-num");
		const removed = number("data-line-old-num");
		if (added) return { view: "unified", key: `n${added}` };
		if (removed) return { view: "unified", key: `o${removed}` };
		return null;
	}
	const view = cell.matches(SPLIT_CELL.old) ? "old" : "new";
	const number = cell.querySelector("[data-line-num]")?.textContent;
	return number ? { view, key: `${view[0]}${number}` } : null;
}

/** The gutter line under a press, if it was on one. */
export function gutterLineAt(target: EventTarget | null): GutterLine | null {
	if (!(target instanceof Element)) return null;
	const cell = target.closest(GUTTER_CELL);
	return cell ? lineOfCell(cell) : null;
}

export function isGutter(target: Element): boolean {
	return target.closest(GUTTER_CELL) !== null;
}

function cellSelector(view: LineView): string {
	return view === "unified" ? UNIFIED_CELL : SPLIT_CELL[view];
}

function cellsOf(root: HTMLElement, view: LineView) {
	return root.querySelectorAll(cellSelector(view));
}

/**
 * The line of the row under a drag, in the view the drag started in: a mouse
 * that drifts from the numbers into the code is still on that row.
 */
function lineOfRowAt(
	root: HTMLElement,
	target: EventTarget | null,
	view: LineView,
) {
	// The move is listened for on the document, over which another diff may be.
	if (!(target instanceof Element) || !root.contains(target)) return null;
	const cell = target.closest("tr")?.querySelector(cellSelector(view));
	return cell ? lineOfCell(cell) : null;
}

/** The keys of the lines drawn in a view right now: the rest are in a collapsed gap. */
export function shownLineKeys(root: HTMLElement, view: LineView): Set<string> {
	const keys = new Set<string>();
	for (const cell of cellsOf(root, view)) {
		const line = lineOfCell(cell);
		if (line) keys.add(line.key);
	}
	return keys;
}

/**
 * Marks the selected lines' cells — the number and the code beside it — and
 * every gap row that lies inside the range, which is one whose neighbouring
 * lines above and below are both selected. Run again whenever the rows change,
 * since the library recreates them as gaps expand.
 */
export function markSelectedLines(
	root: HTMLElement,
	selection: { view: LineView; keys: ReadonlySet<string> } | null,
) {
	const marked = new Set<Element>();
	if (selection) {
		for (const cell of cellsOf(root, selection.view)) {
			const line = lineOfCell(cell);
			if (!line || !selection.keys.has(line.key)) continue;
			marked.add(cell);
			if (cell.nextElementSibling) marked.add(cell.nextElementSibling);
		}
		for (const gap of root.querySelectorAll("tr.diff-line-hunk")) {
			if (
				selection.view !== "unified" &&
				gap.getAttribute("data-side") &&
				gap.getAttribute("data-side") !== selection.view
			) {
				continue;
			}
			const selectedRow = (row: Element | null, step: "previous" | "next") => {
				let current = row;
				// The hunk bar's extend row and widget rows sit between lines, and
				// so, in split view, does the other side's line facing a
				// placeholder on this one.
				const cell = cellSelector(selection.view);
				while (
					current &&
					!(current.matches(LINE_ROW) && current.querySelector(cell))
				) {
					current =
						step === "previous"
							? current.previousElementSibling
							: current.nextElementSibling;
				}
				return !!current && hasSelectedCell(current, marked);
			};
			if (
				selectedRow(gap.previousElementSibling, "previous") &&
				selectedRow(gap.nextElementSibling, "next")
			) {
				marked.add(gap);
			}
		}
	}
	for (const element of root.querySelectorAll(`[${SELECTED_ATTRIBUTE}]`)) {
		if (!marked.has(element)) element.removeAttribute(SELECTED_ATTRIBUTE);
	}
	for (const element of marked) {
		if (!element.hasAttribute(SELECTED_ATTRIBUTE)) {
			element.setAttribute(SELECTED_ATTRIBUTE, "");
		}
	}
}

function hasSelectedCell(row: Element, marked: Set<Element>): boolean {
	for (const cell of row.children) if (marked.has(cell)) return true;
	return false;
}

/**
 * Reads presses in the gutter as selection presses, by what pressed
 * (`pointerType`, per event — not the pointer media queries, which a
 * touchscreen laptop matches both of):
 *
 * - A mouse click starts a selection, a Shift-click extends it, and a drag
 *   down or up the gutter selects what it passes over.
 * - A tap — finger or pen — moves the far end of the selection, which is a
 *   start when there is none. A drag there is the page's scroll.
 *
 * The click that ends a drag is the drag's own, and is swallowed: it lands on
 * whatever holds both ends, which would otherwise read as a click outside.
 * A drag released outside the window has no such click, so the swallowing
 * ends with the next press or key anywhere — a later click is someone else's.
 */
export function attachLineGutter(
	root: HTMLElement,
	onPress: (press: LinePress) => void,
): () => void {
	let pointerType = "mouse";
	// `moved` once any drag press went out: a drag that came back to the line
	// it started on has still made the selection, and its click is its own.
	// `pointer` is the mouse that started it: on a device with a pen or a
	// touchscreen too, their events reach the same document listeners.
	let drag: {
		pointer: number;
		from: GutterLine;
		last: string;
		moved: boolean;
	} | null = null;
	let swallowing = false;

	const swallowClick = (event: MouseEvent) => {
		event.stopPropagation();
		event.preventDefault();
		stopSwallowing();
	};
	const stopSwallowing = () => {
		if (!swallowing) return;
		swallowing = false;
		window.removeEventListener("click", swallowClick, true);
		window.removeEventListener("pointerdown", stopSwallowing, true);
		window.removeEventListener("keydown", stopSwallowing, true);
	};

	const handleMove = (event: PointerEvent) => {
		if (!drag || event.pointerId !== drag.pointer) return;
		// A release the page never heard of — over an iframe, or after the
		// window lost focus — would leave hovering to go on selecting.
		if ((event.buttons & 1) === 0) {
			handleUp(event);
			return;
		}
		const line = lineOfRowAt(root, event.target, drag.from.view);
		if (!line || line.key === drag.last) return;
		drag.last = line.key;
		drag.moved = true;
		onPress({ type: "drag", from: drag.from, line });
	};
	const handleUp = (event: PointerEvent) => {
		if (drag && event.pointerId !== drag.pointer) return;
		document.removeEventListener("pointermove", handleMove);
		document.removeEventListener("pointerup", handleUp);
		document.removeEventListener("pointercancel", handleUp);
		const dragged = drag?.moved;
		drag = null;
		if (!dragged) return;
		swallowing = true;
		window.addEventListener("click", swallowClick, true);
		window.addEventListener("pointerdown", stopSwallowing, true);
		window.addEventListener("keydown", stopSwallowing, true);
	};

	const handleDown = (event: PointerEvent) => {
		pointerType = event.pointerType || "mouse";
		if (pointerType !== "mouse" || event.button !== 0 || event.shiftKey) {
			return;
		}
		const line = gutterLineAt(event.target);
		if (!line) return;
		drag = {
			pointer: event.pointerId,
			from: line,
			last: line.key,
			moved: false,
		};
		document.addEventListener("pointermove", handleMove);
		document.addEventListener("pointerup", handleUp);
		document.addEventListener("pointercancel", handleUp);
	};

	const handleClick = (event: MouseEvent) => {
		const line = gutterLineAt(event.target);
		if (!line) return;
		const type =
			pointerType === "mouse" && !event.shiftKey ? "start" : "extend";
		onPress({ type, line });
	};

	root.addEventListener("pointerdown", handleDown);
	root.addEventListener("click", handleClick);
	return () => {
		root.removeEventListener("pointerdown", handleDown);
		root.removeEventListener("click", handleClick);
		document.removeEventListener("pointermove", handleMove);
		document.removeEventListener("pointerup", handleUp);
		document.removeEventListener("pointercancel", handleUp);
		stopSwallowing();
	};
}
