import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { pagePolicy } from "../../lib/pageHosts";
import { AGENT_PAGE_SANDBOX, HTML_FRAME_SANDBOX, HtmlFrame } from "./HtmlFrame";

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

	describe("a page that sends", () => {
		function drawn(html: string, page?: string) {
			render(
				<HtmlFrame html={html} title="Page" pageKey="call" page={page} />,
				{ wrapper: withQueryClient },
			);
			const wrapper = screen.getByTitle<HTMLIFrameElement>("Page");
			return { wrapper, inner: pageFrame(wrapper) };
		}

		// Forms are how it sends; the floor's two forbidden tokens stay out.
		it("gets the bridge and forms, on both frames, and nothing more", () => {
			const { wrapper, inner } = drawn(
				'<button data-pk-send="go">Go</button>',
				"p3",
			);
			for (const frame of [wrapper, inner]) {
				expect(frame.getAttribute("sandbox")).toBe(AGENT_PAGE_SANDBOX);
				expect(sandboxTokens(frame)).not.toContain("allow-same-origin");
				expect(sandboxTokens(frame)).not.toContain("allow-modals");
			}
			expect(inner.srcdoc).toContain("window.pockode=");
		});

		it("is drawn as before when its HTML never names the bridge", () => {
			const { wrapper, inner } = drawn(
				"<form><button>Go</button></form>",
				"p3",
			);
			for (const frame of [wrapper, inner]) {
				expect(frame.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
			}
			expect(inner.srcdoc).not.toContain("window.pockode=");
		});

		// From before page ids: there is no page for a send to name.
		it("never sends without a page id, whatever its HTML says", () => {
			const { wrapper, inner } = drawn('<button data-pk-send="go">Go</button>');
			expect(wrapper.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
			expect(inner.srcdoc).not.toContain("window.pockode=");
		});
	});

	describe("the theme", () => {
		function drawn(html: string, page?: string) {
			render(
				<HtmlFrame html={html} title="Page" pageKey="call" page={page} />,
				{ wrapper: withQueryClient },
			);
			const wrapper = screen.getByTitle<HTMLIFrameElement>("Page");
			return { wrapper, inner: pageFrame(wrapper) };
		}
		const THEMED = "<style>body{color:var(--pk-text)}</style><p>Hi</p>";

		it("is drawn under the agent's markup in a page that names a variable, with no send", () => {
			const { wrapper, inner } = drawn(THEMED, "p3");
			const base = inner.srcdoc.indexOf("<style data-pockode-page-base=");
			expect(base).toBeGreaterThan(inner.srcdoc.indexOf("pockode:page-ready"));
			expect(base).toBeLessThan(inner.srcdoc.indexOf(THEMED));
			expect(inner.srcdoc).not.toContain("window.pockode=");
			// Following the theme is no reason for forms.
			expect(wrapper.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
			expect(wrapper.srcdoc).toContain("pockode:page-frame-scheme");
			expect(wrapper).toHaveClass("bg-th-bg-primary");
		});

		// Pages stored before the theme existed were written for white.
		it("leaves a page that names none exactly as before", () => {
			const { wrapper, inner } = drawn(
				"<style>:root{--pk-gap:4px}</style><p>Hi</p>",
				"p3",
			);
			expect(inner.srcdoc).not.toContain("data-pockode-page-base");
			expect(inner.srcdoc).not.toContain("pockode:page-ready");
			expect(wrapper.srcdoc).not.toContain("pockode:page-frame-scheme");
			expect(wrapper).toHaveClass("bg-white");
			expect(wrapper.style.colorScheme).toBe("light");
		});

		// Only sending needs a page id.
		it("is followed by a card from before page ids too", () => {
			const { inner } = drawn(THEMED);
			expect(inner.srcdoc).toContain("data-pockode-page-base");
		});
	});
});
