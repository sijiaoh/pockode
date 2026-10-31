/// <reference types="@vitest/browser-playwright" />
// For `cdp()`: the provider is what types its protocol calls.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderUi, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, server } from "vitest/browser";
import type { CanvasReadOnly } from "../../lib/canvasBridge";
import { resetPageHosts } from "../../lib/pageHosts";
import type { CanvasActionInput } from "../../lib/rpc";
import type { RawTarget } from "../../lib/rpc/raw";
import { useWSStore, wsActions } from "../../lib/wsStore";
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
		it("keeps the size a page was drawn for, larger than the area, and scrolls to it", async () => {
			renderFrame({
				canvas: rendered(1, "<p>wide</p>", { width: 800, height: 1200 }),
			});
			const frame = await wrapper();

			// Never scaled: the frame is the drawn size, and the area scrolls.
			const box = frame.getBoundingClientRect();
			expect(box.width).toBe(800);
			expect(box.height).toBe(1200);
			if (!area) throw new Error("no canvas area");
			expect(area.clientWidth).toBeLessThanOrEqual(AREA.width);
			expect(area.scrollWidth).toBe(800);
			expect(area.scrollHeight).toBe(1200);
		});

		it("fills an area larger than the size the page was drawn for", async () => {
			renderFrame({
				canvas: rendered(1, "<p>narrow</p>", { width: 200, height: 100 }),
			});
			const box = (await wrapper()).getBoundingClientRect();
			expect(box.width).toBe(AREA.width);
			expect(box.height).toBe(AREA.height);
		});

		it("keeps the page's own scrolling inside the frame", async () => {
			renderFrame({
				canvas: rendered(
					1,
					`<div style="height:3000px"></div><script>addEventListener("load",function(){scrollTo(0,500);${signal("'scrolled '+scrollY")}})</script>`,
				),
			});
			await signalled("scrolled 500");
			if (!area) throw new Error("no canvas area");
			expect(area.scrollHeight).toBe(AREA.height);
			expect(area.scrollTop).toBe(0);
		});

		// A real touch drag, which only Chromium's protocol can make: a page
		// that cannot scroll itself hands the gesture to the area around it.
		it.runIf(server.browser === "chromium")(
			"scrolls the area with a touch drag over the frame",
			async () => {
				renderFrame({
					canvas: rendered(
						1,
						`<p>tall</p><script>addEventListener("load",function(){${signal("'loaded'")}})</script>`,
						{ width: 300, height: 1200 },
					),
				});
				const frame = await wrapper();
				await signalled("loaded");
				if (!area) throw new Error("no canvas area");
				await touchDrag(frame, 150);
				await waitFor(() => expect(area?.scrollTop).toBeGreaterThan(100));
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
});
