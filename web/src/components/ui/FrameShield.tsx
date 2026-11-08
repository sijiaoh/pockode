import { useIsDrawnOver } from "@pockode/shared";

/**
 * Covers a page's frame while a layer of the app's own is drawn over it, so a
 * press there lands in the app's document — where a panel with no backdrop
 * closes on it (docs/answering-ui.md#who-owns-the-dismissing-click) — and
 * never in the page, where it would act. A press in a frame never reaches the
 * app's document at all.
 *
 * Over the frame alone, in a box of its own that is `relative`, and with no
 * stacking of its own: what the app draws over the frame on purpose stays
 * above it. A frame drawn in a sheet is never shielded by that sheet.
 */
export function FrameShield() {
	const drawnOver = useIsDrawnOver();
	return drawnOver ? (
		<div aria-hidden="true" className="absolute inset-0" />
	) : null;
}
