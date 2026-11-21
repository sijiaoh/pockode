/**
 * Opens a new tab now and sends it to the address `resolveUrl` comes up with
 * later, or to `fallbackUrl` when that fails; false when the browser blocked
 * the tab, and then `resolveUrl` is never called. Must run synchronously inside
 * the user's gesture.
 *
 * For an address that needs a round trip first — a login ticket, say — that
 * must not sit in an `href`: awaiting it before opening would cost the user
 * activation, and the browser would block the tab. So the tab is opened blank
 * and sent on once the address is known. What to do about a blocked tab is the
 * caller's: a link can let its own default click through, a button can say so.
 *
 * `noopener` is not used: with it the call always returns null, so a blocked
 * tab could not be told apart and there would be no tab to send on, and some
 * browsers read any features string as a request for a popup window instead of
 * a tab. The opener is cut on the returned window instead, which is allowed
 * because the tab is on its initial same-origin `about:blank`, and nothing of
 * the target has run yet. `replace`, so Back does not lead to the blank page.
 */
export function openDeferredTab(
	resolveUrl: () => Promise<string>,
	fallbackUrl: string,
): boolean {
	const tab = window.open("", "_blank");
	if (!tab) return false;
	tab.opener = null;
	// A tab the user has closed meanwhile has nowhere to go.
	const send = (url: string) => {
		if (!tab.closed) tab.location.replace(url);
	};
	// Through a promise, so a resolveUrl that throws instead of rejecting still
	// sends the tab on rather than stranding it blank.
	new Promise<string>((resolve) => resolve(resolveUrl())).then(send, () =>
		send(fallbackUrl),
	);
	return true;
}

/**
 * Whether a click on a link is the plain primary click `openDeferredTab` is
 * for. Any other — a middle click, or one with a modifier asking the browser
 * for a background tab or a window — is left to the browser and follows the
 * link's plain `href`, as a long press or a copied address does.
 */
export function isPlainClick(
	e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
	return e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
}
