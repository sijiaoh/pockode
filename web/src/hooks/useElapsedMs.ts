import { useEffect, useState } from "react";

/*
 * One tick shared by every elapsed clock on screen — the turn clock and every
 * live call's counter. Clocks with intervals of their own each tick on the
 * phase of the moment they mounted, so a row and the tail line change their
 * seconds at different moments, and two clocks that started together can read
 * a second apart. Read off one tick, they all change in the same render
 * (docs/tool-call-ui.md#live-run).
 */

const TICK_MS = 1000;

const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;

function subscribe(listener: (now: number) => void): () => void {
	if (timer === undefined) {
		lastTick = Date.now();
		timer = setInterval(() => {
			lastTick = Date.now();
			for (const notify of listeners) notify(lastTick);
		}, TICK_MS);
	}
	listeners.add(listener);
	// A clock drawn before the tick started read its own `Date.now()`; this
	// puts it on the tick's reading at once instead of at the next tick.
	listener(lastTick);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			clearInterval(timer);
			timer = undefined;
		}
	};
}

/**
 * How long it has been since `startMs` (epoch milliseconds), on the shared
 * one-second tick. Call it in the component that draws the number, so the tick
 * re-renders the clock and not what it sits in.
 */
export function useElapsedMs(startMs: number): number {
	const [now, setNow] = useState(() =>
		timer === undefined ? Date.now() : lastTick,
	);
	useEffect(() => subscribe(setNow), []);
	return now - startMs;
}
