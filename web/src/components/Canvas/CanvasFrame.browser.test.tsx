/// <reference types="@vitest/browser-playwright" />
// For `cdp()`: the provider is what types its protocol calls.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderUi, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page, server, userEvent } from "vitest/browser";
import { pageWindowOf } from "../../lib/agentPage";
import type { CanvasReadOnly } from "../../lib/canvasBridge";
import { resetPageHosts } from "../../lib/pageHosts";
import type { CanvasActionInput } from "../../lib/rpc";
import type { RawTarget } from "../../lib/rpc/raw";
import { useWSStore, wsActions } from "../../lib/wsStore";
// Says, from inside the page, that a request to another host went through.
import landedPath from "../../test/page-hosts/landed.htm?url";
import { otherHost } from "../../test/testServerHosts";
import type { CanvasSize, CanvasState } from "../../types/canvas";
import { CanvasFrame } from "./CanvasFrame";

const AREA = { width: 360, height: 240 };
const HOUR = 60 * 60 * 1000;

let expiresIn = HOUR;
const rawCapability = vi.fn(async (_target: RawTarget) => ({
	path: "/api/raw/root/",
	expiresAt: Date.now() + expiresIn,
	worktree: "",
}));

/** Every `signal` a page posts the test, as it arrives. */
let signals: string[] = [];
function onSignal(event: MessageEvent) {
	const data: unknown = event.data;
	if (data && typeof data === "object" && "signal" in data) {
		signals.push(String(data.signal));
	}
}
const signal = (expression: string) =>
	`parent.parent.postMessage({signal:${expression}},'*')`;

async function signalled(...names: string[]) {
	await waitFor(() => expect(signals).toEqual(expect.arrayContaining(names)), {
		timeout: 5000,
	});
}

/**
 * A finger dragged up by `distance` from 200px into `element`, as real touch
 * input. The
 * test runs in a frame the runner scales into its own page, which is where
 * the protocol's coordinates are.
 */
async function touchDrag(element: Element, distance: number) {
	const runner = window.frameElement as HTMLElement | null;
	const outer = runner?.getBoundingClientRect();
	const scale = outer && runner ? outer.width / runner.offsetWidth : 1;
	const box = element.getBoundingClientRect();
	const x = (outer?.left ?? 0) + (box.left + 50) * scale;
	const y = (outer?.top ?? 0) + (box.top + 200) * scale;
	const session = cdp();
	await session.send("Emulation.setTouchEmulationEnabled", {
		enabled: true,
		maxTouchPoints: 1,
	});
	try {
		const at = (dy: number) => [{ x, y: y - dy * scale }];
		await session.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: at(0),
		});
		for (let step = 1; step <= 10; step++) {
			await session.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: at((distance * step) / 10),
			});
		}
		await session.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
	} finally {
		await session.send("Emulation.setTouchEmulationEnabled", {
			enabled: false,
		});
	}
}

function rendered(revision: number, html: string, drawnFor?: CanvasSize) {
	return {
		revision,
		html,
		change: { kind: "render" },
		...(drawnFor ? { drawn_for: drawnFor } : {}),
	} satisfies CanvasState;
}

interface FrameProps {
	canvas: CanvasState;
	onSend?: (input: CanvasActionInput) => Promise<void>;
	readOnly?: CanvasReadOnly;
}

function frameUi({ canvas, onSend = async () => {}, readOnly }: FrameProps) {
	return (
		<QueryClientProvider client={queryClient}>
			<div style={{ ...AREA, display: "flex", flexDirection: "column" }}>
				<CanvasFrame
					sessionId="s1"
					canvas={canvas}
					onSend={onSend}
					readOnly={readOnly}
					className="h-full"
					areaRef={(element) => {
						area = element;
					}}
				/>
			</div>
		</QueryClientProvider>
	);
}

let queryClient: QueryClient;
let area: HTMLDivElement | null = null;
let rerender: (ui: ReactElement) => void;

function renderFrame(props: FrameProps) {
	({ rerender } = renderUi(frameUi(props)));
}

function wrapper(): Promise<HTMLIFrameElement> {
	return screen.findByTitle("Canvas", undefined, { timeout: 5000 });
}

describe("the canvas frame in a real browser", () => {
	beforeEach(() => {
		signals = [];
		expiresIn = HOUR;
		queryClient = new QueryClient();
		window.addEventListener("message", onSignal);
		useWSStore.setState({ status: "connected", workDir: "/home/me/project" });
		vi.spyOn(wsActions, "rawCapability").mockImplementation(rawCapability);
	});
	afterEach(() => {
		window.removeEventListener("message", onSignal);
		useWSStore.setState({ status: "disconnected", workDir: "" });
		resetPageHosts();
		vi.restoreAllMocks();
		rawCapability.mockClear();
	});

	describe("size", () => {
		/** A page that says its own viewport's size at load and on every resize. */
		const SIZED = `<p>sized</p><script>function say(){${signal("'size '+innerWidth+'x'+innerHeight")}}addEventListener("load",say);addEventListener("resize",say)</script>`;

		// The area is the app's own document, which must never move a frame:
		// Chromium on some tablets drops the bars around the canvas while it
		// does (docs/canvas-ui.md §5). What is larger scrolls inside the frame.
		function expectAreaStill(frame: HTMLIFrameElement) {
			if (!area) throw new Error("no canvas area");
			expect(area.scrollWidth).toBe(area.clientWidth);
			expect(area.scrollHeight).toBe(area.clientHeight);
			const box = frame.getBoundingClientRect();
			const areaBox = area.getBoundingClientRect();
			expect(box.left).toBe(areaBox.left);
			expect(box.top).toBe(areaBox.top);
			expect(box.width).toBe(AREA.width);
			expect(box.height).toBe(AREA.height);
		}

		it("shows a page drawn for a larger screen at its size, scrolled inside the frame", async () => {
			renderFrame({
				canvas: rendered(1, SIZED, { width: 800, height: 1200 }),
			});
			const frame = await wrapper();
			// Never scaled: the page's own viewport is the drawn size.
			await signalled("size 800x1200");
			expectAreaStill(frame);
		});

		it("fills an area larger than the size the page was drawn for", async () => {
			renderFrame({
				canvas: rendered(1, SIZED, { width: 200, height: 100 }),
			});
			await signalled(`size ${AREA.width}x${AREA.height}`);
			expectAreaStill(await wrapper());
		});

		it("follows the size of a patched revision, keeping the page", async () => {
			const page = `${SIZED}<ul data-pk-region="r"><li>old</li></ul>`;
			renderFrame({
				canvas: rendered(1, page, { width: 800, height: 1200 }),
			});
			const before = await wrapper();
			await signalled("size 800x1200");

			rerender(
				frameUi({
					canvas: {
						revision: 2,
						html: page,
						drawn_for: { width: 500, height: 900 },
						change: {
							kind: "update",
							from_revision: 1,
							ops: [{ op: "replace", region: "r", html: "<li>new</li>" }],
						},
					},
				}),
			);
			await signalled("size 500x900");
			expect(await wrapper()).toBe(before);
			expectAreaStill(before);
		});

		it("keeps the page's own scrolling inside the frame", async () => {
			renderFrame({
				canvas: rendered(
					1,
					`<div style="height:3000px"></div><script>addEventListener("load",function(){scrollTo(0,500);${signal("'scrolled '+scrollY")}})</script>`,
				),
			});
			await signalled("scrolled 500");
			expectAreaStill(await wrapper());
		});

		// A real touch drag, which only Chromium's protocol can make: a page
		// that cannot scroll itself hands the gesture on — to the frame's own
		// scroller, never to the app's document.
		it.runIf(server.browser === "chromium")(
			"scrolls a page larger than the area inside the frame with a touch drag",
			async () => {
				renderFrame({
					canvas: rendered(
						1,
						// Seen against the screen, past every frame's clip.
						`<div id="top" style="height:40px">top</div><script>addEventListener("load",function(){new IntersectionObserver(function(es){${signal("es[0].isIntersecting?'top shown':'top hidden'")}}).observe(document.getElementById("top"))})</script>`,
						{ width: 300, height: 1200 },
					),
				});
				const frame = await wrapper();
				await signalled("top shown");
				await touchDrag(frame, 150);
				await signalled("top hidden");
				expectAreaStill(frame);
			},
		);
	});

	describe("redrawing", () => {
		const PAGE = `<input id="note"><ul data-pk-region="results"><li>old</li></ul>
<script>addEventListener("load",function(){document.getElementById("note").value="half typed";${signal("'loaded'")}})</script>`;
		const UPDATE: CanvasState = {
			revision: 2,
			html: "<p>whole revision 2</p>",
			change: {
				kind: "update",
				from_revision: 1,
				ops: [
					{
						op: "replace",
						region: "results",
						html: `<li>new</li><script>${signal("'kept '+document.getElementById('note').value+' · '+document.querySelector('[data-pk-region=results] li').textContent")}</script>`,
					},
				],
			},
		};

		it("patches an update in place, keeping what was typed outside the region", async () => {
			renderFrame({ canvas: rendered(1, PAGE) });
			const before = await wrapper();
			await signalled("loaded");

			rerender(frameUi({ canvas: UPDATE }));
			await signalled("kept half typed · new");
			expect(await wrapper()).toBe(before);
		});

		// Reloaded by its own script, the page is the revision it was drawn
		// with again: a send from it must not claim the patched one.
		it("draws whole a patched page that reloads itself", async () => {
			renderFrame({ canvas: rendered(1, PAGE) });
			const before = await wrapper();
			await signalled("loaded");

			const reloading: CanvasState = {
				...UPDATE,
				change: {
					kind: "update",
					from_revision: 1,
					ops: [
						{
							op: "replace",
							region: "results",
							html: `<script>${signal("'patched'")};setTimeout(function(){location.reload()},50)</script>`,
						},
					],
				},
			};
			rerender(frameUi({ canvas: reloading }));
			await signalled("patched");
			await waitFor(() => expect(screen.getByTitle("Canvas")).not.toBe(before));
			expect(screen.getByTitle<HTMLIFrameElement>("Canvas").srcdoc).toContain(
				"whole revision 2",
			);
		});

		it("draws an update whole once the capability is near its expiry", async () => {
			expiresIn = 60 * 1000;
			renderFrame({ canvas: rendered(1, PAGE) });
			const before = await wrapper();
			await signalled("loaded");

			rerender(frameUi({ canvas: UPDATE }));
			await waitFor(() => expect(screen.getByTitle("Canvas")).not.toBe(before));
			expect(screen.getByTitle<HTMLIFrameElement>("Canvas").srcdoc).toContain(
				"whole revision 2",
			);
			expect(signals.some((s) => s.startsWith("kept"))).toBe(false);
		});
	});

	describe("sending", () => {
		const SENDER = `<script>addEventListener("load",function(){pockode.send("pick",{id:3}).then(function(){${signal("'sent'")}},function(e){${signal("e.code+': '+e.message")}})})</script>`;

		it("sends with the revision the frame shows, and answers the page", async () => {
			const onSend = vi.fn(async (_input: CanvasActionInput) => {});
			renderFrame({ canvas: rendered(7, SENDER), onSend });
			await signalled("sent");
			expect(onSend).toHaveBeenCalledWith({
				action: "pick",
				data: { id: 3 },
				revision: 7,
			});
		});

		it("refuses every send from an earlier revision", async () => {
			const onSend = vi.fn(async () => {});
			renderFrame({ canvas: rendered(7, SENDER), onSend, readOnly: "earlier" });
			await signalled(
				"readonly: This is an earlier version of the canvas; it cannot send.",
			);
			expect(onSend).not.toHaveBeenCalled();
		});

		it("refuses every send from the current page shown in history, saying so", async () => {
			const onSend = vi.fn(async () => {});
			renderFrame({ canvas: rendered(7, SENDER), onSend, readOnly: "current" });
			await signalled(
				"readonly: This page is shown in history; close history to use it.",
			);
			expect(onSend).not.toHaveBeenCalled();
		});

		it("refuses a send while not connected", async () => {
			useWSStore.setState({ status: "disconnected" });
			renderFrame({ canvas: rendered(7, SENDER) });
			await signalled(
				"offline: Not connected — try again when the connection is back.",
			);
		});

		it("answers a send the server failed with its error", async () => {
			renderFrame({
				canvas: rendered(7, SENDER),
				onSend: async () => {
					throw new Error("the agent is gone");
				},
			});
			await signalled("failed: the agent is gone");
		});
	});

	// The forms the page submits, by the reader's own click and Enter in the
	// real sandboxed frame: submitted at all in Chromium only under the canvas
	// sandbox's `allow-forms`, and going nowhere by the policy's `form-action`.
	describe("forms", () => {
		const LANDED_URL = `http://${otherHost(location.port)}${landedPath}`;
		const LOADED = `<script>addEventListener("load",function(){${signal("'loaded'")}})</script>`;

		function pageFrame() {
			return page.frameLocator(
				page.frameLocator(page.getByTitle("Canvas")).getByTitle("Canvas"),
			);
		}

		/** Time for a navigation or a request that should not happen. */
		function settle(ms = 1500) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		const FORM = `<form data-pk-send="create">
<input name="title" aria-label="Title"><button name="as" value="urgent">Create</button>
</form>${LOADED}`;

		it("sends a sending form by its button", async () => {
			const onSend = vi.fn(async (_input: CanvasActionInput) => {});
			renderFrame({ canvas: rendered(3, FORM), onSend });
			await signalled("loaded");
			const frame = pageFrame();
			await frame.getByRole("textbox", { name: "Title" }).fill("Fix login");
			await frame.getByRole("button", { name: "Create" }).click();
			await waitFor(() =>
				expect(onSend).toHaveBeenCalledWith({
					action: "create",
					data: { title: "Fix login", as: "urgent" },
					revision: 3,
				}),
			);
		});

		it("sends a sending form by Enter in a field", async () => {
			const onSend = vi.fn(async (_input: CanvasActionInput) => {});
			renderFrame({ canvas: rendered(3, FORM), onSend });
			await signalled("loaded");
			const title = pageFrame().getByRole("textbox", { name: "Title" });
			await title.fill("Fix login");
			await userEvent.type(title, "{Enter}");
			await waitFor(() =>
				expect(onSend).toHaveBeenCalledWith({
					action: "create",
					data: { title: "Fix login", as: "urgent" },
					revision: 3,
				}),
			);
		});

		// Navigates nothing, so it is the one submission the bridge leaves to
		// the browser.
		it.each([
			// A field named "method" is what `form.method` would read.
			[
				"its form's method",
				'<form method="dialog"><input name="method" type="hidden" value="x"><button>Close</button></form>',
			],
			[
				"its button's",
				'<form><button formmethod="dialog">Close</button></form>',
			],
		])("closes a dialog by %s", async (_, form) => {
			renderFrame({
				canvas: rendered(
					1,
					`<dialog open>${form}</dialog>
<script>document.querySelector("dialog").addEventListener("close",function(){${signal("'closed'")}})</script>${LOADED}`,
				),
			});
			await signalled("loaded");
			await pageFrame().getByRole("button", { name: "Close" }).click();
			await signalled("closed");
		});

		// No submit event, so no bridge, and a window of its own, which the
		// wrapper's `frame-src` never sees: `form-action` alone holds it. With
		// an opener, so a popup that landed can tell the page, which relays it.
		it("opens nothing when the page submits a form into a new window by script", async () => {
			renderFrame({
				canvas: rendered(
					1,
					`<form action="${LANDED_URL}" target="_blank" rel="opener"></form>
<button onclick="document.forms[0].submit()">Open</button>
<script>addEventListener("message",function(e){if(e.data&&e.data.signal)parent.parent.postMessage(e.data,"*")})</script>${LOADED}`,
				),
			});
			await signalled("loaded");
			await pageFrame().getByRole("button", { name: "Open" }).click();
			await settle();
			expect(signals).not.toContain("landed");
		});

		it.each([
			// Chromium's `form-action` lets this one through, to `about:srcdoc`:
			// held by the bridge, after the page's own listener has run.
			["a plain form", ""],
			[
				"a form posting to another host",
				` action="${LANDED_URL}" method="post"`,
			],
			["a form getting another host", ` action="${LANDED_URL}"`],
		])("goes nowhere when %s submits", async (_, attributes) => {
			renderFrame({
				canvas: rendered(
					1,
					`<form${attributes}><input name="q" aria-label="Query"><button>Go</button></form>
<script>addEventListener("submit",function(e){${signal("'submitted, cancelled: '+e.defaultPrevented")}});
addEventListener("message",function(e){if(e.data==="query?")${signal("'query '+document.forms[0].q.value")}})</script>${LOADED}`,
				),
			});
			const before = await wrapper();
			await signalled("loaded");
			const frame = pageFrame();
			const query = frame.getByRole("textbox", { name: "Query" });
			await query.fill("typed");
			await frame.getByRole("button", { name: "Go" }).click();
			await signalled("submitted, cancelled: false");
			await settle();
			expect(signals).not.toContain("landed");
			// Loaded once: the frame was not navigated, not even to itself.
			expect(signals.filter((s) => s === "loaded")).toHaveLength(1);
			expect(screen.getByTitle("Canvas")).toBe(before);
			pageWindowOf(before)?.postMessage("query?", "*");
			await signalled("query typed");
		});
	});
});
