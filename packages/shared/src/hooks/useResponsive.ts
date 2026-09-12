import { MEDIA_QUERIES } from "../utils/responsive.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/**
 * Two columns fit side by side (>= lg).
 *
 * The gate for laying a persistent sidebar beside the content. Below it the
 * sidebar is an overlay drawer, mini pads included.
 */
export function useIsExpanded(): boolean {
	return useMediaQuery(MEDIA_QUERIES.atLeastExpanded);
}

/** Reactive `hasCoarsePointer` — the primary pointer is a finger. */
export function useHasCoarsePointer(): boolean {
	return useMediaQuery(MEDIA_QUERIES.primaryCoarsePointer);
}

/** The primary pointer can hover, so hover reveal is usable. */
export function useHasFinePointer(): boolean {
	return useMediaQuery(MEDIA_QUERIES.finePointer);
}
