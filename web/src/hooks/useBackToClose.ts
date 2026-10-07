import { useRouter } from "@tanstack/react-router";
import { type RefObject, useEffect, useId, useRef } from "react";

const STATE_KEY = "fullScreen";

/** How long a `back()` is waited for before it is taken to have landed. */
const BACK_TIMEOUT_MS = 1000;

/** The last close's `back()`, until its traversal has been reported. */
let pendingBack: Promise<void> | null = null;

function ownsEntry(state: unknown, id: string): boolean {
	return (
		typeof state === "object" &&
		state !== null &&
		(state as Record<string, unknown>)[STATE_KEY] === id
	);
}

/**
 * Lets the back gesture — Android's back, iOS's edge swipe, the browser's Back
 * — close what is open, by giving it a history entry of its own while it is
 * mounted (docs/tool-call-ui.md#full-screen).
 *
 * Through the router's history, never a raw `pushState`, which would bypass
 * TanStack's index and state; and its `BACK` / `GO` notifications rather than a
 * raw `popstate`, whose view of the location depends on listener order.
 *
 * Every other close — a button, Escape, the content going away — unmounts the
 * caller, and the entry is taken back then, but only if it is still the
 * current one: whatever pushed its own entry over it (a page opened over the
 * chat) is left alone, at the cost of one later Back that changes nothing on
 * screen. `afterClose` runs once the entry is gone, for an action that must
 * not land on it — opening a file navigates, and would be undone by the Back.
 */
export function useBackToClose(
	onBack: () => void,
	afterClose?: RefObject<(() => void) | null>,
): void {
	const router = useRouter({ warn: false });
	const id = useId();
	const onBackRef = useRef(onBack);
	onBackRef.current = onBack;

	useEffect(() => {
		// Taken at this viewer's own unmount, so a viewer mounting before our
		// `back()` lands cannot run it early from its own cleanup.
		const takeAfter = () => {
			const after = afterClose?.current ?? undefined;
			if (afterClose) afterClose.current = null;
			return after;
		};
		const history = router?.history;
		if (!history) return () => takeAfter()?.();

		// Pushed a tick late, so that StrictMode's mount-unmount-mount pushes
		// once: the router queues pushes to a microtask, and a `back()` issued
		// before its push has landed would go back past the page instead. And
		// only once an earlier viewer's `back()` has landed, or that one would
		// take this entry instead of its own.
		let pushed = false;
		let cancelled = false;
		const timer = setTimeout(() => {
			void (pendingBack ?? Promise.resolve()).then(() => {
				if (cancelled) return;
				pushed = true;
				history.push(history.location.href, {
					...history.location.state,
					[STATE_KEY]: id,
				});
			});
		});
		const unsubscribe = history.subscribe(({ action }) => {
			if (action.type !== "BACK" && action.type !== "GO") return;
			if (pushed && !ownsEntry(history.location.state, id)) {
				onBackRef.current();
			}
		});

		return () => {
			cancelled = true;
			clearTimeout(timer);
			unsubscribe();
			const after = takeAfter();
			if (!pushed || !ownsEntry(history.location.state, id)) {
				after?.();
				return;
			}
			const landed = new Promise<void>((resolve) => {
				// A traversal that never reports — a browser dropping the
				// `popstate` — must not keep the next viewer, or the file the
				// reader asked for, waiting for ever.
				const fallback = setTimeout(done, BACK_TIMEOUT_MS);
				const stop = history.subscribe(({ action }) => {
					if (action.type === "BACK" || action.type === "GO") done();
				});
				function done() {
					clearTimeout(fallback);
					stop();
					resolve();
				}
			});
			pendingBack = landed;
			void landed.then(() => {
				if (pendingBack === landed) pendingBack = null;
				after?.();
			});
			history.back();
		};
	}, [router, id, afterClose]);
}
