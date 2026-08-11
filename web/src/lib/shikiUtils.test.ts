import { describe, expect, it } from "vitest";
import { getLanguageFromPath, isMarkdownFile } from "./shikiUtils";

describe("getLanguageFromPath", () => {
	// A tool result's `file_path` is passed through verbatim from the AI CLI, so
	// on Windows it is backslash-separated.
	it.each([
		["C:\\Users\\me\\project\\src\\main.go", "go"],
		["C:\\Users\\me\\project\\Dockerfile", "docker"],
		["C:\\Users\\me\\project\\.env", "shellscript"],
		["C:\\Users\\me\\project\\.env.local", "shellscript"],
		["C:\\Users\\me\\my.dir\\Makefile", "make"],
	])("resolves %s on Windows", (path, expected) => {
		expect(getLanguageFromPath(path)).toBe(expected);
	});

	it.each([
		["/home/me/project/src/main.go", "go"],
		["/home/me/project/Dockerfile", "docker"],
		["/home/me/project/.env", "shellscript"],
		["/home/me/my.dir/Makefile", "make"],
		// Pockode's own API always spells paths with forward slashes, on every
		// platform, and passes them relative to the work dir.
		["src/components/App.tsx", "tsx"],
	])("resolves %s on POSIX", (path, expected) => {
		expect(getLanguageFromPath(path)).toBe(expected);
	});

	it("returns undefined for an unknown extension", () => {
		expect(getLanguageFromPath("C:\\Users\\me\\notes.qqq")).toBeUndefined();
	});
});

describe("isMarkdownFile", () => {
	it("only looks at the extension, so separators do not matter", () => {
		expect(isMarkdownFile("C:\\Users\\me\\README.md")).toBe(true);
		expect(isMarkdownFile("C:\\Users\\me\\docs.md\\main.go")).toBe(false);
	});
});
