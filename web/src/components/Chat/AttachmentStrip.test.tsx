import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// The suite's global stub never reports anything, so a thumbnail gated on
// visibility would never ask for its bytes. This one says everything it is
// given is on screen, which is what a transcript scrolled to a tool call is.
beforeEach(() => {
	globalThis.IntersectionObserver = class {
		callback: IntersectionObserverCallback;
		constructor(callback: IntersectionObserverCallback) {
			this.callback = callback;
		}
		observe(target: Element) {
			this.callback(
				[{ isIntersecting: true, target } as IntersectionObserverEntry],
				this as unknown as IntersectionObserver,
			);
		}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof globalThis.IntersectionObserver;

	getAttachment.mockReset();
	getFile.mockReset();
});

// A 1×1 PNG, so the data URL an <img> gets is a real one.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function imageContent(overrides: Partial<FileContent> = {}): FileContent {
	return {
		name: "abc",
		type: "file",
		path: "abc",
		size: 68,
		mime: "image/png",
		content: PNG_BASE64,
		encoding: "base64",
		...overrides,
	};
}

function renderStrip(files: FileBlock[], onOpenFile?: (path: string) => void) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
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

describe("AttachmentStrip", { timeout: 20_000 }, () => {
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
		expect(image).toHaveAttribute("src", `data:image/png;base64,${PNG_BASE64}`);
		expect(getAttachment).toHaveBeenCalledWith("session-1", "abc");
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
		// The thumbnail and the full-size copy, so the preview really opened.
		expect(screen.getAllByRole("img")).toHaveLength(2);
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
	// the type and size here would read as nothing being wrong.
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
});
