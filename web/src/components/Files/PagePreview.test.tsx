import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateWorkspaceCapabilities } from "../../hooks/useRawMediaSource";
import { apiUrl } from "../../lib/api";
import { saveUrl } from "../../lib/fileDownload";
import { useWSStore, wsActions } from "../../lib/wsStore";
import { reportEverythingInView } from "../../test/imageFixtures";
import type { TreeOrigin } from "../../types/contents";
import { HTML_FRAME_SANDBOX } from "../Chat/HtmlFrame";
import PagePreview from "./PagePreview";

vi.mock("../../lib/fileDownload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/fileDownload")>()),
	saveUrl: vi.fn(),
}));

let issued = 0;
const rawCapability = vi.fn(
	async ({ scope }: { scope: "file" | "directory" }) => ({
		path:
			scope === "directory"
				? `/api/raw/cap${++issued}/`
				: `/api/raw/cap${++issued}/index.html`,
		expiresAt: Date.now() + 4 * 60 * 60 * 1000,
	}),
);

function renderPage(
	origin: TreeOrigin = { kind: "file", path: "coverage/index.html" },
	revision: unknown = "v1",
	content: string | null = "<p>A page</p>",
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
				content={content}
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
function capabilityOf(element: HTMLIFrameElement) {
	return element.getAttribute("src")?.match(/cap\d+/)?.[0];
}

const afterEachRestore: (() => void)[] = [];

/**
 * Every `src` the app sets on a frame by hand. Setting it, even to the URL it
 * has, is a navigation — which a change React makes to the attribute is too,
 * so a test of a load looks for either.
 */
function spyOnNavigation() {
	const descriptor = Object.getOwnPropertyDescriptor(
		HTMLIFrameElement.prototype,
		"src",
	);
	// Called on the frame, so `mock.contexts` says which one navigated.
	const set = vi.fn(function (this: HTMLIFrameElement, url: string) {
		return url;
	});
	Object.defineProperty(HTMLIFrameElement.prototype, "src", {
		...descriptor,
		set(this: HTMLIFrameElement, url: string) {
			set.call(this, url);
			descriptor?.set?.call(this, url);
		},
	});
	afterEachRestore.push(() => {
		if (descriptor) {
			Object.defineProperty(HTMLIFrameElement.prototype, "src", descriptor);
		}
	});
	return set;
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
		for (const restore of afterEachRestore.splice(0)) restore();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rawCapability.mockClear();
	});

	it("loads the page from its folder in a sandboxed frame", async () => {
		stubProbe();
		renderPage({ kind: "file", path: "reports/cov erage/index.html" });

		const element = await frame();
		expect(rawCapability).toHaveBeenCalledWith({
			origin: { kind: "file", path: "reports/cov erage" },
			scope: "directory",
		});
		expect(element.getAttribute("src")).toBe(
			apiUrl("/api/raw/cap1/index.html"),
		);
		expect(element.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
		expect(element.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(screen.getByText("HTML · 2 KB")).toBeInTheDocument();
	});

	it("asks for the commit's folder for a page in a commit", async () => {
		stubProbe();
		renderPage({ kind: "commit", hash: "abc", path: "site/index.html" });

		await frame();
		expect(rawCapability).toHaveBeenCalledWith({
			origin: { kind: "commit", hash: "abc", path: "site" },
			scope: "directory",
		});
	});

	// The server refuses a directory scope for both, so asking would fail.
	it.each([
		["at the root", "index.html"],
		["in a hidden folder", "docs/.vitepress/dist/index.html"],
		["named as a hidden file", "docs/.draft.html"],
	])("asks for the page alone %s", async (_, path) => {
		stubProbe();
		renderPage({ kind: "file", path });

		const element = await frame();
		expect(rawCapability).toHaveBeenCalledWith({
			origin: { kind: "file", path },
			scope: "file",
		});
		expect(element.getAttribute("src")).toBe(
			apiUrl("/api/raw/cap1/index.html"),
		);
	});

	// The server's directory scope never follows a link on its way: a folder
	// that is one could not serve even the page.
	it("falls back to the page alone, and says so, when its folder's capability cannot reach it", async () => {
		stubProbe(
			Response.json(
				{ error: "site is not a plain directory", code: "outside_scope" },
				{ status: 403 },
			),
		);
		renderPage(
			{ kind: "file", path: "site/index.html" },
			"v1",
			'<script type="module" src="app.js"></script>',
		);

		fireEvent.load(await frame());
		await vi.waitFor(async () =>
			expect(capabilityOf(await frame())).toBe("cap2"),
		);
		expect(rawCapability).toHaveBeenLastCalledWith({
			origin: { kind: "file", path: "site/index.html" },
			scope: "file",
		});
		expect((await frame()).getAttribute("src")).toBe(
			apiUrl("/api/raw/cap2/index.html"),
		);
		expect(screen.getByRole("note")).toHaveTextContent(
			"A page whose folder can't be opened for it is shown on its own",
		);
		expect(screen.queryByText("Couldn't load page")).not.toBeInTheDocument();

		// The viewer starts where this frame ended up, rather than trying again.
		await userEvent.click(
			screen.getByRole("button", { name: "View full screen" }),
		);
		const staged = await within(
			await screen.findByRole("dialog"),
		).findByTitle<HTMLIFrameElement>("index.html");
		expect(staged.getAttribute("src")).toBe(apiUrl("/api/raw/cap2/index.html"));
		expect(rawCapability).toHaveBeenCalledTimes(2);
	});

	it("checks the page's first load with one byte, and nothing it navigates to", async () => {
		const fetchMock = stubProbe();
		renderPage();

		const element = await frame();
		fireEvent.load(element);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			apiUrl("/api/raw/cap1/index.html"),
			expect.objectContaining({ headers: { Range: "bytes=0-0" } }),
		);

		fireEvent.load(element);
		await act(async () => {});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("renews a dead capability once, silently, on the same frame", async () => {
		stubProbe(dead());
		renderPage();

		const element = await frame();
		fireEvent.load(element);
		await vi.waitFor(() => expect(capabilityOf(element)).toBe("cap2"));
		expect(await frame()).toBe(element);
		expect(screen.queryByText("Couldn't load page")).not.toBeInTheDocument();
	});

	it("shows the failure when a renewed capability dies again", async () => {
		stubProbe(dead(), dead());
		renderPage();

		fireEvent.load(await frame());
		await vi.waitFor(async () =>
			expect(capabilityOf(await frame())).toBe("cap2"),
		);
		fireEvent.load(await frame());

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
		fireEvent.load(element);
		await vi.waitFor(() => expect(rawCapability).toHaveBeenCalledTimes(2));

		// The cached capability is the dead one, and still fresh by its expiry.
		rerender("v2");
		await act(async () => issue());
		await vi.waitFor(() => expect(capabilityOf(element)).not.toBe("cap1"));
	});

	it("says the file is gone when the server no longer has it", async () => {
		stubProbe(Response.json({ code: "not_found" }, { status: 404 }));
		renderPage();

		fireEvent.load(await frame());
		expect(await screen.findByText("File not found")).toBeInTheDocument();
	});

	it("keeps a loaded page on the URL it loaded with when the capability is renewed elsewhere", async () => {
		stubProbe();
		const { queryClient } = renderPage();
		const element = await frame();
		fireEvent.load(element);

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
		fireEvent.load(element);

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

	it("loads the page again, on the same frame, once a worktree switch has landed", async () => {
		stubProbe();
		const { queryClient } = renderPage();
		const element = await frame();
		fireEvent.load(element);
		const navigated = spyOnNavigation();

		await act(() => invalidateWorkspaceCapabilities(queryClient));

		await vi.waitFor(() => expect(capabilityOf(element)).toBe("cap2"));
		expect(await frame()).toBe(element);
		// React put the new URL on the attribute; nothing set it a second time.
		expect(navigated).not.toHaveBeenCalled();
	});

	// The same frame, so Back steps back through the reload as through a link
	// followed in the page; a new frame would leave the old one's pages behind
	// in the history as entries Back cannot show.
	it("shows no frame from the worktree left while Retry asks again after a switch", async () => {
		stubProbe();
		const { queryClient } = renderPage();
		fireEvent.load(await frame());

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
		fireEvent.load(element);
		const navigated = spyOnNavigation();

		await userEvent.click(screen.getByRole("button", { name: "Reload page" }));
		// The capability was still fresh: nothing new was asked for.
		await vi.waitFor(() =>
			expect(navigated).toHaveBeenCalledWith(
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
			fireEvent.load(element);
		});
		await vi.waitFor(() => expect(navigated).toHaveBeenCalledTimes(1));
		fireEvent.load(element);
		await vi.waitFor(() =>
			expect(reload.querySelector("svg")).not.toHaveClass("animate-spin"),
		);
	});

	it("reloads when the page's content changes, and only then", async () => {
		stubProbe();
		const { rerender } = renderPage(undefined, "v1");
		const element = await frame();
		fireEvent.load(element);
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
			expect(staged.getAttribute("src")).toBe(inPlace.getAttribute("src"));
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
			fireEvent.load(inPlace);
			await user.click(
				await screen.findByRole("button", { name: "View full screen" }),
			);
			const dialog = await screen.findByRole("dialog");
			const staged = await within(dialog).findByTitle("index.html");
			fireEvent.load(staged);
			const navigated = spyOnNavigation();

			rerender("v2");
			await vi.waitFor(() => expect(navigated.mock.contexts).toEqual([staged]));

			await user.click(within(dialog).getByRole("button", { name: "Close" }));
			await vi.waitFor(() =>
				expect(navigated.mock.contexts).toEqual([staged, inPlace]),
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
			fireEvent.load(element);
			await screen.findByText("File not found");
			expect(
				screen.queryByRole("button", { name: "View full screen" }),
			).not.toBeInTheDocument();
		});
	});

	describe("notice for a page shown on its own", () => {
		const LINKED = '<link rel="stylesheet" href="style.css"><p>A page</p>';
		const notice = () => screen.queryByRole("note");

		afterEach(() => {
			useWSStore.setState({ remoteUrl: "" });
		});

		it.each([
			[
				"at the worktree root",
				{ kind: "file", path: "index.html" },
				"A page at the root of the project is shown on its own",
			],
			[
				"at the commit root",
				{ kind: "commit", hash: "abc", path: "index.html" },
				"A page at the root of the repository is shown on its own",
			],
			[
				"in a hidden folder",
				{ kind: "file", path: "docs/.vitepress/index.html" },
				"A page inside a hidden folder is shown on its own",
			],
			[
				"named as a hidden file",
				{ kind: "file", path: "docs/.draft.html" },
				"A hidden page is shown on its own",
			],
		] satisfies [
			string,
			TreeOrigin,
			string,
		][])("says why its linked files won't load %s", async (_, origin, why) => {
			stubProbe();
			renderPage(origin, "v1", LINKED);

			expect(await screen.findByRole("note")).toHaveTextContent(why);
		});

		it.each([
			[
				"a root page with a hidden name",
				{ kind: "file", path: ".draft.html" },
				"Move it into a folder and rename it without the leading dot to load them.",
			],
			[
				"a page in a hidden folder",
				{ kind: "file", path: "docs/.vitepress/index.html" },
				"Move it out of the hidden folder to load them.",
			],
			[
				"a page with a hidden name",
				{ kind: "file", path: "docs/.draft.html" },
				"Rename it without the leading dot to load them.",
			],
			[
				"a commit's page in a hidden folder",
				{ kind: "commit", hash: "abc", path: ".github/index.html" },
				"can't reach the rest of the repository (.env, .git). Move it out of the hidden folder to load them.",
			],
		] satisfies [
			string,
			TreeOrigin,
			string,
		][])("says what frees %s", async (_, origin, text) => {
			stubProbe();
			renderPage(origin, "v1", LINKED);

			expect(await screen.findByRole("note")).toHaveTextContent(text);
		});

		it("is not shown for a page its folder's capability reaches", async () => {
			stubProbe();
			renderPage({ kind: "file", path: "site/index.html" }, "v1", LINKED);

			await frame();
			expect(notice()).not.toBeInTheDocument();
		});

		it("is not shown for a page that links to nothing", async () => {
			stubProbe();
			renderPage(
				{ kind: "file", path: "index.html" },
				"v1",
				'<a href="#top">Top</a><img src="data:image/png;base64,AA==">',
			);

			await frame();
			expect(notice()).not.toBeInTheDocument();
		});

		it("is shown for a page too large to read", async () => {
			stubProbe();
			renderPage({ kind: "file", path: "index.html" }, "v1", null);

			expect(await screen.findByRole("note")).toBeInTheDocument();
		});

		it("offers Port Preview only while the relay is there", async () => {
			stubProbe();
			const user = userEvent.setup();
			useWSStore.setState({ remoteUrl: "" });
			renderPage({ kind: "file", path: "index.html" }, "v1", LINKED);

			expect(await screen.findByRole("note")).toHaveTextContent(
				"Move it into a folder to load them.",
			);
			expect(
				screen.queryByRole("button", { name: "Port Preview" }),
			).not.toBeInTheDocument();

			act(() => {
				useWSStore.setState({ remoteUrl: "https://abc.cloud.pockode.com" });
			});
			expect(screen.getByRole("note")).toHaveTextContent(
				"Move it into a folder, or serve it and use Port Preview ›.",
			);
			await user.click(screen.getByRole("button", { name: "Port Preview" }));
			expect(await screen.findByRole("dialog")).toBeInTheDocument();
		});

		it("offers no Port Preview for a page in a commit", async () => {
			stubProbe();
			useWSStore.setState({ remoteUrl: "https://abc.cloud.pockode.com" });
			renderPage(
				{ kind: "commit", hash: "abc", path: "index.html" },
				"v1",
				LINKED,
			);

			expect(await screen.findByRole("note")).toHaveTextContent(
				"Move it into a folder to load them.",
			);
			expect(
				screen.queryByRole("button", { name: "Port Preview" }),
			).not.toBeInTheDocument();
		});

		it("shows in the viewer as text only", async () => {
			stubProbe();
			const user = userEvent.setup();
			useWSStore.setState({ remoteUrl: "https://abc.cloud.pockode.com" });
			renderPage({ kind: "file", path: "index.html" }, "v1", LINKED);

			await user.click(
				await screen.findByRole("button", { name: "View full screen" }),
			);
			const dialog = await screen.findByRole("dialog");
			expect(within(dialog).getByRole("note")).toHaveTextContent(
				"Move it into a folder to load them.",
			);
			expect(
				within(dialog).queryByRole("button", { name: "Port Preview" }),
			).not.toBeInTheDocument();
		});
	});
});
