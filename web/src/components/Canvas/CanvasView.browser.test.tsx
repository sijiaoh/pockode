import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server, userEvent } from "vitest/browser";
import { canvasActions, useCanvasStore } from "../../lib/canvasStore";
import { resetPageHosts } from "../../lib/pageHosts";
import {
	permissionRequestActions,
	usePermissionRequestStore,
} from "../../lib/permissionRequestStore";
import { hitAt } from "../../test/hitAt";
import {
	pageSignal,
	signals,
	startPageSignals,
	stopPageSignals,
} from "../../test/pageSignals";
import ResponsivePanel from "../ui/ResponsivePanel";
import { ComposerDock } from "./CanvasComposer";
import { CanvasView } from "./CanvasView";

/** A fractional width, as a real screen's layout often gives. */
const AREA = { width: 360.6, height: 480 };

/**
 * The canvas view in a column the size the bars leave it, with a field of the
 * app's own beside it standing in for the composer.
 */
function ui(area: { width: number; height: number }, shown = true) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<div style={{ ...area, display: "flex", flexDirection: "column" }}>
				<CanvasView
					sessionId="s1"
					shown={shown}
					turnRunning={false}
					onSend={async () => {}}
				/>
			</div>
			<input aria-label="Composer" />
		</QueryClientProvider>
	);
}

const keptSize = () => useCanvasStore.getState().size;

/** Long enough for a resize observer that would fire to have fired. */
const nextFrames = () =>
	new Promise((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(resolve)),
	);

describe("the canvas view in a real browser", () => {
	beforeEach(() => {
		useCanvasStore.setState({ sessionId: null, canvas: null, size: null });
		canvasActions.receive("s1", {
			revision: 1,
			html: "<p>drawn</p>",
			change: { kind: "render" },
		});
	});
	afterEach(() => {
		resetPageHosts();
	});

	it("fills the area it is given, and keeps its size in whole pixels", async () => {
		render(ui(AREA));
		const frame = await screen.findByTitle("Canvas");
		const box = frame.getBoundingClientRect();
		expect(box.width).toBeCloseTo(AREA.width, 0);
		expect(box.height).toBe(AREA.height);
		await waitFor(() =>
			expect(keptSize()).toEqual({ width: 360, height: 480 }),
		);
	});

	it("keeps no height change while a field has focus, and every width change", async () => {
		const { rerender } = render(ui(AREA));
		await waitFor(() =>
			expect(keptSize()).toEqual({ width: 360, height: 480 }),
		);

		// A keyboard coming up under the composer.
		act(() => screen.getByLabelText("Composer").focus());
		rerender(ui({ width: AREA.width, height: 200 }));
		await nextFrames();
		expect(keptSize()).toEqual({ width: 360, height: 480 });
		// A rotation with it still up.
		rerender(ui({ width: 640, height: 200 }));
		await waitFor(() =>
			expect(keptSize()).toEqual({ width: 640, height: 200 }),
		);

		// And with nothing focused, a height change is the area's own.
		act(() => screen.getByLabelText("Composer").blur());
		rerender(ui({ width: 640, height: 300 }));
		await waitFor(() =>
			expect(keptSize()).toEqual({ width: 640, height: 300 }),
		);
	});

	// The page focuses its own field: WebKit does not let a frame take the
	// focus without a press, which only Chromium's run can do without one.
	it.runIf(server.browser === "chromium")(
		"keeps no height change while a field in the page has focus",
		async () => {
			canvasActions.receive("s1", {
				revision: 2,
				html: '<input id="f"><script>addEventListener("load",function(){document.getElementById("f").focus()})</script>',
				change: { kind: "render" },
			});
			const { rerender } = render(ui(AREA));
			await waitFor(() =>
				expect(keptSize()).toEqual({ width: 360, height: 480 }),
			);
			// The page's field has the caret: the app sees only its frame.
			const frame = await screen.findByTitle("Canvas");
			await waitFor(() => expect(document.activeElement).toBe(frame), {
				timeout: 5000,
			});

			rerender(ui({ width: AREA.width, height: 200 }));
			await nextFrames();
			expect(keptSize()).toEqual({ width: 360, height: 480 });
		},
	);

	it("measures nothing while it is hidden", async () => {
		render(ui(AREA, false));
		await screen.findByTitle("Canvas");
		await nextFrames();
		expect(keptSize()).toBeNull();
	});
});

/** Says, from inside the page, that it has loaded, and each click it gets. */
const PAGE_CLICKS = `<p>drawn</p><script>addEventListener("load",function(){${pageSignal("'loaded'")}});document.addEventListener("click",function(){${pageSignal("'clicked'")}})</script>`;

/**
 * The canvas under the session header's details panel — a dropdown with no
 * backdrop, as above the expanded tier — with the composer floating over the
 * bottom of the canvas, as `ChatPanel` lays them out.
 */
function Covered({ initiallyOpen }: { initiallyOpen: boolean }) {
	const [open, setOpen] = useState(initiallyOpen);
	return (
		<QueryClientProvider client={new QueryClient()}>
			<div style={{ position: "relative" }}>
				<ResponsivePanel
					isOpen={open}
					onClose={() => setOpen(false)}
					title="Session details"
					isExpanded
					desktopPosition="left"
				>
					<p>Engine</p>
				</ResponsivePanel>
			</div>
			<div style={{ ...AREA, display: "flex", flexDirection: "column" }}>
				<CanvasView
					sessionId="s1"
					shown
					turnRunning={false}
					onSend={async () => {}}
				/>
				<ComposerDock floating open>
					<input aria-label="Composer" />
				</ComposerDock>
			</div>
		</QueryClientProvider>
	);
}

describe("the canvas frame while a layer covers the page", () => {
	beforeEach(() => {
		startPageSignals();
		usePermissionRequestStore.setState({
			sessionId: null,
			records: {},
			outcomes: {},
			unreadable: {},
		});
		useCanvasStore.setState({ sessionId: null, canvas: null, size: null });
		canvasActions.receive("s1", {
			revision: 1,
			html: PAGE_CLICKS,
			change: { kind: "render" },
		});
	});
	afterEach(() => {
		stopPageSignals();
		resetPageHosts();
	});

	it("takes a press over the canvas into the app, which closes the panel, and not into the page", async () => {
		render(<Covered initiallyOpen />);
		const frame = await screen.findByTitle("Canvas");
		await screen.findByRole("dialog", { name: "Session details" });
		// Listening already, so a press that got in would be heard.
		await waitFor(() => expect(signals).toEqual(["loaded"]), {
			timeout: 5000,
		});

		const hit = hitAt(frame);
		if (hit === null) throw new Error("nothing at the frame's middle");
		expect(hit).not.toBe(frame);
		expect(frame.parentElement?.contains(hit)).toBe(true);
		await userEvent.click(hit);

		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: "Session details" }),
			).toBeNull(),
		);
		// With nothing over it, a press reaches the page again.
		expect(hitAt(frame)).toBe(frame);
		await userEvent.click(frame);
		await waitFor(() => expect(signals).toEqual(["loaded", "clicked"]), {
			timeout: 5000,
		});
	});

	it("leaves the composer floating over the canvas within reach", async () => {
		render(<Covered initiallyOpen />);
		await screen.findByTitle("Canvas");
		const composer = screen.getByLabelText("Composer");
		expect(hitAt(composer)).toBe(composer);
	});

	// The panel registers itself as a layer, so the frame under it is
	// shielded too: the panel is drawn beside the frame, never under it.
	it("leaves the permission panel drawn over the canvas within reach", async () => {
		permissionRequestActions.reset("s1", [
			{
				requestId: "a",
				toolName: "Bash",
				toolInput: { command: "npm test" },
				toolUseId: "tool-a",
			},
		]);
		render(
			<QueryClientProvider client={new QueryClient()}>
				<div style={{ ...AREA, display: "flex", flexDirection: "column" }}>
					<CanvasView
						sessionId="s1"
						shown
						turnRunning={false}
						onSend={async () => {}}
						permissions={{
							turn: {
								phase: "blocked",
								open: true,
								since: "",
								blockers: [
									{ kind: "permission", request_id: "a", raised_at: "" },
								],
							},
							turnKnown: true,
							transcript: new Map(),
							isCodex: false,
							onRespond: () => {},
						}}
					/>
				</div>
			</QueryClientProvider>,
		);
		await screen.findByTitle("Canvas");
		const hide = await screen.findByRole("button", { name: /Hide/ });
		expect(hide.contains(hitAt(hide))).toBe(true);
	});

	it("is not shielded with nothing over the page", async () => {
		render(<Covered initiallyOpen={false} />);
		const frame = await screen.findByTitle("Canvas");
		expect(hitAt(frame)).toBe(frame);
	});
});
