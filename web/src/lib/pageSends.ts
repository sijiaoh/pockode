import { useCallback, useSyncExternalStore } from "react";
import type { SendRefusal } from "./pageBridge";

/**
 * What became of a page's latest send, for its send line
 * (docs/tool-call-ui.md § The card's send line).
 */
export type PageSendOutcome =
	| { state: "sending"; action: string }
	| { state: "sent"; action: string }
	| {
			state: "refused";
			action: string;
			code: SendRefusal;
			message: string;
	  };

/**
 * Kept by call in memory, as the card's measured height is: the card and its
 * full-screen view are two documents of one page and show one line. The
 * reader's memory of this sitting, so a reload of the app forgets it.
 */
const latestByPage = new Map<
	string,
	{ token: number; outcome: PageSendOutcome }
>();
const listeners = new Set<() => void>();
let nextToken = 0;

function notify() {
	for (const listener of listeners) listener();
}

/**
 * Starts a send from the page `pageKey` names, and returns how to settle it.
 * A settle only lands while its send is still the page's latest, so a slow
 * answer to an earlier send never overwrites a later one.
 */
export function startPageSend(
	pageKey: string,
	action: string,
): (outcome: PageSendOutcome) => void {
	const token = ++nextToken;
	latestByPage.set(pageKey, { token, outcome: { state: "sending", action } });
	notify();
	return (outcome) => {
		if (latestByPage.get(pageKey)?.token !== token) return;
		latestByPage.set(pageKey, { token, outcome });
		notify();
	};
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function usePageSendOutcome(pageKey: string): PageSendOutcome | null {
	const read = useCallback(
		() => latestByPage.get(pageKey)?.outcome ?? null,
		[pageKey],
	);
	return useSyncExternalStore(subscribe, read, read);
}

/** Forgets every outcome; for tests, which share this module's memory. */
export function resetPageSends() {
	latestByPage.clear();
	notify();
}
