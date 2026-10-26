import { describe, expect, it } from "vitest";
import type { SearchRange } from "../types/search";
import { buildSnippet } from "./snippet";

/** The text each range of a snippet marks. */
function marked(text: string, ranges: SearchRange[]): string[] {
	return ranges.map(({ start, end }) => text.slice(start, end));
}

/** The range of the first occurrence of `needle` in `text`. */
function at(text: string, needle: string): SearchRange[] {
	const start = text.indexOf(needle);
	return [{ start, end: start + needle.length }];
}

describe("buildSnippet", () => {
	it("drops leading indentation and expands tabs, moving the ranges along", () => {
		const line = "\t\tconst a\t= value;";

		const snippet = buildSnippet(line, at(line, "value"));

		expect(snippet.text).toBe("const a  = value;");
		expect(marked(snippet.text, snippet.ranges)).toEqual(["value"]);
	});

	it("keeps a short line as is", () => {
		const line = "const value = 1;";

		const snippet = buildSnippet(line, at(line, "value"));

		expect(snippet.text).toBe(line);
		expect(snippet.ranges).toEqual(at(line, "value"));
	});

	it("re-anchors on the first range when it sits far into the line", () => {
		const line = `${"x".repeat(100)}NEEDLE tail`;

		const snippet = buildSnippet(line, at(line, "NEEDLE"));

		// Only the configured amount of leading context is kept.
		expect(snippet.text).toBe(`…${"x".repeat(16)}NEEDLE tail`);
		expect(marked(snippet.text, snippet.ranges)).toEqual(["NEEDLE"]);
	});

	it("trims a range the clamp cuts through", () => {
		const line = `${"y".repeat(198)}abcd`;

		const snippet = buildSnippet(line, [
			{ start: 0, end: 2 },
			{ start: 198, end: 202 },
		]);

		expect(snippet.text).toHaveLength(200);
		expect(marked(snippet.text, snippet.ranges)).toEqual(["yy", "ab"]);
	});

	it("clamps a long line without ranges", () => {
		const snippet = buildSnippet("y".repeat(500), []);

		expect(snippet.text).toHaveLength(200);
		expect(snippet.text.startsWith("…")).toBe(false);
	});

	it("never splits a surrogate pair", () => {
		// The clamp boundary lands in the middle of the emoji.
		const snippet = buildSnippet(`${"z".repeat(199)}😀 tail`, []);

		expect(snippet.text).toBe("z".repeat(199));
	});
});
