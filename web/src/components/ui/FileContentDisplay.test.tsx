import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import type { StageComponent } from "../Media/types";
import { FileContentDisplay } from "./FileContentDisplay";

const getFile = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ workDir: "/work", actions: { getFile } }),
	isRPCTimeout: () => false,
}));

// The stage is the viewer's to test; here only whether it offers Open in Files.
vi.mock("../Media/stages", () => {
	const Stage: StageComponent = ({ item }) => <p>stage: {item.name}</p>;
	return { loadedStage: () => Stage, loadStage: async () => Stage };
});

function renderFile(
	filePath: string,
	content: string,
	onOpenFile?: (path: string) => void,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<FileContentDisplay
				content={content}
				filePath={filePath}
				onOpenFile={onOpenFile}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	reportEverythingInView();
	stubObjectUrls();
	stubImageFetch();
	getFile.mockReset();
	getFile.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a rendered Markdown file's images", () => {
	it.each([
		["docs/guide.md", "Files"],
		["/work/docs/guide.md", "the transcript"],
	])("resolve against the directory of %s (%s)", (filePath) => {
		renderFile(filePath, "![shot](../img/a.png)\n\n![logo](logo.png)");

		expect(getFile).toHaveBeenCalledWith("img/a.png");
		expect(getFile).toHaveBeenCalledWith("docs/logo.png");
	});

	it("are outside the work directory when the file is", async () => {
		renderFile("/tmp/notes.md", "![shot](a.png)");

		expect(
			await screen.findByText("Outside the work directory"),
		).toBeInTheDocument();
		expect(getFile).not.toHaveBeenCalled();
	});

	describe("in the viewer", () => {
		beforeEach(() => {
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

		async function openViewer() {
			// jsdom never decodes an image on its own.
			fireEvent.load(await screen.findByRole("img", { name: "logo" }));
			await userEvent.click(screen.getByRole("button", { name: "View logo" }));
			return screen.findByRole("dialog");
		}

		it("open in Files, by their work-directory path, where the host navigates", async () => {
			const onOpenFile = vi.fn();
			renderFile("docs/guide.md", "![logo](logo.png)", onOpenFile);

			const viewer = await openViewer();
			await userEvent.click(
				within(viewer).getByRole("button", { name: "Open in Files" }),
			);

			expect(onOpenFile).toHaveBeenCalledWith("docs/logo.png");
		});

		it("offer no Open in Files where the host cannot navigate", async () => {
			renderFile("docs/guide.md", "![logo](logo.png)");

			const viewer = await openViewer();

			expect(
				within(viewer).getByRole("button", { name: "Save" }),
			).toBeInTheDocument();
			expect(
				within(viewer).queryByRole("button", { name: "Open in Files" }),
			).toBeNull();
		});
	});
});
