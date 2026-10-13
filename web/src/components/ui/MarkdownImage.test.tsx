import { Sheet } from "@pockode/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import type { FileContent } from "../../types/contents";
import type { StageComponent } from "../Media/types";
import { MarkdownContent } from "./MarkdownContent";

const getFile = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ workDir: "/work", actions: { getFile } }),
	isRPCTimeout: () => false,
}));

// The stage is the viewer's to test; here only what it is handed matters.
vi.mock("../Media/stages", () => {
	const Stage: StageComponent = ({ item }) => <p>stage: {item.name}</p>;
	return { loadedStage: () => Stage, loadStage: async () => Stage };
});

function imageFile(path: string, overrides: Partial<FileContent> = {}) {
	return {
		type: "file",
		file: {
			name: path.split("/").pop(),
			type: "file",
			path,
			size: 68,
			mime: "image/png",
			content: "",
			encoding: "http",
			...overrides,
		},
	};
}

function renderMarkdown(
	content: string,
	props: { baseDir?: string; onOpenFile?: (path: string) => void } = {},
	wrap: (node: ReactNode) => ReactNode = (node) => node,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, retryDelay: 0 } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			{wrap(<MarkdownContent content={content} {...props} />)}
		</QueryClientProvider>,
	);
}

/** The `<img>` once its frame is laid out, which jsdom never decodes on its own. */
async function loadImage(name: string) {
	const image = await screen.findByRole("img", { name });
	fireEvent.load(image);
	return image;
}

beforeEach(() => {
	reportEverythingInView();
	stubObjectUrls();
	stubImageFetch();
	getFile.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a Markdown image", () => {
	it("reads a relative path from the work directory's root by default", async () => {
		getFile.mockResolvedValue(imageFile("shots/a.png"));

		renderMarkdown("![shot](shots/a.png)");

		expect(await loadImage("shot")).toHaveAttribute("src", "blob:test/1");
		expect(getFile).toHaveBeenCalledWith("shots/a.png");
	});

	it("reads a relative path from the base directory its host gives", async () => {
		getFile.mockResolvedValue(imageFile("docs/img/a.png"));

		renderMarkdown("![shot](img/a.png)", { baseDir: "docs" });

		await loadImage("shot");
		expect(getFile).toHaveBeenCalledWith("docs/img/a.png");
	});

	it("reads nothing until it comes into view", async () => {
		globalThis.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof globalThis.IntersectionObserver;

		const { container } = renderMarkdown(
			"![shot](a.png)\n![badge](https://example.com/b.svg)",
		);

		expect(
			await screen.findByRole("status", { name: "shot" }),
		).toBeInTheDocument();
		expect(getFile).not.toHaveBeenCalled();
		expect(container.querySelector("img")).toBeNull();
	});

	it("does not take a missing file for a slow one", async () => {
		getFile.mockRejectedValue(new Error("not found: a.png"));

		renderMarkdown("![shot](a.png)");

		expect(await screen.findByText("not found: a.png")).toBeInTheDocument();
		expect(getFile).toHaveBeenCalledOnce();
	});

	// A message still streaming re-renders around the image.
	it("keeps the viewer open while the text around it grows", async () => {
		const user = userEvent.setup();
		const queryClient = new QueryClient();
		const content = "Look:\n![badge](https://example.com/a.png)";
		const tree = (text: string) => (
			<QueryClientProvider client={queryClient}>
				<MarkdownContent content={text} />
			</QueryClientProvider>
		);
		const { rerender } = render(tree(content));
		await loadImage("badge");
		await user.click(screen.getByRole("button", { name: "View badge" }));
		await screen.findByRole("dialog");

		rerender(tree(`${content}\n\nAnd more text arriving.`));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByText("And more text arriving.")).toBeInTheDocument();
	});

	it("opens a workspace image in the viewer, with Save and Open in Files", async () => {
		const user = userEvent.setup();
		const onOpenFile = vi.fn();
		getFile.mockResolvedValue(imageFile("a.png"));
		renderMarkdown("Look:\n![](a.png)", { onOpenFile });
		await loadImage("a.png");

		await user.click(screen.getByRole("button", { name: "View a.png" }));

		const viewer = await screen.findByRole("dialog");
		expect(within(viewer).getByText("stage: a.png")).toBeInTheDocument();
		expect(within(viewer).getByText("PNG · 68 B")).toBeInTheDocument();
		expect(
			within(viewer).getByRole("button", { name: "Save" }),
		).toBeInTheDocument();
		await user.click(
			within(viewer).getByRole("button", { name: "Open in Files" }),
		);
		expect(onOpenFile).toHaveBeenCalledWith("a.png");
	});

	it("says why a workspace read failed, and reads again on Retry", async () => {
		const user = userEvent.setup();
		getFile.mockRejectedValue(new Error("not found: a.png"));
		renderMarkdown("![shot](a.png)");

		expect(await screen.findByText("not found: a.png")).toBeInTheDocument();
		getFile.mockResolvedValue(imageFile("a.png"));
		await user.click(screen.getByRole("button", { name: "Retry" }));

		expect(await loadImage("shot")).toBeInTheDocument();
	});

	it("says a file that is not an image can't be previewed", async () => {
		getFile.mockResolvedValue(
			imageFile("notes.txt", {
				mime: "text/plain",
				encoding: "text",
				content: "hello",
			}),
		);

		renderMarkdown("![notes](notes.txt)");

		expect(await screen.findByText("Can't be previewed")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
	});

	it("never reads a path outside the work directory", async () => {
		renderMarkdown("![secret](/etc/a.png)");

		expect(
			await screen.findByText("Outside the work directory"),
		).toBeInTheDocument();
		expect(screen.getByText("secret")).toHaveAttribute("title", "/etc/a.png");
		expect(getFile).not.toHaveBeenCalled();
	});

	it("drops any other scheme, saying so instead of drawing it", () => {
		const { container } = renderMarkdown("![pixel](data:image/png;base64,AA)");

		expect(
			screen.getByText("Not shown: unsupported address"),
		).toBeInTheDocument();
		expect(container.querySelector("img")).toBeNull();
	});

	describe("from another server", () => {
		const SRC = "https://example.com/badge.svg";

		it("loads lazily and tells the host nothing about the page", () => {
			renderMarkdown(`![badge](${SRC})`);

			const image = screen.getByRole("img", { name: "badge" });
			expect(image).toHaveAttribute("src", SRC);
			expect(image).toHaveAttribute("loading", "lazy");
			expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
		});

		it("names the host when it fails, and tries again on Retry", async () => {
			const user = userEvent.setup();
			renderMarkdown(`![badge](${SRC})`);

			fireEvent.error(screen.getByRole("img", { name: "badge" }));
			expect(
				screen.getByText("Couldn't load image · example.com"),
			).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Retry" }));

			expect(screen.getByRole("img", { name: "badge" })).toBeInTheDocument();
		});

		it("opens in the viewer with the original instead of Save", async () => {
			const user = userEvent.setup();
			renderMarkdown(`![badge](${SRC})`);
			await loadImage("badge");

			await user.click(screen.getByRole("button", { name: "View badge" }));

			const viewer = await screen.findByRole("dialog");
			expect(within(viewer).getByText("example.com")).toBeInTheDocument();
			expect(within(viewer).queryByRole("button", { name: "Save" })).toBeNull();
			const original = within(viewer).getByRole("link", {
				name: "Open original",
			});
			expect(original).toHaveAttribute("href", SRC);
			expect(original).toHaveAttribute("target", "_blank");
			expect(original).toHaveAttribute("rel", "noopener noreferrer");
		});
	});

	describe("shape", () => {
		it("is a block alone on its line, with Retry on failure", () => {
			renderMarkdown("Screenshot:\n![shot](https://example.com/a.png)");

			fireEvent.error(screen.getByRole("img", { name: "shot" }));
			expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
		});

		// The image is a box of its own; a break leading the next line would
		// draw an empty one under it.
		it("starts the next line under a block without a blank line", () => {
			const { container } = renderMarkdown(
				"Before:\n![shot](https://example.com/a.png)\nAfter",
			);

			expect(container.querySelectorAll("br")).toHaveLength(1);
			expect(screen.getByText(/After/)).toBeInTheDocument();
		});

		it.each([
			["beside text", "Status ![badge](https://example.com/a.png) ok"],
			[
				"beside another image",
				"![badge](https://example.com/a.png) ![b](https://example.com/b.png)",
			],
			[
				"in a table cell",
				"| a |\n| - |\n| ![badge](https://example.com/a.png) |",
			],
			["in a heading", "# ![badge](https://example.com/a.png) Title"],
		])("is inline %s, its failure a label with no Retry", (_, content) => {
			renderMarkdown(content);

			fireEvent.error(screen.getByRole("img", { name: "badge" }));
			expect(screen.getByText("badge")).toHaveAttribute(
				"title",
				"https://example.com/a.png\nCouldn't load image · example.com",
			);
			expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
		});
	});

	it("follows its link rather than opening the viewer", async () => {
		renderMarkdown(
			"[![build](https://example.com/b.svg)](https://ci.example.com)",
		);
		await loadImage("build");

		expect(screen.getByRole("link")).toHaveAttribute(
			"href",
			"https://ci.example.com",
		);
		expect(screen.queryByRole("button", { name: "View build" })).toBeNull();
	});

	// The viewer is a sheet, and sheets do not nest.
	it("opens nothing inside a sheet", async () => {
		renderMarkdown("![badge](https://example.com/a.png)", {}, (node) => (
			<Sheet title="Full screen" onClose={() => {}}>
				{node}
			</Sheet>
		));
		await loadImage("badge");

		expect(screen.queryByRole("button", { name: "View badge" })).toBeNull();
	});
});
