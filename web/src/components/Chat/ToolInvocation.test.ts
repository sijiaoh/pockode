import { describe, expect, it } from "vitest";
import { invocationView } from "./ToolInvocation";

describe("invocationView", () => {
	it("shows a known file tool's call as its file", () => {
		expect(invocationView("Read", { file_path: "/w/a.ts", limit: 10 })).toEqual(
			{ kind: "paths", paths: ["/w/a.ts"] },
		);
	});

	// Everything the row truncates has to be in the body verbatim; a tool that
	// merely takes a `path` would otherwise lose every other argument.
	it.each([
		"mcp__fs__write_file",
		"fs:write_file",
		"Frobnicate",
	])("shows every argument of %s, path included", (name) => {
		expect(invocationView(name, { path: "/w/a.ts", content: "hi" })).toEqual({
			kind: "params",
			entries: [
				["path", "/w/a.ts"],
				["content", "hi"],
			],
		});
	});
});
