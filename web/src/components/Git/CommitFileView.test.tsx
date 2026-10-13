import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWSStore, wsActions } from "../../lib/wsStore";
import { reportEverythingInView } from "../../test/imageFixtures";
import type { FileContent } from "../../types/contents";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import CommitFileView from "./CommitFileView";

const navigate = vi.fn();
const downloadFile = vi.fn();
let file: FileContent;

// Only the transfer itself is replaced; what it is asked for is the contract.
vi.mock("../../lib/fileDownload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/fileDownload")>()),
	downloadFile: (...args: unknown[]) => downloadFile(...args),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));

vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));

vi.mock("../../hooks/useGitCommit", () => ({
	useGitCommit: () => ({
		data: {
			hash: "abc1234def",
			subject: "Do a thing",
			author: "a",
			date: "d",
			files: [],
		},
	}),
}));

vi.mock("../../hooks/useCommitFile", () => ({
	useCommitFile: () => ({ data: file, isLoading: false, error: null }),
}));

// Shiki tokenizes on the main thread with real grammars; what matters here is
// which of the two renderers the toggle picks.
vi.mock("../../lib/shikiUtils", () => ({
	CodeHighlighter: ({ children }: { children: string }) => (
		<pre>{children}</pre>
	),
	getLanguageFromPath: () => undefined,
	isMarkdownFile: (path: string) => path.endsWith(".md"),
}));

vi.mock("../ui/MarkdownContent", () => ({
	MarkdownContent: ({ content }: { content: string }) => (
		<div data-testid="markdown">{content}</div>
	),
}));

beforeEach(() => {
	navigate.mockClear();
	downloadFile.mockReset();
	downloadFile.mockResolvedValue(undefined);
	file = {
		name: "readme.md",
		type: "file",
		path: "docs/readme.md",
		size: 7,
		mime: "text/markdown; charset=utf-8",
		content: "# Title",
		encoding: "text",
	};
});

// A version the viewer cannot preview: the case that has a stand-in card, and
// nothing for the plain-text toggle to act on.
const binaryFile: FileContent = {
	name: "logo.ico",
	type: "file",
	path: "assets/logo.ico",
	size: 4096,
	mime: "application/octet-stream",
	content: "",
	encoding: "none",
	omitted: "binary",
};

const tooLargeFile: FileContent = {
	name: "readme.md",
	type: "file",
	path: "docs/readme.md",
	size: 3 * 1024 * 1024,
	mime: "text/markdown; charset=utf-8",
	content: "",
	encoding: "none",
	omitted: "too_large",
	limit: 2 * 1024 * 1024,
};

function renderView() {
	return render(<CommitFileView hash="abc1234def" path="docs/readme.md" />);
}

describe("CommitFileView", () => {
	it("names the version it is showing and that it cannot be changed", () => {
		renderView();

		expect(screen.getByText(/Read-only/)).toHaveTextContent("abc1234");
		expect(screen.getByText(/Do a thing/)).toBeInTheDocument();
	});

	it("goes back to the diff it came from", async () => {
		const user = userEvent.setup();
		renderView();

		await user.click(screen.getByRole("button", { name: "Back to diff" }));

		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/commit/$hash/diff/$",
				params: { hash: "abc1234def", _splat: "docs/readme.md" },
			}),
		);
	});

	it("offers no way to change or delete the file", () => {
		renderView();

		for (const name of [/edit/i, /delete/i]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
		// Nor is the path a door back to the editable file.
		expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
	});

	// Past its preview limit, or when it is binary, the card is all there is of
	// the file, so the card is where getting it has to be.
	it.each([
		["too large to preview", tooLargeFile],
		["binary", binaryFile],
	])("downloads this version of a file that is %s", async (_kind, version) => {
		const user = userEvent.setup();
		file = version;
		renderView();

		// The bottom bar's icon carries the same name only as `aria-label`, so the
		// one with visible text is the card's.
		await user.click(screen.getByText("Download"));

		expect(downloadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				hash: "abc1234def",
				path: "docs/readme.md",
				worktree: "",
			}),
		);
	});

	it("reports a failed download, and only for the version it was about", async () => {
		const user = userEvent.setup();
		downloadFile.mockRejectedValue(new Error("File not found"));
		file = tooLargeFile;
		const { rerender } = renderView();

		await user.click(screen.getByText("Download"));
		expect(
			await screen.findByText("Download failed: File not found"),
		).toBeInTheDocument();

		// The view is reused across commits, so a banner about one version would
		// otherwise sit above another.
		rerender(<CommitFileView hash="fedcba9876" path="docs/readme.md" />);

		expect(screen.queryByText(/Download failed/)).toBeNull();
	});

	// The stand-in cards explain why editing is disabled, which is written for
	// the viewer's disabled Edit button. There is no such button here.
	it("does not explain why a binary version cannot be edited", () => {
		file = binaryFile;
		renderView();

		expect(screen.queryByText(/Editing is disabled/)).toBeNull();
	});

	it("drops the plain-text toggle when there is no rendering to drop", () => {
		file = binaryFile;
		renderView();

		expect(screen.queryByRole("button", { name: /plain text/i })).toBeNull();
	});

	it("drops Markdown to its source so the whole file can be copied", async () => {
		const user = userEvent.setup();
		renderView();

		expect(screen.getByTestId("markdown")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Show plain text" }));

		expect(screen.queryByTestId("markdown")).toBeNull();
		expect(screen.getByText("# Title").tagName).toBe("PRE");
	});

	it("drops the toggle on a file already forced to plain text", () => {
		file = {
			...file,
			name: "huge.md",
			path: "docs/huge.md",
			size: HIGHLIGHT_LIMIT + 1,
		};
		renderView();

		expect(screen.queryByRole("button", { name: /plain text/i })).toBeNull();
		expect(screen.getByText(/Large file/)).toBeInTheDocument();
	});

	describe("HTML page", () => {
		const page: FileContent = {
			name: "index.html",
			type: "file",
			path: "site/index.html",
			size: 11,
			mime: "text/html; charset=utf-8",
			content: "<h1>Hi</h1>",
			encoding: "text",
		};

		beforeEach(() => {
			reportEverythingInView();
			useWSStore.setState({ status: "connected" });
			vi.spyOn(wsActions, "rawCapability").mockResolvedValue({
				path: "/api/raw/cap1/",
				expiresAt: Date.now() + 60 * 60 * 1000,
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("x", { status: 206 })),
			);
		});

		afterEach(() => {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		});

		function renderPage(version: FileContent = page) {
			file = version;
			const queryClient = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			return render(
				<QueryClientProvider client={queryClient}>
					<CommitFileView hash="abc1234def" path={version.path} />
				</QueryClientProvider>,
			);
		}

		it("renders the page as of the commit, from the commit's folder", async () => {
			renderPage();

			expect(await screen.findByTitle("index.html")).toHaveAttribute("sandbox");
			expect(wsActions.rawCapability).toHaveBeenCalledWith({
				origin: { kind: "commit", hash: "abc1234def", path: "site" },
				scope: "directory",
			});
		});

		it("turns the plain toggle into page and source, for a page of any size", async () => {
			const user = userEvent.setup();
			renderPage({
				...page,
				content: "",
				encoding: "none",
				omitted: "too_large",
				size: 3 * 1024 * 1024,
				limit: 2 * 1024 * 1024,
			});
			await screen.findByTitle("index.html");
			expect(screen.queryByRole("button", { name: /plain text/i })).toBeNull();

			await user.click(screen.getByRole("button", { name: "Show source" }));

			expect(screen.queryByTitle("index.html")).toBeNull();
			expect(
				screen.getByText("File is too large to preview"),
			).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Show page" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		});
	});
});
