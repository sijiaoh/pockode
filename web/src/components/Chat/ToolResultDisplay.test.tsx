import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ToolResultDisplay, { resultCount } from "./ToolResultDisplay";

const mockWorkDir = vi.hoisted(() => ({ value: "/Users/test/project" }));

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { workDir: string }) => string) =>
		selector({ workDir: mockWorkDir.value }),
}));

vi.mock("../../lib/shikiUtils", () => ({
	CodeHighlighter: ({ children }: { children: string }) => (
		<pre>{children}</pre>
	),
}));

describe("ToolResultDisplay", () => {
	// The fallback used to be a bare `<pre>` with no wrapping at all, so one
	// long line of JSON was a horizontal drag on a phone.
	it("pretty-prints the JSON an MCP tool answered with", () => {
		render(
			<ToolResultDisplay
				toolName="github:create_issue"
				toolInput={{}}
				result='{"number":7,"title":"Broken"}'
			/>,
		);
		expect(screen.getByText(/"number": 7/)).toBeVisible();
	});

	it("wraps a result it cannot parse rather than letting it scroll sideways", () => {
		const line = `not json ${"x".repeat(400)}`;
		render(
			<ToolResultDisplay toolName="Whatever" toolInput={{}} result={line} />,
		);
		expect(screen.getByText(line)).toHaveClass("whitespace-pre-wrap");
	});

	// A search answers with a list of files, and reading one is scanning for a
	// name — so each is a row, shortened, with the way over to it.
	it("renders a search result as the file list it is", async () => {
		const user = userEvent.setup();
		const onOpenFile = vi.fn();
		render(
			<ToolResultDisplay
				toolName="Glob"
				toolInput={{ pattern: "**/*.ts" }}
				result={`${mockWorkDir.value}/src/lib/api.ts\n${mockWorkDir.value}/src/lib/ws.ts`}
				onOpenFile={onOpenFile}
			/>,
		);
		expect(screen.getByText("api.ts (src/lib)")).toBeVisible();

		await user.click(screen.getAllByRole("button", { name: "Open" })[0]);
		expect(onOpenFile).toHaveBeenCalledWith("src/lib/api.ts");
	});

	// Grep answers with paths in one mode only. Its other modes prefix every
	// line with `path:line:`, and a short match with no space in it looks
	// exactly like a path — drawn as a file row it would offer to open one that
	// does not exist.
	it("leaves a Grep result that is matches, not paths, as text", () => {
		const result = "src/lib/api.ts:12:const=1\nsrc/lib/ws.ts:3:let=2";
		render(
			<ToolResultDisplay
				toolName="Grep"
				toolInput={{ pattern: "=", output_mode: "content" }}
				result={result}
				onOpenFile={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
		expect(
			screen.getByText(result, { normalizer: (text) => text }),
		).toHaveClass("whitespace-pre-wrap");
	});
});

// What the button opening a cut result counts in: whatever the result is drawn
// as, so that "Show 85 more files" reveals files.
describe("resultCount", () => {
	it("counts a search that answered with paths in files", () => {
		expect(resultCount("Glob", {}, "/a.ts\n/b.ts\n/c.ts\n")).toEqual({
			noun: "file",
			total: 3,
		});
	});

	it("counts a Grep that answered with matches in lines", () => {
		expect(
			resultCount("Grep", { output_mode: "content" }, "a.ts:1:x\na.ts:2:y"),
		).toEqual({ noun: "line", total: 2 });
	});

	// Drawn as printed: JSON a command printed is not pretty-printed.
	it("counts a command's output in the lines it printed", () => {
		expect(resultCount("Bash", {}, '{"a":1,"b":2}\n')).toEqual({
			noun: "line",
			total: 1,
		});
	});

	it("counts a file in its own lines, without the CLI's numbering", () => {
		expect(resultCount("Read", {}, "     1→one\n     2→two\n")).toEqual({
			noun: "line",
			total: 2,
		});
	});

	it("counts pretty-printed JSON in the lines it is drawn in", () => {
		expect(resultCount("mcp__x", {}, '{"a":1,"b":2}')).toEqual({
			noun: "line",
			total: 4,
		});
	});

	// Prose and blocks have no line a reader would count.
	it("leaves Markdown and content blocks uncounted", () => {
		expect(resultCount("WebFetch", {}, "# Title\n\ntext")).toBeUndefined();
		expect(
			resultCount("mcp__x", {}, "", [{ type: "text", text: "x" }]),
		).toBeUndefined();
	});
});
