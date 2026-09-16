import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ToolResultDisplay from "./ToolResultDisplay";

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
