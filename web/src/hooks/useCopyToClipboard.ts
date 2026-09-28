import { useCallback, useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "failed";

interface Options {
	/**
	 * Back to idle this long after a copy. Omit to keep the result until the
	 * next copy or `reset`: a user who copied a code and left for another app
	 * should still find "copied" when they come back.
	 */
	resetAfterMs?: number;
}

/**
 * Copies text and remembers how it went.
 *
 * `failed` is an ordinary outcome, not a rare one: outside a secure context —
 * Pockode on a LAN address over plain http — the browser has no clipboard API
 * at all. A caller showing it should put the value in full on screen so it can
 * be copied by hand.
 */
export function useCopyToClipboard({ resetAfterMs }: Options = {}) {
	const [state, setState] = useState<CopyState>("idle");
	const timerRef = useRef<number | undefined>(undefined);

	useEffect(() => () => clearTimeout(timerRef.current), []);

	const copy = useCallback(
		async (text: string): Promise<boolean> => {
			clearTimeout(timerRef.current);
			let ok: boolean;
			try {
				if (!navigator.clipboard) throw new Error("No clipboard API");
				await navigator.clipboard.writeText(text);
				ok = true;
			} catch {
				ok = false;
			}
			// Again: a copy started while this one awaited armed its own timer.
			clearTimeout(timerRef.current);
			setState(ok ? "copied" : "failed");
			if (resetAfterMs !== undefined) {
				timerRef.current = window.setTimeout(
					() => setState("idle"),
					resetAfterMs,
				);
			}
			return ok;
		},
		[resetAfterMs],
	);

	const reset = useCallback(() => {
		clearTimeout(timerRef.current);
		setState("idle");
	}, []);

	return { state, copy, reset };
}
