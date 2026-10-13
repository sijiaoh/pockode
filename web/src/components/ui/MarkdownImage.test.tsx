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

let hosts = 0;
/**
 * A host no other test has loaded from: the page remembers every external URL
 * it requested, for as long as the test file runs.
 */
function freshHost() {
	hosts += 1;
	return `h${hosts}.example.com`;
}

/** The reader's tap on a held external image. */
async function allow(name: string, host: string) {
	await userEvent.click(
		screen.getByRole("button", { name: `Load ${name} from ${host}` }),
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

		const host = freshHost();
		const { container } = renderMarkdown(
			`![shot](a.png)\n![badge](https://${host}/b.svg)`,
		);
		// Even an allowed host is asked only once the image is on screen.
		await allow("badge", host);

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
		const host = freshHost();
		const content = `Look:\n![badge](https://${host}/a.png)`;
		const tree = (text: string) => (
			<QueryClientProvider client={queryClient}>
				<MarkdownContent content={text} />
			</QueryClientProvider>
		);
		const { rerender } = render(tree(content));
		await allow("badge", host);
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
		let host: string;
		let src: string;
		beforeEach(() => {
			host = freshHost();
			src = `https://${host}/badge.svg`;
		});

		it("asks nothing of the host until the reader allows it", async () => {
			const { container } = renderMarkdown(`Look:\n![badge](${src})`);

			expect(screen.getByText(`Not loaded · ${host}`)).toBeInTheDocument();
			expect(container.querySelector("img")).toBeNull();
			await allow("badge", host);

			expect(screen.getByRole("img", { name: "badge" })).toHaveAttribute(
				"src",
				src,
			);
		});

		it("holds an inline image as a button naming the host", async () => {
			const { container } = renderMarkdown(`Status ![badge](${src}) ok`);

			expect(container.querySelector("img")).toBeNull();
			const held = screen.getByRole("button", {
				name: `Load badge from ${host}`,
			});
			expect(held).toHaveAttribute("title", src);
			await userEvent.click(held);

			expect(screen.getByRole("img", { name: "badge" })).toBeInTheDocument();
		});

		it("loads lazily and tells the host nothing about the page", async () => {
			renderMarkdown(`![badge](${src})`);
			await allow("badge", host);

			const image = screen.getByRole("img", { name: "badge" });
			expect(image).toHaveAttribute("src", src);
			expect(image).toHaveAttribute("loading", "lazy");
			expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
		});

		// A badge row is one tap, and stays allowed while the text streams in.
		it("allows the host for every image of it in the same text", async () => {
			const other = freshHost();
			const queryClient = new QueryClient();
			const tree = (text: string) => (
				<QueryClientProvider client={queryClient}>
					<MarkdownContent content={text} />
				</QueryClientProvider>
			);
			const content = `![a](https://${host}/a.svg) ![b](https://${other}/b.svg)`;
			const { rerender } = render(tree(content));

			await allow("a", host);
			rerender(tree(`${content} ![c](https://${host}/c.svg)`));

			expect(screen.getByRole("img", { name: "a" })).toBeInTheDocument();
			expect(screen.getByRole("img", { name: "c" })).toBeInTheDocument();
			expect(screen.queryByRole("img", { name: "b" })).toBeNull();
		});

		it("keeps the reader's place when Load gives way to the image", async () => {
			renderMarkdown(`Look:\n![badge](${src})`);

			await allow("badge", host);

			expect(document.activeElement).not.toBe(document.body);
			expect(document.activeElement).toContainElement(
				screen.getByRole("img", { name: "badge" }),
			);
		});

		it("keeps the reader's place when the image then fails", async () => {
			renderMarkdown(`Look:\n![badge](${src})`);
			await allow("badge", host);

			fireEvent.error(screen.getByRole("img", { name: "badge" }));

			expect(document.activeElement).not.toBe(document.body);
			expect(document.activeElement).toContainElement(
				screen.getByRole("button", { name: "Retry" }),
			);
		});

		// A host that shows another file or work item in the same place need not
		// remount the text.
		it("forgets the host when the text is swapped for another", async () => {
			const queryClient = new QueryClient();
			const tree = (text: string) => (
				<QueryClientProvider client={queryClient}>
					<MarkdownContent content={text} />
				</QueryClientProvider>
			);
			const { rerender } = render(tree(`![a](https://${host}/a.svg)`));
			await allow("a", host);

			rerender(tree(`![b](https://${host}/b.svg)`));

			expect(screen.queryByRole("img", { name: "b" })).toBeNull();
			expect(
				screen.getByRole("button", { name: `Load b from ${host}` }),
			).toBeInTheDocument();
		});

		it("does not allow the host in another text", async () => {
			const queryClient = new QueryClient();
			render(
				<QueryClientProvider client={queryClient}>
					<MarkdownContent content={`![a](https://${host}/a.svg)`} />
					<MarkdownContent content={`![b](https://${host}/b.svg)`} />
				</QueryClientProvider>,
			);

			await allow("a", host);

			expect(screen.getByRole("img", { name: "a" })).toBeInTheDocument();
			expect(screen.queryByRole("img", { name: "b" })).toBeNull();
		});

		it("does not ask again for a URL it has already requested", async () => {
			const first = renderMarkdown(`![badge](${src})`);
			await allow("badge", host);
			first.unmount();

			renderMarkdown(`![badge](${src})`);

			expect(screen.getByRole("img", { name: "badge" })).toHaveAttribute(
				"src",
				src,
			);
		});

		it("names the host when it fails, and tries again on Retry", async () => {
			const user = userEvent.setup();
			renderMarkdown(`![badge](${src})`);
			await allow("badge", host);

			fireEvent.error(screen.getByRole("img", { name: "badge" }));
			expect(
				screen.getByText(`Couldn't load image · ${host}`),
			).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Retry" }));

			expect(screen.getByRole("img", { name: "badge" })).toBeInTheDocument();
		});

		it("opens in the viewer with the original instead of Save", async () => {
			const user = userEvent.setup();
			renderMarkdown(`![badge](${src})`);
			await allow("badge", host);
			await loadImage("badge");

			await user.click(screen.getByRole("button", { name: "View badge" }));

			const viewer = await screen.findByRole("dialog");
			expect(within(viewer).getByText(host)).toBeInTheDocument();
			expect(within(viewer).queryByRole("button", { name: "Save" })).toBeNull();
			const original = within(viewer).getByRole("link", {
				name: "Open original",
			});
			expect(original).toHaveAttribute("href", src);
			expect(original).toHaveAttribute("target", "_blank");
			expect(original).toHaveAttribute("rel", "noopener noreferrer");
		});
	});

	describe("shape", () => {
		it("is a block alone on its line, with Retry on failure", async () => {
			const host = freshHost();
			renderMarkdown(`Screenshot:\n![shot](https://${host}/a.png)`);
			await allow("shot", host);

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
			["beside text", (src: string) => `Status ![badge](${src}) ok`],
			[
				"beside another image",
				(src: string) => `![badge](${src}) ![b](https://example.com/b.png)`,
			],
			[
				"in a table cell",
				(src: string) => `| a |\n| - |\n| ![badge](${src}) |`,
			],
			["in a heading", (src: string) => `# ![badge](${src}) Title`],
		])("is inline %s, its failure a label with no Retry", async (_, content) => {
			const host = freshHost();
			const src = `https://${host}/a.png`;
			renderMarkdown(content(src));
			await allow("badge", host);

			fireEvent.error(screen.getByRole("img", { name: "badge" }));
			expect(screen.getByText("badge")).toHaveAttribute(
				"title",
				`${src}\nCouldn't load image · ${host}`,
			);
			expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
		});
	});

	it("follows its link rather than opening the viewer", async () => {
		getFile.mockResolvedValue(imageFile("b.svg"));
		renderMarkdown("[![build](b.svg)](https://ci.example.com)");
		await loadImage("build");

		expect(screen.getByRole("link")).toHaveAttribute(
			"href",
			"https://ci.example.com",
		);
		expect(screen.queryByRole("button", { name: "View build" })).toBeNull();
	});

	// A button may not nest in an <a>, so the link itself is the Load.
	it("takes a link's first activation as Load when it holds an external image", async () => {
		const user = userEvent.setup();
		const host = freshHost();
		const { container } = renderMarkdown(
			`[![build](https://${host}/b.svg)](https://ci.example.com)`,
		);
		const link = screen.getByRole("link");
		expect(container.querySelector("img")).toBeNull();
		expect(within(link).queryByRole("button")).toBeNull();

		// Read past React's root listener, then stopped: jsdom cannot navigate.
		const follows = () => {
			let followed: boolean | null = null;
			window.addEventListener(
				"click",
				(event) => {
					followed = !event.defaultPrevented;
					event.preventDefault();
				},
				{ once: true },
			);
			return () => followed;
		};

		const first = follows();
		link.focus();
		await user.keyboard("{Enter}");
		expect(first()).toBe(false);
		expect(screen.getByRole("img", { name: "build" })).toBeInTheDocument();

		const second = follows();
		await user.click(link);
		expect(second()).toBe(true);
	});

	// The viewer is a sheet, and sheets do not nest.
	it("opens nothing inside a sheet", async () => {
		const host = freshHost();
		renderMarkdown(`![badge](https://${host}/a.png)`, {}, (node) => (
			<Sheet title="Full screen" onClose={() => {}}>
				{node}
			</Sheet>
		));
		await allow("badge", host);
		await loadImage("badge");

		expect(screen.queryByRole("button", { name: "View badge" })).toBeNull();
	});
});
