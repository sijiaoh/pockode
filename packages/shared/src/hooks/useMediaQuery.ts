import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Subscribes to a media query and re-renders when it flips.
 *
 * Capability is not a constant: a window is dragged across a breakpoint, a
 * tablet gains a mouse mid-session. Anything sampled once at module load or at
 * mount starts lying the moment that happens, so every capability read in the
 * app goes through here.
 */
export function useMediaQuery(query: string): boolean {
	const mql = useMemo(() => window.matchMedia(query), [query]);

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			mql.addEventListener("change", onStoreChange);
			return () => mql.removeEventListener("change", onStoreChange);
		},
		[mql],
	);

	// No getServerSnapshot: both apps mount with createRoot, so there is no
	// server render for it to answer.
	return useSyncExternalStore(subscribe, () => mql.matches);
}
