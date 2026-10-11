export interface Limiter {
	/**
	 * Runs `task` once a slot is free. Aborting `signal` while the task is still
	 * waiting drops it from the queue, so a caller that went away never takes a
	 * slot at all.
	 */
	run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/**
 * Runs at most `max` tasks at once. Of the rest, the newest starts first: for
 * reads a screen asks for as the user moves through it, what was asked for
 * last is what they are looking at now, and what was asked for earlier is
 * what they have already moved past.
 */
export function createLimiter(max: number): Limiter {
	let running = 0;
	const waiting: Array<() => void> = [];

	function acquire(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (running < max) {
			running += 1;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const start = () => {
				signal?.removeEventListener("abort", abandon);
				resolve();
			};
			const abandon = () => {
				const index = waiting.indexOf(start);
				if (index !== -1) waiting.splice(index, 1);
				reject(signal?.reason);
			};
			signal?.addEventListener("abort", abandon, { once: true });
			waiting.push(start);
		});
	}

	function release() {
		const next = waiting.pop();
		// The slot passes straight to the next task rather than being freed and
		// re-taken: a task arriving in between would otherwise take it too, and
		// put one more than `max` in flight.
		if (next) next();
		else running -= 1;
	}

	return {
		async run(task, signal) {
			await acquire(signal);
			try {
				return await task();
			} finally {
				release();
			}
		},
	};
}
