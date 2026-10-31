import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "vitest/browser";
import { canvasActions, useCanvasStore } from "../../lib/canvasStore";
import { resetPageHosts } from "../../lib/pageHosts";
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
