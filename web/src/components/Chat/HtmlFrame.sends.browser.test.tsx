import { useCoverPage } from "@pockode/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { JSONRPCErrorException } from "json-rpc-2.0";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { resetPageHosts } from "../../lib/pageHosts";
import { resetPageSends } from "../../lib/pageSends";
import { type SessionView, SessionViewProvider } from "../../lib/sessionView";
import { useWSStore } from "../../lib/wsStore";
import { HtmlFrame } from "./HtmlFrame";
import { PageSendContext, type PageSender } from "./pageSendContext";

// The app's side of a page's send, against real frames: a press in the page
// is a real activation in the page's own document, which nothing else can
// stand in for.

/** Every `signal` a page posts the test, as it arrives. */
let signals: string[] = [];
function onSignal(event: MessageEvent) {
	const data: unknown = event.data;
	if (data && typeof data === "object" && "signal" in data) {
		signals.push(String(data.signal));
	}
}

/** Posts the outcome of `pockode.send` to the test, as `ok` or `err:<code>`. */
const REPORT = `function report(p){p.then(function(){parent.parent.postMessage({signal:"ok"},"*");},function(e){parent.parent.postMessage({signal:"err:"+e.code},"*");});}`;

const BUTTON = `<button id="b" style="width:100%;height:60px" onclick="report(pockode.send('approve',{id:'42'}))">Approve</button><script>${REPORT}</script>`;

function renderPage(
	html: string,
	sender: Partial<PageSender> = {},
	{
		view = null,
		over = null,
	}: { view?: SessionView | null; over?: ReactNode } = {},
) {
	const value: PageSender = {
		send: vi.fn(async () => {}),
		awaitingPermission: false,
		...sender,
	};
	const ui = (layer: ReactNode) => (
		<QueryClientProvider client={new QueryClient()}>
			<SessionViewProvider value={view}>
				<PageSendContext value={value}>
					<HtmlFrame
						html={html}
						title="Page"
						pageKey="call-1"
						page="p3"
						boxStyle={{ height: 120 }}
					/>
					{layer}
				</PageSendContext>
			</SessionViewProvider>
		</QueryClientProvider>
	);
	const { rerender } = render(ui(over));
	return { ...value, rerender: (layer: ReactNode) => rerender(ui(layer)) };
}

function inner() {
	return page.frameLocator(
		page.frameLocator(page.getByTitle("Page")).getByTitle("Page"),
	);
}

/** A layer of the app's own with no backdrop, as a dropdown is. */
function Layer() {
	useCoverPage(true, { onBack: () => {} });
	return null;
}

/** What a press at the middle of the page's frame lands on. */
function underPress(): Element | null {
	const box = screen.getByTitle("Page").getBoundingClientRect();
	return document.elementFromPoint(
		box.left + box.width / 2,
		box.top + box.height / 2,
	);
}

async function press() {
	await inner().getByRole("button", { name: "Approve" }).click();
}

describe("a page that sends", () => {
	beforeEach(() => {
		signals = [];
		window.addEventListener("message", onSignal);
		useWSStore.setState({ status: "connected" });
	});
	afterEach(() => {
		window.removeEventListener("message", onSignal);
		useWSStore.setState({ status: "disconnected" });
		resetPageHosts();
		resetPageSends();
	});

	it("sends a press as the card's page, and says it was sent", async () => {
		const sender = renderPage(BUTTON);
		await press();

		await waitFor(() => expect(signals).toContain("ok"), { timeout: 5000 });
		expect(sender.send).toHaveBeenCalledWith({
			page: "p3",
			action: "approve",
			data: { id: "42" },
		});
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent('Sent "approve"'),
		);
	});

	it("refuses a send before the reader used the page, quietly", async () => {
		const sender = renderPage(
			`<p>Hi</p><script>${REPORT}report(pockode.send('refresh'))</script>`,
		);

		await waitFor(() => expect(signals).toContain("err:inactive"), {
			timeout: 5000,
		});
		expect(sender.send).not.toHaveBeenCalled();
		const line = await screen.findByText(
			'Not sent · "refresh" — the page tried to send before you used it',
		);
		expect(line.closest("[role]")).toBeNull();
	});

	it("refuses a press while a permission request is open, as an alert", async () => {
		const sender = renderPage(BUTTON, { awaitingPermission: true });
		await press();

		await waitFor(() => expect(signals).toContain("err:awaiting"), {
			timeout: 5000,
		});
		expect(sender.send).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				'Not sent · "approve" — Answer the permission request first.',
			),
		);
	});

	it("tells the server's permission refusal apart by its reason", async () => {
		renderPage(BUTTON, {
			send: vi.fn(async () => {
				throw new JSONRPCErrorException("turn awaits an answer", -32602, {
					reason: "awaiting_permission",
				});
			}),
		});
		await press();

		await waitFor(() => expect(signals).toContain("err:awaiting"), {
			timeout: 5000,
		});
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Answer the permission request first.",
			),
		);
	});

	it("passes any other refusal on in the server's words", async () => {
		renderPage(BUTTON, {
			send: vi.fn(async () => {
				throw new JSONRPCErrorException("page p3 does not exist", -32602);
			}),
		});
		await press();

		await waitFor(() => expect(signals).toContain("err:invalid"), {
			timeout: 5000,
		});
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				'Not sent · "approve" — page p3 does not exist',
			),
		);
	});

	it("refuses offline without calling the server", async () => {
		useWSStore.setState({ status: "disconnected" });
		const sender = renderPage(BUTTON);
		await press();

		await waitFor(() => expect(signals).toContain("err:offline"), {
			timeout: 5000,
		});
		expect(sender.send).not.toHaveBeenCalled();
	});

	// `allow-forms` lets a plain form submit; the bridge's cancel is what
	// keeps it from reloading the page into itself.
	it("keeps a plain form from reloading the page", async () => {
		renderPage(
			`<form><input name="q"><button>Go</button></form><button data-pk-send="x">X</button><script>parent.parent.postMessage({signal:"loaded"},"*")</script>`,
		);
		await waitFor(() => expect(signals).toContain("loaded"), {
			timeout: 5000,
		});
		await inner().getByRole("button", { name: "Go" }).click();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(signals.filter((s) => s === "loaded")).toHaveLength(1);
	});

	it("refuses every send from a session read from another worktree", async () => {
		const sender = renderPage(
			BUTTON,
			{},
			{
				view: { worktree: "other", exists: true, label: "other" },
			},
		);
		await press();

		await waitFor(() => expect(signals).toContain("err:readonly"), {
			timeout: 5000,
		});
		expect(sender.send).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"This session is read-only here.",
			),
		);
	});

	// A press meant to put a backdrop-less layer away must land in the app's
	// document, never in a page that could send on it.
	it("is shielded while a layer is drawn over it, and only then", async () => {
		const view = renderPage(BUTTON);
		await waitFor(() => expect(underPress()).toBe(screen.getByTitle("Page")));
		view.rerender(<Layer />);
		await waitFor(() =>
			expect(underPress()).not.toBe(screen.getByTitle("Page")),
		);
		expect(underPress()?.getAttribute("aria-hidden")).toBe("true");
		view.rerender(null);
		await waitFor(() => expect(underPress()).toBe(screen.getByTitle("Page")));
	});

	it("is not shielded when it cannot send", async () => {
		renderPage("<button>Plain</button>", {}, { over: <Layer /> });
		await waitFor(() => expect(underPress()).toBe(screen.getByTitle("Page")));
	});
});
