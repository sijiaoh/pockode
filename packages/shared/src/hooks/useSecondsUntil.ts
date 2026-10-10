import { useEffect, useReducer } from "react";

/**
 * Whole seconds left until `deadline` (epoch milliseconds), rounded up so a
 * countdown never reads 0 while the wait is still on; 0 once it has passed or
 * when there is none. Re-renders on each second boundary of the deadline
 * rather than on a free-running interval, which could lag the real end by up to
 * a second.
 */
export function useSecondsUntil(deadline: number | null): number {
	const [, tick] = useReducer((n: number) => n + 1, 0);
	const remainingMs = deadline === null ? 0 : deadline - Date.now();

	useEffect(() => {
		if (remainingMs <= 0) return;
		const timer = setTimeout(tick, remainingMs % 1000 || 1000);
		return () => clearTimeout(timer);
	});

	return Math.max(0, Math.ceil(remainingMs / 1000));
}
