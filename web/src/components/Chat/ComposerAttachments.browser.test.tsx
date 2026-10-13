import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftAttachment } from "../../lib/inputStore";
import clipPath from "../../test/clip-64x36.webm?url";
import ComposerAttachments from "./ComposerAttachments";

const urls: string[] = [];

/** A real local file's `blob:` URL, as the store makes for a picked one. */
async function blobOf(path: string): Promise<string> {
	const url = URL.createObjectURL(await (await fetch(path)).blob());
	urls.push(url);
	return url;
}

afterEach(() => {
	for (const url of urls.splice(0)) URL.revokeObjectURL(url);
});

function draft(change: Partial<DraftAttachment>): DraftAttachment {
	return {
		key: "k",
		name: "clip.webm",
		size: 2048,
		kind: "video",
		previewUrl: null,
		status: "ready",
		...change,
	};
}

/** The entry's box: the preview's parent, which holds the upload spinner too. */
function boxOf(preview: HTMLElement) {
	const box = preview.parentElement;
	if (!box) throw new Error("no box around the preview");
	const { width, height } = box.getBoundingClientRect();
	return { width, height };
}

describe("ComposerAttachments in a browser", () => {
	it("keeps a video's box while its preview loads", async () => {
		const url = await blobOf(clipPath);
		render(
			<ComposerAttachments
				items={[draft({ previewUrl: url })]}
				onRemove={vi.fn()}
			/>,
		);
		const before = boxOf(screen.getByRole("img", { name: "clip.webm, video" }));

		// Past the default wait: reading even a header goes through the media
		// pipeline, which a loaded machine starts late.
		const loaded = await screen.findByRole(
			"img",
			{ name: /^clip\.webm, video, \d+:\d\d$/ },
			{ timeout: 15_000 },
		);

		expect(before).toEqual({ width: 56, height: 56 });
		expect(boxOf(loaded)).toEqual(before);
	});

	// The upload veil is over the text only: a voice note can be checked while
	// it is still on its way. Only a layout engine can say what a press lands on.
	it("leaves an uploading audio file's play button to be pressed", async () => {
		const url = await blobOf(clipPath);
		render(
			<ComposerAttachments
				items={[
					draft({
						name: "note.webm",
						kind: "audio",
						previewUrl: url,
						status: "uploading",
					}),
				]}
				onRemove={vi.fn()}
			/>,
		);
		const play = screen.getByRole("button", { name: "Play note.webm" });
		expect(
			screen.getByRole("status", { name: "Uploading note.webm" }),
		).toBeInTheDocument();

		await waitFor(() => {
			const { left, top, width, height } = play.getBoundingClientRect();
			const hit = document.elementFromPoint(left + width / 2, top + height / 2);
			expect(play.contains(hit)).toBe(true);
		});
	});
});
