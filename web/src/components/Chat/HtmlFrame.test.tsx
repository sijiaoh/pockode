import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { pagePolicy } from "../../lib/pageHosts";
import { HTML_FRAME_SANDBOX, HtmlFrame } from "./HtmlFrame";

function sandboxTokens(frame: Element): string[] {
	return frame.getAttribute("sandbox")?.split(/\s+/) ?? [];
}

/** The frame the page itself is drawn in, inside the wrapper document. */
function pageFrame(wrapper: HTMLIFrameElement): HTMLIFrameElement {
	const inner = new DOMParser()
		.parseFromString(wrapper.srcdoc, "text/html")
		.querySelector("iframe");
	if (!inner) throw new Error("no page frame in the wrapper");
	return inner;
}

// Offline, as the WebSocket starts in tests: drawn at once, with no capability
// for the project to wait for.
const withQueryClient = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>
		{children}
	</QueryClientProvider>
);

describe("HtmlFrame", () => {
	// The card and the full screen viewer both draw a page through this frame,
	// so this is the one place the security floor is held.
	it("lets scripts and popups run, and never same-origin or modals", () => {
		render(<HtmlFrame html="<p>hi</p>" title="Page" pageKey="call" />, {
			wrapper: withQueryClient,
		});
		const wrapper = screen.getByTitle<HTMLIFrameElement>("Page");

		for (const frame of [wrapper, pageFrame(wrapper)]) {
			const tokens = sandboxTokens(frame);
			expect(tokens).not.toContain("allow-same-origin");
			expect(tokens).not.toContain("allow-modals");
			expect(tokens).toEqual(
				expect.arrayContaining([
					"allow-scripts",
					"allow-popups",
					"allow-popups-to-escape-sandbox",
				]),
			);
		}
		expect(wrapper.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
	});

	// Before anything the agent wrote, so nothing it wrote — a doctype, a
	// comment, a script — is parsed or run outside the policy.
	it("puts the policy at the very start of the page, in its wrapper too", () => {
		render(
			<HtmlFrame
				html={'<!doctype html><script src="https://cdn.example/x.js"></script>'}
				title="Page"
				pageKey="call"
			/>,
			{ wrapper: withQueryClient },
		);
		const wrapper = screen.getByTitle<HTMLIFrameElement>("Page");
		const meta = `<meta http-equiv="Content-Security-Policy" content="${pagePolicy([])}">`;

		expect(wrapper.srcdoc.startsWith(meta)).toBe(true);
		expect(pageFrame(wrapper).srcdoc.startsWith(meta)).toBe(true);
	});
});
