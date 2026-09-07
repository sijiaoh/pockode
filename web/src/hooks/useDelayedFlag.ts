import { useEffect, useState } from "react";

/**
 * How long a session switch may take before anything is shown for it. Below
 * this the switch reads as instant, and an indicator is more distracting than
 * the wait. Shared by the chat and session-list skeletons: they are two parts
 * of one switch and must not reveal themselves at different moments.
 */
export const SKELETON_DELAY_MS = 150;

/**
 * Mirrors `value`, but delays the false -> true edge by `delayMs`; true -> false
 * is immediate.
 *
 * For loading indicators that should stay invisible while the wait is short
 * enough to read as instant. `useDebouncedValue` is not a substitute: it delays
 * both edges, so the indicator would linger after the content arrives.
 *
 * The caller must feed this a single continuous flag. Splitting a wait into two
 * flags that each restart the delay produces a longer blank than no delay at
 * all.
 */
export function useDelayedFlag(value: boolean, delayMs: number): boolean {
	const [delayed, setDelayed] = useState(false);

	useEffect(() => {
		if (!value) {
			setDelayed(false);
			return;
		}
		const timer = setTimeout(() => setDelayed(true), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);

	return delayed;
}
