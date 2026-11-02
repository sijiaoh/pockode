import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionViewProvider } from "../../lib/sessionView";
import { useWSStore } from "../../lib/wsStore";
import { reportEverythingInView } from "../../test/imageFixtures";
import type { ToolRun } from "../../types/message";
import { FullScreenHost } from "./FullScreenHost";
import { HtmlRenderCard } from "./HtmlRenderCard";

const RUN = {
	id: "tool-page",
	name: "mcp__pockode__html_render",
	input: { title: "Latency report", html: "<h1>p99</h1>" },
	status: "success" as const,
};

describe("HtmlRenderCard full screen", () => {
	// A rendered page is out of find's reach, so find comes and goes with the
	// source — and never lingers out of sight to take the Escape that closes.
	it("offers find on the source alone, and Escape still closes after it", async () => {
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={new QueryClient()}>
				<FullScreenHost>
					<HtmlRenderCard run={RUN} sessionId="session-1" />
				</FullScreenHost>
			</QueryClientProvider>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open page in full screen" }),
		);
		const dialog = screen.getByRole("dialog", { name: "Latency report" });
		expect(within(dialog).getByTitle("Latency report")).toBeInTheDocument();
		expect(within(dialog).queryByRole("button", { name: "Find" })).toBeNull();

		const toggle = within(dialog).getByRole("button", { name: "Show source" });
		await user.click(toggle);
		expect(within(dialog).queryByTitle("Latency report")).toBeNull();
		await user.click(within(dialog).getByRole("button", { name: "Find" }));
		expect(
			within(dialog).getByRole("textbox", { name: "Find in page" }),
		).toBeInTheDocument();

		await user.click(toggle);
		expect(
			within(dialog).queryByRole("textbox", { name: "Find in page" }),
		).toBeNull();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});

describe("HtmlRenderCard page id", () => {
	const initialIntersectionObserver = globalThis.IntersectionObserver;
	const getHtmlPage = vi.fn();
	const sessionViewHtmlPage = vi.fn();
	const initialActions = useWSStore.getState().actions;

	beforeEach(() => {
		reportEverythingInView();
		useWSStore.setState({
			actions: { ...initialActions, getHtmlPage, sessionViewHtmlPage },
		});
	});

	afterEach(() => {
		globalThis.IntersectionObserver = initialIntersectionObserver;
		useWSStore.setState({ actions: initialActions });
		getHtmlPage.mockReset();
		sessionViewHtmlPage.mockReset();
	});

	function renderCard(run: ToolRun, wrap = (node: ReactNode) => node) {
		// `useHtmlPage` passes a `retry` of its own; only the backoff is taken
		// away, so a failure settles at once.
		const client = new QueryClient({
			defaultOptions: { queries: { retryDelay: 0 } },
		});
		return render(
			<QueryClientProvider client={client}>
				{wrap(<HtmlRenderCard run={run} sessionId="session-1" />)}
			</QueryClientProvider>,
		);
	}

	const EDIT: ToolRun = {
		id: "tool-edit",
		name: "pockode:html_edit",
		input: { base: "p2", edits: [{ old: "p99", new: "p50" }] },
		status: "success",
		htmlPage: "p3",
	};

	it("shows a render's id and draws it from its input", () => {
		renderCard({ ...RUN, htmlPage: "p1" });
		const card = screen.getByRole("region", { name: "Latency report" });
		expect(within(card).getByText("p1")).toBeInTheDocument();
		expect(within(card).getByTitle("Latency report")).toBeInTheDocument();
		expect(getHtmlPage).not.toHaveBeenCalled();
	});

	// The edit's input holds only the edits: the page is the server's.
	it("reads an edit's page by its id and names the page it came from", async () => {
		getHtmlPage.mockResolvedValue({
			id: "p3",
			title: "Latency (p50)",
			html: "<h1>p50</h1>",
			base: "p2",
			created_at: "2026-11-02T00:00:00Z",
		});
		renderCard(EDIT);
		expect(screen.getByRole("region", { name: "Loading page…" })).toBeVisible();
		// Nothing to show the source of or open yet.
		expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Open page in full screen" }),
		).toBeNull();

		const card = await screen.findByRole("region", { name: "Latency (p50)" });
		expect(getHtmlPage).toHaveBeenCalledWith("session-1", "p3");
		expect(within(card).getByText("p3 · from p2")).toBeInTheDocument();
		expect(within(card).getByTitle("Latency (p50)")).toBeInTheDocument();
	});

	it("reads an edit's page from the worktree a viewed transcript belongs to", async () => {
		sessionViewHtmlPage.mockResolvedValue({
			id: "p3",
			title: "Elsewhere",
			html: "<p>x</p>",
			created_at: "2026-11-02T00:00:00Z",
		});
		renderCard(EDIT, (node) => (
			<SessionViewProvider
				value={{ worktree: "old", exists: false, label: "old" }}
			>
				{node}
			</SessionViewProvider>
		));
		await screen.findByRole("region", { name: "Elsewhere" });
		expect(sessionViewHtmlPage).toHaveBeenCalledWith("old", "session-1", "p3");
		expect(getHtmlPage).not.toHaveBeenCalled();
	});

	it("says why an edit's page did not load, and reads it again on Retry", async () => {
		const user = userEvent.setup();
		// The server's verdict: final, so shown without a retry first.
		getHtmlPage.mockRejectedValue(
			new JSONRPCErrorException("page not found", -32602),
		);
		renderCard(EDIT);

		const alert = await screen.findByRole("alert", {}, { timeout: 10_000 });
		expect(alert).toHaveTextContent("Couldn't load page p3: page not found");
		expect(getHtmlPage).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();

		getHtmlPage.mockResolvedValue({
			id: "p3",
			title: "Back",
			html: "<p>ok</p>",
			created_at: "2026-11-02T00:00:00Z",
		});
		await user.click(within(alert).getByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("region", { name: "Back" }),
		).toBeInTheDocument();
	});

	it("tries a read the connection lost again by itself", async () => {
		getHtmlPage
			.mockRejectedValueOnce(new JSONRPCErrorException("Connection lost", 0))
			.mockResolvedValue({
				id: "p3",
				title: "Arrived",
				html: "<p>ok</p>",
				created_at: "2026-11-02T00:00:00Z",
			});
		renderCard(EDIT);
		expect(
			await screen.findByRole("region", { name: "Arrived" }),
		).toBeInTheDocument();
		expect(getHtmlPage).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
