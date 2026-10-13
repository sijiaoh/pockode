import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentsQueryKey } from "../../hooks/useContents";
import { overlayToNavigation } from "../../lib/navigation";
import {
	reportEverythingInView,
	stubImageFetch,
	stubObjectUrls,
} from "../../test/imageFixtures";
import type { Entry, FileContent } from "../../types/contents";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import FileView from "./FileView";

const getFile = vi.fn();
const saveRawFile = vi.fn();
const renameFile = vi.fn();
const navigate = vi.fn();

// Only the hand-over to the browser is replaced; the players' capabilities
// are the real ones.
vi.mock("../../hooks/useRawMediaSource", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useRawMediaSource")>()),
	saveRawFile: (...args: unknown[]) => saveRawFile(...args),
}));

const rawCapability = vi.fn();

vi.mock("../../lib/wsStore", () => {
	// Built on each read: the factory is hoisted above the mocks it closes over.
	const state = () => ({
		status: "connected",
		actions: { getFile, deleteFile: vi.fn(), renameFile },
	});
	return {
		useWSStore: Object.assign(
			(selector: (state: unknown) => unknown) => selector(state()),
			{ getState: state },
		),
		wsActions: {
			rawCapability: (...args: unknown[]) => rawCapability(...args),
		},
		isRPCTimeout: () => false,
	};
});

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));

vi.mock("../../hooks/useFSWatch", () => ({
	useFSWatch: () => {},
}));

vi.mock("../../hooks/useRouteState", () => ({
	useCurrentWorktree: () => "",
	useRouteState: () => ({ sessionId: null }),
}));

// Shiki loads real grammars and tokenizes on the main thread; the viewer's own
// branching is what these cases are about.
vi.mock("../../lib/shikiUtils", () => ({
	CodeHighlighter: ({ children }: { children: string }) => (
		<pre>{children}</pre>
	),
	getLanguageFromPath: () => undefined,
	isMarkdownFile: (path: string) => path.endsWith(".md"),
}));

// Stands in for an image's viewer, whose Open in Files hands back this path.
vi.mock("../ui/MarkdownContent", () => ({
	MarkdownContent: ({ onOpenFile }: { onOpenFile?: (path: string) => void }) =>
		onOpenFile && (
			<button type="button" onClick={() => onOpenFile("docs/a.png")}>
				Image · Open in Files
			</button>
		),
}));

function fileContent(overrides: Partial<FileContent>): FileContent {
	return {
		name: "app.ts",
		type: "file",
		path: "src/app.ts",
		size: 5,
		mime: "text/plain; charset=utf-8",
		content: "hello",
		encoding: "text",
		...overrides,
	};
}

/**
 * `siblings` is what the file's own folder holds, which is what the rename
 * sheet checks a new name against. A file reached from search or a chat link
 * has no listing cached for that folder, so the sheet fetches one.
 */
async function renderFileView(file: FileContent, siblings: Entry[] = []) {
	getFile.mockImplementation(async (path: string) =>
		path === file.path
			? { type: "file", file }
			: { type: "directory", entries: siblings },
	);

	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);

	const result = render(<FileView path={file.path} onBack={vi.fn()} />, {
		wrapper,
	});
	// Every case needs the fetch to have landed before it can assert anything,
	// and the default 1s outruns a query round trip on a loaded machine.
	await screen.findByRole("button", { name: /^Edit/ }, { timeout: 10_000 });
	return { ...result, queryClient };
}

function editButton() {
	return screen.getByRole("button", { name: /^Edit/ });
}

function downloadButton() {
	return screen.getByRole("button", { name: "Download" });
}

describe("FileView", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	beforeEach(() => {
		getFile.mockReset();
		saveRawFile.mockReset();
		saveRawFile.mockResolvedValue(undefined);
		renameFile.mockReset();
		renameFile.mockResolvedValue(undefined);
		navigate.mockReset();
	});

	it("shows text content and allows editing", async () => {
		await renderFileView(fileContent({ content: "const a = 1;" }));

		expect(screen.getByText("const a = 1;")).toBeInTheDocument();
		expect(editButton()).toBeEnabled();
	});

	it("reads a raster image over HTTP from the server's MIME type, and blocks editing", async () => {
		reportEverythingInView();
		stubObjectUrls();
		const fetchMock = stubImageFetch();
		await renderFileView(
			fileContent({
				path: "logo.avif",
				mime: "image/avif",
				encoding: "http",
				content: "",
				size: 4,
			}),
		);

		expect(
			await screen.findByRole("img", { name: "logo.avif" }),
		).toHaveAttribute("src", "blob:test/1");
		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("/api/files/download?path=logo.avif");
		expect(editButton()).toBeDisabled();
	});

	it("says why an image's bytes could not be read, and reads them again on Retry", async () => {
		const user = userEvent.setup();
		reportEverythingInView();
		stubObjectUrls();
		const fetchMock = stubImageFetch();
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "gone", code: "not_found" }), {
				status: 404,
			}),
		);
		await renderFileView(
			fileContent({
				path: "logo.png",
				mime: "image/png",
				encoding: "http",
				content: "",
				size: 4,
			}),
		);

		expect(await screen.findByText("Couldn't load image")).toBeInTheDocument();
		expect(screen.getByText(/File not found/)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("img", { name: "logo.png" }),
		).toHaveAttribute("src", "blob:test/1");
	});

	it("renders SVG as an image while keeping its source editable", async () => {
		await renderFileView(
			fileContent({
				path: "icon.svg",
				mime: "image/svg+xml",
				encoding: "text",
				content: "<svg/>",
				size: 6,
			}),
		);

		// Shown from its source: SVG is never read into a same-origin object URL.
		expect(screen.getByRole("img", { name: "icon.svg" })).toHaveAttribute(
			"src",
			"data:image/svg+xml,%3Csvg%2F%3E",
		);
		expect(editButton()).toBeEnabled();
	});

	it("describes a binary file instead of previewing it", async () => {
		await renderFileView(
			fileContent({
				path: "app.zip",
				mime: "application/zip",
				encoding: "none",
				omitted: "binary",
				content: "",
				size: 4096,
			}),
		);

		expect(screen.getByText("Binary file")).toBeInTheDocument();
		expect(screen.getByText("application/zip")).toBeInTheDocument();
		expect(screen.getByText("4 KB")).toBeInTheDocument();
		expect(editButton()).toBeDisabled();
		// The other half of `FileBody`'s `readOnly`: the sentence belongs here,
		// where there is a disabled button for it to explain.
		expect(
			screen.getByText("Editing is disabled for binary files."),
		).toBeInTheDocument();
		// The regression this replaces: no way to delete what you cannot preview.
		expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
	});

	it("names the server's limit on an oversized file, and keeps Delete", async () => {
		await renderFileView(
			fileContent({
				path: "dump.log",
				mime: "text/plain; charset=utf-8",
				encoding: "none",
				omitted: "too_large",
				content: "",
				size: 5_000_000,
				limit: 2 << 20,
			}),
		);

		expect(
			screen.getByText("File is too large to preview"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Files over 2 MB aren't loaded/),
		).toBeInTheDocument();
		expect(editButton()).toBeDisabled();
		expect(
			screen.getByText("Editing is disabled for files this large."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
	});

	it("marks an empty file as empty but still editable", async () => {
		await renderFileView(fileContent({ content: "", size: 0 }));

		expect(screen.getByText("Empty file")).toBeInTheDocument();
		expect(editButton()).toBeEnabled();
	});

	describe("HTML page", () => {
		const page = (overrides: Partial<FileContent> = {}) =>
			fileContent({
				name: "index.html",
				path: "site/index.html",
				mime: "text/html; charset=utf-8",
				content: "<h1>Hi</h1>",
				size: 11,
				...overrides,
			});

		beforeEach(() => {
			reportEverythingInView();
			let issued = 0;
			rawCapability.mockReset();
			rawCapability.mockImplementation(async () => ({
				path: `/api/raw/cap${++issued}/`,
				expiresAt: Date.now() + 60 * 60 * 1000,
				worktree: "",
			}));
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("x", { status: 206 })),
			);
		});

		function frame() {
			return screen.findByTitle<HTMLIFrameElement>("index.html");
		}

		it("opens rendered, with its source a toggle away and still editable", async () => {
			await renderFileView(page());

			const element = await frame();
			expect(element.tagName).toBe("IFRAME");
			expect(element).toHaveAttribute("sandbox");
			expect(screen.queryByText("<h1>Hi</h1>")).not.toBeInTheDocument();
			expect(editButton()).toBeEnabled();

			await userEvent.click(
				screen.getByRole("button", { name: "Show source" }),
			);
			expect(screen.getByText("<h1>Hi</h1>")).toBeInTheDocument();
			expect(screen.queryByTitle("index.html")).not.toBeInTheDocument();
			expect(editButton()).toBeEnabled();
			expect(screen.getByRole("button", { name: "Show page" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		});

		it("places the toggle after Download and before Delete", async () => {
			await renderFileView(page());

			const labels = screen
				.getAllByRole("button")
				.map((button) => button.getAttribute("aria-label"))
				.filter((label): label is string =>
					["Download", "Show source", "Delete"].includes(label ?? ""),
				);
			expect(labels).toEqual(["Download", "Show source", "Delete"]);
		});

		it("renders a page too large to send, with editing disabled", async () => {
			await renderFileView(
				page({
					encoding: "none",
					omitted: "too_large",
					content: "",
					size: 5 * 1024 * 1024,
					limit: 2 * 1024 * 1024,
				}),
			);

			await frame();
			expect(editButton()).toBeDisabled();
			await userEvent.click(
				screen.getByRole("button", { name: "Show source" }),
			);
			expect(
				screen.getByText("File is too large to preview"),
			).toBeInTheDocument();
		});

		it("reloads the page when it is rewritten, not when it is only fetched again", async () => {
			const { queryClient } = await renderFileView(page());
			const element = await frame();
			// Each load the app starts is checked once it lands, and a load from
			// anything else is not: the probe count says which this was.
			const probes = vi.mocked(fetch);
			fireEvent.load(element);
			await waitFor(() => expect(probes).toHaveBeenCalledTimes(1));

			await act(() =>
				queryClient.invalidateQueries({
					queryKey: contentsQueryKey(page().path),
				}),
			);
			expect(getFile).toHaveBeenCalledTimes(2);
			fireEvent.load(element);
			await act(async () => {});
			expect(probes).toHaveBeenCalledTimes(1);

			getFile.mockImplementation(async () => ({
				type: "file",
				file: page({ content: "<h1>Bye</h1>", size: 12 }),
			}));
			await act(() =>
				queryClient.invalidateQueries({
					queryKey: contentsQueryKey(page().path),
				}),
			);
			// Until the reload has its capability, a load is the old one's.
			await waitFor(() => {
				fireEvent.load(element);
				expect(probes).toHaveBeenCalledTimes(2);
			});
			expect(await frame()).toBe(element);
		});

		it("does not carry a page's source view over to text that is not a page", async () => {
			const { rerender } = await renderFileView(page());
			await userEvent.click(
				screen.getByRole("button", { name: "Show source" }),
			);

			const text = fileContent({ content: "const a = 1;" });
			getFile.mockImplementation(async () => ({ type: "file", file: text }));
			rerender(<FileView path={text.path} onBack={vi.fn()} />);
			expect(await screen.findByText("const a = 1;")).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /Show (source|page)/ }),
			).not.toBeInTheDocument();
		});
	});

	it("warns that a large text file is shown unhighlighted", async () => {
		await renderFileView(
			fileContent({ content: "big", size: HIGHLIGHT_LIMIT + 1 }),
		);

		expect(
			screen.getByText("Large file — showing plain text only."),
		).toBeInTheDocument();
		expect(screen.getByText("big")).toBeInTheDocument();
		expect(editButton()).toBeEnabled();
	});

	describe("download", () => {
		it("saves the file the view is showing", async () => {
			const user = userEvent.setup();
			await renderFileView(fileContent({}));

			await user.click(downloadButton());

			expect(saveRawFile).toHaveBeenCalledWith(
				expect.anything(),
				{ kind: "file", path: "src/app.ts" },
				"app.ts",
				expect.any(AbortSignal),
			);
		});

		it("keeps the destructive action last in the action bar", async () => {
			await renderFileView(fileContent({}));

			const labels = screen
				.getAllByRole("button")
				.map((button) => button.getAttribute("aria-label"))
				.filter((label): label is string =>
					["Edit", "Download", "Delete"].includes(label ?? ""),
				);
			expect(labels).toEqual(["Edit", "Download", "Delete"]);
		});

		it("offers the download from the card that stands in for a binary file", async () => {
			const user = userEvent.setup();
			await renderFileView(
				fileContent({
					path: "app.zip",
					mime: "application/zip",
					encoding: "none",
					omitted: "binary",
					content: "",
					size: 4096,
				}),
			);

			// The file the viewer cannot render is the one most likely to be wanted
			// elsewhere, so the card carries the action too. The bottom bar's button
			// is an icon, so the labelled one is the card's.
			await user.click(screen.getByText("Download"));

			expect(saveRawFile).toHaveBeenCalledWith(
				expect.anything(),
				{ kind: "file", path: "app.zip" },
				"app.zip",
				expect.any(AbortSignal),
			);
		});

		it("reports a failed download in the action banner", async () => {
			const user = userEvent.setup();
			saveRawFile.mockRejectedValue(new Error("File not found"));
			await renderFileView(fileContent({}));

			await user.click(downloadButton());

			expect(
				await screen.findByText("Download failed: File not found"),
			).toBeInTheDocument();
		});

		it("cancels a running download on the next click, without reporting it", async () => {
			const user = userEvent.setup();
			let abortSignal: AbortSignal | undefined;
			saveRawFile.mockImplementation(
				(
					_client: unknown,
					_origin: unknown,
					_name: string,
					signal: AbortSignal,
				) => {
					abortSignal = signal;
					return new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => {
							const aborted = new Error("The operation was aborted.");
							aborted.name = "AbortError";
							reject(aborted);
						});
					});
				},
			);
			await renderFileView(fileContent({}));

			await user.click(downloadButton());
			const cancel = await screen.findByRole("button", {
				name: "Cancel download",
			});
			await user.click(cancel);

			expect(abortSignal?.aborted).toBe(true);
			await waitFor(() => expect(downloadButton()).toBeInTheDocument());
			expect(screen.queryByText(/Download failed/)).not.toBeInTheDocument();
		});

		it("does not carry one file's failure over to the next", async () => {
			const user = userEvent.setup();
			saveRawFile.mockRejectedValue(new Error("File not found"));
			const { rerender } = await renderFileView(fileContent({}));
			await user.click(downloadButton());
			await screen.findByText("Download failed: File not found");

			// The view is reused across paths, so a banner about the file that was
			// open would otherwise sit above the one that is.
			getFile.mockResolvedValue({
				type: "file",
				file: fileContent({ path: "other.ts", content: "the next file" }),
			});
			rerender(<FileView path="other.ts" onBack={vi.fn()} />);

			// Waiting for the new content matters: while the query is in flight the
			// viewer renders a spinner instead of its children, which would hide a
			// surviving banner and make this pass either way.
			expect(await screen.findByText("the next file")).toBeInTheDocument();
			expect(screen.queryByText(/Download failed/)).not.toBeInTheDocument();
		});
	});

	it("opens an image of a Markdown file in Files, over the document", async () => {
		const user = userEvent.setup();
		await renderFileView(
			fileContent({ name: "guide.md", path: "docs/guide.md" }),
		);

		await user.click(
			screen.getByRole("button", { name: "Image · Open in Files" }),
		);

		// Pushed: Back returns to the document.
		expect(navigate).toHaveBeenCalledWith(
			overlayToNavigation({ type: "file", path: "docs/a.png" }, "", null),
		);
	});

	describe("renaming", () => {
		// The only way to rename a file opened from search or from a chat link:
		// neither has a tree row, so neither has the row's `…` menu.
		it("renames in place and follows the file to its new path", async () => {
			const user = userEvent.setup();
			await renderFileView(fileContent({ content: "const a = 1;" }));

			await user.click(screen.getByRole("button", { name: "Rename" }));
			const sheet = screen.getByRole("dialog", { name: "Rename file" });
			await user.clear(screen.getByLabelText("Name"));
			await user.type(screen.getByLabelText("Name"), "main.ts");
			await user.click(within(sheet).getByRole("button", { name: "Rename" }));

			expect(renameFile).toHaveBeenCalledWith("src/app.ts", "main.ts");
			// Followed rather than closed: nothing was lost, and the user is still
			// reading the same file.
			await waitFor(() =>
				expect(navigate).toHaveBeenCalledWith(
					expect.objectContaining({ params: { _splat: "src/main.ts" } }),
				),
			);
		});

		it("stays available for a file the viewer cannot render", async () => {
			const user = userEvent.setup();
			await renderFileView(
				fileContent({
					path: "src/dump.bin",
					mime: "application/octet-stream",
					encoding: "none",
					omitted: "binary",
					content: "",
					size: 9,
				}),
			);

			// Not being able to preview a file is no reason to be unable to name it.
			await user.click(screen.getByRole("button", { name: "Rename" }));
			expect(screen.getByLabelText("Name")).toHaveValue("dump.bin");
		});

		it("refuses a name the folder already holds, without asking the server", async () => {
			const user = userEvent.setup();
			await renderFileView(fileContent({}), [
				{ name: "main.ts", type: "file", path: "src/main.ts" },
			]);

			await user.click(screen.getByRole("button", { name: "Rename" }));
			await user.clear(screen.getByLabelText("Name"));
			await user.type(screen.getByLabelText("Name"), "main.ts");

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"already exists here",
			);
			expect(renameFile).not.toHaveBeenCalled();
		});

		it("reports a failed rename instead of leaving it looking done", async () => {
			const user = userEvent.setup();
			renameFile.mockRejectedValue(new Error("permission denied"));
			await renderFileView(fileContent({}));

			await user.click(screen.getByRole("button", { name: "Rename" }));
			const sheet = screen.getByRole("dialog", { name: "Rename file" });
			await user.clear(screen.getByLabelText("Name"));
			await user.type(screen.getByLabelText("Name"), "main.ts");
			await user.click(within(sheet).getByRole("button", { name: "Rename" }));

			expect(await screen.findByText("permission denied")).toBeInTheDocument();
			expect(navigate).not.toHaveBeenCalled();
		});
	});
});
