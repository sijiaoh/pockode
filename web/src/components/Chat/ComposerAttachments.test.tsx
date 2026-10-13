import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftAttachment } from "../../lib/inputStore";
import { stubMediaControls } from "../../test/mediaFixtures";
import ComposerAttachments from "./ComposerAttachments";

function draft(change: Partial<DraftAttachment>): DraftAttachment {
	return {
		key: change.name ?? "k",
		name: "clip.mov",
		size: 2048,
		kind: "video",
		previewUrl: "blob:clip",
		status: "ready",
		...change,
	};
}

function renderItems(items: DraftAttachment[]) {
	return render(<ComposerAttachments items={items} onRemove={vi.fn()} />);
}

/** What a browser reports once it has read the header of `element`. */
function loadMetadata(
	element: HTMLMediaElement,
	{ duration, width = 0 }: { duration: number; width?: number },
) {
	Object.defineProperty(element, "duration", {
		value: duration,
		configurable: true,
	});
	Object.defineProperty(element, "videoWidth", {
		value: width,
		configurable: true,
	});
	fireEvent.loadedMetadata(element);
}

function videoOf(preview: HTMLElement): HTMLVideoElement {
	const video = preview.querySelector("video");
	if (!video) throw new Error("no <video> in the preview");
	return video;
}

function audioOf(button: HTMLElement): HTMLAudioElement {
	const audio = button.parentElement?.querySelector("audio");
	if (!audio) throw new Error("no <audio> beside the play button");
	return audio;
}

describe("ComposerAttachments", () => {
	describe("a picked video", () => {
		// The local file, its first frame only: nothing is uploaded to preview it,
		// and nothing past the header is read.
		it("previews the first frame of the local file", () => {
			renderItems([draft({})]);

			const video = videoOf(
				screen.getByRole("img", { name: "clip.mov, video" }),
			);
			expect(video).toHaveAttribute("src", "blob:clip#t=0.001");
			expect(video).toHaveAttribute("preload", "metadata");
			expect(video.muted).toBe(true);
			expect(video).toHaveAttribute("playsinline");
			expect(video).not.toHaveAttribute("controls");
		});

		// iOS may read a `blob:`'s header and paint no frame: the length still
		// shows.
		it("gives its length once the header is read, frame or no frame", () => {
			renderItems([draft({})]);

			loadMetadata(
				videoOf(screen.getByRole("img", { name: "clip.mov, video" })),
				{ duration: 42, width: 1080 },
			);

			expect(
				screen.getByRole("img", { name: "clip.mov, video, 0:42" }),
			).toBeInTheDocument();
			expect(screen.getByText("0:42")).toBeInTheDocument();
		});

		it("says it is uploading over the preview", () => {
			renderItems([draft({ status: "uploading" })]);

			expect(
				screen.getByRole("img", { name: "clip.mov, video" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("status", { name: "Uploading clip.mov" }),
			).toBeInTheDocument();
		});

		// Still sent, but the user is told why they see no frame.
		it("says so when the browser cannot open it", () => {
			renderItems([draft({})]);

			fireEvent.error(
				videoOf(screen.getByRole("img", { name: "clip.mov, video" })),
			);

			expect(
				screen.queryByRole("img", { name: /clip\.mov/ }),
			).not.toBeInTheDocument();
			expect(
				screen.getByText("2 KB · Can't be previewed", { exact: false }),
			).toBeInTheDocument();
		});

		// HEVC in a Chromium without it opens with no error and no picture.
		it("says so when it opens with no picture to show", () => {
			renderItems([draft({})]);

			loadMetadata(
				videoOf(screen.getByRole("img", { name: "clip.mov, video" })),
				{ duration: 42, width: 0 },
			);

			expect(
				screen.queryByRole("img", { name: /clip\.mov/ }),
			).not.toBeInTheDocument();
			expect(
				screen.getByText("2 KB · Can't be previewed", { exact: false }),
			).toBeInTheDocument();
		});
	});

	describe("a picked audio file", () => {
		const note = draft({
			name: "note.m4a",
			kind: "audio",
			previewUrl: "blob:note",
		});

		beforeEach(() => {
			stubMediaControls();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("plays the local file in place, and gives its length", async () => {
			const user = userEvent.setup();
			renderItems([note]);
			const play = screen.getByRole("button", { name: "Play note.m4a" });
			const audio = audioOf(play);
			expect(audio).toHaveAttribute("src", "blob:note");
			expect(audio).toHaveAttribute("preload", "metadata");

			loadMetadata(audio, { duration: 42 });
			expect(screen.getByText("0:42 · 2 KB")).toBeInTheDocument();

			await user.click(play);
			expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
			await user.click(screen.getByRole("button", { name: "Pause note.m4a" }));
			expect(
				screen.getByRole("button", { name: "Play note.m4a" }),
			).toBeInTheDocument();
		});

		it("plays one sound at a time", async () => {
			const user = userEvent.setup();
			renderItems([note, { ...note, key: "memo", name: "memo.m4a" }]);

			await user.click(screen.getByRole("button", { name: "Play note.m4a" }));
			await user.click(screen.getByRole("button", { name: "Play memo.m4a" }));

			expect(
				screen.getByRole("button", { name: "Play note.m4a" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Pause memo.m4a" }),
			).toBeInTheDocument();
		});

		it("says so when the browser cannot play it", () => {
			renderItems([note]);

			fireEvent.error(
				audioOf(screen.getByRole("button", { name: "Play note.m4a" })),
			);

			expect(
				screen.queryByRole("button", { name: "Play note.m4a" }),
			).not.toBeInTheDocument();
			expect(
				screen.getByText("2 KB · Can't be previewed", { exact: false }),
			).toBeInTheDocument();
		});
	});
});
