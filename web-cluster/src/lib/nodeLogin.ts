import { openDeferredTab } from "@pockode/shared";

/** Where: web/src/lib/loginTicket.ts, the node web app's boot, reads it back. */
const TICKET_FRAGMENT_KEY = "login_ticket";

/**
 * `nodeUrl` carrying `ticket` in its fragment — the one part of an address a
 * browser never sends, so the ticket reaches no server, relay log or
 * `Referer` on the way to the node's page that redeems it.
 */
export function nodeLoginUrl(nodeUrl: string, ticket: string): string {
	const url = new URL(nodeUrl);
	url.hash = `${TICKET_FRAGMENT_KEY}=${encodeURIComponent(ticket)}`;
	return url.href;
}

/**
 * Opens the node's web app at `nodeUrl` in a new tab, logged in with a ticket
 * from `getTicket`; false when the browser blocked the tab. Must run
 * synchronously inside the user's gesture.
 *
 * Any ticket that cannot be had — an older node answers `unsupported`, a node
 * may be gone or restarting, the cluster may be unreachable — sends the tab to
 * the plain address, where the node asks for its password as it always did.
 */
export function openNodeTab(
	nodeUrl: string,
	getTicket: () => Promise<string>,
): boolean {
	return openDeferredTab(
		() => getTicket().then((ticket) => nodeLoginUrl(nodeUrl, ticket)),
		nodeUrl,
	);
}
