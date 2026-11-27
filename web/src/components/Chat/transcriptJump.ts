import { useCallback, useEffect, useRef } from "react";

const HIGHLIGHT_DURATION_MS = 1500;
const HIGHLIGHT_CLASS = "jump-highlight";

/**
 * The element marked with this id under `root`, laid out rather than merely
 * mounted: a row folded into a group is only `hidden`, and measures as sitting
 * at the very top. An attribute lookup rather than a `[data-...="id"]`
 * selector, so ids never need CSS escaping.
 */
export function findShown(
	root: HTMLElement,
	attribute: "permissionRequestId" | "toolUseId",
	id: string,
): HTMLElement | null {
	const selector =
		attribute === "toolUseId"
			? "[data-tool-use-id]"
			: "[data-permission-request-id]";
	for (const el of root.querySelectorAll<HTMLElement>(selector)) {
		if (el.dataset[attribute] === id && !el.closest("[hidden]")) return el;
	}
	return null;
}

/**
 * What landing on a card or a row does in a transcript: `moveTo` puts it in
 * view by the transcript's own rules, then it is ringed for a moment and its
 * first button takes focus.
 */
export function useLanding(
	moveTo: (target: HTMLElement) => void,
): (target: HTMLElement) => void {
	const highlightRef = useRef<{
		card: HTMLElement;
		timer: ReturnType<typeof setTimeout>;
	} | null>(null);

	// Both the class and its removal timer have to go together: dropping only the
	// timer would strand the ring on that card for good.
	const clearHighlight = useCallback(() => {
		const current = highlightRef.current;
		if (!current) return;
		clearTimeout(current.timer);
		current.card.classList.remove(HIGHLIGHT_CLASS);
		highlightRef.current = null;
	}, []);

	useEffect(() => clearHighlight, [clearHighlight]);

	return useCallback(
		(target: HTMLElement) => {
			moveTo(target);

			clearHighlight();
			target.classList.add(HIGHLIGHT_CLASS);
			highlightRef.current = {
				card: target,
				timer: setTimeout(() => {
					target.classList.remove(HIGHLIGHT_CLASS);
					highlightRef.current = null;
				}, HIGHLIGHT_DURATION_MS),
			};

			// preventScroll: the browser's own focus scroll would move the view off
			// the position the move just took it to.
			//
			// The first button is the row that opens the target — a permission
			// card's is as close as it has to a header. Without moving the focus,
			// the jump is one a keyboard user cannot perceive — and a focus into an
			// `inert` subtree is dropped without a word, so a caller jumping out
			// from under something that covers the transcript has to let the cover
			// go first (`ChatPanel.handleJumpToRequest`).
			target
				.querySelector<HTMLElement>("button")
				?.focus({ preventScroll: true });
		},
		[clearHighlight, moveTo],
	);
}
