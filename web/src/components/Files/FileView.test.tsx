import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LARGE_DOWNLOAD_WARNING_SIZE } from "../../lib/fileDownload";
import type { FileContent } from "../../types/contents";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import FileView from "./FileView";

const getFile = vi.fn();
const downloadFile = vi.fn();

// Only the transfer itself is replaced; the size threshold and the abort check
// are the real ones, so the view is tested against the rules it ships with.
vi.mock("../../lib/fileDownload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/fileDownload")>()),
	downloadFile: (...args: unknown[]) => downloadFile(...args),
}));

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ actions: { getFile, deleteFile: vi.fn() } }),
	isRPCTimeout: () => false,
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
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
	isMarkdownFile: () => false,
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

async function renderFileView(file: FileContent) {
	getFile.mockResolvedValue({ type: "file", file });

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
	return result;
}

function editButton() {
	return screen.getByRole("button", { name: /^Edit/ });
}

function downloadButton() {
	return screen.getByRole("button", { name: "Download" });
}

describe("FileView", { timeout: 20_000 }, () => {
	beforeEach(() => {
		getFile.mockReset();
		downloadFile.mockReset();
		downloadFile.mockResolvedValue(undefined);
	});

	it("shows text content and allows editing", async () => {
		await renderFileView(fileContent({ content: "const a = 1;" }));

		expect(screen.getByText("const a = 1;")).toBeInTheDocument();
		expect(editButton()).toBeEnabled();
	});

	it("renders images from the server's MIME type, and blocks editing", async () => {
		await renderFileView(
			fileContent({
				path: "logo.avif",
				mime: "image/avif",
				encoding: "base64",
				content: "AAAA",
				size: 4,
			}),
		);

		expect(screen.getByRole("img", { name: "logo.avif" })).toHaveAttribute(
			"src",
			"data:image/avif;base64,AAAA",
		);
		expect(editButton()).toBeDisabled();
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

		expect(screen.getByRole("img", { name: "icon.svg" })).toBeInTheDocument();
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
		expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
	});

	it("marks an empty file as empty but still editable", async () => {
		await renderFileView(fileContent({ content: "", size: 0 }));

		expect(screen.getByText("Empty file")).toBeInTheDocument();
		expect(editButton()).toBeEnabled();
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

			expect(downloadFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "src/app.ts", worktree: "" }),
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

			expect(downloadFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "app.zip" }),
			);
		});

		it("reports a failed download in the action banner", async () => {
			const user = userEvent.setup();
			downloadFile.mockRejectedValue(new Error("File not found"));
			await renderFileView(fileContent({}));

			await user.click(downloadButton());

			expect(
				await screen.findByText("Download failed: File not found"),
			).toBeInTheDocument();
		});

		it("cancels a running download on the next click, without reporting it", async () => {
			const user = userEvent.setup();
			let abortSignal: AbortSignal | undefined;
			downloadFile.mockImplementation(({ signal }: { signal: AbortSignal }) => {
				abortSignal = signal;
				return new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						const aborted = new Error("The operation was aborted.");
						aborted.name = "AbortError";
						reject(aborted);
					});
				});
			});
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
			downloadFile.mockRejectedValue(new Error("File not found"));
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

		it("confirms before a file large enough to strain the browser", async () => {
			const user = userEvent.setup();
			await renderFileView(
				fileContent({
					path: "dump.log",
					encoding: "none",
					omitted: "too_large",
					content: "",
					size: LARGE_DOWNLOAD_WARNING_SIZE + 1,
				}),
			);

			await user.click(screen.getByText("Download"));
			expect(downloadFile).not.toHaveBeenCalled();

			const dialog = screen.getByRole("dialog", {
				name: "Download this file?",
			});
			expect(
				within(dialog).getByText(/This file is 200 MB/),
			).toBeInTheDocument();
			await user.click(
				within(dialog).getByRole("button", { name: "Download" }),
			);

			expect(downloadFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "dump.log" }),
			);
		});
	});
});
