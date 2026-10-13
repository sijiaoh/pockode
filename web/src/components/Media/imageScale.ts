import type { ImageDimensions } from "../../utils/fileView";

/**
 * The image stage's scales. Scale 1 is the image laid out to fit the frame —
 * contained, never enlarged — so the library's own `minScale: 1` and
 * `centerView(1)` both mean "fit".
 */

/** How near 1 a scale has to be to count as fit: pinching leaves residue. */
const FIT_TOLERANCE = 0.01;

/** Below this, actual size is too close to fit for the toggle to show anything. */
const MIN_TOGGLE_SCALE = 1.5;

/** Where the toggle goes from fit when actual size is too close to it. */
const SMALL_IMAGE_TOGGLE_SCALE = 2;

/** One key press of + or −. */
export const KEY_ZOOM_FACTOR = 1.5;

/** One arrow key press, as a share of the frame. */
export const KEY_PAN_SHARE = 0.1;

/** The image's layout size at fit, or null while either size is unknown. */
export function fitSize(
	natural: ImageDimensions | null,
	frame: ImageDimensions | null,
): ImageDimensions | null {
	if (!natural || !frame || natural.width <= 0 || natural.height <= 0) {
		return null;
	}
	if (frame.width <= 0 || frame.height <= 0) return null;
	const ratio = Math.min(
		1,
		frame.width / natural.width,
		frame.height / natural.height,
	);
	return { width: natural.width * ratio, height: natural.height * ratio };
}

/**
 * One image pixel per CSS pixel — what a browser's own image view calls 100%.
 * Not per device pixel: on a phone a phone screenshot would then be about the
 * size of fit, and the toggle would do nothing.
 */
export function actualScale(
	natural: ImageDimensions,
	fit: ImageDimensions,
): number {
	return Math.max(1, natural.width / fit.width);
}

/** A screenshot on a phone reaches about 12×; a small icon still gets 4×. */
export function maxScale(actual: number): number {
	return Math.max(4, actual * 4);
}

export function isAtFit(scale: number): boolean {
	return Math.abs(scale - 1) < FIT_TOLERANCE;
}

/** Where double-tap, double-click and the zoom readout go from `scale`. */
export function toggleTarget(scale: number, actual: number): number {
	if (!isAtFit(scale)) return 1;
	return actual < MIN_TOGGLE_SCALE ? SMALL_IMAGE_TOGGLE_SCALE : actual;
}

/** The zoom readout: `Fit`, or the share of actual size, so 100% is actual. */
export function zoomLabel(scale: number, actual: number): string {
	return isAtFit(scale) ? "Fit" : `${Math.round((scale / actual) * 100)}%`;
}
