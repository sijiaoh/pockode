import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeHighlighter } from "../../lib/shikiUtils";
import type { FileViewState } from "../../utils/fileView";
import FileBody from "./FileBody";

vi.mock("../ui/MarkdownContent", () => ({
	MarkdownContent: ({ content }: { content: string }) => (
		<div data-testid="markdown">{content}</div>
	),
}));

type TextViewState = Extract<FileViewState, { kind: "text" }>;

const text = (content: string, highlight = true): TextViewState => ({
	kind: "text",
	content,
	highlight,
});

/** The numbers the gutter draws, as the reader sees them top to bottom. */
function gutterNumbers(container: HTMLElement): string[] | null {
	const gutter = container.querySelector(".code-gutter");
	if (!gutter) return null;
	return [...gutter.children].flatMap(
		(block) => block.getAttribute("data-numbers")?.split("\n") ?? [],
	);
}

describe("line numbers", () => {
	it("number every row of the text, the last one included", () => {
		const { container } = render(
			<FileBody state={text("a\n\nb\n")} path="a.ts" lineNumbers />,
		);

		expect(gutterNumbers(container)).toEqual(["1", "2", "3"]);
	});

	it("number plain text past the highlight limit too", () => {
		const { container } = render(
			<FileBody state={text("a\nb", false)} path="a.ts" lineNumbers />,
		);

		expect(screen.getByText(/Large file/)).toBeInTheDocument();
		expect(gutterNumbers(container)).toEqual(["1", "2"]);
	});

	it("split into blocks without skipping or repeating a number", () => {
		const content = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n");
		const { container } = render(
			<FileBody state={text(content, false)} path="a.ts" lineNumbers />,
		);

		const numbers = gutterNumbers(container);
		expect(numbers).toHaveLength(2500);
		expect(numbers?.every((n, i) => n === String(i + 1))).toBe(true);
	});

	it("are off unless the view asks for them", () => {
		const { container } = render(<FileBody state={text("a")} path="a.ts" />);

		expect(gutterNumbers(container)).toBeNull();
	});

	it("are left out of rendered Markdown, which has no lines", () => {
		const { container } = render(
			<FileBody state={text("# Title")} path="a.md" lineNumbers />,
		);

		expect(screen.getByTestId("markdown")).toBeInTheDocument();
		expect(gutterNumbers(container)).toBeNull();
	});

	it("number Markdown's source", () => {
		const { container } = render(
			<FileBody state={text("# Title")} path="a.md" plain lineNumbers />,
		);

		expect(gutterNumbers(container)).toEqual(["1"]);
	});

	it("number a page's source", () => {
		const { container } = render(
			<FileBody
				state={{
					kind: "page",
					origin: { kind: "file", path: "index.html" },
					mime: "text/html",
					size: 11,
					source: text("<h1>Hi</h1>\n"),
				}}
				path="index.html"
				plain
				lineNumbers
			/>,
		);

		expect(gutterNumbers(container)).toEqual(["1"]);
	});

	it("cannot be asked of a wrapped block, whose lines take more than a row", () => {
		const block = (
			// @ts-expect-error -- `wrap` and `lineNumbers` are exclusive.
			<CodeHighlighter wrap lineNumbers>
				{"a"}
			</CodeHighlighter>
		);
		expect(block).toBeTruthy();
	});
});
