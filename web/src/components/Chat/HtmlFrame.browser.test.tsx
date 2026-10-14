import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { page, userEvent as realUserEvent } from "vitest/browser";
import {
	allowedPageHosts,
	pagePolicy,
	resetPageHosts,
	watchAppInput,
} from "../../lib/pageHosts";
// Says, from inside the page, that a request to another host went through.
import landedPath from "../../test/page-hosts/landed.htm?url";
import signalPath from "../../test/page-hosts/signal.js?url";
import { otherHost } from "../../test/testServerHosts";
import { PRESS_HOLD_MS } from "../ui/PageHostsStrip";
import { HTML_FRAME_SANDBOX, HtmlFrame } from "./HtmlFrame";

// What jsdom cannot do is enforce a policy, which is the whole guarantee: these
// run real pages against real engines. The same server under another name
// stands in for another host — a CDN (`src/test/testServerHosts.ts`) — so a
// request that is let through is seen to arrive.
const OTHER_HOST = otherHost(location.port);
const SIGNAL_URL = `http://${OTHER_HOST}${signalPath}`;
const LANDED_URL = `http://${OTHER_HOST}${landedPath}`;
const KEY = "call-under-test";

/** Every `signal` a page posts the test, as it arrives. */
let signals: string[] = [];
function onSignal(event: MessageEvent) {
	const data: unknown = event.data;
	if (data && typeof data === "object" && "signal" in data) {
		signals.push(String(data.signal));
	}
}

function renderPage(html: string, title = "Page") {
	render(
		<div style={{ width: 480 }}>
			<HtmlFrame
				html={html}
				title={title}
				pageKey={KEY}
				boxStyle={{ height: 240 }}
			/>
		</div>,
	);
}

function wrapperOf(title = "Page"): HTMLIFrameElement {
	return screen.getByTitle(title);
}

function policyOf(frame: HTMLIFrameElement): string {
	return (
		new DOMParser()
			.parseFromString(frame.srcdoc, "text/html")
			.querySelector('meta[http-equiv="Content-Security-Policy"]')
			?.getAttribute("content") ?? ""
	);
}

function strip() {
	return screen.findByRole(
		"group",
		{ name: "Hosts not loaded" },
		{ timeout: 5000 },
	);
}

/** Time for anything a page was going to do to have happened. */
function settle(ms = 1500) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("an agent's page in a real browser", () => {
	// What `main.tsx` does as the app starts.
	beforeAll(watchAppInput);
	beforeEach(() => {
		signals = [];
		window.addEventListener("message", onSignal);
	});
	afterEach(() => {
		window.removeEventListener("message", onSignal);
		resetPageHosts();
		vi.restoreAllMocks();
	});

	it("refuses another host until the reader loads it, then the page has it", async () => {
		const user = userEvent.setup();
		renderPage(`<script src="${SIGNAL_URL}"></script><p>chart</p>`);

		const refused = await strip();
		expect(refused).toHaveTextContent(`Not loaded · ${OTHER_HOST}`);
		expect(signals).not.toContain("script");

		await settle(PRESS_HOLD_MS + 100);
		await user.click(
			within(refused).getByRole("button", {
				name: `Load ${OTHER_HOST} and reload the page`,
			}),
		);

		await waitFor(() => expect(signals).toContain("script"), {
			timeout: 5000,
		});
		expect(policyOf(wrapperOf())).toContain(`https://${OTHER_HOST}`);
		expect(screen.queryByRole("group")).toBeNull();
		// Where the Load was, not the top of the screen.
		expect(document.activeElement).toBe(wrapperOf());
	});

	// The card under a full-screen view: allowed there, it keeps the document
	// the reader left, and offers to reload into the allowance.
	it("never reloads a frame for hosts allowed in another", async () => {
		const user = userEvent.setup();
		const html = `<script src="${SIGNAL_URL}"></script>`;
		render(
			<>
				<HtmlFrame html={html} title="Card" pageKey={KEY} />
				<HtmlFrame html={html} title="Full screen" pageKey={KEY} />
			</>,
		);
		await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(2), {
			timeout: 5000,
		});
		const [card, fullScreen] = screen.getAllByRole("group");

		await settle(PRESS_HOLD_MS + 100);
		await user.click(within(fullScreen).getByRole("button", { name: /^Load/ }));
		await waitFor(() => expect(signals).toEqual(["script"]), {
			timeout: 5000,
		});

		expect(card).toHaveTextContent(`Allowed · ${OTHER_HOST}`);
		await settle(1000);
		expect(signals).toEqual(["script"]);

		await user.click(
			within(card).getByRole("button", {
				name: `Reload the page to load ${OTHER_HOST}`,
			}),
		);
		await waitFor(() => expect(signals).toEqual(["script", "script"]), {
			timeout: 5000,
		});
		expect(screen.queryByRole("group")).toBeNull();
	});

	it("refuses every kind of request a page can make, by the host it was for", async () => {
		const user = userEvent.setup();
		renderPage(`<!doctype html><html><head>
<link rel="stylesheet" href="https://style.example/a.css">
<style>@font-face{font-family:F;src:url(https://font.example/f.woff2)}body{font-family:F}</style>
</head><body><p>text</p>
<img src="https://img.example/a.png">
<script>
fetch("https://fetch.example/x").catch(function(){});
try{new WebSocket("wss://socket.example/")}catch(e){}
try{navigator.sendBeacon("https://beacon.example/", "k")}catch(e){}
try{new EventSource("https://events.example/")}catch(e){}
var x=new XMLHttpRequest();x.open("GET","https://xhr.example/");try{x.send()}catch(e){}
var f=document.createElement("iframe");f.src="https://frame.example/";document.body.append(f);
</script></body></html>`);

		const refused = await strip();
		// The strip is up at the first refusal; Review only past three hosts.
		await user.click(
			await within(refused).findByRole(
				"button",
				{ name: "Review" },
				{ timeout: 5000 },
			),
		);
		const listed = () =>
			within(refused)
				.getAllByRole("listitem")
				.map((item) => item.textContent);
		await waitFor(
			() =>
				expect(listed()).toEqual(
					expect.arrayContaining([
						"style.example",
						"font.example",
						"img.example",
						"fetch.example",
						"socket.example",
						"beacon.example",
						"events.example",
						"xhr.example",
						// A frame never reaches a host here, allowed or not.
						"frame.example (can't be allowed)",
					]),
				),
			{ timeout: 5000 },
		);
	});

	describe("cannot be allowed anything by the page itself", () => {
		it("whatever it posts to the app", async () => {
			const open = vi.spyOn(window, "open").mockReturnValue(null);
			renderPage(`<script>
var forged = [
	{ type: "pockode:page-allow", hosts: ["${OTHER_HOST}"] },
	{ type: "pockode:page-left", url: "https://left.example/" },
	{ type: "pockode:page-link", href: "https://link.example/" },
	{ type: "pockode:page-refused", url: "https://forged.example/", directive: "script-src" },
];
for (var target of [parent, parent.parent, top]) {
	for (var message of forged) target.postMessage(message, "*");
}
</script><script src="${SIGNAL_URL}"></script>`);

			const refused = await strip();
			await settle();

			// Shown, never acted on: a report is only ever something to read.
			expect(refused).toHaveTextContent("forged.example");
			expect(refused).toHaveTextContent("Link not opened · link.example");
			expect(refused).not.toHaveTextContent("Page left");
			expect(open).not.toHaveBeenCalled();
			expect(allowedPageHosts(KEY).size).toBe(0);
			expect(policyOf(wrapperOf())).toBe(pagePolicy([]));
			expect(signals).not.toContain("script");
		});

		// The one way out a policy's fetch directives do not govern: a frame
		// that navigates itself lands on a document under no policy of ours.
		// What the tests below look for, seen arriving where nothing holds the
		// frame in: a sandboxed page with a policy of its own, and no wrapper.
		it("(the landing page says when a page gets there)", async () => {
			const frame = document.createElement("iframe");
			frame.sandbox.value = HTML_FRAME_SANDBOX;
			frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${pagePolicy([])}"><script>location.href = "${LANDED_URL}"</script>`;
			document.body.append(frame);
			try {
				await waitFor(() => expect(signals).toContain("landed"), {
					timeout: 5000,
				});
			} finally {
				frame.remove();
			}
		});

		const later = (attempt: string) =>
			`<body><script>setTimeout(function(){ ${attempt} }, 50)</script>`;
		it.each([
			["by script", later(`location.href = "${LANDED_URL}"`), "Page left"],
			[
				"by window.open into itself",
				later(`window.open("${LANDED_URL}", "_self")`),
				"Page left",
			],
			[
				"by a refresh",
				`<meta http-equiv="refresh" content="0;url=${LANDED_URL}">`,
				"Page left",
			],
			// The page is the embedder here, so it is the one refused, and a
			// frame is never anything to load.
			[
				"in a frame of its own",
				later(
					`var f = document.createElement("iframe"); f.srcdoc = '<script>location.href = "${LANDED_URL}"<\\/script>'; document.body.append(f)`,
				),
				`${OTHER_HOST} (can't be allowed)`,
			],
			// Held first by the sandbox, which has no `allow-forms`, and behind
			// it by `form-action`; nothing is reported.
			[
				"by a form",
				later(
					`var f = document.createElement("form"); f.action = "${LANDED_URL}"; document.body.append(f); f.submit()`,
				),
				null,
			],
			// Held by the sandbox, which lets a frame navigate only itself and
			// what it holds: not the wrapper, and not the app.
			[
				"the wrapper",
				later(`try { parent.location.href = "${LANDED_URL}" } catch (e) {}`),
				null,
			],
			[
				"the app",
				later(`try { top.location.href = "${LANDED_URL}" } catch (e) {}`),
				null,
			],
		])("by navigating %s", async (_, html, says) => {
			renderPage(html);

			if (says) {
				const refused = await strip();
				await waitFor(() => expect(refused).toHaveTextContent(says), {
					timeout: 5000,
				});
			}
			await settle(2000);
			expect(signals).not.toContain("landed");
			expect(allowedPageHosts(KEY).size).toBe(0);
		});

		// WebKit loads an `<object>` from a host `default-src` allows, and the
		// document it loads would answer to no policy of ours.
		it("by embedding a document from a host the reader has allowed", async () => {
			const user = userEvent.setup();
			renderPage(`<script src="${SIGNAL_URL}"></script>
<object data="${LANDED_URL}" type="text/html"></object>
<embed src="${LANDED_URL}" type="text/html">`);
			const refused = await strip();
			await settle(PRESS_HOLD_MS + 100);
			await user.click(within(refused).getByRole("button", { name: /^Load/ }));
			await waitFor(() => expect(signals).toContain("script"), {
				timeout: 5000,
			});

			await settle(2000);
			expect(signals).not.toContain("landed");
		});

		it("by navigating to a host the reader has allowed", async () => {
			const user = userEvent.setup();
			renderPage(`<script src="${SIGNAL_URL}"></script><button id="go" onclick="location.href='${LANDED_URL}'">go</button><script>
addEventListener("message", function(e){ if (e.data === "go") location.href = "${LANDED_URL}"; });
</script>`);
			const refused = await strip();
			await settle(PRESS_HOLD_MS + 100);
			await user.click(within(refused).getByRole("button", { name: /^Load/ }));
			await waitFor(() => expect(signals).toContain("script"), {
				timeout: 5000,
			});

			// Asked by the test, which reaches the page as any window may.
			wrapperOf().contentWindow?.[0]?.postMessage("go", "*");

			const left = await strip();
			await waitFor(() => expect(left).toHaveTextContent("Page left"), {
				timeout: 5000,
			});
			await settle(1000);
			expect(signals).not.toContain("landed");
		});
	});

	describe("a link in the page", () => {
		it("opens in a new tab on the reader's tap, rather than in the frame", async () => {
			const open = vi.spyOn(window, "open").mockReturnValue(null);
			renderPage(
				`<a href="${LANDED_URL}" style="display:block;padding:20px">Docs</a>`,
				"Linked page",
			);
			const wrapper = page.frameLocator(page.getByTitle("Linked page"));
			const inner = page.frameLocator(wrapper.getByTitle("Linked page"));

			await inner.getByRole("link", { name: "Docs" }).click();

			await waitFor(() =>
				expect(open).toHaveBeenCalledWith(
					LANDED_URL,
					"_blank",
					"noopener,noreferrer",
				),
			);
			await settle(1000);
			expect(signals).not.toContain("landed");
			expect(screen.queryByRole("group")).toBeNull();
		});

		// The reader's tap on Load leaves the app an activation, and puts the
		// focus on the new frame; neither is a tap in the page.
		it("is not opened on the activation a Load leaves", async () => {
			const open = vi.spyOn(window, "open").mockReturnValue(null);
			renderPage(
				`<script src="${SIGNAL_URL}"></script><script>parent.parent.postMessage({ type: "pockode:page-link", href: "https://collector.example/?k=1" }, "*")</script>`,
			);
			const refused = await strip();
			await settle(PRESS_HOLD_MS + 100);
			await realUserEvent.click(
				within(refused).getByRole("button", { name: /^Load/ }),
			);
			await waitFor(() => expect(signals).toContain("script"), {
				timeout: 5000,
			});

			const asked = await strip();
			await waitFor(() =>
				expect(asked).toHaveTextContent("Link not opened · collector.example"),
			);
			expect(open).not.toHaveBeenCalled();
		});

		// An activation does not say which frame it came from, and Chromium
		// lets a page take the focus without one.
		it("is not opened on a tap in another frame", async () => {
			const open = vi.spyOn(window, "open").mockReturnValue(null);
			render(
				<>
					<HtmlFrame
						html={'<button style="width:100%;height:80px">Tap</button>'}
						title="Tapped"
						pageKey="tapped"
					/>
					<HtmlFrame
						html={`<input id="i"><script>setInterval(function(){ document.getElementById("i").focus(); parent.parent.postMessage({ type: "pockode:page-link", href: "https://collector.example/" }, "*"); }, 50)</script>`}
						title="Stealing"
						pageKey="stealing"
					/>
				</>,
			);
			await settle(500);
			const tapped = page.frameLocator(
				page.frameLocator(page.getByTitle("Tapped")).getByTitle("Tapped"),
			);

			await tapped.getByRole("button", { name: "Tap" }).click();
			await settle(1000);

			expect(open).not.toHaveBeenCalled();
			expect(await strip()).toHaveTextContent(
				"Link not opened · collector.example",
			);
		});

		it("asks first when the page follows one by script", async () => {
			const user = userEvent.setup();
			const open = vi.spyOn(window, "open").mockReturnValue(null);
			renderPage(
				`<a id="l" href="${LANDED_URL}">Docs</a><script>document.getElementById("l").click()</script>`,
			);

			const asked = await strip();
			expect(asked).toHaveTextContent(`Link not opened · ${OTHER_HOST}`);
			expect(open).not.toHaveBeenCalled();

			await settle(PRESS_HOLD_MS + 100);
			await user.click(
				within(asked).getByRole("button", {
					name: `Open link to ${OTHER_HOST}`,
				}),
			);
			expect(open).toHaveBeenCalledWith(
				LANDED_URL,
				"_blank",
				"noopener,noreferrer",
			);
			expect(signals).not.toContain("landed");
		});
	});
});
