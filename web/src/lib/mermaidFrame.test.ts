import { describe, expect, it } from "vitest";
import { mermaidFrameDocument } from "./mermaidFrame";

const SECRETS = { nonce: "the-nonce", token: "the-token" };

interface RunningFrame {
	document: Document;
	ready: unknown;
	/** What the frame has posted over its port. */
	received: unknown[];
}

/**
 * Runs the frame document's own script against a document of its own, with a
 * parent that records the handshake: the script is a string the page writes
 * into `srcdoc`, so this is the only place its side of the protocol runs.
 */
async function runFrame(imageHosts: string[] = []): Promise<RunningFrame> {
	const written = new DOMParser().parseFromString(
		mermaidFrameDocument(SECRETS, imageHosts),
		"text/html",
	);
	const source = written.querySelector("script")?.textContent ?? "";
	const frameDocument = document.implementation.createHTMLDocument();
	frameDocument.body.innerHTML = '<div id="diagram"></div>';

	let handshake: { data: unknown; port: MessagePort } | null = null;
	const frameWindow = {
		parent: {
			postMessage: (data: unknown, _origin: string, ports: MessagePort[]) => {
				handshake = { data, port: ports[0] };
			},
		},
	};
	class InertResizeObserver {
		observe() {}
	}
	new Function("window", "document", "ResizeObserver", source)(
		frameWindow,
		frameDocument,
		InertResizeObserver,
	);
	const opened = handshake as { data: unknown; port: MessagePort } | null;
	if (!opened) throw new Error("the frame said no ready");
	const received: unknown[] = [];
	opened.port.onmessage = (event) => received.push(event.data);
	return { document: frameDocument, ready: opened.data, received };
}

async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the Mermaid frame's document", () => {
	it("opens by handing the page a port, with its token and its hosts", async () => {
		const frame = await runFrame(["a.example", "b.example:8080"]);

		expect(frame.ready).toEqual({
			type: "ready",
			token: "the-token",
			hosts: "a.example b.example:8080",
		});
	});

	it.each([
		[
			"a link",
			'<svg><a href="https://example.com/a"><text id="hit">x</text></a></svg>',
			"https://example.com/a",
		],
		[
			"an SVG link written with xlink",
			'<svg><a xlink:href="https://example.com/x"><text id="hit">x</text></a></svg>',
			"https://example.com/x",
		],
		[
			"an image map's area",
			'<map name="m"><area id="hit" shape="default" href="https://example.com/m"></map>',
			"https://example.com/m",
		],
	])("never follows %s itself, but reports it", async (_, markup, href) => {
		const frame = await runFrame();
		const root = frame.document.getElementById("diagram");
		if (!root) throw new Error("no diagram root");
		root.innerHTML = markup;
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });

		frame.document.getElementById("hit")?.dispatchEvent(click);
		await settle();

		expect(click.defaultPrevented).toBe(true);
		expect(frame.received).toEqual([{ type: "link", href }]);
	});

	it("reports an Escape, which the page would otherwise never see", async () => {
		const frame = await runFrame();

		frame.document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		await settle();

		expect(frame.received).toEqual([{ type: "escape" }]);
	});

	it("reports the images its policy refused, and nothing else it refused", async () => {
		const frame = await runFrame();
		const refused = (directive: string, url: string) =>
			frame.document.dispatchEvent(
				Object.assign(new Event("securitypolicyviolation"), {
					effectiveDirective: directive,
					blockedURI: url,
				}),
			);

		refused("img-src", "https://img.example/p.png");
		refused("style-src-elem", "https://css.example/s.css");
		await settle();

		expect(frame.received).toEqual([
			{ type: "blocked", url: "https://img.example/p.png" },
		]);
	});
});
