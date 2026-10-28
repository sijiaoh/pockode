import { useLayoutEffect, useState } from "react";

/**
 * An element's `clientWidth`, followed as it changes. Read before paint, so a
 * layout derived from it never draws a frame at the initial 0. The element
 * must be mounted with the component and stay mounted.
 */
export function useElementWidth(
	ref: React.RefObject<HTMLElement | null>,
): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(el.clientWidth);
		const observer = new ResizeObserver(() => setWidth(el.clientWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}
