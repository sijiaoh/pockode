import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { resetPageHosts, watchAppInput } from "../../lib/pageHosts";
import type { RawTarget } from "../../lib/rpc/raw";
import { useWSStore, wsActions } from "../../lib/wsStore";
import { otherHost } from "../../test/testServerHosts";
import { PRESS_HOLD_MS } from "../ui/PageHostsStrip";
import PagePreview from "./PagePreview";

// A workspace page, served by `/api/raw` as the server serves it — its policy,
// its sandbox, its reporter (`vitest.rawPages.ts`) — in real engines, where
// the policy is enforced. The same server under another name stands in for
// another host (`src/test/testServerHosts.ts`).
const OTHER_HOST = otherHost(location.port);
const LANDED_URL = `http://${OTHER_HOST}/src/test/page-hosts/landed.htm`;

let issued = 0;
/**
 * A capability as the stand-in server reads it: the hosts the real server
 * would bind to it, in its name (`vitest.rawPages.ts`).
 */
function capabilityPath(hosts: readonly string[]) {
	const named = hosts.map((host) => `~${host.replace(":", "_")}`).join("");
	return `/api/raw/c${++issued}${named}/`;
}

const rawCapability = vi.fn(async (target: RawTarget) => ({
	path: capabilityPath(target.page?.hosts ?? []),
	expiresAt: Date.now() + 60 * 60 * 1000,
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

function renderPage() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<div style={{ width: 480, height: 400, display: "flex" }}>
				<PagePreview
					origin={{ kind: "file", path: "site/page.htm" }}
					fileName="page.htm"
					mime="text/html; charset=utf-8"
					size={1024}
					content="<p>page</p>"
				/>
			</div>
		</QueryClientProvider>,
	);
}

function frame(within: HTMLElement = document.body) {
	const frames = [
		...within.querySelectorAll<HTMLIFrameElement>('iframe[title="page.htm"]'),
	];
	return frames[0];
}

/** Tells the page in `wrapper` to do something (see `site/page.htm`). */
function ask(wrapper: HTMLIFrameElement, what: Record<string, unknown>) {
	const page = wrapper.contentWindow?.[0];
	if (!page) throw new Error("the page is not up");
	page.postMessage(what, "*");
}

function strip() {
	return screen.findByRole(
		"group",
		{ name: "Hosts not loaded" },
		{ timeout: 5000 },
	);
}

/** Until the strip says `text`: it says what the page was refused first. */
async function stripSays(text: string) {
	await waitFor(
		() =>
			expect(
				screen.getByRole("group", { name: "Hosts not loaded" }),
			).toHaveTextContent(text),
		{ timeout: 5000 },
	);
}

/** Time for anything a page was going to do to have happened. */
function settle(ms = 1500) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Until the page has started, reporting what it was refused. */
async function started() {
	await waitFor(() => expect(signals).toContain("own"), { timeout: 5000 });
	return frame();
}

describe("a workspace page in a real browser", () => {
	beforeAll(watchAppInput);
	beforeEach(() => {
		issued = 0;
		signals = [];
		window.addEventListener("message", onSignal);
		useWSStore.setState({ status: "connected" });
		vi.spyOn(wsActions, "rawCapability").mockImplementation(rawCapability);
	});
	afterEach(() => {
		window.removeEventListener("message", onSignal);
		resetPageHosts();
		vi.restoreAllMocks();
		rawCapability.mockClear();
	});

	it("loads its own files and refuses another host until the reader loads it", async () => {
		const user = userEvent.setup();
		renderPage();

		const refused = await strip();
		expect(refused).toHaveTextContent(`Not loaded · ${OTHER_HOST}`);
		expect(signals).toEqual(["own"]);

		await settle(PRESS_HOLD_MS + 100);
		await user.click(
			within(refused).getByRole("button", {
				name: `Load ${OTHER_HOST} and reload the page`,
			}),
		);

		await waitFor(() => expect(signals).toContain("script"), {
			timeout: 5000,
		});
		expect(rawCapability).toHaveBeenLastCalledWith(
			expect.objectContaining({ page: { hosts: [OTHER_HOST] } }),
		);
		expect(screen.queryByRole("group")).toBeNull();
		// Where the Load was, not the top of the screen.
		expect(document.activeElement).toBe(frame());
	});

	it("follows a link inside its own directory in the frame", async () => {
		renderPage();
		const wrapper = await started();

		ask(wrapper, { click: "inside" });

		await waitFor(() => expect(signals).toContain("second"), {
			timeout: 5000,
		});
		expect(screen.queryByText(/Page left/)).toBeNull();
	});

	it("asks before opening a link out of its directory that no tap followed", async () => {
		const open = vi.spyOn(window, "open");
		renderPage();
		const wrapper = await started();

		ask(wrapper, { click: "outside" });

		await stripSays(`Link not opened · ${OTHER_HOST}`);
		expect(open).not.toHaveBeenCalled();
		await settle(500);
		expect(signals).not.toContain("landed");
	});

	// The Files page under the viewer: allowed there, it keeps the document the
	// reader left, and offers to reload into the allowance.
	it("leaves a frame behind as it was when the viewer loads the hosts", async () => {
		const user = userEvent.setup();
		renderPage();
		const inPlace = await started();
		await strip();

		await user.click(screen.getByRole("button", { name: "View full screen" }));
		const dialog = await screen.findByRole("dialog");
		await waitFor(
			() => expect(signals.filter((s) => s === "own")).toHaveLength(2),
			{
				timeout: 5000,
			},
		);
		await settle(PRESS_HOLD_MS + 100);
		await user.click(
			await within(dialog).findByRole(
				"button",
				{ name: `Load ${OTHER_HOST} and reload the page` },
				{ timeout: 5000 },
			),
		);
		await waitFor(() => expect(signals).toContain("script"), {
			timeout: 5000,
		});

		await user.click(within(dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(frame()).toBe(inPlace);
		expect(signals.filter((s) => s === "own")).toHaveLength(3);
		await stripSays(`Allowed · ${OTHER_HOST}`);

		await user.click(
			screen.getByRole("button", {
				name: `Reload the page to load ${OTHER_HOST}`,
			}),
		);
		await waitFor(
			() => expect(signals.filter((s) => s === "script")).toHaveLength(2),
			{ timeout: 5000 },
		);
		expect(screen.queryByRole("group")).toBeNull();
	});

	// What an allowed host serves as a document runs under no policy of ours,
	// and a CDN serves HTML anyone can publish: it is never framed.
	it("never frames a document from a host it has been allowed", async () => {
		const user = userEvent.setup();
		renderPage();
		const refused = await strip();
		await settle(PRESS_HOLD_MS + 100);
		await user.click(
			within(refused).getByRole("button", {
				name: `Load ${OTHER_HOST} and reload the page`,
			}),
		);
		await waitFor(() => expect(signals).toContain("script"), {
			timeout: 5000,
		});

		ask(frame(), { embed: LANDED_URL });

		await stripSays(`${OTHER_HOST} (allowed, still refused)`);
		await settle();
		expect(signals).not.toContain("landed");
	});

	// The allowance is the app's alone to grant. Whatever the page does, it
	// reaches no host, and the app is asked for no capability with hosts.
	describe("cannot be allowed anything by the page", () => {
		const granting = `/api/raw/c99~${OTHER_HOST.replace(":", "_")}/page.htm`;

		async function expectNothingAllowed() {
			await settle();
			expect(signals).not.toContain("script");
			expect(signals).not.toContain("landed");
			for (const [target] of rawCapability.mock.calls) {
				expect(target.page?.hosts).toEqual([]);
			}
		}

		it.each([
			["to another host", { go: LANDED_URL }],
			["to a capability that allows a host", { go: granting }],
			["by open(_self) to a capability that allows a host", { open: granting }],
		])("navigating itself %s", async (_, what) => {
			renderPage();
			const wrapper = await started();
			signals = [];

			ask(wrapper, what);

			await stripSays("Page left");
			await expectNothingAllowed();
			expect(signals).not.toContain("own");
		});

		// Refused by the page's own policy before its frame is asked to move.
		it("submitting a form to another host", async () => {
			renderPage();
			const wrapper = await started();
			signals = [];

			ask(wrapper, { submit: LANDED_URL });

			await expectNothingAllowed();
			expect(screen.queryByText(/Page left/)).toBeNull();
		});

		// Its own capability under any other URL is still its own, with its
		// policy: nothing a URL says is an allowance.
		it("navigating itself to its own capability with the hosts in the URL", async () => {
			renderPage();
			const wrapper = await started();
			signals = [];

			ask(wrapper, {
				go: `./page.htm?hosts=${OTHER_HOST}&host=${OTHER_HOST}`,
			});

			await waitFor(() => expect(signals).toContain("own"), {
				timeout: 5000,
			});
			await expectNothingAllowed();
		});

		it("posting what the app or its wrapper would say", async () => {
			renderPage();
			const wrapper = await started();
			signals = [];

			for (const post of [
				{ type: "pockode:page-navigate", url: `${location.origin}${granting}` },
				{ type: "pockode:page-loaded" },
				{ type: "pockode:page-left", url: LANDED_URL },
				{ type: "pockode:page-link", href: LANDED_URL },
				{
					type: "pockode:page-refused",
					url: LANDED_URL,
					directive: "script-src",
				},
				{ type: "pockode:page-allow", hosts: [OTHER_HOST] },
			]) {
				ask(wrapper, { post });
			}

			await expectNothingAllowed();
			expect(screen.queryByText(/Page left/)).toBeNull();
		});
	});
});
