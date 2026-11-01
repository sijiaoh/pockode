import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { CANVAS_FRAME_SANDBOX } from "../../lib/agentPage";
import { pageFrameOf } from "../../test/pageFrame";
import { CanvasFrame } from "./CanvasFrame";

// Offline, as the WebSocket starts in tests: drawn at once, with no capability
// for the project to wait for.
const withQueryClient = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>
		{children}
	</QueryClientProvider>
);

const AGENT = '<!doctype html><p id="agent">drawn</p>';

describe("CanvasFrame", () => {
	it("draws the page in the canvas's sandbox, policy first and the bridge before the agent's markup", async () => {
		render(
			<CanvasFrame
				sessionId="s1"
				canvas={{ revision: 1, html: AGENT, change: { kind: "render" } }}
				onSend={async () => {}}
			/>,
			{ wrapper: withQueryClient },
		);
		const wrapper = await screen.findByTitle<HTMLIFrameElement>("Canvas");
		const page = pageFrameOf(wrapper);
		expect(wrapper.getAttribute("sandbox")).toBe(CANVAS_FRAME_SANDBOX);
		expect(page.getAttribute("sandbox")).toBe(CANVAS_FRAME_SANDBOX);

		const doc = page.getAttribute("srcdoc") ?? "";
		expect(doc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(
			true,
		);
		const reporter = doc.indexOf("pockode:page-refused");
		const bridge = doc.indexOf("window.pockode=");
		const base = doc.indexOf("<style data-pockode-canvas-base>");
		const agent = doc.indexOf(AGENT);
		expect(reporter).toBeGreaterThan(0);
		expect(bridge).toBeGreaterThan(reporter);
		expect(base).toBeGreaterThan(bridge);
		expect(agent).toBeGreaterThan(base);
	});

	it("draws no page before anything is drawn", () => {
		render(
			<CanvasFrame
				sessionId="s1"
				canvas={{ revision: 0 }}
				onSend={async () => {}}
			/>,
			{ wrapper: withQueryClient },
		);
		expect(screen.queryByTitle("Canvas")).toBeNull();
	});
});
