import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How far ahead of the viewport an element counts as in view, so content it
 * gates has a moment to arrive before the user reaches it.
 */
const ROOT_MARGIN = "200px";

/**
 * Whether the element has been scrolled into view, latched once true.
 *
 * Latched because what this gates is a fetch: the answer is cached, so
 * forgetting it on the way out would only cost a re-render, and the transcript
 * scrolls back and forth across the same elements constantly.
 */
export function useInView<T extends Element>() {
	const [inView, setInView] = useState(false);
	const observer = useRef<IntersectionObserver | null>(null);

	const stopWatching = useCallback(() => {
		observer.current?.disconnect();
		observer.current = null;
	}, []);

	// A callback ref rather than a ref object read from an effect: that only
	// finds an element the very first render put on screen, and silently watches
	// nothing at all for a caller whose element appears a render later.
	const ref = useCallback(
		(node: T | null) => {
			stopWatching();
			if (!node) return;

			const watch = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) setInView(true);
				},
				{ rootMargin: ROOT_MARGIN },
			);
			watch.observe(node);
			observer.current = watch;
		},
		[stopWatching],
	);

	// The answer never goes back to no, so there is nothing left to watch for.
	useEffect(() => {
		if (inView) stopWatching();
	}, [inView, stopWatching]);

	return { ref, inView };
}
