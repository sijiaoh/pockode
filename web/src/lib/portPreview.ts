const MAX_PORT = 65535;

/**
 * The port in what the user typed, or null when it is not one. Leading zeros
 * are accepted and dropped: a preview address writes the port plainly.
 */
export function parsePort(input: string): number | null {
	const trimmed = input.trim();
	if (!/^\d{1,5}$/.test(trimmed)) return null;
	const port = Number(trimmed);
	return port >= 1 && port <= MAX_PORT ? port : null;
}

/**
 * The preview address of `port`: the app's relay address with `-<port>` added
 * to its first label (docs/port-preview.md#the-address).
 */
export function previewUrl(remoteUrl: string, port: number): string {
	const url = new URL(remoteUrl);
	const [subdomain, ...rest] = url.hostname.split(".");
	url.hostname = [`${subdomain}-${port}`, ...rest].join(".");
	url.pathname = "/";
	url.search = "";
	url.hash = "";
	return url.href;
}

/**
 * Opens `url` in a new tab without handing it `window.opener`; false when the
 * browser blocked the tab. Must run synchronously inside the user's gesture.
 *
 * The opener is cut on the returned window rather than with a `noopener`
 * feature: with `noopener` the call always returns null, so a blocked tab could
 * not be told apart, and some browsers read any features string as a request
 * for a popup window instead of a tab. Cutting it here is allowed because the
 * tab is still on its initial same-origin `about:blank` until navigation
 * begins, and nothing of the target has run yet.
 */
export function openInNewTab(url: string): boolean {
	const tab = window.open(url, "_blank");
	if (!tab) return false;
	tab.opener = null;
	return true;
}
