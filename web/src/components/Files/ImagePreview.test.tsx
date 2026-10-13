import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import type { ImageSource } from "../../utils/fileView";
import type { MediaViewerProps } from "../Media";
import ImagePreview from "./ImagePreview";

const viewerProps = vi.fn<(props: MediaViewerProps) => void>();
const viewerMounted = vi.fn();

// The viewer has tests of its own; what is under test here is the way in.
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

const source: ImageSource = {
	kind: "remote",
	origin: { kind: "file", path: "docs/shot.png" },
	mime: "image/png",
};

function renderPreview() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<ImagePreview
				source={source}
				fileName="shot.png"
				mime="image/png"
				size={4}
				dimensions={{ width: 40, height: 30 }}
			/>
		</QueryClientProvider>,
	);
}

async function loadImage() {
	const img = await screen.findByRole("img", { name: "shot.png" });
	fireEvent.load(img);
	return img;
}

describe("ImagePreview", () => {
	beforeEach(() => {
		viewerProps.mockReset();
		viewerMounted.mockReset();
		reportEverythingInView();
		stubObjectUrls();
		stubImageFetch();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("offers full screen only once the image has loaded", async () => {
		renderPreview();
		await screen.findByRole("img", { name: "shot.png" });
		expect(
			screen.queryByRole("button", { name: "View full screen" }),
		).not.toBeInTheDocument();

		await loadImage();
		expect(
			screen.getByRole("button", { name: "View full screen" }),
		).toBeInTheDocument();
	});

	it("opens the viewer on the file, with no way back to Files", async () => {
		const user = userEvent.setup();
		renderPreview();
		await loadImage();

		await user.click(screen.getByRole("button", { name: "View full screen" }));

		expect(
			screen.getByRole("dialog", { name: "shot.png" }),
		).toBeInTheDocument();
		const props = viewerProps.mock.lastCall?.[0];
		expect(props?.item).toEqual({
			kind: "image",
			name: "shot.png",
			saveAs: "shot.png",
			mime: "image/png",
			size: 4,
			source,
			dimensions: { width: 40, height: 30 },
		});
		expect(props?.openInFiles).toBeUndefined();

		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("opens the viewer from a click on the image itself", async () => {
		const user = userEvent.setup();
		renderPreview();

		await user.click(await loadImage());

		expect(
			screen.getByRole("dialog", { name: "shot.png" }),
		).toBeInTheDocument();
	});

	it("does not open the viewer from the image while it is loading", async () => {
		const user = userEvent.setup();
		renderPreview();

		await user.click(await screen.findByRole("img", { name: "shot.png" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("keeps the viewer mounted when the preview's own copy fails to decode", async () => {
		const user = userEvent.setup();
		renderPreview();
		const img = await loadImage();
		await user.click(screen.getByRole("button", { name: "View full screen" }));

		fireEvent.error(img);

		expect(screen.getByText("Image can't be displayed")).toBeInTheDocument();
		expect(
			screen.getByRole("dialog", { name: "shot.png" }),
		).toBeInTheDocument();
		// Remounted, it would lose its zoom and cycle its history entry.
		expect(viewerMounted).toHaveBeenCalledOnce();
	});
});
