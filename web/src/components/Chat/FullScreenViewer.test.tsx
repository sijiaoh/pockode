import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileFullScreenContent } from "../../lib/fullScreen";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import { FullScreenViewer } from "./FullScreenViewer";

const getFile = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ workDir: "/work", actions: { getFile } }),
	isRPCTimeout: () => false,
}));

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

describe("a Markdown file read full screen", () => {
	it("resolves its images against the file's own directory", async () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<FullScreenViewer
					source={{
						title: "Read · guide.md",
						label: "File",
						noun: "file",
						from: "start",
						// The transcript names a file by its absolute path.
						content: fileFullScreenContent(
							"![logo](logo.png)",
							"/work/docs/guide.md",
						),
					}}
					onClose={() => {}}
					closeThen={(after) => after()}
					afterCloseRef={{ current: null }}
				/>
			</QueryClientProvider>,
		);

		expect(
			await screen.findByRole("img", { name: "logo" }),
		).toBeInTheDocument();
		expect(getFile).toHaveBeenCalledWith("docs/logo.png");
	});
});
