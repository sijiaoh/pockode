import type { CanvasSize } from "../types/canvas";

/** The contract's bounds on a size (docs/canvas-ui.md §5, `CanvasSize`). */
const MAX_SIDE = 10000;

/** `input` types that hold no text, so bring up no keyboard. */
const TEXTLESS_INPUTS = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"hidden",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

/**
 * Whether `element` is editable in the sense of the size rule (§5): a field a
 * keyboard comes up for. The bridge reports the same test from inside the page;
 * this one is for the app's own elements — the composer above all.
 */
export function isEditableElement(element: Element | null): boolean {
	if (element instanceof HTMLInputElement) {
		return (
			!TEXTLESS_INPUTS.has(element.type) &&
			!element.disabled &&
			!element.readOnly
		);
	}
	if (element instanceof HTMLTextAreaElement) {
		return !element.disabled && !element.readOnly;
	}
	if (element instanceof HTMLSelectElement) return !element.disabled;
	return element instanceof HTMLElement && element.isContentEditable === true;
}

/**
 * A measured box as the contract takes it: whole CSS pixels, rounded down, and
 * null for a box with no area — a hidden one has nothing to tell the agent.
 */
export function canvasSizeOf(box: {
	width: number;
	height: number;
}): CanvasSize | null {
	const width = Math.min(Math.floor(box.width), MAX_SIDE);
	const height = Math.min(Math.floor(box.height), MAX_SIDE);
	return width >= 1 && height >= 1 ? { width, height } : null;
}

/**
 * Whether a new measurement replaces the kept one (§5): always on a width
 * change — a rotation or a resized window — and otherwise only while nothing
 * editable has focus, since a soft keyboard is what changes the height then.
 */
export function keepsMeasurement(
	kept: CanvasSize | null,
	measured: CanvasSize,
	editing: boolean,
): boolean {
	if (kept === null || kept.width !== measured.width) return true;
	return kept.height !== measured.height && !editing;
}
