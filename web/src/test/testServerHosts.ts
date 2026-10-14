/**
 * The two names the real-browser tests reach their one server under: the app
 * is served from `APP_HOST`, and the same server under `localhost` stands in
 * for another host — a CDN — so a page's request to it is cross-origin.
 *
 * The server listens on `APP_HOST` alone (`vitest.browser.config.ts`), an
 * address rather than a name, so nothing here depends on what `localhost`
 * resolves to: IPv4 loopback exists on every machine, and a browser tries every
 * loopback address for `localhost`, so that name reaches the listener whether
 * or not `::1` comes first — as it does on CI's ubuntu runners.
 */
export const APP_HOST = "127.0.0.1";

export function otherHost(port: string) {
	return `localhost:${port}`;
}
