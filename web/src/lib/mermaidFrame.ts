import { generateUUID } from "../utils/uuid";
import { refusedHost } from "./pageHosts";

/**
 * The document a Mermaid diagram is drawn in, and what it and the page say to
 * each other (docs/markdown-images-ui.md#diagrams-draw-in-a-sealed-frame).
 *
 * The frame is sandboxed without `allow-same-origin`, so it runs in an opaque
 * origin with no reach into the app's storage, and its Content-Security-Policy
 * lets nothing load but the script the page hands it and the image hosts the
 * reader has allowed for it.
 *
 * Everything after the handshake goes over a `MessagePort` the document hands
 * the page with its `ready`, which carries a token only that document was
 * written with. The window's origin and identity are not enough: should the
 * frame ever be navigated, the page it lands on is just as opaque and is the
 * same `contentWindow`, but it holds neither the token nor the port.
 */

/** What the page sends the frame. */
export type ToFrame =
	| { type: "script"; source: string }
	| {
			type: "render";
			code: string;
			theme: "dark" | "default";
			colorScheme: "dark" | "light";
			fontFamily: string;
			color: string;
	  };

/** What the frame sends the page over its port; anything else is dropped. */
export type FromFrame =
	| { type: "rendered"; code: string; height: number }
	| { type: "size"; height: number }
	| { type: "error"; message: string }
	/** An image request the policy refused, by the URL the browser reported. */
	| { type: "blocked"; url: string }
	| { type: "link"; href: string }
	| { type: "escape" };

/**
 * `default-src 'none'` refuses every fetch the rest does not name: no
 * stylesheet, font, `@import`, connection, frame or worker. Styles are inline
 * only, because Mermaid puts a `<style>` in every SVG. `data:` images make no
 * request.
 */
export function mermaidFramePolicy(
	nonce: string,
	imageHosts: readonly string[],
): string {
	const images = ["data:"];
	for (const host of imageHosts)
		images.push(`http://${host}`, `https://${host}`);
	return [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		"style-src 'unsafe-inline'",
		`img-src ${images.join(" ")}`,
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}

/**
 * Runs inside the frame. A string rather than a function's source, because
 * the build would rename what a serialised function refers to.
 */
const BOOTSTRAP = `(() => {
	const channel = new MessageChannel();
	const port = channel.port1;
	const post = (message) => port.postMessage(message);
	const root = document.getElementById("diagram");
	const height = () => Math.ceil(root.getBoundingClientRect().height);
	let latest = 0;

	document.addEventListener("securitypolicyviolation", (event) => {
		if (event.effectiveDirective === "img-src") {
			post({ type: "blocked", url: event.blockedURI });
		}
	});
	new ResizeObserver(() => post({ type: "size", height: height() })).observe(root);
	// Every element that navigates on a click: an SVG or HTML link, and an
	// image map's area, which DOMPurify keeps too.
	document.addEventListener("click", (event) => {
		const link = event.target instanceof Element ? event.target.closest("a, area") : null;
		if (!link) return;
		event.preventDefault();
		const href = link.getAttribute("href") || link.getAttribute("xlink:href");
		if (href) post({ type: "link", href });
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") post({ type: "escape" });
	});

	port.onmessage = async (event) => {
		const message = event.data;
		if (message.type === "script") {
			if (window.mermaid) return;
			const script = document.createElement("script");
			script.nonce = __NONCE__;
			script.textContent = message.source;
			document.head.append(script);
			return;
		}
		if (message.type !== "render") return;
		const seq = ++latest;
		const page = document.documentElement.style;
		page.colorScheme = message.colorScheme;
		page.fontFamily = message.fontFamily;
		page.color = message.color;
		try {
			window.mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: message.theme,
				suppressErrorRendering: true,
			});
			const { svg } = await window.mermaid.render("mermaid-" + seq, message.code);
			if (seq !== latest) return;
			root.innerHTML = svg;
			post({ type: "rendered", code: message.code, height: height() });
		} catch (error) {
			if (seq !== latest) return;
			post({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};
	window.parent.postMessage(
		{ type: "ready", token: __TOKEN__, hosts: __HOSTS__ },
		"*",
		[channel.port2],
	);
})();`;

/**
 * What one diagram's frames are written with. The token is a second secret
 * beside the nonce because the nonce also stands in the policy's `<meta>`,
 * an attribute a diagram's CSS can select on; the token is only ever script
 * text.
 */
export interface FrameSecrets {
	nonce: string;
	token: string;
}

/**
 * Not `crypto.randomUUID`, which a page on plain `http://<LAN-IP>` does not
 * have.
 */
export function newFrameSecrets(): FrameSecrets {
	return { nonce: generateUUID(), token: generateUUID() };
}

/**
 * The image hosts a frame's policy allows, as one string: what its `ready`
 * names, so the page knows which document is the one that answered.
 */
export function frameHostsKey(imageHosts: readonly string[]): string {
	return imageHosts.join(" ");
}

/** The frame's whole document, for `srcdoc`. */
export function mermaidFrameDocument(
	{ nonce, token }: FrameSecrets,
	imageHosts: readonly string[],
): string {
	// Replacer functions, so that nothing in a value is read as a `$` pattern.
	const script = BOOTSTRAP.replace("__NONCE__", () => JSON.stringify(nonce))
		.replace("__TOKEN__", () => JSON.stringify(token))
		.replace("__HOSTS__", () => JSON.stringify(frameHostsKey(imageHosts)));
	return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${mermaidFramePolicy(nonce, imageHosts)}">
<meta name="referrer" content="no-referrer">
<meta http-equiv="x-dns-prefetch-control" content="off">
<style>html,body{margin:0;background:transparent;overflow:hidden}#diagram{overflow-x:auto}#diagram svg{max-width:100%}</style>
</head><body><div id="diagram"></div><script nonce="${nonce}">${script}</script></body></html>`;
}

/**
 * The port a frame's `ready` hands over and the hosts its policy allows, if
 * `data` is that message from a document written with `token`; null for
 * anything else.
 */
export function readFrameHandshake(
	data: unknown,
	ports: readonly MessagePort[],
	token: string,
): { port: MessagePort; hosts: string } | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (message.type !== "ready" || message.token !== token) return null;
	const port = ports[0];
	if (!port || typeof message.hosts !== "string") return null;
	return { port, hosts: message.hosts };
}

/**
 * The host a refused image request may be allowed for, or null for one it may
 * not: what a page may be allowed (`refusedHost`), over http(s) only, as an
 * image is fetched.
 */
export function blockedImageHost(
	url: string,
	ownHostname: string,
): string | null {
	const refused = refusedHost(url, ownHostname);
	if (!refused?.allowable) return null;
	const { protocol } = new URL(url);
	return protocol === "http:" || protocol === "https:" ? refused.host : null;
}

/** `data` if it is one of the messages the frame sends, else null. */
export function readFrameMessage(data: unknown): FromFrame | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	const isHeight = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) && value >= 0;
	switch (message.type) {
		case "escape":
			return { type: "escape" };
		case "rendered":
			return typeof message.code === "string" && isHeight(message.height)
				? {
						type: "rendered",
						code: message.code,
						height: message.height as number,
					}
				: null;
		case "size":
			return isHeight(message.height)
				? { type: "size", height: message.height as number }
				: null;
		case "error":
			return typeof message.message === "string"
				? { type: "error", message: message.message }
				: null;
		case "blocked":
			return typeof message.url === "string"
				? { type: "blocked", url: message.url }
				: null;
		case "link":
			return typeof message.href === "string"
				? { type: "link", href: message.href }
				: null;
		default:
			return null;
	}
}
