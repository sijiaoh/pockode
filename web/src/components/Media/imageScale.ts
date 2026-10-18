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

/**
 * The image's layout size at fit, or null while either size is unknown. In
 * whole pixels: the library measures the image with `offsetWidth`, which
 * rounds, and its bounds and the ones `bounded` works out have to be about
 * the image that is drawn.
 */
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
	return {
		width: Math.max(1, Math.round(natural.width * ratio)),
		height: Math.max(1, Math.round(natural.height * ratio)),
	};
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

/**
 * The transform as the library holds it: `x` and `y` place the image's
 * top-left corner in the frame, and `scale` is its size over fit.
 */
export type View = { scale: number; x: number; y: number };

/** The frame and the image at fit, as the library measures them. */
export type Layout = { frame: ImageDimensions; image: ImageDimensions };

/**
 * `view` moved into the bounds the library holds it to with `limitToBounds`
 * and `centerZoomedOut`: on an axis where the image is smaller than the frame
 * it is centred, and where it is larger it leaves no empty edge.
 */
export function bounded(view: View, { frame, image }: Layout): View {
	const along = (position: number, frameSize: number, imageSize: number) => {
		const drawn = imageSize * view.scale;
		if (drawn <= frameSize) return (frameSize - drawn) / 2;
		return Math.min(0, Math.max(frameSize - drawn, position));
	};
	return {
		scale: view.scale,
		x: along(view.x, frame.width, image.width),
		y: along(view.y, frame.height, image.height),
	};
}

/**
 * `view` zoomed to `scale` about `point`, a place in the frame: what is under
 * it stays there, unless the bounds move it.
 */
export function zoomedTo(
	view: View,
	scale: number,
	point: { x: number; y: number },
	layout: Layout,
): View {
	const ratio = scale / view.scale;
	return bounded(
		{
			scale,
			x: point.x - (point.x - view.x) * ratio,
			y: point.y - (point.y - view.y) * ratio,
		},
		layout,
	);
}

/** `view` with the image moved by `dx`, `dy`, as far as the bounds allow. */
export function pannedBy(
	view: View,
	dx: number,
	dy: number,
	layout: Layout,
): View {
	return bounded({ ...view, x: view.x + dx, y: view.y + dy }, layout);
}
