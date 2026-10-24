import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateWorkspaceCapabilities } from "../../hooks/useRawMediaSource";
import { apiUrl } from "../../lib/api";
import { saveUrl } from "../../lib/fileDownload";
import { navigateWrapper } from "../../lib/pageHosts";
import { useWSStore, wsActions } from "../../lib/wsStore";
import { reportEverythingInView } from "../../test/imageFixtures";
import { pageFrameOf, pageLoaded, pageUrlOf } from "../../test/pageFrame";
import type { TreeOrigin } from "../../types/contents";
import { HTML_FRAME_SANDBOX } from "../Chat/HtmlFrame";
import PagePreview from "./PagePreview";

vi.mock("../../lib/fileDownload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/fileDownload")>()),
	saveUrl: vi.fn(),
}));
vi.mock("../../lib/pageHosts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/pageHosts")>()),
	navigateWrapper: vi.fn(),
}));

let issued = 0;
const rawCapability = vi.fn(async ({ scope }: { scope: "file" | "root" }) => ({
	path:
		scope === "root"
			? `/api/raw/cap${++issued}/`
			: `/api/raw/cap${++issued}/index.html`,
	expiresAt: Date.now() + 4 * 60 * 60 * 1000,
	worktree: "",
}));

function renderPage(
	origin: TreeOrigin = { kind: "file", path: "index.html" },
	revision: unknown = "v1",
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const page = (rev: unknown) => (
		<QueryClientProvider client={queryClient}>
			<PagePreview
				origin={origin}
				fileName={origin.path.split("/").pop() ?? ""}
				mime="text/html; charset=utf-8"
				size={2048}
				revision={rev}
			/>
		</QueryClientProvider>
	);
	const result = render(page(revision));
	return {
		queryClient,
		rerender: (rev: unknown) => result.rerender(page(rev)),
	};
}

function frame() {
	return screen.findByTitle<HTMLIFrameElement>(/\.html$/);
}

/** The capability the frame loads from. */
function capabilityOf(wrapper: HTMLIFrameElement) {
	return pageUrlOf(wrapper)?.match(/cap\d+/)?.[0];
}

/**
 * Every load the app has a wrapper make of its page — a navigation of the
 * same frame, unlike a new wrapper, which is drawn with its page.
 */
function spyOnNavigation() {
	const navigate = vi.mocked(navigateWrapper);
	navigate.mockClear();
	return navigate;
}

/** Which wrappers were told to load their page again, in order. */
function navigatedFrames(navigate: ReturnType<typeof spyOnNavigation>) {
	return navigate.mock.calls.map(([wrapper]) => wrapper);
}

function stubProbe(...responses: Response[]) {
	const fetchMock = vi.fn(
		async () => responses.shift() ?? new Response("x", { status: 206 }),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function dead() {
	return Response.json(
		{ error: "capability is unknown", code: "capability_not_found" },
		{ status: 404 },
	);
}

describe("PagePreview", () => {
	beforeEach(() => {
		issued = 0;
		reportEverythingInView();
		useWSStore.setState({ status: "connected" });
		vi.spyOn(wsActions, "rawCapability").mockImplementation(rawCapability);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rawCapability.mockClear();
	});

	it("loads the page at its path under the root in a sandboxed frame", async () => {
		stubProbe();
		renderPage({ kind: "file", path: "reports/cov erage/index.html" });

		const element = await frame();
		expect(rawCapability).toHaveBeenCalledWith({
			origin: { kind: "file" },
			scope: "root",
			page: { hosts: [] },
		});
		expect(pageUrlOf(element)).toBe(
			apiUrl("/api/raw/cap1/reports/cov%20erage/index.html"),
		);
		// The page and the wrapper holding it to its capability: the sandbox on
		// both, and the page's own policy is the server's.
		expect(element.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
		expect(pageFrameOf(element).getAttribute("sandbox")).toBe(
			HTML_FRAME_SANDBOX,
		);
		expect(pageFrameOf(element).getAttribute("referrerpolicy")).toBe(
			"no-referrer",
		);
		expect(screen.getByText("HTML · 2 KB")).toBeInTheDocument();
	});

	// A build in a dot folder loads its own assets like any other page.
	it("loads a page in a dot folder through the root, with nothing to say", async () => {
		stubProbe();
		renderPage({ kind: "file", path: "docs/.vitepress/dist/index.html" });

		const element = await frame();
		expect(rawCapability).toHaveBeenCalledWith({
			origin: { kind: "file" },
			scope: "root",
			page: { hosts: [] },
		});
		expect(pageUrlOf(element)).toBe(
			apiUrl("/api/raw/cap1/docs/.vitepress/dist/index.html"),
		);
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});

	// What the frame may navigate to is the root, not the page's folder, so a
	// `../` reference stays under the capability.
	it("holds a page's `../` references under its capability", async () => {
		stubProbe();
		renderPage({ kind: "file", path: "docs/site/index.html" });

		const element = await frame();
		const policy =
			new DOMParser()
				.parseFromString(element.srcdoc, "text/html")
				.querySelector('meta[http-equiv="Content-Security-Policy"]')
				?.getAttribute("content") ?? "";
		const root = apiUrl("/api/raw/cap1/");
		expect(policy).toContain(`frame-src ${root}`);
		expect(new URL("../shared/style.css", pageUrlOf(element) ?? "").href).toBe(
			`${root}docs/shared/style.css`,
		);
	});

	it("asks for the commit's root for a page in a commit", async () => {
		stubProbe();
		renderPage({ kind: "commit", hash: "abc", path: "site/index.html" });

		const element = await frame();
		expect(rawCapability).toHaveBeenCalledWith({
			origin: { kind: "commit", hash: "abc" },
			scope: "root",
			page: { hosts: [] },
		});
		expect(pageUrlOf(element)).toBe(apiUrl("/api/raw/cap1/site/index.html"));
	});

	it("shows a page the root does not reach as a failure", async () => {
		stubProbe(
			Response.json(
				{ error: "outside the capability's scope", code: "outside_scope" },
				{ status: 403 },
			),
		);
		renderPage({ kind: "file", path: "site/index.html" });

		pageLoaded(await frame());
		expect(await screen.findByText("Couldn't load page")).toBeInTheDocument();
		expect(
			screen.getByText(/Pages can't be shown from here/),
		).toBeInTheDocument();
		expect(rawCapability).toHaveBeenCalledTimes(1);
	});

	it("checks the page's first load with one byte, and nothing it navigates to", async () => {
		const fetchMock = stubProbe();
		renderPage();

		const element = await frame();
		pageLoaded(element);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			apiUrl("/api/raw/cap1/index.html"),
			expect.objectContaining({ headers: { Range: "bytes=0-0" } }),
		);

		pageLoaded(element);
		await act(async () => {});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// Another capability is another wrapper: the one before holds its page to
	// the capability it was drawn for.
	it("renews a dead capability once, silently", async () => {
		stubProbe(dead());
		renderPage();

		pageLoaded(await frame());
		await vi.waitFor(async () =>
			expect(capabilityOf(await frame())).toBe("cap2"),
		);
		expect(screen.queryByText("Couldn't load page")).not.toBeInTheDocument();
	});

	it("shows the failure when a renewed capability dies again", async () => {
		stubProbe(dead(), dead());
		renderPage();

		pageLoaded(await frame());
		await vi.waitFor(async () =>
			expect(capabilityOf(await frame())).toBe("cap2"),
		);
		pageLoaded(await frame());

		expect(await screen.findByText("Couldn't load page")).toBeInTheDocument();
		expect(screen.queryByTitle("index.html")).not.toBeInTheDocument();

		// Retry starts over on yet another capability — and until it has one,
		// shows no frame, which would load the URL that just failed.
		let issue = () => {};
		rawCapability.mockImplementationOnce(
			(target) =>
				new Promise((resolve) => {
					issue = () => resolve(rawCapability(target));
				}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(screen.queryByTitle("index.html")).not.toBeInTheDocument();
		expect(screen.queryByText("Couldn't load page")).not.toBeInTheDocument();
		act(() => issue());
		expect(capabilityOf(await frame())).toBe("cap3");
	});

	it("renews again for an edit that cuts in on a renewal", async () => {
		stubProbe(dead());
		const { rerender } = renderPage(undefined, "v1");
		const element = await frame();
		let issue = () => {};
		rawCapability.mockImplementationOnce(
			(target) =>
				new Promise((resolve) => {
					issue = () => resolve(rawCapability(target));
				}),
		);
		pageLoaded(element);
		await vi.waitFor(() => expect(rawCapability).toHaveBeenCalledTimes(2));

		// The cached capability is the dead one, and still fresh by its expiry.
		rerender("v2");
		await act(async () => issue());
		await vi.waitFor(async () =>
			expect(capabilityOf(await frame())).not.toBe("cap1"),
		);
	});

	it("says the file is gone when the server no longer has it", async () => {
		stubProbe(Response.json({ code: "not_found" }, { status: 404 }));
		renderPage();

		pageLoaded(await frame());
		expect(await screen.findByText("File not found")).toBeInTheDocument();
	});

	it("keeps a loaded page on the URL it loaded with when the capability is renewed elsewhere", async () => {
		stubProbe();
		const { queryClient } = renderPage();
		const element = await frame();
		pageLoaded(element);

		await act(() =>
			queryClient.refetchQueries({ queryKey: ["raw-capability"] }),
		);
		expect(rawCapability).toHaveBeenCalledTimes(2);
		expect(await frame()).toBe(element);
		expect(capabilityOf(element)).toBe("cap1");
	});

	it("does not reload a page when renewing its capability fails and then succeeds", async () => {
		stubProbe();
		const { queryClient } = renderPage();
		const element = await frame();
		pageLoaded(element);

		rawCapability.mockRejectedValueOnce(new Error("relay down"));
		await act(() =>
			queryClient
				.refetchQueries({ queryKey: ["raw-capability"] })
				.catch(() => {}),
		);
		await act(() =>
			queryClient.refetchQueries({ queryKey: ["raw-capability"] }),
		);
		expect(rawCapability).toHaveBeenCalledTimes(3);
		expect(await frame()).toBe(element);
		expect(capabilityOf(element)).toBe("cap1");
	});

	it("loads the page again once a worktree switch has landed", async () => {
		stubProbe();
		const { queryClient } = renderPage();
		const element = await frame();
		pageLoaded(element);
		const navigated = spyOnNavigation();

		await act(() => invalidateWorkspaceCapabilities(queryClient));

		await vi.waitFor(async () =>
			expect(capabilityOf(await frame())).toBe("cap2"),
		);
		// A new wrapper, drawn with its page; nothing loaded it a second time.
		expect(await frame()).not.toBe(element);
		expect(navigated).not.toHaveBeenCalled();
	});

	// The same frame, so Back steps back through the reload as through a link
	// followed in the page; a new frame would leave the old one's pages behind
	// in the history as entries Back cannot show.
	it("shows no frame from the worktree left while Retry asks again after a switch", async () => {
		stubProbe();
		const { queryClient } = renderPage();
		pageLoaded(await frame());

		rawCapability.mockRejectedValueOnce(new Error("relay down"));
		await act(() =>
			invalidateWorkspaceCapabilities(queryClient).catch(() => {}),
		);
		expect(await screen.findByText("Couldn't load page")).toBeInTheDocument();

		let issue = () => {};
		rawCapability.mockImplementationOnce(
			(target) =>
				new Promise((resolve) => {
					issue = () => resolve(rawCapability(target));
				}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(screen.queryByTitle("index.html")).not.toBeInTheDocument();
		act(() => issue());
		expect(capabilityOf(await frame())).toBe("cap2");
	});

	it("reloads the page from its entry URL on Reload, on the same frame", async () => {
		stubProbe();
		renderPage();
		const element = await frame();
		pageLoaded(element);
		const navigated = spyOnNavigation();

		await userEvent.click(screen.getByRole("button", { name: "Reload page" }));
		// The capability was still fresh: nothing new was asked for.
		await vi.waitFor(() =>
			expect(navigated).toHaveBeenCalledWith(
				element,
				apiUrl("/api/raw/cap1/index.html"),
			),
		);
		expect(navigated).toHaveBeenCalledTimes(1);
		expect(await frame()).toBe(element);
		expect(rawCapability).toHaveBeenCalledTimes(1);
	});

	it("finishes a reload whose frame's earlier load lands before it renders", async () => {
		stubProbe();
		renderPage();
		const element = await frame();
		const navigated = spyOnNavigation();
		const reload = screen.getByRole("button", { name: "Reload page" });

		// One act, so the reload's `busy` has not rendered when the first
		// load's event arrives.
		act(() => {
			fireEvent.click(reload);
			pageLoaded(element);
		});
		await vi.waitFor(() => expect(navigated).toHaveBeenCalledTimes(1));
		pageLoaded(element);
		await vi.waitFor(() =>
			expect(reload.querySelector("svg")).not.toHaveClass("animate-spin"),
		);
	});

	it("reloads when the page's content changes, and only then", async () => {
		stubProbe();
		const { rerender } = renderPage(undefined, "v1");
		const element = await frame();
		pageLoaded(element);
		const navigated = spyOnNavigation();

		rerender("v1");
		await act(async () => {});
		expect(navigated).not.toHaveBeenCalled();

		rerender("v2");
		await vi.waitFor(() => expect(navigated).toHaveBeenCalledTimes(1));
		expect(await frame()).toBe(element);
	});

	describe("full screen", () => {
		it("opens the page in the viewer through the same capability, leaving this frame in place", async () => {
			stubProbe();
			const user = userEvent.setup();
			renderPage();
			const inPlace = await frame();

			await user.click(
				await screen.findByRole("button", { name: "View full screen" }),
			);
			const dialog = await screen.findByRole("dialog");
			const staged =
				await within(dialog).findByTitle<HTMLIFrameElement>("index.html");
			expect(staged).not.toBe(inPlace);
			expect(inPlace).toBeInTheDocument();
			expect(pageUrlOf(staged)).toBe(pageUrlOf(inPlace));
			expect(staged.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
			expect(rawCapability).toHaveBeenCalledOnce();
			expect(within(dialog).getByText("HTML · 2 KB")).toBeInTheDocument();
			expect(
				within(dialog).getByRole("button", { name: "Reload page" }),
			).toBeInTheDocument();
			expect(
				within(dialog).queryByRole("button", { name: "Open in Files" }),
			).not.toBeInTheDocument();
		});

		it("saves the page from the URL the viewer loaded it from", async () => {
			stubProbe();
			const user = userEvent.setup();
			renderPage();
			await user.click(
				await screen.findByRole("button", { name: "View full screen" }),
			);
			const dialog = await screen.findByRole("dialog");
			await within(dialog).findByTitle("index.html");

			await user.click(within(dialog).getByRole("button", { name: "Save" }));
			expect(saveUrl).toHaveBeenCalledWith(
				apiUrl("/api/raw/cap1/index.html"),
				"index.html",
			);
			expect(rawCapability).toHaveBeenCalledOnce();
		});

		it("reloads the viewer's page on a rewrite, and this one only once the viewer has closed", async () => {
			stubProbe();
			const user = userEvent.setup();
			const { rerender } = renderPage(undefined, "v1");
			const inPlace = await frame();
			pageLoaded(inPlace);
			await user.click(
				await screen.findByRole("button", { name: "View full screen" }),
			);
			const dialog = await screen.findByRole("dialog");
			const staged =
				await within(dialog).findByTitle<HTMLIFrameElement>("index.html");
			pageLoaded(staged);
			const navigated = spyOnNavigation();

			rerender("v2");
			await vi.waitFor(() =>
				expect(navigatedFrames(navigated)).toEqual([staged]),
			);

			await user.click(within(dialog).getByRole("button", { name: "Close" }));
			await vi.waitFor(() =>
				expect(navigatedFrames(navigated)).toEqual([staged, inPlace]),
			);
		});

		it("is not offered before there is a page, nor on a failure card", async () => {
			stubProbe(Response.json({ code: "not_found" }, { status: 404 }));
			renderPage();
			expect(
				screen.queryByRole("button", { name: "View full screen" }),
			).not.toBeInTheDocument();

			const element = await frame();
			expect(
				screen.getByRole("button", { name: "View full screen" }),
			).toBeInTheDocument();
			pageLoaded(element);
			await screen.findByText("File not found");
			expect(
				screen.queryByRole("button", { name: "View full screen" }),
			).not.toBeInTheDocument();
		});
	});
});
