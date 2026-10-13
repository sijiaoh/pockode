import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

function renderMarkdown(content: string) {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<div style={{ width: 480 }}>
				<MarkdownContent content={content} />
			</div>
		</QueryClientProvider>,
	);
}

function frame(): HTMLIFrameElement {
	return screen.getByTitle("Mermaid diagram");
}

function policyOf(element: HTMLIFrameElement): string {
	return (
		new DOMParser()
			.parseFromString(element.srcdoc, "text/html")
			.querySelector('meta[http-equiv="Content-Security-Policy"]')
			?.getAttribute("content") ?? ""
	);
}

// Real Mermaid in a real frame: what jsdom cannot do is enforce the frame's
// policy, which is the whole guarantee.
describe("a Mermaid diagram in a real browser", () => {
	it("draws inside its frame, sized to the diagram", async () => {
		renderMarkdown("```mermaid\nflowchart TD\n  A[Start] --> B[Done]\n```");

		await waitFor(
			() => expect(frame().getBoundingClientRect().height).toBeGreaterThan(40),
			{ timeout: 20_000 },
		);
	});

	it("refuses an external image until the reader loads it, then lets that host through", async () => {
		const user = userEvent.setup();
		renderMarkdown(
			"```mermaid\nflowchart LR\n  A[\"<img src='https://img.example/p.png'> Logo\"] --> B\n```",
		);

		// The browser enforced the frame's policy: it reported refusing the
		// request — rather than making it — and the page offers to load it.
		const load = await screen.findByRole(
			"button",
			{ name: "Load diagram images from img.example" },
			{ timeout: 20_000 },
		);
		expect(policyOf(frame())).toContain("img-src data:;");
		expect(frame().getBoundingClientRect().height).toBeGreaterThan(0);

		await user.click(load);

		expect(policyOf(frame())).toContain(
			"img-src data: http://img.example https://img.example;",
		);
		// A new document under that policy, drawn by Mermaid in turn.
		expect(screen.getByText("Loading diagram...")).toBeInTheDocument();
		await waitFor(
			() => expect(screen.queryByText("Loading diagram...")).toBeNull(),
			{ timeout: 20_000 },
		);
		expect(frame().getBoundingClientRect().height).toBeGreaterThan(0);
	});
});
