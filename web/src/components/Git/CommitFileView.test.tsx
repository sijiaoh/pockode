import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "../../types/contents";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import CommitFileView from "./CommitFileView";

const navigate = vi.fn();
let file: FileContent;

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

vi.mock("../Chat/MarkdownContent", () => ({
	MarkdownContent: ({ content }: { content: string }) => (
		<div data-testid="markdown">{content}</div>
	),
}));

beforeEach(() => {
	navigate.mockClear();
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

function renderView() {
	return render(<CommitFileView hash="abc1234def" path="docs/readme.md" />);
}

describe("CommitFileView", () => {
	it("names the version it is showing and that it cannot be changed", () => {
		renderView();

		expect(screen.getByText(/Read-only/)).toHaveTextContent("abc1234");
		expect(screen.getByText(/Do a thing/)).toBeInTheDocument();
	});

	it("offers no way to change or delete the file", () => {
		renderView();

		for (const name of [/edit/i, /delete/i]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
		// Nor is the path a door back to the editable file.
		expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
	});

	// The download affordance lives on the stand-in cards, so only a file that
	// cannot be previewed can show its absence.
	it("does not offer to download a binary version it cannot preview", () => {
		file = binaryFile;
		renderView();

		expect(screen.getByText("Binary file")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
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
});
