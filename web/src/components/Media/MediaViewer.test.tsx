import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "../../lib/api";
import { saveBlob, saveUrl } from "../../lib/fileDownload";
import { wsActions } from "../../lib/wsStore";
import { MediaViewer } from "./MediaViewer";
import { loadStage } from "./stages";
import type {
	HtmlMediaItem,
	ImageMediaItem,
	MediaItem,
	StageComponent,
	VideoMediaItem,
} from "./types";

vi.mock("./stages", () => ({
	loadedStage: () => undefined,
	loadStage: vi.fn(),
}));

vi.mock("../../lib/fileDownload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/fileDownload")>()),
	saveBlob: vi.fn(),
	saveUrl: vi.fn(),
}));

const Stage: StageComponent = () => <p>stage</p>;

function stubServedProbe() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("x", { status: 206 })),
	);
}

const item: ImageMediaItem = {
	kind: "image",
	name: "diagram.svg",
	saveAs: "diagram-1.svg",
	mime: "image/svg+xml",
	size: 2048,
	source: {
		kind: "inline",
		src: `data:image/svg+xml,${encodeURIComponent("<svg>#fff</svg>")}`,
	},
};

const video: VideoMediaItem = {
	kind: "video",
	name: "recording.mov",
	saveAs: "recording.mov",
	mime: "video/quicktime",
	size: 500 * 1024 * 1024,
	origin: { kind: "file", path: "rec/recording.mov" },
	dimensions: { width: 1080, height: 1920 },
	duration: 42,
};

const page: HtmlMediaItem = {
	kind: "html",
	name: "index.html",
	saveAs: "index.html",
	mime: "text/html",
	size: 120,
	origin: { kind: "file", path: "site/index.html" },
};

/** Registers the URL Save downloads, as the HTML stage does once loaded. */
const PageStage: StageComponent = ({ saveUrlRef }) => {
	saveUrlRef.current = "/api/raw/dircap/index.html";
	return <p>stage</p>;
};

function setup(
	openInFiles?: () => void,
	shown: MediaItem = item,
	afterClose?: () => void,
) {
	const history = createMemoryHistory({ initialEntries: ["/chat"] });
	function Root() {
		const [open, setOpen] = useState(true);
		return open ? (
			<MediaViewer
				item={shown}
				openInFiles={openInFiles}
				onClose={() => setOpen(false)}
				afterClose={afterClose}
			/>
		) : (
			<p>closed</p>
		);
	}
	const router = createRouter({
		routeTree: createRootRoute({ component: Root }),
		history,
	});
	render(
		<QueryClientProvider client={new QueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { history };
}

describe("MediaViewer", () => {
	beforeEach(() => {
		vi.mocked(loadStage).mockReset().mockResolvedValue(Stage);
		vi.mocked(saveBlob).mockReset();
		vi.mocked(saveUrl).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		setup();
		await screen.findByText("stage");

		await user.keyboard("{Escape}");
		expect(await screen.findByText("closed")).toBeInTheDocument();
	});

	it("offers Open in Files only when the host can open the file", async () => {
		setup();
		await screen.findByText("stage");
		expect(
			screen.queryByRole("button", { name: "Open in Files" }),
		).not.toBeInTheDocument();
	});

	it("opens Files once the viewer's history entry is gone", async () => {
		const user = userEvent.setup();
		const statesAtOpen: unknown[] = [];
		const { history } = setup(() => statesAtOpen.push(history.location.state));
		await waitFor(() =>
			expect(history.location.state).toHaveProperty("fullScreen"),
		);

		await user.click(screen.getByRole("button", { name: "Open in Files" }));

		await waitFor(() => expect(statesAtOpen).toHaveLength(1));
		expect(statesAtOpen[0]).not.toHaveProperty("fullScreen");
		expect(screen.getByText("closed")).toBeInTheDocument();
	});

	it("tells the host once its history entry is gone, however it closed", async () => {
		const user = userEvent.setup();
		const states: unknown[] = [];
		const { history } = setup(undefined, item, () =>
			states.push(history.location.state),
		);
		await waitFor(() =>
			expect(history.location.state).toHaveProperty("fullScreen"),
		);

		await user.click(screen.getByRole("button", { name: "Close" }));
		await waitFor(() => expect(states).toHaveLength(1));
		expect(states[0]).not.toHaveProperty("fullScreen");
	});

	it("tells the host after a Back closed it", async () => {
		const afterClose = vi.fn();
		const { history } = setup(undefined, item, afterClose);
		await waitFor(() =>
			expect(history.location.state).toHaveProperty("fullScreen"),
		);

		act(() => history.back());
		await screen.findByText("closed");
		expect(afterClose).toHaveBeenCalledOnce();
	});

	it("saves the bytes under the item's file name", async () => {
		const user = userEvent.setup();
		setup();

		await user.click(await screen.findByRole("button", { name: "Save" }));

		expect(saveBlob).toHaveBeenCalledOnce();
		const [blob, name] = vi.mocked(saveBlob).mock.calls[0];
		expect(name).toBe("diagram-1.svg");
		expect(await blob.text()).toBe("<svg>#fff</svg>");
	});

	it("loads the stage for a video, captioned with its length", async () => {
		setup(undefined, video);

		await screen.findByText("stage");
		expect(loadStage).toHaveBeenCalledWith("video");
		expect(
			screen.getByText("MOV · 1080×1920 · 0:42 · 500 MB"),
		).toBeInTheDocument();
	});

	it("saves a video straight from its capability, never through a Blob", async () => {
		const user = userEvent.setup();
		// The byte asked for before the browser is handed the URL.
		stubServedProbe();
		vi.spyOn(wsActions, "rawCapability").mockResolvedValue({
			path: "/api/raw/cap1/recording.mov",
			expiresAt: Date.now() + 60 * 60 * 1000,
			worktree: "",
		});
		setup(undefined, video);

		await user.click(await screen.findByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(saveUrl).toHaveBeenCalledWith(
				apiUrl("/api/raw/cap1/recording.mov"),
				"recording.mov",
			),
		);
		expect(saveBlob).not.toHaveBeenCalled();
	});

	it("saves on the capability the players hold while it still works, rather than renewing it under them", async () => {
		const user = userEvent.setup();
		// The byte asked for before the browser is handed the URL.
		stubServedProbe();
		// Inside the margin where a player would no longer start on it.
		const issue = vi.spyOn(wsActions, "rawCapability").mockResolvedValue({
			path: "/api/raw/cap1/recording.mov",
			expiresAt: Date.now() + 2 * 60 * 1000,
			worktree: "",
		});
		setup(undefined, video);
		const save = await screen.findByRole("button", { name: "Save" });

		await user.click(save);
		await waitFor(() => expect(saveUrl).toHaveBeenCalledOnce());
		await user.click(save);

		await waitFor(() => expect(saveUrl).toHaveBeenCalledTimes(2));
		expect(issue).toHaveBeenCalledOnce();
	});

	it("saves a page from the URL its stage loaded, once it is served", async () => {
		const user = userEvent.setup();
		stubServedProbe();
		vi.mocked(loadStage).mockResolvedValue(PageStage);
		setup(undefined, page);
		await screen.findByText("stage");

		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(saveUrl).toHaveBeenCalledWith(
				"/api/raw/dircap/index.html",
				"index.html",
			),
		);
	});

	// Past the click the browser says nothing, and some save the error body
	// under the page's name.
	it("reports a page whose capability is refused instead of saving it", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "gone", code: "not_found" }), {
						status: 404,
					}),
			),
		);
		vi.mocked(loadStage).mockResolvedValue(PageStage);
		setup(undefined, page);
		await screen.findByText("stage");

		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(
			await screen.findByText(
				"Couldn't save index.html: File not found — it may have been moved or deleted",
			),
		).toBeInTheDocument();
		expect(saveUrl).not.toHaveBeenCalled();
	});

	it("offers a retry when the stage fails to load", async () => {
		const user = userEvent.setup();
		vi.mocked(loadStage).mockRejectedValueOnce(
			new Error("Failed to fetch dynamically imported module"),
		);
		setup();

		expect(
			await screen.findByText("Couldn't load the image viewer"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Failed to fetch dynamically imported module"),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("stage")).toBeInTheDocument();
	});
});
