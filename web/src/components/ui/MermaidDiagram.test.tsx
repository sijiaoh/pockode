import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToFrame } from "../../lib/mermaidFrame";
import { reportEverythingInView } from "../../test/imageFixtures";
import { MarkdownContent } from "./MarkdownContent";

const loadMermaidSource = vi.hoisted(() => vi.fn(async () => "/* mermaid */"));

vi.mock("../../lib/mermaidSource", () => ({ loadMermaidSource }));

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ workDir: "/work", actions: { getFile: vi.fn() } }),
	isRPCTimeout: () => false,
}));

let hosts = 0;
/** A host no other test has loaded a diagram from: the page remembers them. */
function freshHost() {
	hosts += 1;
	return `d${hosts}.example.com`;
}

let diagrams = 0;
/** A diagram no other test has drawn, for the same reason. */
function freshDiagram() {
	diagrams += 1;
	return `flowchart LR\n  A${diagrams} --> B`;
}

function fenced(source: string) {
	return `\`\`\`mermaid\n${source}\n\`\`\``;
}

function renderMarkdown(content: string) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<MarkdownContent content={content} />
		</QueryClientProvider>,
	);
}

function frame(): HTMLIFrameElement {
	return screen.getByTitle("Mermaid diagram");
}

function policyOf(element: HTMLIFrameElement): string {
	const document = new DOMParser().parseFromString(
		element.getAttribute("srcdoc") ?? "",
		"text/html",
	);
	return (
		document
			.querySelector('meta[http-equiv="Content-Security-Policy"]')
			?.getAttribute("content") ?? ""
	);
}

function nonceOf(element: HTMLIFrameElement): string {
	return /<script nonce="([^"]+)">/.exec(element.srcdoc)?.[1] ?? "";
}

/** The `ready` the frame's document opens with, as its script writes it. */
function readyOf(element: HTMLIFrameElement): {
	type: "ready";
	token: string;
	hosts: string;
} {
	const written = /type: "ready", token: ("[^"]*"), hosts: ("[^"]*")/.exec(
		element.srcdoc,
	);
	if (!written) throw new Error("the frame's document says no ready");
	return {
		type: "ready",
		token: JSON.parse(written[1]),
		hosts: JSON.parse(written[2]),
	};
}

/** The window message a frame's document opens with, handing over its port. */
function handshake(
	data: unknown,
	port: MessagePort,
	{ origin = "null", source }: { origin?: string; source?: Window | null } = {},
) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data,
				origin,
				source: source === undefined ? frame().contentWindow : source,
				ports: [port],
			}),
		);
	});
}

/** Lets messages in flight on a port arrive, and React take them in. */
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/**
 * The frame's document as the page sees it: what it was sent, and a way to
 * answer over the port it handed over.
 */
interface FakeDocument {
	received: ToFrame[];
	send: (message: unknown) => Promise<void>;
}

/** Loads the current frame's document, or one saying `ready` otherwise. */
async function load(ready: unknown = readyOf(frame())): Promise<FakeDocument> {
	const channel = new MessageChannel();
	const received: ToFrame[] = [];
	channel.port1.onmessage = (event) => received.push(event.data);
	handshake(ready, channel.port2);
	await settle();
	return {
		received,
		send: async (message) => {
			channel.port1.postMessage(message);
			await settle();
		},
	};
}

/** Brings the frame up to a drawn diagram, as its document would. */
async function draw(code: string, height = 120): Promise<FakeDocument> {
	const document = await load();
	await waitFor(() =>
		expect(document.received).toContainEqual(
			expect.objectContaining({ type: "render", code }),
		),
	);
	await document.send({ type: "rendered", code, height });
	return document;
}

beforeEach(() => {
	reportEverythingInView();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a Mermaid diagram", () => {
	it("is drawn in a frame sealed off from the network and the app", () => {
		renderMarkdown(fenced(freshDiagram()));

		const element = frame();
		expect(element.getAttribute("sandbox")).toBe("allow-scripts");
		const nonce = nonceOf(element);
		expect(nonce).not.toBe("");
		expect(policyOf(element)).toBe(
			`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`,
		);
	});

	it("hands the frame Mermaid, then the diagram, and shows it at its size", async () => {
		const code = freshDiagram();
		renderMarkdown(fenced(code));
		expect(screen.getByText("Loading diagram...")).toBeInTheDocument();

		const frameDocument = await draw(code, 240);

		expect(frameDocument.received[0]).toEqual({
			type: "script",
			source: "/* mermaid */",
		});
		expect(frameDocument.received[1]).toMatchObject({
			type: "render",
			code,
			theme: "default",
			colorScheme: "light",
		});
		expect(screen.queryByText("Loading diagram...")).toBeNull();
		expect(frame()).toHaveStyle({ height: "240px" });

		await frameDocument.send({ type: "size", height: 300 });
		expect(frame()).toHaveStyle({ height: "300px" });
	});

	it("talks only to the document it wrote, never to one the frame was navigated to", async () => {
		const code = freshDiagram();
		renderMarkdown(fenced(code));
		const ready = readyOf(frame());

		// Opaque and in the same frame, as a page the frame was navigated to
		// would be, but without the token.
		const stranger = await load({ ...ready, token: "not-the-token" });
		const elsewhere = new MessageChannel();
		handshake(ready, elsewhere.port2, { origin: window.location.origin });
		handshake(ready, elsewhere.port2, { source: window });
		await settle();

		expect(stranger.received).toEqual([]);
		await stranger.send({ type: "rendered", code, height: 500 });
		expect(screen.getByText("Loading diagram...")).toBeInTheDocument();

		const own = await draw(code, 100);
		await own.send({ type: "size", height: "500" });
		expect(frame()).toHaveStyle({ height: "100px" });
	});

	it("draws again in a frame the browser reloaded", async () => {
		const code = freshDiagram();
		renderMarkdown(fenced(code));
		await draw(code);

		// Moving an iframe in the DOM reloads it: the same document, empty.
		const reloaded = await load();

		expect(screen.getByText("Loading diagram...")).toBeInTheDocument();
		await waitFor(() =>
			expect(reloaded.received).toContainEqual(
				expect.objectContaining({ type: "render", code }),
			),
		);
	});

	it("shows its source when Mermaid cannot draw it", async () => {
		const code = "flowchart LR\n  A --> ((broken";
		const { container } = renderMarkdown(fenced(code));
		const frameDocument = await load();

		await frameDocument.send({ type: "error", message: "Parse error" });

		// The text, not a node: the code block swaps its plain text for the
		// highlighted one once the highlighter is ready.
		await waitFor(() => expect(container).toHaveTextContent("A --> ((broken"));
		expect(screen.queryByText("Loading diagram...")).toBeNull();
		expect(frame()).toHaveAttribute("aria-hidden", "true");
		expect(frame()).toHaveAttribute("inert");
	});

	it("shows its source when the frame never comes up", () => {
		vi.useFakeTimers();
		try {
			renderMarkdown(fenced("flowchart LR\n  Never --> Up"));

			act(() => vi.advanceTimersByTime(10_000));

			expect(screen.getByText(/Never --> Up/)).toBeInTheDocument();
			expect(screen.queryByText("Loading diagram...")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("times a new document out even when an earlier one with its hosts came up", async () => {
		const user = userEvent.setup();
		const code = freshDiagram();
		const host = freshHost();
		const first = renderMarkdown(fenced(code));
		const frameDocument = await draw(code);
		await frameDocument.send({ type: "blocked", url: `https://${host}/p.png` });
		await user.click(
			screen.getByRole("button", { name: `Load diagram images from ${host}` }),
		);
		await draw(code);
		first.unmount();

		vi.useFakeTimers();
		try {
			const view = renderMarkdown(fenced(code));
			handshake(readyOf(frame()), new MessageChannel().port2);
			const show = (source: string) =>
				view.rerender(
					<QueryClientProvider client={new QueryClient()}>
						<MarkdownContent content={fenced(source)} />
					</QueryClientProvider>,
				);
			// Streams on past the remembered source — a document without its
			// host — and an edit brings it back: a third document, never up.
			show(`${code}\n  B --> C`);
			show(code);

			act(() => vi.advanceTimersByTime(10_000));

			expect(screen.queryByText("Loading diagram...")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for Mermaid on a slow network once the frame is up", () => {
		loadMermaidSource.mockReturnValueOnce(new Promise(() => {}));
		vi.useFakeTimers();
		try {
			renderMarkdown(fenced("flowchart LR\n  Slow --> Chunk"));
			const channel = new MessageChannel();
			handshake(readyOf(frame()), channel.port2);

			act(() => vi.advanceTimersByTime(30_000));

			expect(screen.getByText("Loading diagram...")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("offers to load the images its frame refused, and allows exactly those hosts", async () => {
		const user = userEvent.setup();
		const code = freshDiagram();
		const host = freshHost();
		renderMarkdown(fenced(code));
		const first = await draw(code);

		await first.send({ type: "blocked", url: `https://${host}/p.png` });
		await first.send({ type: "blocked", url: `https://${host}/q.png` });

		expect(screen.getByText(`Not loaded · ${host}`)).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: `Load diagram images from ${host}` }),
		);

		const element = frame();
		expect(policyOf(element)).toContain(
			`img-src data: http://${host} https://${host};`,
		);
		expect(screen.queryByText(`Not loaded · ${host}`)).toBeNull();
		// The old document, still finishing as the new one loads, is not
		// taken for it.
		await first.send({ type: "error", message: "late" });
		expect(screen.getByText("Loading diagram...")).toBeInTheDocument();
		await first.send({ type: "rendered", code, height: 120 });
		expect(screen.getByText("Loading diagram...")).toBeInTheDocument();
		// A new document, so Mermaid is drawn again in it.
		const second = await draw(code);
		expect(screen.queryByText("Loading diagram...")).toBeNull();
		// The focus goes where the Load was, not to the top of the page.
		expect(document.activeElement).not.toBe(document.body);
		expect(document.activeElement).toContainElement(element);

		// And again for a host only the redrawn diagram was refused.
		const other = freshHost();
		await second.send({ type: "blocked", url: `https://${other}/r.png` });
		await user.click(
			screen.getByRole("button", { name: `Load diagram images from ${other}` }),
		);
		expect(document.activeElement).not.toBe(document.body);
		expect(document.activeElement).toContainElement(frame());
	});

	it("does not offer a swapped-out diagram's hosts for the one swapped in", async () => {
		const code = freshDiagram();
		const host = freshHost();
		const view = renderMarkdown(fenced(code));
		const frameDocument = await draw(code);
		await frameDocument.send({ type: "blocked", url: `https://${host}/p.png` });
		expect(screen.getByText(`Not loaded · ${host}`)).toBeInTheDocument();

		const next = freshDiagram();
		view.rerender(
			<QueryClientProvider client={new QueryClient()}>
				<MarkdownContent content={fenced(next)} />
			</QueryClientProvider>,
		);
		await frameDocument.send({ type: "rendered", code: next, height: 120 });

		expect(screen.queryByText("Loading diagram...")).toBeNull();
		expect(screen.queryByText(`Not loaded · ${host}`)).toBeNull();
	});

	it("never offers the app's own host, nor anything but http(s)", async () => {
		const code = freshDiagram();
		renderMarkdown(fenced(code));
		const frameDocument = await draw(code);

		await frameDocument.send({
			type: "blocked",
			url: `${window.location.origin}/api/x`,
		});
		await frameDocument.send({
			type: "blocked",
			url: "ftp://files.example.com/x.png",
		});
		await frameDocument.send({ type: "blocked", url: "inline" });

		expect(screen.queryByRole("button", { name: /^Load/ })).toBeNull();
	});

	it("allows its hosts for the images in the same text, and theirs for it", async () => {
		const user = userEvent.setup();
		const code = freshDiagram();
		const host = freshHost();
		const other = freshHost();
		renderMarkdown(
			[
				`![badge](https://${host}/b.svg)`,
				fenced(code),
				`![logo](https://${other}/l.svg)`,
			].join("\n\n"),
		);
		await user.click(
			screen.getByRole("button", { name: `Load badge from ${host}` }),
		);
		const first = await draw(code);

		// Already allowed in this text: no second question.
		await first.send({ type: "blocked", url: `https://${host}/a.png` });
		expect(policyOf(frame())).toContain(`https://${host};`);
		expect(screen.queryByRole("button", { name: /^Load diagram/ })).toBeNull();

		const second = await draw(code);
		await second.send({ type: "blocked", url: `https://${other}/a.png` });
		await user.click(
			screen.getByRole("button", {
				name: `Load diagram images from ${other}`,
			}),
		);
		expect(
			await screen.findByRole("img", { name: "logo" }),
		).toBeInTheDocument();
	});

	it("needs no second tap once loaded, wherever it mounts again", async () => {
		const user = userEvent.setup();
		const code = freshDiagram();
		const host = freshHost();
		const first = renderMarkdown(fenced(code));
		const frameDocument = await draw(code);
		await frameDocument.send({ type: "blocked", url: `https://${host}/p.png` });
		await user.click(
			screen.getByRole("button", { name: `Load diagram images from ${host}` }),
		);
		await draw(code);
		first.unmount();

		renderMarkdown(fenced(code));

		expect(policyOf(frame())).toContain(`https://${host};`);
	});

	it("opens a link the reader taps outside the frame, and only a web one", async () => {
		const code = freshDiagram();
		renderMarkdown(fenced(code));
		const frameDocument = await draw(code);
		const open = vi.spyOn(window, "open").mockReturnValue(null);

		await frameDocument.send({ type: "link", href: "javascript:alert(1)" });
		await frameDocument.send({ type: "link", href: "not a url" });
		await frameDocument.send({
			type: "link",
			href: "https://example.com/docs",
		});

		expect(open).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledWith(
			"https://example.com/docs",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("passes an Escape pressed in the frame on to the page", async () => {
		const code = freshDiagram();
		renderMarkdown(fenced(code));
		const frameDocument = await draw(code);
		const keys: string[] = [];
		const onKey = (event: KeyboardEvent) => keys.push(event.key);
		document.addEventListener("keydown", onKey);

		await frameDocument.send({ type: "escape" });

		document.removeEventListener("keydown", onKey);
		expect(keys).toEqual(["Escape"]);
	});
});
