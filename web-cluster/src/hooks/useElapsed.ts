import { useEffect, useReducer } from "react";
import { formatElapsed } from "../utils/time";

/**
 * Time since `since` as a clock, re-rendering every second while it is set:
 * a wait that counts up, where nothing else would make the view render.
 */
export function useElapsed(since: string | undefined) {
	const [, tick] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (since === undefined) return;
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, [since]);
	return since === undefined ? null : formatElapsed(since, Date.now());
}
