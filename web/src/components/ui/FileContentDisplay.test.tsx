import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import { FileContentDisplay } from "./FileContentDisplay";

const getFile = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ workDir: "/work", actions: { getFile } }),
	isRPCTimeout: () => false,
}));

function renderFile(filePath: string, content: string) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<FileContentDisplay content={content} filePath={filePath} />
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
});
