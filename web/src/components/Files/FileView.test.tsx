import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "../../types/contents";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import FileView from "./FileView";

const getFile = vi.fn();

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

	render(<FileView path={file.path} onBack={vi.fn()} />, { wrapper });
	// Every case needs the fetch to have landed before it can assert anything,
	// and the default 1s outruns a query round trip on a loaded machine.
	await screen.findByRole("button", { name: /^Edit/ }, { timeout: 10_000 });
}

function editButton() {
	return screen.getByRole("button", { name: /^Edit/ });
}

describe("FileView", { timeout: 20_000 }, () => {
	beforeEach(() => {
		getFile.mockReset();
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
});
