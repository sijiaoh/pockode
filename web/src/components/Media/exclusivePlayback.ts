/**
 * One sound at a time across every player on the page: two voice notes
 * talking over each other is never what was meant, and neither is one carrying
 * on under a video just opened in the viewer.
 *
 * Module state rather than a store, because nothing renders from it.
 */
let current: { element: HTMLMediaElement; yieldTo: () => void } | null = null;

/**
 * Call from an element's `play` event: whichever other one was sounding is
 * told to stop.
 *
 * `yieldTo` is the player's own pause, not just the element's: a player whose
 * source is being swapped is already paused with no `pause` event to come, and
 * would start again once its new source loads unless its intent is cleared.
 */
export function claimPlayback(
	element: HTMLMediaElement,
	yieldTo: () => void,
): void {
	if (current && current.element !== element) current.yieldTo();
	current = { element, yieldTo };
}

/** Call when an element goes away, so it is not held past its life. */
export function releasePlayback(element: HTMLMediaElement): void {
	if (current?.element === element) current = null;
}
