import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { RawCapability } from "../../lib/rpc/raw";
import { useWSStore, wsActions } from "../../lib/wsStore";
// A 72×128 portrait VP9 clip, served by the test server as a capability path
// would be. Portrait so that its own ratio is not the 16:9 reserved for it.
import clipPath from "../../test/clip-72x128.webm?url";
import MediaPreview from "./MediaPreview";

function contentWidth(element: HTMLElement): number {
	const style = getComputedStyle(element);
	return (
		element.clientWidth -
		Number.parseFloat(style.paddingLeft) -
		Number.parseFloat(style.paddingRight)
	);
}

describe("MediaPreview video box", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await page.viewport(414, 896);
	});

	it("reserves 16:9 across the width, then takes the clip's own shape without enlarging it, within 70vh", async () => {
		useWSStore.setState({ status: "connected" });
		let issue: (capability: RawCapability) => void = () => {};
		vi.spyOn(wsActions, "rawCapability").mockReturnValue(
			new Promise((resolve) => {
				issue = resolve;
			}),
		);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<MediaPreview
					kind="video"
					origin={{ kind: "file", path: "clip.webm" }}
					fileName="clip.webm"
					mime="video/webm"
					size={1695}
				/>
			</QueryClientProvider>,
		);
		const box = container.querySelector<HTMLElement>('[style*="aspect-ratio"]');
		if (!box?.parentElement) throw new Error("no video box");
		const frame = box.parentElement;

		// Before there is anything to measure: the full width, at 16:9.
		await expect.poll(() => wsActions.rawCapability).toHaveBeenCalled();
		let rect = box.getBoundingClientRect();
		expect(rect.width).toBeCloseTo(contentWidth(frame), 0);
		expect(rect.width / rect.height).toBeCloseTo(16 / 9, 1);

		issue({
			path: clipPath,
			expiresAt: Date.now() + 60 * 60 * 1000,
			worktree: "",
		});
		const video = (await screen.findByLabelText("clip.webm", {
			selector: "video",
		})) as HTMLVideoElement;
		// The clip is fetched and decoded, which a loaded machine stretches past
		// the poll's 1s default; the margin `browserSetup.ts` gives findBy*.
		await expect.poll(() => video.videoWidth, { timeout: 5_000 }).toBe(72);

		// Room to spare on both sides, so the clip keeps its own pixels.
		await expect
			.poll(() => box.getBoundingClientRect().width)
			.toBeCloseTo(72, 0);
		expect(box.getBoundingClientRect().height).toBeCloseTo(128, 0);

		// A window shorter than the clip: 70vh caps the height, the ratio holds.
		await page.viewport(414, 120);
		await expect
			.poll(() => box.getBoundingClientRect().height)
			.toBeCloseTo(84, 0);
		rect = box.getBoundingClientRect();
		expect(rect.width / rect.height).toBeCloseTo(72 / 128, 1);
	});
});
