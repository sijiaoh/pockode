import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "../../lib/api";
import { useWSStore, wsActions } from "../../lib/wsStore";
import { reportEverythingInView } from "../../test/imageFixtures";
import type { ContentOrigin } from "../../types/contents";
import type { PlayableKind } from "../../utils/fileView";
import type { MediaViewerProps } from "../Media";
import MediaPreview from "./MediaPreview";

const viewerProps = vi.fn<(props: MediaViewerProps) => void>();
const viewerMounted = vi.fn();

// The viewer and its video stage have tests of their own; what is under test
// here is the way in, and the position handed each way.
vi.mock("../Media", () => ({
	MediaViewer: (props: MediaViewerProps) => {
		viewerProps(props);
		useEffect(() => viewerMounted(), []);
		return (
			<div role="dialog" aria-label={props.item.name}>
				<button type="button" onClick={props.onClose}>
					Close
				</button>
			</div>
		);
	},
}));

const origin: ContentOrigin = { kind: "file", path: "rec/clip.mov" };

let issued = 0;
const rawCapability = vi.fn(async () => ({
	path: `/api/raw/cap${++issued}/clip.mov`,
	expiresAt: Date.now() + 4 * 60 * 60 * 1000,
	worktree: "",
}));
const play = vi.fn(async () => {});

function renderPreview({
	kind = "video" as PlayableKind,
	mime = "video/quicktime",
	download = vi.fn(),
} = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<MediaPreview
				kind={kind}
				origin={origin}
				fileName="clip.mov"
				mime={mime}
				size={2048}
				downloadAction={{ label: "Download", onClick: download }}
			/>
		</QueryClientProvider>,
	);
	return { download, queryClient };
}

async function findPlayer(kind: PlayableKind = "video") {
	const label = "clip.mov";
	const element = await screen.findByLabelText(label);
	expect(element.tagName).toBe(kind === "video" ? "VIDEO" : "AUDIO");
	return element as HTMLMediaElement;
}

/** The capability the element is loading, without the first-frame fragment. */
function capabilityOf(element: HTMLMediaElement) {
	return element.getAttribute("src")?.match(/cap\d+/)?.[0];
}

function loadMetadata(
	element: HTMLMediaElement,
	{ width = 0, height = 0, duration = 42 } = {},
) {
	Object.defineProperties(element, {
		videoWidth: { value: width, configurable: true },
		videoHeight: { value: height, configurable: true },
		duration: { value: duration, configurable: true },
	});
	fireEvent.loadedMetadata(element);
}

function playTo(element: HTMLMediaElement, time: number) {
	fireEvent.play(element);
	Object.defineProperty(element, "currentTime", {
		value: time,
		writable: true,
		configurable: true,
	});
	fireEvent.timeUpdate(element);
}

describe("MediaPreview", () => {
	beforeEach(() => {
		issued = 0;
		reportEverythingInView();
		useWSStore.setState({ status: "connected" });
		vi.spyOn(wsActions, "rawCapability").mockImplementation(rawCapability);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
		// jsdom implements neither, and handing over to the viewer pauses.
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rawCapability.mockClear();
		play.mockClear();
		viewerProps.mockClear();
		viewerMounted.mockClear();
	});

	it("streams the file from a capability, shown inline before it has loaded", async () => {
		renderPreview();

		const video = await findPlayer();
		expect(rawCapability).toHaveBeenCalledWith({ origin, scope: "file" });
		expect(video.getAttribute("src")).toBe(
			apiUrl("/api/raw/cap1/clip.mov#t=0.001"),
		);
		expect(video).toHaveAttribute("playsinline");
		expect(video).toHaveAttribute("controls");
		expect(video).toHaveAttribute("preload", "metadata");
		expect(video).not.toHaveAttribute("autoplay");
	});

	it("asks for nothing until it is scrolled into view", async () => {
		globalThis.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof globalThis.IntersectionObserver;
		renderPreview();

		await act(async () => {});
		expect(rawCapability).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("clip.mov")).not.toBeInTheDocument();
	});

	it("waits for the connection instead of failing while it is down", async () => {
		useWSStore.setState({ status: "connecting" });
		renderPreview();

		await act(async () => {});
		expect(rawCapability).not.toHaveBeenCalled();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();

		act(() => useWSStore.setState({ status: "connected" }));
		await findPlayer();
	});

	it("loads audio into an audio element, without the video's fragment", async () => {
		renderPreview({ kind: "audio", mime: "audio/mpeg" });

		const audio = await findPlayer("audio");
		expect(audio.getAttribute("src")).toBe(apiUrl("/api/raw/cap1/clip.mov"));
		loadMetadata(audio, { duration: 192 });
		expect(screen.getByText("MP3 · 3:12 · 2 KB")).toBeInTheDocument();
	});

	it("captions a video with its size and length once its metadata is in", async () => {
		renderPreview();
		const video = await findPlayer();
		expect(screen.getByText("MOV · 2 KB")).toBeInTheDocument();

		loadMetadata(video, { width: 1080, height: 1920, duration: 42 });
		expect(
			screen.getByText("MOV · 1080×1920 · 0:42 · 2 KB"),
		).toBeInTheDocument();
	});

	it("lays a video with no picture out as sound, on the same element", async () => {
		renderPreview({ mime: "video/mp4" });
		const video = await findPlayer();

		loadMetadata(video, { width: 0, height: 0 });
		expect(screen.getByText(/^No picture/)).toBeInTheDocument();
		expect(await findPlayer()).toBe(video);
	});

	describe("the full-screen viewer", () => {
		const viewButton = () =>
			screen.queryByRole("button", { name: "View full screen" });

		it("is offered as soon as there is a source, before anything has loaded", async () => {
			useWSStore.setState({ status: "connecting" });
			renderPreview();
			await act(async () => {});
			expect(viewButton()).not.toBeInTheDocument();

			act(() => useWSStore.setState({ status: "connected" }));
			await findPlayer();
			expect(viewButton()).toBeInTheDocument();
		});

		it("is not offered for sound", async () => {
			renderPreview({ kind: "audio", mime: "audio/mpeg" });
			await findPlayer("audio");
			expect(viewButton()).not.toBeInTheDocument();

			cleanup();
			renderPreview({ mime: "video/mp4" });
			loadMetadata(await findPlayer(), { width: 0, height: 0 });
			expect(viewButton()).not.toBeInTheDocument();
		});

		it("takes playback over from the same second, pausing this player", async () => {
			const pause = vi
				.spyOn(HTMLMediaElement.prototype, "pause")
				.mockImplementation(() => {});
			renderPreview();
			const video = await findPlayer();
			loadMetadata(video, { width: 1080, height: 1920, duration: 42 });
			playTo(video, 17);

			await userEvent.click(
				screen.getByRole("button", { name: "View full screen" }),
			);

			expect(
				screen.getByRole("dialog", { name: "clip.mov" }),
			).toBeInTheDocument();
			expect(pause).toHaveBeenCalled();
			expect(viewerProps).toHaveBeenLastCalledWith(
				expect.objectContaining({
					item: expect.objectContaining({
						kind: "video",
						origin,
						dimensions: { width: 1080, height: 1920 },
						duration: 42,
						handoff: { time: 17, playing: true },
					}),
				}),
			);
		});

		it("picks up where the viewer left off, paused", async () => {
			renderPreview();
			const video = await findPlayer();
			loadMetadata(video, { width: 1920, height: 1080 });
			playTo(video, 5);
			await userEvent.click(
				screen.getByRole("button", { name: "View full screen" }),
			);
			const { handoff } = viewerProps.mock.lastCall?.[0].item as {
				handoff: { time: number; playing: boolean };
			};
			handoff.time = 31;
			handoff.playing = true;
			play.mockClear();

			await userEvent.click(screen.getByRole("button", { name: "Close" }));

			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(video.currentTime).toBe(31);
			expect(play).not.toHaveBeenCalled();
			// What it hands over next time is where it was put back, not playing.
			await userEvent.click(
				screen.getByRole("button", { name: "View full screen" }),
			);
			expect(viewerProps).toHaveBeenLastCalledWith(
				expect.objectContaining({
					item: expect.objectContaining({
						handoff: { time: 31, playing: false },
					}),
				}),
			);
		});

		it("hands a video that has played to the end over paused, not to start over", async () => {
			renderPreview();
			const video = await findPlayer();
			loadMetadata(video, { width: 1920, height: 1080, duration: 42 });
			playTo(video, 42);
			// What reaching the end does: `ended` is true by the time it pauses.
			Object.defineProperty(video, "ended", {
				value: true,
				configurable: true,
			});
			fireEvent.pause(video);
			fireEvent.ended(video);

			await userEvent.click(
				screen.getByRole("button", { name: "View full screen" }),
			);

			expect(viewerProps).toHaveBeenLastCalledWith(
				expect.objectContaining({
					item: expect.objectContaining({
						handoff: { time: 42, playing: false },
					}),
				}),
			);
		});

		it("does not start again behind the viewer when a new source lands after opening it", async () => {
			const { queryClient } = renderPreview();
			const video = await findPlayer();
			playTo(video, 20);
			await act(() =>
				queryClient.refetchQueries({ queryKey: ["raw-capability"] }),
			);
			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));

			await userEvent.click(
				screen.getByRole("button", { name: "View full screen" }),
			);
			play.mockClear();
			loadMetadata(video);

			expect(video.currentTime).toBe(20);
			expect(play).not.toHaveBeenCalled();
			expect(viewerProps).toHaveBeenLastCalledWith(
				expect.objectContaining({
					item: expect.objectContaining({
						handoff: { time: 20, playing: true },
					}),
				}),
			);
		});

		it("stays open when this player fails underneath it", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("x", { status: 206 })),
			);
			renderPreview();
			const video = await findPlayer();
			await userEvent.click(
				screen.getByRole("button", { name: "View full screen" }),
			);

			fireEvent.error(video);
			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
			fireEvent.error(video);

			expect(
				await screen.findByText("Video can't be played"),
			).toBeInTheDocument();
			expect(screen.getByRole("dialog")).toBeInTheDocument();
			expect(viewerMounted).toHaveBeenCalledOnce();
		});
	});

	describe("recovery", () => {
		it("answers a failure with a new capability, resumed and playing", async () => {
			renderPreview();
			const video = await findPlayer();
			loadMetadata(video, { width: 1920, height: 1080 });
			playTo(video, 73);
			play.mockClear();

			fireEvent.error(video);

			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
			expect(await findPlayer()).toBe(video);
			video.currentTime = 0;
			loadMetadata(video, { width: 1920, height: 1080 });
			expect(video.currentTime).toBe(73);
			expect(play).toHaveBeenCalledTimes(1);
			expect(screen.queryByText(/couldn't/i)).not.toBeInTheDocument();
		});

		it("swaps in a capability renewed elsewhere at the same second", async () => {
			const { queryClient } = renderPreview();
			const video = await findPlayer();
			playTo(video, 20);
			play.mockClear();

			await act(() =>
				queryClient.refetchQueries({ queryKey: ["raw-capability"] }),
			);

			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
			expect(await findPlayer()).toBe(video);
			video.currentTime = 0;
			loadMetadata(video);
			expect(video.currentTime).toBe(20);
			expect(play).toHaveBeenCalledTimes(1);
		});

		it("recovers again once playback has moved on since the last time", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			renderPreview();
			const video = await findPlayer();
			playTo(video, 10);

			fireEvent.error(video);
			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
			loadMetadata(video);
			playTo(video, 15);
			fireEvent.error(video);

			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap3"));
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("leaves a paused player paused at the same second", async () => {
			renderPreview();
			const video = await findPlayer();
			playTo(video, 12);
			fireEvent.pause(video);
			play.mockClear();

			fireEvent.error(video);
			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
			video.currentTime = 0;
			loadMetadata(video);

			expect(video.currentTime).toBe(12);
			expect(play).not.toHaveBeenCalled();
		});

		it("does not treat a refused play as a failure", async () => {
			play.mockRejectedValueOnce(new DOMException("", "NotAllowedError"));
			renderPreview();
			const video = await findPlayer();
			playTo(video, 5);

			fireEvent.error(video);
			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
			loadMetadata(video);
			await act(async () => {});

			expect(await findPlayer()).toBe(video);
		});

		it("stops meaning to play once a play is refused", async () => {
			play.mockRejectedValueOnce(new DOMException("", "NotAllowedError"));
			const { queryClient } = renderPreview();
			const video = await findPlayer();
			playTo(video, 5);
			fireEvent.error(video);
			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
			loadMetadata(video);
			await act(async () => {});
			play.mockClear();

			// A source renewed later, by nobody's press, must not start it.
			await act(() =>
				queryClient.refetchQueries({ queryKey: ["raw-capability"] }),
			);
			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap3"));
			loadMetadata(video);

			expect(play).not.toHaveBeenCalled();
		});

		it("waits for the connection before asking again", async () => {
			renderPreview();
			const video = await findPlayer();
			act(() => useWSStore.setState({ status: "connecting" }));

			fireEvent.error(video);
			await act(async () => {});
			expect(rawCapability).toHaveBeenCalledTimes(1);

			act(() => useWSStore.setState({ status: "connected" }));
			await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
		});

		describe("when the new capability fails too", () => {
			function stubProbe(response: Response) {
				const fetchMock = vi.fn(async () => response);
				vi.stubGlobal("fetch", fetchMock);
				return fetchMock;
			}

			async function failTwice() {
				const video = await findPlayer();
				fireEvent.error(video);
				await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
				fireEvent.error(video);
			}

			it("probes one byte and says the browser cannot play it", async () => {
				const fetchMock = stubProbe(new Response("x", { status: 206 }));
				const { download } = renderPreview();
				await failTwice();

				expect(
					await screen.findByText("Video can't be played"),
				).toBeInTheDocument();
				expect(
					screen.getByText(/iPhone videos recorded in HEVC/),
				).toBeInTheDocument();
				expect(fetchMock).toHaveBeenCalledWith(
					apiUrl("/api/raw/cap2/clip.mov"),
					expect.objectContaining({ headers: { Range: "bytes=0-0" } }),
				);
				await userEvent.click(screen.getByRole("button", { name: "Download" }));
				expect(download).toHaveBeenCalled();
				expect(rawCapability).toHaveBeenCalledTimes(2);
			});

			// The probe finds the bytes served because the network is back; the
			// element said it lost them, so they were never what failed.
			it("offers a retry, not Download, when the element lost the bytes on the way", async () => {
				stubProbe(new Response("x", { status: 206 }));
				renderPreview();
				const video = await findPlayer();
				fireEvent.error(video);
				await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
				Object.defineProperty(video, "error", {
					value: { code: 2 },
					configurable: true,
				});
				fireEvent.error(video);

				expect(
					await screen.findByText("Couldn't load video"),
				).toBeInTheDocument();
				expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
				expect(
					screen.queryByText("Video can't be played"),
				).not.toBeInTheDocument();
			});

			it("says the file is gone when the server has no such file", async () => {
				stubProbe(
					Response.json(
						{ error: "not found: rec/clip.mov", code: "not_found" },
						{ status: 404 },
					),
				);
				renderPreview();
				await failTwice();

				expect(await screen.findByText("File not found")).toBeInTheDocument();
				expect(screen.queryByRole("button")).not.toBeInTheDocument();
			});

			it("offers a retry that resumes where it was", async () => {
				stubProbe(
					Response.json(
						{ error: "capability is unknown", code: "capability_not_found" },
						{ status: 404 },
					),
				);
				renderPreview();
				const video = await findPlayer();
				playTo(video, 30);
				fireEvent.error(video);
				await vi.waitFor(() => expect(capabilityOf(video)).toBe("cap2"));
				fireEvent.error(video);

				expect(
					await screen.findByText("Couldn't load video"),
				).toBeInTheDocument();
				expect(screen.getByText("capability is unknown")).toBeInTheDocument();
				play.mockClear();

				await userEvent.click(screen.getByRole("button", { name: "Retry" }));

				const again = await findPlayer();
				expect(capabilityOf(again)).toBe("cap3");
				loadMetadata(again);
				expect(again.currentTime).toBe(30);
				expect(play).toHaveBeenCalledTimes(1);
			});
		});

		it("reports a capability that cannot be issued, with a retry", async () => {
			rawCapability.mockRejectedValueOnce(new Error("raw capability refused"));
			renderPreview({ kind: "audio", mime: "audio/mpeg" });

			expect(
				await screen.findByText("Couldn't load audio"),
			).toBeInTheDocument();
			expect(screen.getByText("raw capability refused")).toBeInTheDocument();

			await userEvent.click(screen.getByRole("button", { name: "Retry" }));
			expect(capabilityOf(await findPlayer("audio"))).toBe("cap1");
		});
	});
});
