import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileFullScreenContent } from "../../lib/fullScreen";
import { sliceContent } from "../../lib/hugeContent";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import type { StageComponent } from "../Media/types";
import { ContentSlice } from "./HugeContent";

const getFile = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ workDir: "/work", actions: { getFile } }),
	isRPCTimeout: () => false,
}));

vi.mock("../Media/stages", () => {
	const Stage: StageComponent = ({ item }) => <p>stage: {item.name}</p>;
	return { loadedStage: () => Stage, loadStage: async () => Stage };
});

beforeEach(() => {
	reportEverythingInView();
	stubObjectUrls();
	stubImageFetch();
	getFile.mockReset();
	getFile.mockResolvedValue({
		type: "file",
		file: {
			name: "logo.png",
			type: "file",
			path: "docs/logo.png",
			size: 68,
			mime: "image/png",
			content: "",
			encoding: "http",
		},
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the slice of a huge Markdown file", () => {
	it("is still that file: its images resolve against its directory and open in Files", async () => {
		const onOpenFile = vi.fn();
		const content = fileFullScreenContent(
			"![logo](logo.png)\n\nThe rest.",
			// The transcript names a file by its absolute path.
			"/work/docs/guide.md",
			onOpenFile,
		);
		render(
			<QueryClientProvider client={new QueryClient()}>
				<ContentSlice content={sliceContent(content, "start")} />
			</QueryClientProvider>,
		);

		fireEvent.load(await screen.findByRole("img", { name: "logo" }));
		expect(getFile).toHaveBeenCalledWith("docs/logo.png");
		await userEvent.click(screen.getByRole("button", { name: "View logo" }));
		const viewer = await screen.findByRole("dialog");
		await userEvent.click(
			within(viewer).getByRole("button", { name: "Open in Files" }),
		);

		expect(onOpenFile).toHaveBeenCalledWith("docs/logo.png");
	});
});
