import { useLayoutEffect, useState } from "react";

/**
 * How far below the top of `container` the element `target` starts, followed
 * as anything in `container` changes size — content above `target` growing or
 * shrinking, or a resize rewrapping it. Read before paint. 0 until both are
 * mounted.
 *
 * `container` is the content of a scroll area, not the scroll area itself:
 * the scroll area keeps its size as its content grows, so watching it would
 * miss exactly the changes this is for.
 */
export function useOffsetWithin(
	target: HTMLElement | null,
	container: HTMLElement | null,
): number {
	const [offset, setOffset] = useState(0);
	useLayoutEffect(() => {
		if (!target || !container) return;
		const measure = () =>
			setOffset(
				target.getBoundingClientRect().top -
					container.getBoundingClientRect().top,
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [target, container]);
	return offset;
}
