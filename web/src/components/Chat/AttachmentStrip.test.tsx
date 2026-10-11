import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import type { FileBlock } from "../../types/content";
import type { FileContent } from "../../types/contents";
import AttachmentStrip from "./AttachmentStrip";

const getAttachment = vi.fn();
const getFile = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ workDir: "/work", actions: { getAttachment, getFile } }),
	isRPCTimeout: () => false,
}));

let fetchMock: ReturnType<typeof stubImageFetch>;
let revoked: string[];

// A transcript scrolled to a tool call: everything given is on screen.
beforeEach(() => {
	reportEverythingInView();
	({ revoked } = stubObjectUrls());
	fetchMock = stubImageFetch();
	getAttachment.mockReset();
	getFile.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function fetchedUrls(): URL[] {
	return fetchMock.mock.calls.map(
		(call) => new URL(String((call as unknown[])[0]), "http://host"),
	);
}

function imageContent(overrides: Partial<FileContent> = {}): FileContent {
	return {
		name: "abc",
		type: "file",
		path: "abc",
		size: 68,
		mime: "image/png",
		content: "",
		encoding: "http",
		...overrides,
	};
}

function renderStrip(files: FileBlock[], onOpenFile?: (path: string) => void) {
	const queryClient = new QueryClient({
		// Same as `FilesTab.test.tsx`: `useAttachmentContent` passes a `retry` of
		// its own, so `retry: false` does not reach it. Only the ~7s of backoff
		// between attempts is taken away, not the attempts themselves.
		defaultOptions: { queries: { retry: false, retryDelay: 0 } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return render(
		<AttachmentStrip
			files={files}
			sessionId="session-1"
			onOpenFile={onOpenFile}
		/>,
		{ wrapper },
	);
}

describe("AttachmentStrip", () => {
	it("shows an image a tool returned inline, without expanding anything", async () => {
		getAttachment.mockResolvedValue(imageContent());

		renderStrip([
			{
				mime: "image/png",
				size: 68,
				width: 64,
				height: 64,
				attachment_id: "abc",
			},
		]);

		const image = await screen.findByRole("img", {}, { timeout: 10_000 });
		expect(image).toHaveAttribute("src", "blob:test/1");
		expect(getAttachment).toHaveBeenCalledWith("session-1", "abc");
		const [url] = fetchedUrls();
		expect(url.pathname).toBe("/api/chat/attachments");
		expect(url.searchParams.get("session_id")).toBe("session-1");
		expect(url.searchParams.get("id")).toBe("abc");
	});

	it("reads nothing for a thumbnail that has not come into view", async () => {
		globalThis.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof globalThis.IntersectionObserver;
		getAttachment.mockResolvedValue(imageContent());

		renderStrip([{ mime: "image/png", attachment_id: "abc" }]);

		expect(await screen.findByLabelText("PNG image")).toBeInTheDocument();
		expect(getAttachment).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("lets go of the image's object URL once the thumbnail unmounts", async () => {
		getAttachment.mockResolvedValue(imageContent());

		const { unmount } = renderStrip([
			{ mime: "image/png", attachment_id: "abc" },
		]);
		await screen.findByRole("img", {}, { timeout: 10_000 });
		unmount();

		expect(revoked).toEqual(["blob:test/1"]);
	});

	it("opens the picked image at full size and offers to save it", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(imageContent());

		renderStrip([{ mime: "image/png", attachment_id: "abc" }]);

		await user.click(
			await screen.findByRole("button", {}, { timeout: 10_000 }),
		);

		expect(
			await screen.findByRole("button", { name: "Save" }),
		).toBeInTheDocument();
		// The thumbnail and the full-size copy, so the preview really opened —
		// and both from one read of the bytes.
		await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// The CLI's block type is what says a result is an image, so the server keeps
	// one whose media type went missing. Refusing to draw it here would make that
	// storing pointless — and the fetch names the content from its own bytes.
	it("still draws an image the agent reported no type for", async () => {
		getAttachment.mockResolvedValue(imageContent());

		renderStrip([{ mime: "", size: 68, attachment_id: "abc" }]);

		expect(
			await screen.findByRole("img", {}, { timeout: 10_000 }),
		).toHaveAttribute("src", "blob:test/1");
	});

	it("says why a file has nothing behind it instead of asking for it", async () => {
		renderStrip([
			{ mime: "application/pdf", size: 385, omitted: "binary" },
			{ mime: "image/png", size: 9_000_000, omitted: "too_large" },
		]);

		expect(await screen.findByText("Can't be previewed")).toBeInTheDocument();
		expect(screen.getByText("Too large to preview")).toBeInTheDocument();
		expect(getAttachment).not.toHaveBeenCalled();
		expect(getFile).not.toHaveBeenCalled();
	});

	// Codex both stores the bytes and says where they came from, so the way over
	// to the real viewer must not be read off where the bytes are fetched.
	it("offers the file viewer for an attachment that also names a path", async () => {
		const user = userEvent.setup();
		const onOpenFile = vi.fn();
		getAttachment.mockResolvedValue(imageContent());

		renderStrip(
			[
				{
					mime: "image/png",
					attachment_id: "abc",
					path: "/work/shots/a.png",
				},
			],
			onOpenFile,
		);

		await user.click(
			await screen.findByRole("button", {}, { timeout: 10_000 }),
		);
		await user.click(
			await screen.findByRole("button", { name: "Open in Files" }),
		);
		expect(onOpenFile).toHaveBeenCalledWith("shots/a.png");
	});

	it("reads a file the agent only named, through the work directory", async () => {
		getFile.mockResolvedValue({ type: "file", file: imageContent() });

		renderStrip([{ mime: "image/png", path: "/work/shots/a.png" }]);

		await screen.findByRole("img", {}, { timeout: 10_000 });
		expect(getFile).toHaveBeenCalledWith("shots/a.png");
		expect(fetchedUrls()[0].pathname).toBe("/api/files/download");
	});

	// `unavailable` says the server could not keep the content, not that there
	// is anything wrong with it — so a file still in the work directory is the
	// image after all, and showing "Not available" over it would be a lie.
	it("reads the file when the server could not keep the content", async () => {
		getFile.mockResolvedValue({ type: "file", file: imageContent() });

		renderStrip([
			{ mime: "image/png", path: "/work/shots/a.png", omitted: "unavailable" },
		]);

		await screen.findByRole("img", {}, { timeout: 10_000 });
		expect(getFile).toHaveBeenCalledWith("shots/a.png");
	});

	// The block claimed an image and the bytes turned out not to be one, so
	// there is nothing to draw and the server sent no reason for it. Saying only
	// its size here would read as nothing being wrong.
	it("says so when what arrives is not the image it claimed", async () => {
		getAttachment.mockResolvedValue(
			imageContent({ mime: "text/xml", content: "<svg/>", encoding: "text" }),
		);

		renderStrip([{ mime: "image/svg+xml", size: 6, attachment_id: "abc" }]);

		expect(
			await screen.findByText("Can't be previewed", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("draws an SVG from its source, never reading it over HTTP", async () => {
		getAttachment.mockResolvedValue(
			imageContent({
				mime: "image/svg+xml",
				content: "<svg/>",
				encoding: "text",
			}),
		);

		renderStrip([{ mime: "image/svg+xml", size: 6, attachment_id: "abc" }]);

		expect(
			await screen.findByRole("img", {}, { timeout: 10_000 }),
		).toHaveAttribute("src", "data:image/svg+xml,%3Csvg%2F%3E");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("offers no way over to a file outside the work directory", async () => {
		const onOpenFile = vi.fn();
		renderStrip([{ mime: "application/pdf", path: "/tmp/a.pdf" }], onOpenFile);

		expect(await screen.findByText("a.pdf")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
		expect(getFile).not.toHaveBeenCalled();
	});

	it("falls back to a retryable entry when the content cannot be read", async () => {
		const user = userEvent.setup();
		getAttachment.mockRejectedValue(new Error("attachment not found"));

		renderStrip([{ mime: "image/png", attachment_id: "gone" }]);

		const retry = await screen.findByRole(
			"button",
			{ name: "Retry" },
			{ timeout: 10_000 },
		);
		expect(screen.getByText("Couldn't load image")).toBeInTheDocument();

		getAttachment.mockResolvedValue(imageContent());
		await user.click(retry);
		await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
	});

	it("offers to retry when the bytes cannot be read", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(imageContent());
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "gone", code: "not_found" }), {
				status: 404,
			}),
		);

		renderStrip([{ mime: "image/png", attachment_id: "abc" }]);

		await user.click(
			await screen.findByRole("button", { name: "Retry" }, { timeout: 10_000 }),
		);
		expect(await screen.findByRole("img")).toHaveAttribute(
			"src",
			"blob:test/1",
		);
		// Only the bytes were read again; the description was fine.
		expect(getAttachment).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// A refusal is shown at once (above), but a failure on the way — the relay
	// answering while the tunnel reconnects — may well go through next time.
	it("tries again by itself when the server fails rather than refuses", async () => {
		getAttachment.mockResolvedValue(imageContent());
		fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }));

		renderStrip([{ mime: "image/png", attachment_id: "abc" }]);

		expect(
			await screen.findByRole("img", {}, { timeout: 10_000 }),
		).toHaveAttribute("src", "blob:test/1");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
