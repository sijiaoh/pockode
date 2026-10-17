import { useCallback, useSyncExternalStore } from "react";

/**
 * What every HTML page frame shares about the hosts its policy refuses and the
 * reader allows (docs/page-external-hosts-ui.md): the policy itself, how a
 * refused URL becomes a host the strip can name, what a page's reports look
 * like, and the allowance, which lives here and nowhere the page can reach.
 */

/**
 * Every source an allowed host is named by: a source with a scheme does not
 * reach `ws:` from `https:` in every engine, and one without takes its scheme
 * from an origin a `srcdoc` document does not have.
 */
function hostSources(hosts: readonly string[]): string[] {
	return hosts.flatMap((host) => [
		`http://${host}`,
		`https://${host}`,
		`ws://${host}`,
		`wss://${host}`,
	]);
}

/**
 * A page's policy: nothing reaches a host the reader has not allowed, and
 * everything else a page does stays possible — inline scripts and styles and
 * `eval`, which agent pages and chart libraries need, and `data:` and `blob:`,
 * which are no request. No `'self'`: a `srcdoc` document may name the app's
 * origin by it. `projectRoot`, when given, is the URL of a raw capability for
 * the root of the worktree, whose files the page may load as its own — named
 * in full, path and all, so nothing else of the app's server is reached.
 *
 * `frame-src 'none'` whatever is allowed, because in the document that embeds
 * the page it is the one directive the browser checks when the page navigates
 * itself, and a page on an allowed host would be under no policy at all.
 * `object-src 'none'` for the same document by another door: WebKit loads an
 * `<object>` or `<embed>` from a host `default-src` allows, and what it loads
 * runs under no policy of ours.
 */
export function pagePolicy(
	allowedHosts: readonly string[],
	projectRoot?: string,
): string {
	const reach = [
		...(projectRoot ? [projectRoot] : []),
		"data:",
		"blob:",
		...hostSources(allowedHosts),
	].join(" ");
	return [
		`default-src ${reach}`,
		`script-src 'unsafe-inline' 'unsafe-eval' ${reach}`,
		`style-src 'unsafe-inline' ${reach}`,
		"frame-src 'none'",
		"object-src 'none'",
		"form-action 'none'",
	].join("; ");
}

/** The policy as the first thing in a document, before anything that runs. */
export function pagePolicyMeta(
	allowedHosts: readonly string[],
	projectRoot?: string,
): string {
	return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(pagePolicy(allowedHosts, projectRoot))}"><meta http-equiv="x-dns-prefetch-control" content="off">`;
}

/** A host a page was refused, as the strip names it. */
export interface RefusedHost {
	/** `URL.host`: lowercased, port included. */
	host: string;
	/** False for a host no policy here will name; listed, never loaded. */
	allowable: boolean;
	/**
	 * Refused although the document's policy names it — a request that
	 * redirected elsewhere, or a forged report — so loading it again would
	 * change nothing.
	 */
	inPolicy?: boolean;
	/**
	 * Refused as a document the page embeds, which is never allowed — while
	 * the same host may well be allowable for what else the page asks of it.
	 */
	embedded?: boolean;
}

/** Every host a CSP host-source can name as written: no IPv6 literal, no `_`. */
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/;

const ALLOWABLE_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

/** A name with a trailing dot is the same name to DNS. */
function withoutRootDot(hostname: string): string {
	return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * The host a refused request went to, or null for a URL with none. Not
 * allowable: the app's own host on any port, with or without a trailing dot —
 * cookies are not kept apart by port, so a request there could carry the
 * app's — anything a host-source
 * cannot name, and anything but http(s) and ws(s).
 */
export function refusedHost(
	url: string,
	ownHostname: string,
): RefusedHost | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const host = parsed.host;
	if (!host) return null;
	return {
		host,
		allowable:
			ALLOWABLE_SCHEMES.has(parsed.protocol) &&
			withoutRootDot(parsed.hostname) !== withoutRootDot(ownHostname) &&
			HOST.test(host),
	};
}

/** Past this many the list stops; the rest stay refused, unnamed. */
export const MAX_LISTED_HOSTS = 50;

/**
 * As many hosts as a page may be allowed in all, over every Load: the server
 * binds no more to a capability (`MaxRawGrantHosts`).
 */
export const MAX_ALLOWED_HOSTS = 50;

/** What one document was refused, in the order it was first refused. */
export interface Refusals {
	hosts: readonly RefusedHost[];
	/** More hosts were refused than are listed. */
	overflow: boolean;
}

export const NO_REFUSALS: Refusals = { hosts: [], overflow: false };

/**
 * The list with `refused` added at the end, or the same list if it is there.
 * Not offered to load past what the page may be allowed in all, counting the
 * hosts already `allowed` for it: a Load would ask for more than the server
 * binds and leave the page failing until the app reloads.
 */
export function addRefusal(
	list: Refusals,
	refused: RefusedHost,
	allowed: ReadonlySet<string> = new Set(),
): Refusals {
	const at = list.hosts.findIndex((entry) => entry.host === refused.host);
	// Listed only for a frame it serves, which no Load allows: a script it
	// serves is another matter, and the one to offer. Where it was, so the list
	// does not move.
	const upgrade = at >= 0 && list.hosts[at].embedded && refused.allowable;
	if (at >= 0 && !upgrade) return list;
	if (!upgrade && list.hosts.length >= MAX_LISTED_HOSTS) {
		return list.overflow ? list : { ...list, overflow: true };
	}
	const offered = list.hosts.filter(
		(entry) => entry.allowable && !allowed.has(entry.host),
	).length;
	const full =
		refused.allowable &&
		!allowed.has(refused.host) &&
		allowed.size + offered >= MAX_ALLOWED_HOSTS;
	const entry = full ? { ...refused, allowable: false } : refused;
	const hosts = [...list.hosts];
	if (upgrade) hosts[at] = entry;
	else hosts.push(entry);
	return { ...list, hosts };
}

/**
 * The directives a refusal to load a document into the page is reported
 * under — a frame, an `<object>`, an `<embed>` — which the policy never
 * allows, whatever host it is for. Reported to the embedding document, a
 * frame directive is the page's own frame leaving.
 */
export function isEmbedDirective(directive: string): boolean {
	return (
		directive === "frame-src" ||
		directive === "child-src" ||
		directive === "object-src"
	);
}

const REFUSED = "pockode:page-refused";
const LINK = "pockode:page-link";

/** What a page's reporter says. Untrusted: the page's own scripts can say it too. */
export type PageReport =
	| { type: "refused"; url: string; directive: string }
	| { type: "link"; href: string };

/**
 * Runs inside the page before anything the page wrote, so it hears what the
 * policy refuses while the head is still being parsed, and posts each refusal
 * to `target` — a script expression for the app's window. Also takes a plain
 * click on a link that would navigate the frame, which the policy would only
 * refuse, and hands it to the app to open.
 *
 * A link into the page itself (`href="#section"`) is followed in place, as
 * the fragment it is: a `srcdoc` document's URL is `about:srcdoc`, and its
 * base — the app's, or the project's (`HtmlFrame`) — is not, so the browser
 * would take the link for another document's.
 *
 * Neither is ever more than a report: the page shares this document and can
 * send the same messages itself.
 */
export function pageReporterScript(target: string): string {
	return `<script>(function(){var app=${target};document.addEventListener("securitypolicyviolation",function(e){app.postMessage({type:"${REFUSED}",url:String(e.blockedURI),directive:String(e.effectiveDirective)},"*");});addEventListener("click",function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var t=e.target;var a=t&&t.closest?t.closest("a[href],area[href]"):null;if(!a)return;var w=(a.getAttribute("target")||"").toLowerCase();if(w&&w!=="_self"&&w!=="_parent"&&w!=="_top")return;var u;try{u=new URL(a.href);}catch(x){return;}if(a.href.indexOf("#")>=0&&u.href.split("#")[0]===document.baseURI.split("#")[0]){e.preventDefault();location.hash=u.hash;return;}if(u.protocol!=="http:"&&u.protocol!=="https:")return;e.preventDefault();app.postMessage({type:"${LINK}",href:u.href},"*");});})();</script>`;
}

/** `data` if it is a report a page's reporter sends, else null. */
export function readPageReport(data: unknown): PageReport | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (
		message.type === REFUSED &&
		typeof message.url === "string" &&
		typeof message.directive === "string"
	) {
		return { type: "refused", url: message.url, directive: message.directive };
	}
	if (message.type === LINK && typeof message.href === "string") {
		return { type: "link", href: message.href };
	}
	return null;
}

/**
 * The `http(s)` URL a link report names, or null. Opened at once only under
 * the app's own user activation, which a tap in the frame gives it and a
 * script alone does not.
 */
export function linkUrl(href: string): URL | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

const LEFT = "pockode:page-left";
const LOADED = "pockode:page-loaded";
const NAVIGATE = "pockode:page-navigate";

/**
 * Hears, in the document a page's frame sits in, the frame being refused a
 * navigation — which only the document that embeds a frame is told of — and
 * tells the app. Script source, for a wrapper's own `<script>`.
 */
export const LEFT_LISTENER = `document.addEventListener("securitypolicyviolation",function(e){if(e.effectiveDirective==="frame-src"||e.effectiveDirective==="child-src")parent.postMessage({type:"${LEFT}",url:String(e.blockedURI)},"*");});`;

/**
 * What a wrapper says. Taken only from the wrapper's own window, which the
 * page inside it cannot post as.
 */
export type WrapperReport = { type: "left"; url: string } | { type: "loaded" };

export function readWrapperReport(data: unknown): WrapperReport | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (message.type === LEFT && typeof message.url === "string") {
		return { type: "left", url: message.url };
	}
	return message.type === LOADED ? { type: "loaded" } : null;
}

/** A wrapper is nothing but its page's frame, filling it. */
export const WRAPPER_STYLE =
	"<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff;color-scheme:light}iframe{display:block;width:100%;height:100%;border:0;background:#fff;color-scheme:light}</style>";

export function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The prefix of every URL a raw capability reaches, from the URL it was
 * issued with: a root capability's own, which ends in `/`, or a file
 * capability's up to the file's name.
 */
export function capabilityRoot(capabilityUrl: string): string {
	return capabilityUrl.slice(0, capabilityUrl.lastIndexOf("/") + 1);
}

/**
 * The name of the frame a wrapper holds a workspace page in, which the
 * server's reporter answers to (`pageFrameName` in server/filetransfer/raw.go):
 * it stands down in a frame the page makes itself, whose reports would reach
 * only the wrapper.
 */
const PAGE_FRAME_NAME = "pockode-page";

/**
 * The document a workspace page's frame sits in, one per capability, which
 * exists for its `frame-src`: the browser checks the embedding document's
 * policy on every navigation of a frame, those the frame starts included, so
 * the page can follow links within its capability — `root`, as
 * `capabilityRoot` gives it — and go nowhere else: not to a host, which no
 * policy of ours would hold, and not to another capability, whose hosts are
 * another page's. The app's own document cannot be the embedder, being every
 * page's at once.
 *
 * Unlike an agent's page, the page is a URL and so inherits nothing: its own
 * policy is the response's (`/api/raw`). The wrapper says when the page has
 * loaded — the `load` event the app could hear is the wrapper's — and loads it
 * again when the app — only the app — asks (`navigateWrapper`): a navigation of
 * the same frame, so Back steps back through it.
 */
export function rawPageWrapper(
	pageUrl: string,
	root: string,
	title: string,
	sandbox: string,
): string {
	const policy = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${root}`;
	return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta http-equiv="x-dns-prefetch-control" content="off">${WRAPPER_STYLE}<iframe name="${PAGE_FRAME_NAME}" title="${escapeAttribute(title)}" sandbox="${sandbox}" referrerpolicy="no-referrer" src="${escapeAttribute(pageUrl)}"></iframe><script>${LEFT_LISTENER}var f=document.querySelector("iframe");f.addEventListener("load",function(){parent.postMessage({type:"${LOADED}"},"*");});addEventListener("message",function(e){var d=e.data;if(e.source===parent&&d&&d.type==="${NAVIGATE}"&&typeof d.url==="string")f.src=d.url;});</script>`;
}

/** Has `wrapper` load its page again from `pageUrl`, under its capability. */
export function navigateWrapper(wrapper: HTMLIFrameElement, pageUrl: string) {
	wrapper.contentWindow?.postMessage({ type: NAVIGATE, url: pageUrl }, "*");
}

/**
 * How long an input in the app's own document may still be what its user
 * activation comes from: Chromium keeps one for 5 s, the longest of the
 * engines.
 */
const ACTIVATION_LIFETIME_MS = 5000;

let lastAppInput = Number.NEGATIVE_INFINITY;

/**
 * Whether `event` gives the document a user activation, as HTML lists them: a
 * key other than Escape, a mouse press, and any other pointer's release — so
 * a touch that scrolls, which ends in `pointercancel`, gives none. Only the
 * reader's own input: a dispatched event gives none to spend.
 */
function activates(event: Event): boolean {
	if (!event.isTrusted) return false;
	if (event instanceof KeyboardEvent) return event.key !== "Escape";
	if (!(event instanceof PointerEvent)) return false;
	return event.type === "pointerdown"
		? event.pointerType === "mouse"
		: event.pointerType !== "mouse";
}

/**
 * Starts noting input in the app's own document, which a tap or key inside a
 * frame never reaches, so the two can be told apart. Called once as the app
 * starts, before any input: the tap that first mounts a page must already be
 * the app's.
 */
export function watchAppInput() {
	const note = (event: Event) => {
		if (activates(event)) lastAppInput = performance.now();
	};
	for (const type of ["keydown", "pointerdown", "pointerup"]) {
		window.addEventListener(type, note, { capture: true });
	}
}

/**
 * Whether the app holds a user activation that can only have come from a tap
 * or key inside `frame`:
 *
 * - active, with no input in the app's own document for as long as an
 *   activation lasts — a Load tap, or a Tab into the frame, is the app's own,
 *   and a page that reports a link straight after it gets nothing from it;
 * - `frame` the only frame in the app's document, and the focused element.
 *   An activation says nothing of which frame it came from, and Chromium lets
 *   a page focus itself without one, so with a second frame up — another page,
 *   a diagram — a tap there would be this page's to spend.
 */
export function activatedIn(frame: HTMLIFrameElement | null): boolean {
	return (
		frame !== null &&
		(navigator.userActivation?.isActive ?? false) &&
		performance.now() - lastAppInput > ACTIVATION_LIFETIME_MS &&
		document.activeElement === frame &&
		document.querySelectorAll("iframe").length === 1
	);
}

/**
 * The hosts the reader has allowed, by page. In memory only, so a reload of
 * the app asks again, and only ever written by the app's own Load.
 */
const allowedByPage = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
const NONE: ReadonlySet<string> = new Set();

export function allowedPageHosts(pageKey: string): ReadonlySet<string> {
	return allowedByPage.get(pageKey) ?? NONE;
}

export function allowPageHosts(pageKey: string, hosts: readonly string[]) {
	const current = allowedPageHosts(pageKey);
	if (hosts.every((host) => current.has(host))) return;
	allowedByPage.set(pageKey, new Set([...current, ...hosts]));
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useAllowedPageHosts(pageKey: string): ReadonlySet<string> {
	const read = useCallback(() => allowedPageHosts(pageKey), [pageKey]);
	return useSyncExternalStore(subscribe, read, read);
}

/**
 * Forgets every allowance and the app's last input; for tests, which share
 * this module's memory.
 */
export function resetPageHosts() {
	allowedByPage.clear();
	lastAppInput = Number.NEGATIVE_INFINITY;
	for (const listener of listeners) listener();
}
