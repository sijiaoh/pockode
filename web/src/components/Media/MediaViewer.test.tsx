import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveBlob } from "../../lib/fileDownload";
import { MediaViewer } from "./MediaViewer";
import { loadStage } from "./stages";
import type { ImageMediaItem, StageComponent } from "./types";

vi.mock("./stages", () => ({
	loadedStage: () => undefined,
	loadStage: vi.fn(),
}));

vi.mock("../../lib/fileDownload", () => ({ saveBlob: vi.fn() }));

const Stage: StageComponent = () => <p>stage</p>;

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

function setup(openInFiles?: () => void) {
	const history = createMemoryHistory({ initialEntries: ["/chat"] });
	function Root() {
		const [open, setOpen] = useState(true);
		return open ? (
			<MediaViewer
				item={item}
				openInFiles={openInFiles}
				onClose={() => setOpen(false)}
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

	it("saves the bytes under the item's file name", async () => {
		const user = userEvent.setup();
		setup();

		await user.click(await screen.findByRole("button", { name: "Save" }));

		expect(saveBlob).toHaveBeenCalledOnce();
		const [blob, name] = vi.mocked(saveBlob).mock.calls[0];
		expect(name).toBe("diagram-1.svg");
		expect(await blob.text()).toBe("<svg>#fff</svg>");
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
