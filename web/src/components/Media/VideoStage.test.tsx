import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "../../lib/api";
import { useWSStore, wsActions } from "../../lib/wsStore";
import type {
	MediaMetadata,
	PlaybackHandoff,
	StageKeyHandler,
	VideoMediaItem,
} from "./types";
import VideoStage from "./VideoStage";

const rawCapability = vi.fn(async () => ({
	path: "/api/raw/cap1/clip.mp4",
	expiresAt: Date.now() + 4 * 60 * 60 * 1000,
}));
const play = vi.fn(async () => {});
const pause = vi.fn();

function videoItem(handoff?: PlaybackHandoff): VideoMediaItem {
	return {
		kind: "video",
		name: "clip.mp4",
		saveAs: "clip.mp4",
		mime: "video/mp4",
		size: 4096,
		origin: { kind: "file", path: "rec/clip.mp4" },
		handoff,
	};
}

/** The stage in a stand-in for the viewer's frame, which forwards its keys. */
function renderStage(item: VideoMediaItem) {
	const onMetadata = vi.fn<(metadata: MediaMetadata | null) => void>();
	function Frame() {
		const keysRef = useRef<StageKeyHandler | null>(null);
		return (
			<section
				aria-label="frame"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the viewer's frame holds focus
				tabIndex={0}
				onKeyDown={(event) => keysRef.current?.(event)}
			>
				<VideoStage
					item={item}
					toolbarStart={null}
					keysRef={keysRef}
					onMetadata={onMetadata}
					saveUrlRef={{ current: null }}
				/>
			</section>
		);
	}
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<Frame />
		</QueryClientProvider>,
	);
	return { onMetadata };
}

function loadMetadata(video: HTMLVideoElement, duration = 60) {
	Object.defineProperties(video, {
		videoWidth: { value: 320, configurable: true },
		videoHeight: { value: 180, configurable: true },
		duration: { value: duration, configurable: true },
	});
	fireEvent.loadedMetadata(video);
}

function setTime(video: HTMLMediaElement, time: number) {
	Object.defineProperty(video, "currentTime", {
		value: time,
		writable: true,
		configurable: true,
	});
}

async function findVideo() {
	return (await screen.findByLabelText("clip.mp4")) as HTMLVideoElement;
}

describe("VideoStage", () => {
	beforeEach(() => {
		useWSStore.setState({ status: "connected" });
		vi.spyOn(wsActions, "rawCapability").mockImplementation(rawCapability);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rawCapability.mockClear();
		play.mockClear();
		pause.mockClear();
	});

	it("plays the file from a capability with the native controls, inline", async () => {
		renderStage(videoItem());

		const video = await findVideo();
		expect(video.getAttribute("src")).toBe(
			apiUrl("/api/raw/cap1/clip.mp4#t=0.001"),
		);
		expect(video).toHaveAttribute("controls");
		expect(video).toHaveAttribute("playsinline");
		expect(video).not.toHaveAttribute("autoplay");
	});

	it("reports the video's size and length for the caption", async () => {
		const { onMetadata } = renderStage(videoItem());
		loadMetadata(await findVideo(), 42);

		expect(onMetadata).toHaveBeenLastCalledWith({
			dimensions: { width: 320, height: 180 },
			duration: 42,
		});
	});

	describe("handover", () => {
		it("carries on from the handed-over second, playing if it was", async () => {
			renderStage(videoItem({ time: 17, playing: true }));
			const video = await findVideo();
			setTime(video, 0);

			loadMetadata(video);

			expect(video.currentTime).toBe(17);
			expect(play).toHaveBeenCalledOnce();
		});

		it("stays paused at that second if it was paused", async () => {
			renderStage(videoItem({ time: 17, playing: false }));
			const video = await findVideo();
			setTime(video, 0);

			loadMetadata(video);

			expect(video.currentTime).toBe(17);
			expect(play).not.toHaveBeenCalled();
		});

		it("keeps the handoff at the position it has reached", async () => {
			const handoff = { time: 17, playing: true };
			renderStage(videoItem(handoff));
			const video = await findVideo();
			loadMetadata(video);

			setTime(video, 25);
			fireEvent.timeUpdate(video);
			fireEvent.pause(video);

			expect(handoff).toEqual({ time: 25, playing: false });
		});

		it("does not take the position from a source still loading", async () => {
			const handoff = { time: 17, playing: false };
			renderStage(videoItem(handoff));
			const video = await findVideo();
			setTime(video, 0);

			fireEvent.timeUpdate(video);

			expect(handoff.time).toBe(17);
		});
	});

	describe("keys", () => {
		async function focusedFrame() {
			renderStage(videoItem());
			const video = await findVideo();
			loadMetadata(video, 60);
			setTime(video, 30);
			screen.getByRole("region", { name: "frame" }).focus();
			return video;
		}

		it("plays and pauses on Space and k", async () => {
			const user = userEvent.setup();
			const video = await focusedFrame();
			Object.defineProperty(video, "paused", {
				value: true,
				configurable: true,
			});

			await user.keyboard(" ");
			expect(play).toHaveBeenCalledOnce();

			Object.defineProperty(video, "paused", {
				value: false,
				configurable: true,
			});
			await user.keyboard("k");
			expect(pause).toHaveBeenCalledOnce();
		});

		it("seeks, within the video's length", async () => {
			const user = userEvent.setup();
			const video = await focusedFrame();

			await user.keyboard("{ArrowRight}");
			expect(video.currentTime).toBe(35);
			await user.keyboard("j");
			expect(video.currentTime).toBe(25);
			await user.keyboard("l".repeat(4));
			expect(video.currentTime).toBe(60);
			await user.keyboard("{Home}");
			expect(video.currentTime).toBe(0);
			await user.keyboard("{ArrowLeft}");
			expect(video.currentTime).toBe(0);
		});

		it("mutes and unmutes on m", async () => {
			const user = userEvent.setup();
			const video = await focusedFrame();

			await user.keyboard("m");
			expect(video.muted).toBe(true);
			await user.keyboard("m");
			expect(video.muted).toBe(false);
		});

		it("leaves a key to the browser when a modifier is held", async () => {
			const user = userEvent.setup();
			const video = await focusedFrame();

			await user.keyboard("{Control>}{ArrowRight}{/Control}");
			expect(video.currentTime).toBe(30);
		});

		it("leaves the video's own keys to it once it has focus, and still does the rest", async () => {
			const video = await focusedFrame();
			Object.defineProperty(video, "paused", {
				value: true,
				configurable: true,
			});

			fireEvent.keyDown(video, { key: " " });
			fireEvent.keyDown(video, { key: "ArrowRight" });
			expect(play).not.toHaveBeenCalled();
			expect(video.currentTime).toBe(30);

			fireEvent.keyDown(video, { key: "k" });
			fireEvent.keyDown(video, { key: "l" });
			expect(play).toHaveBeenCalledOnce();
			expect(video.currentTime).toBe(40);
		});
	});

	it("shows why it will not play, without a Download beside the toolbar's Save", async () => {
		rawCapability.mockRejectedValueOnce(new Error("raw capability refused"));
		renderStage(videoItem());

		expect(await screen.findByText("Couldn't load video")).toBeInTheDocument();
		expect(screen.getByText("raw capability refused")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Download" }),
		).not.toBeInTheDocument();
	});
});
