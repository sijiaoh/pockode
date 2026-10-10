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

/** Where: server/relay/preview_auth.go's previewLoginPath and previewTicketParam. */
const TICKET_LOGIN_PATH = "/__pockode/preview/login";

function ticketLoginUrl(previewUrl: string, ticket: string): string {
	const url = new URL(TICKET_LOGIN_PATH, previewUrl);
	url.searchParams.set("ticket", ticket);
	return url.href;
}

/**
 * Opens the preview at `previewUrl` in a new tab, logged in with a ticket from
 * `getTicket`; false when the browser blocked the tab. Must run synchronously
 * inside the user's gesture.
 *
 * The tab is opened blank first and sent on once the ticket arrives: awaiting
 * the ticket before opening would cost the user activation, and the browser
 * would block the tab. It is the one place the ticket goes — never an `href`,
 * where it could be copied and used as a login by whoever it was sent to. A
 * ticket that cannot be had sends the tab to the preview itself, whose password
 * page still lets the user in; the host redirects a ticket login to its root
 * (docs/code/relay-system.md#ticket-login), so both end on the same page.
 *
 * `noopener` is not used: with it the call always returns null, so a blocked
 * tab could not be told apart and there would be no tab to send on, and some
 * browsers read any features string as a request for a popup window instead of
 * a tab. The opener is cut on the returned window instead, which is allowed
 * because the tab is on its initial same-origin `about:blank`, and nothing of
 * the target has run yet. `replace`, so Back does not lead to the blank page.
 */
export function openPreviewTab(
	previewUrl: string,
	getTicket: () => Promise<string>,
): boolean {
	const tab = window.open("", "_blank");
	if (!tab) return false;
	tab.opener = null;
	// A tab the user has closed meanwhile has nowhere to go.
	const send = (url: string) => {
		if (!tab.closed) tab.location.replace(url);
	};
	getTicket().then(
		(ticket) => send(ticketLoginUrl(previewUrl, ticket)),
		() => send(previewUrl),
	);
	return true;
}
