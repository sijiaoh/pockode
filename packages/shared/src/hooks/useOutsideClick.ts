import { useEffect, useRef } from "react";

/**
 * Runs `onOutside` when a click lands somewhere else, while `active`.
 *
 * `click`, not `pointerdown`: a coarse pointer fires `pointerdown` the moment a
 * finger touches the screen, before the browser knows whether the gesture is a
 * tap or a scroll, so scrolling the page behind an open overlay would dismiss
 * it. `click` is only dispatched once the gesture resolves to an activation,
 * and it covers a finger and a stylus as well as a mouse — which emulated
 * `mousedown` does not. Gesture *tracking* (dragging a resize handle) still
 * belongs to pointer events; see docs/responsive-ui.md.
 *
 * The listener is attached a task later because a `click` that has not yet
 * reached `document` still picks up listeners added while it propagates: the
 * very click that opened the overlay would otherwise close it again.
 *
 * `onOutside` receives the click target so the caller can spare its own trigger
 * or a portalled dialog; nothing is filtered here, because what counts as
 * "inside" differs per overlay. It is read through a ref rather than depended
 * on: every caller closes over a ref of its own, so depending on it would tear
 * the listener down and re-schedule it on every render of the panel behind the
 * overlay — once per keystroke while the command palette is open — and would
 * make each of them memoise a callback to avoid that.
 */
export function useOutsideClick(
	active: boolean,
	onOutside: (target: Element) => void,
): void {
	const latest = useRef(onOutside);
	latest.current = onOutside;

	useEffect(() => {
		if (!active) return;

		const handleClick = (e: MouseEvent) => latest.current(e.target as Element);

		const timeoutId = setTimeout(() => {
			document.addEventListener("click", handleClick);
		}, 0);

		return () => {
			clearTimeout(timeoutId);
			document.removeEventListener("click", handleClick);
		};
	}, [active]);
}
