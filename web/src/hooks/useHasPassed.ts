import { useEffect, useReducer } from "react";

// `setTimeout` takes a signed 32-bit delay; a longer one fires at once.
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * Whether `deadline` (epoch milliseconds) has been reached, re-rendering once
 * when it is — not every second on the way, as `useSecondsUntil` does for a
 * countdown: a schedule's time can be weeks away, and nothing here shows the
 * wait. `null` is never reached.
 */
export function useHasPassed(deadline: number | null): boolean {
	const [, tick] = useReducer((n: number) => n + 1, 0);
	const remainingMs = deadline === null ? 0 : deadline - Date.now();
	const passed = deadline !== null && remainingMs <= 0;

	useEffect(() => {
		if (deadline === null || remainingMs <= 0) return;
		// A capped wait re-renders early, measures again and re-arms.
		const timer = setTimeout(tick, Math.min(remainingMs, MAX_DELAY_MS));
		return () => clearTimeout(timer);
	});

	return passed;
}
