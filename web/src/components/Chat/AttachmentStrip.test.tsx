import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "../../lib/api";
import { saveBlob, saveUrl } from "../../lib/fileDownload";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import { stubMediaControls } from "../../test/mediaFixtures";
import type { FileBlock } from "../../types/content";
import type { FileContent } from "../../types/contents";
import type { StageComponent, VideoMediaItem } from "../Media/types";
import AttachmentStrip from "./AttachmentStrip";

const { getAttachment, getFile, rawCapability, stageItem } = vi.hoisted(() => ({
	getAttachment: vi.fn(),
	getFile: vi.fn(),
	rawCapability: vi.fn(),
	stageItem: vi.fn(),
}));

vi.mock("../../lib/wsStore", () => {
	const state = {
		workDir: "/work",
		status: "connected",
		actions: { getAttachment, getFile },
	};
	const useWSStore = (selector: (state: unknown) => unknown) => selector(state);
	useWSStore.getState = () => state;
	return {
		useWSStore,
		wsActions: { rawCapability },
		isRPCTimeout: () => false,
	};
});

// The stage is the viewer's to test; here only that the strip opens it with
// the right item matters.
vi.mock("../Media/stages", () => {
	const Stage: StageComponent = ({ item }) => {
		stageItem(item);
		return <p>stage: {item.name}</p>;
	};
	return { loadedStage: () => Stage, loadStage: async () => Stage };
});

// Only the saves: the rest of the module is how a file's bytes are read.
vi.mock("../../lib/fileDownload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/fileDownload")>()),
	saveBlob: vi.fn(),
	saveUrl: vi.fn(),
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
	vi.mocked(saveBlob).mockReset();
	vi.mocked(saveUrl).mockReset();
	stageItem.mockReset();
	let issued = 0;
	rawCapability.mockReset().mockImplementation(async () => ({
		path: `/api/raw/cap${++issued}/clip.mov`,
		expiresAt: Date.now() + 4 * 60 * 60 * 1000,
		worktree: "",
	}));
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
	it("shows an image a tool returned inline, without opening anything", async () => {
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

	it("opens the picked image in the media viewer and saves it from there", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(imageContent());

		renderStrip([{ mime: "image/png", attachment_id: "abc" }]);

		await user.click(
			await screen.findByRole(
				"button",
				{ name: "View PNG image" },
				{ timeout: 10_000 },
			),
		);

		const viewer = await screen.findByRole("dialog");
		expect(
			await within(viewer).findByText("stage: PNG image"),
		).toBeInTheDocument();
		// No way over to Files for an attachment that names no file.
		expect(
			within(viewer).queryByRole("button", { name: "Open in Files" }),
		).toBeNull();

		await user.click(within(viewer).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(saveBlob).toHaveBeenCalledOnce());
		expect(vi.mocked(saveBlob).mock.calls[0][1]).toBe("image.png");
		// The bytes the thumbnail already read.
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
			await screen.findByRole(
				"button",
				{ name: "View a.png" },
				{ timeout: 10_000 },
			),
		);
		await user.click(
			await screen.findByRole("button", { name: "Open in Files" }),
		);
		await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("shots/a.png"));
		expect(screen.queryByRole("dialog")).toBeNull();
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

function videoContent(overrides: Partial<FileContent> = {}): FileContent {
	return imageContent({ mime: "video/quicktime", size: 4096, ...overrides });
}

const clip: FileBlock = {
	mime: "video/quicktime",
	size: 4096,
	attachment_id: "clip",
	name: "clip.mov",
};

/** The poster element, which is the play button's only media child. */
async function findPoster() {
	const button = await screen.findByRole(
		"button",
		{ name: "Play clip.mov" },
		{ timeout: 10_000 },
	);
	const video = button.querySelector("video");
	if (!video) throw new Error("no <video> in the thumbnail");
	return { button, video };
}

function paintFirstFrame(
	video: HTMLVideoElement,
	{ width = 1080, height = 1920, duration = 42 } = {},
) {
	Object.defineProperties(video, {
		videoWidth: { value: width, configurable: true },
		videoHeight: { value: height, configurable: true },
		duration: { value: duration, configurable: true },
	});
	fireEvent.loadedMetadata(video);
	fireEvent.loadedData(video);
}

/**
 * A failure the capability does not cure, diagnosed from one byte. The second
 * error waits for the new capability to be on the element: one arriving while
 * it is still being asked for is ignored.
 */
async function failToPlay(video: HTMLVideoElement, probe: Response) {
	fireEvent.error(video);
	await waitFor(async () =>
		expect((await findPoster()).video.getAttribute("src")).toContain("cap2"),
	);
	fetchMock.mockResolvedValueOnce(probe);
	fireEvent.error((await findPoster()).video);
}

/** The square's size utilities, which are what keep the transcript still. */
function sizeClasses(element: Element): string[] {
	return element.className
		.split(/\s+/)
		.filter((name) => /^(sm:)?size-/.test(name))
		.sort();
}

describe("AttachmentStrip video", () => {
	it("shows a poster that reads only the header and first frame", async () => {
		getAttachment.mockResolvedValue(videoContent());

		renderStrip([clip]);

		const { video } = await findPoster();
		expect(rawCapability).toHaveBeenCalledWith({
			origin: {
				kind: "attachment",
				sessionId: "session-1",
				id: "clip",
				worktree: expect.any(String),
			},
			scope: "file",
		});
		// The fragment is what makes iOS paint the first frame.
		expect(video.getAttribute("src")).toBe(
			apiUrl("/api/raw/cap1/clip.mov#t=0.001"),
		);
		expect(video).toHaveAttribute("preload", "metadata");
		expect(video).toHaveAttribute("playsinline");
		expect(video.muted).toBe(true);
		expect(video).not.toHaveAttribute("controls");
		expect(video).not.toHaveAttribute("autoplay");
		// The element streams it; nothing reads the file itself.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads nothing for a video that has not come into view", async () => {
		globalThis.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof globalThis.IntersectionObserver;
		getAttachment.mockResolvedValue(videoContent());

		renderStrip([clip]);

		expect(await screen.findByLabelText("clip.mov")).toBeInTheDocument();
		expect(getAttachment).not.toHaveBeenCalled();
		expect(rawCapability).not.toHaveBeenCalled();
	});

	// iOS may load nothing before a press, so the entry has to be a video to
	// tap before any frame of it paints — in the box it was waiting in.
	it("can be opened before a frame paints, in the box it waited in", async () => {
		let describe: (content: FileContent) => void = () => {};
		getAttachment.mockReturnValue(
			new Promise<FileContent>((resolve) => {
				describe = resolve;
			}),
		);

		renderStrip([clip]);

		const waiting = await screen.findByLabelText("clip.mov");
		const box = sizeClasses(waiting.parentElement as Element);
		expect(box).toEqual(["size-24", "sm:size-32"]);
		describe(videoContent());

		const { button, video } = await findPoster();
		expect(sizeClasses(button)).toEqual(box);
		expect(screen.queryByText("0:42")).toBeNull();

		paintFirstFrame(video);

		expect(await screen.findByText("0:42")).toBeInTheDocument();
		expect(sizeClasses((await findPoster()).button)).toEqual(box);
	});

	it("opens the viewer already playing, with what the poster learnt", async () => {
		const user = userEvent.setup();
		const onOpenFile = vi.fn();
		getAttachment.mockResolvedValue(videoContent());

		renderStrip([{ ...clip, path: "/work/rec/clip.mov" }], onOpenFile);

		const { button, video } = await findPoster();
		paintFirstFrame(video);
		await user.click(button);

		const viewer = await screen.findByRole("dialog");
		expect(
			await within(viewer).findByText("stage: clip.mov"),
		).toBeInTheDocument();
		expect(stageItem).toHaveBeenLastCalledWith(
			expect.objectContaining<Partial<VideoMediaItem>>({
				kind: "video",
				mime: "video/quicktime",
				size: 4096,
				saveAs: "clip.mov",
				// The poster's origin, which is the key the stage's capability is
				// cached under — so the stage plays from the one already held.
				origin: expect.objectContaining({ kind: "attachment", id: "clip" }),
				dimensions: { width: 1080, height: 1920 },
				duration: 42,
				handoff: { time: 0, playing: true },
			}),
		);
		expect(
			within(viewer).getByRole("button", { name: "Open in Files" }),
		).toBeInTheDocument();
	});

	it("routes a block the agent gave no type for to the video entry", async () => {
		getAttachment.mockResolvedValue(videoContent());

		renderStrip([{ mime: "", attachment_id: "clip", name: "clip.mov" }]);

		await findPoster();
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("offers to retry a video that fails to load", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(videoContent());

		renderStrip([clip]);

		await failToPlay(
			(await findPoster()).video,
			new Response("", { status: 502 }),
		);

		const retry = await screen.findByRole("button", { name: "Retry" });
		expect(screen.getByText("Couldn't load video")).toBeInTheDocument();
		await user.click(retry);
		await findPoster();
		expect(rawCapability).toHaveBeenCalledTimes(3);
	});

	// The strip opens no viewer for a failed entry, so the viewer's Save is out
	// of reach — and bytes this browser cannot play may well open elsewhere.
	it("offers to save a video this browser cannot play", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(videoContent());

		renderStrip([clip]);

		await failToPlay((await findPoster()).video, new Response("x"));

		expect(
			await screen.findByText("Video can't be played"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(saveUrl).toHaveBeenCalledOnce());
		expect(vi.mocked(saveUrl).mock.calls[0]).toEqual([
			apiUrl("/api/raw/cap2/clip.mov"),
			"clip.mov",
		]);
	});

	it("says a file that is gone is gone, with nothing to retry", async () => {
		getAttachment.mockResolvedValue(videoContent());

		renderStrip([clip]);

		await failToPlay(
			(await findPoster()).video,
			new Response(JSON.stringify({ error: "gone", code: "not_found" }), {
				status: 404,
			}),
		);

		expect(await screen.findByText("File not found")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("offers to retry when the description cannot be read", async () => {
		const user = userEvent.setup();
		getAttachment.mockRejectedValue(new Error("attachment not found"));

		renderStrip([clip]);

		const retry = await screen.findByRole(
			"button",
			{ name: "Retry" },
			{ timeout: 10_000 },
		);
		expect(screen.getByText("Couldn't load video")).toBeInTheDocument();

		getAttachment.mockResolvedValue(videoContent());
		await user.click(retry);
		await findPoster();
	});

	// A block keeps the type it was written with; what the file is said to be
	// now is what plays it.
	it("plays a block written as audio that is described as video", async () => {
		getAttachment.mockResolvedValue(videoContent());

		renderStrip([{ ...clip, mime: "audio/mp4" }]);

		// Asked again each try: the audio entry it waited as has a play button
		// of the same name.
		await waitFor(() => findPoster(), { timeout: 10_000 });
		expect(screen.queryByText("Can't be previewed")).toBeNull();
	});

	it("says so when what arrives is not the video it claimed", async () => {
		getAttachment.mockResolvedValue(
			videoContent({ mime: "text/plain", content: "hi", encoding: "text" }),
		);

		renderStrip([clip]);

		expect(
			await screen.findByText("Can't be previewed", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		expect(rawCapability).not.toHaveBeenCalled();
	});

	// The icon is the point: a reader looking for something to watch or hear
	// is told there is none — and only when there is none.
	it("marks only media with nothing behind it as missing", async () => {
		const { container } = renderStrip([
			{ mime: "video/mp4", path: "/tmp/out.mp4" },
			{ mime: "audio/mpeg", path: "/tmp/note.mp3" },
			{ mime: "application/pdf", attachment_id: "doc" },
		]);

		expect(await screen.findByText("out.mp4")).toBeInTheDocument();
		expect(container.querySelectorAll(".lucide-video-off")).toHaveLength(1);
		expect(container.querySelectorAll(".lucide-volume-x")).toHaveLength(1);
		expect(container.querySelectorAll(".lucide-file-text")).toHaveLength(1);
		expect(rawCapability).not.toHaveBeenCalled();
	});
});

const note: FileBlock = {
	mime: "audio/mpeg",
	size: 2048,
	attachment_id: "note",
	name: "note.mp3",
};

function audioContent(overrides: Partial<FileContent> = {}): FileContent {
	return imageContent({ mime: "audio/mpeg", size: 2048, ...overrides });
}

function audioOf(button: HTMLElement): HTMLAudioElement {
	const audio = button.parentElement?.querySelector("audio");
	if (!audio) throw new Error("no <audio> beside the play button");
	return audio;
}

/**
 * The play button once the entry has a source to play. Asked again each try:
 * the waiting entry's button is not the player's.
 */
function findReadyPlay(name = "note.mp3") {
	return waitFor(
		() => {
			const button = screen.getByRole("button", { name: `Play ${name}` });
			expect(button).toBeEnabled();
			return button;
		},
		{ timeout: 10_000 },
	);
}

function loadAudioMetadata(audio: HTMLMediaElement, duration = 42) {
	Object.defineProperty(audio, "duration", {
		value: duration,
		configurable: true,
	});
	fireEvent.loadedMetadata(audio);
}

/** The entry's outer box: the button's parent. */
function boxClasses(button: HTMLElement): string[] {
	return (button.parentElement?.className ?? "")
		.split(/\s+/)
		.filter((name) => /(^|:)(w|min-h)-/.test(name))
		.sort();
}

/** Puts `audio` at `time` as the browser does while playing. */
function playTo(audio: HTMLMediaElement, time: number) {
	audio.currentTime = time;
	fireEvent.timeUpdate(audio);
}

/**
 * A capability renewed under a playing element. The browser pauses it on the
 * new `src` without a `pause` event and rewinds it to 0; the player is to put
 * it back once the new source's metadata lands.
 */
async function swapCapability(audio: HTMLMediaElement) {
	const before = audio.getAttribute("src");
	fireEvent.error(audio);
	await waitFor(() => expect(audio.getAttribute("src")).not.toBe(before));
	Object.defineProperty(audio, "paused", { value: true, configurable: true });
	playTo(audio, 0);
}

describe("AttachmentStrip audio", () => {
	beforeEach(() => {
		stubMediaControls();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("streams only the header until played, from the raw capability", async () => {
		getAttachment.mockResolvedValue(audioContent());

		renderStrip([note]);

		const audio = audioOf(await findReadyPlay());
		expect(rawCapability).toHaveBeenCalledWith({
			origin: expect.objectContaining({ kind: "attachment", id: "note" }),
			scope: "file",
		});
		expect(audio.getAttribute("src")).toBe(apiUrl("/api/raw/cap1/clip.mov"));
		expect(audio).toHaveAttribute("preload", "metadata");
		expect(audio).not.toHaveAttribute("autoplay");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
	});

	it("reads nothing for audio that has not come into view", async () => {
		globalThis.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof globalThis.IntersectionObserver;
		getAttachment.mockResolvedValue(audioContent());

		renderStrip([note]);

		expect(
			await screen.findByRole("button", { name: "Play note.mp3" }),
		).toBeDisabled();
		expect(getAttachment).not.toHaveBeenCalled();
		expect(rawCapability).not.toHaveBeenCalled();
	});

	it("plays and pauses in place, keeping its box", async () => {
		const user = userEvent.setup();
		let describe: (content: FileContent) => void = () => {};
		getAttachment.mockReturnValue(
			new Promise<FileContent>((resolve) => {
				describe = resolve;
			}),
		);

		renderStrip([note]);

		const waiting = await screen.findByRole("button", {
			name: "Play note.mp3",
		});
		expect(waiting).toBeDisabled();
		const box = boxClasses(waiting);
		expect(box).toContain("w-56");
		describe(audioContent());

		const play = await findReadyPlay();
		const audio = audioOf(play);
		loadAudioMetadata(audio);
		expect(await screen.findByText("0:42 · 2 KB")).toBeInTheDocument();

		await user.click(play);

		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
		const pause = await screen.findByRole("button", { name: "Pause note.mp3" });
		expect(boxClasses(pause)).toEqual(box);
		const seek = screen.getByRole("slider", { name: "Seek note.mp3" });
		expect(seek).toHaveAttribute("aria-valuetext", "0:00 of 0:42");

		await user.click(pause);

		// Paused part-way, it still says where it got to.
		expect(
			await screen.findByRole("button", { name: "Play note.mp3" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("slider", { name: "Seek note.mp3" }),
		).toBeInTheDocument();
	});

	it("seeks where the scrubber is dragged", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(audioContent());

		renderStrip([note]);

		const play = await findReadyPlay();
		const audio = audioOf(play);
		loadAudioMetadata(audio);
		await user.click(play);
		fireEvent.change(screen.getByRole("slider", { name: "Seek note.mp3" }), {
			target: { value: "12" },
		});

		expect(audio.currentTime).toBe(12);
		expect(screen.getByText("0:12 / 0:42")).toBeInTheDocument();
	});

	it("plays one sound at a time", async () => {
		const user = userEvent.setup();
		getAttachment.mockImplementation(async () => audioContent());

		renderStrip([note, { ...note, attachment_id: "memo", name: "memo.mp3" }]);

		await user.click(await findReadyPlay("note.mp3"));
		await user.click(await findReadyPlay("memo.mp3"));

		expect(
			await screen.findByRole("button", { name: "Play note.mp3" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Pause memo.mp3" }),
		).toBeInTheDocument();
	});

	it("does not take the sound back after its source is swapped", async () => {
		const user = userEvent.setup();
		getAttachment.mockImplementation(async () => audioContent());

		renderStrip([note, { ...note, attachment_id: "memo", name: "memo.mp3" }]);

		const first = await findReadyPlay("note.mp3");
		const audio = audioOf(first);
		await user.click(first);
		await swapCapability(audio);
		// Pressed while the first one's new source is still loading.
		await user.click(await findReadyPlay("memo.mp3"));
		vi.mocked(HTMLMediaElement.prototype.play).mockClear();
		loadAudioMetadata(audio);

		expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Play note.mp3" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Pause memo.mp3" }),
		).toBeInTheDocument();
	});

	it("holds its place through a swapped source, and says if it could not resume", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(audioContent());

		renderStrip([note]);

		const play = await findReadyPlay();
		const audio = audioOf(play);
		loadAudioMetadata(audio);
		await user.click(play);
		playTo(audio, 12);
		expect(await screen.findByText("0:12 / 0:42")).toBeInTheDocument();

		await swapCapability(audio);
		expect(screen.getByText("0:12 / 0:42")).toBeInTheDocument();

		// iOS may refuse a resume outside the press.
		vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
			new DOMException("not allowed", "NotAllowedError"),
		);
		loadAudioMetadata(audio);

		expect(
			await screen.findByRole("button", { name: "Play note.mp3" }),
		).toBeInTheDocument();
		expect(audio.currentTime).toBe(12);
		expect(screen.getByText("0:12 / 0:42")).toBeInTheDocument();
	});

	it("offers to retry audio that fails to load", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(audioContent());

		renderStrip([note]);

		const audio = audioOf(await findReadyPlay());
		fireEvent.error(audio);
		await waitFor(async () =>
			expect(audioOf(await findReadyPlay()).getAttribute("src")).toContain(
				"cap2",
			),
		);
		fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }));
		fireEvent.error(audioOf(await findReadyPlay()));

		const retry = await screen.findByRole("button", { name: "Retry" });
		expect(screen.getByText("Couldn't load audio")).toBeInTheDocument();
		await user.click(retry);
		await findReadyPlay();
	});

	it("offers to save audio this browser cannot play", async () => {
		const user = userEvent.setup();
		getAttachment.mockResolvedValue(audioContent());

		renderStrip([note]);

		fireEvent.error(audioOf(await findReadyPlay()));
		await waitFor(async () =>
			expect(audioOf(await findReadyPlay()).getAttribute("src")).toContain(
				"cap2",
			),
		);
		fetchMock.mockResolvedValueOnce(new Response("x"));
		fireEvent.error(audioOf(await findReadyPlay()));

		expect(
			await screen.findByText("Audio can't be played"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(saveUrl).toHaveBeenCalledOnce());
		expect(vi.mocked(saveUrl).mock.calls[0]?.[1]).toBe("note.mp3");
	});

	it("routes a block the agent gave no type for to the audio entry", async () => {
		getAttachment.mockResolvedValue(audioContent());

		renderStrip([{ mime: "", attachment_id: "note", name: "note.mp3" }]);

		await findReadyPlay();
		expect(screen.queryByRole("img")).toBeNull();
	});

	// A voice note written as `video/mp4` before the server told an MP4 with
	// no picture from a video.
	it("plays a block written as video that is described as audio", async () => {
		getAttachment.mockResolvedValue(audioContent({ mime: "audio/mp4" }));

		renderStrip([{ ...note, mime: "video/mp4" }]);

		const play = await findReadyPlay();
		expect(audioOf(play)).toBeInTheDocument();
		expect(play.querySelector("video")).toBeNull();
		expect(screen.queryByText("Can't be previewed")).toBeNull();
		// The entry it was handed to finds the description already read.
		expect(getAttachment).toHaveBeenCalledOnce();
	});

	it("says so when what arrives is not the audio it claimed", async () => {
		getAttachment.mockResolvedValue(
			audioContent({ mime: "text/plain", content: "hi", encoding: "text" }),
		);

		renderStrip([note]);

		expect(
			await screen.findByText("Can't be previewed", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		expect(rawCapability).not.toHaveBeenCalled();
	});
});
