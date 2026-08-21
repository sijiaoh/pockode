import { describe, expect, it } from "vitest";
import { buildSnippet } from "./snippet";

describe("buildSnippet", () => {
	it("drops leading indentation and expands tabs", () => {
		expect(buildSnippet("\t\tconst a\t= 1;", "const")).toBe("const a  = 1;");
	});

	it("keeps a short line as is", () => {
		expect(buildSnippet("const value = 1;", "value")).toBe("const value = 1;");
	});

	it("re-anchors on the match when it sits far into the line", () => {
		const line = `${"x".repeat(100)}needle tail`;

		const snippet = buildSnippet(line, "needle");

		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet).toContain("needle tail");
		// Only the configured amount of leading context is kept.
		expect(snippet).toBe(`…${"x".repeat(16)}needle tail`);
	});

	it("matches case-insensitively when anchoring", () => {
		const snippet = buildSnippet(`${"x".repeat(100)}NEEDLE`, "needle");

		expect(snippet).toBe(`…${"x".repeat(16)}NEEDLE`);
	});

	it("clamps a long line without a match", () => {
		const snippet = buildSnippet("y".repeat(500), "nothing");

		expect(snippet).toHaveLength(200);
		expect(snippet.startsWith("…")).toBe(false);
	});

	it("never splits a surrogate pair", () => {
		// The clamp boundary lands in the middle of the emoji.
		const snippet = buildSnippet(`${"z".repeat(199)}😀 tail`, "nothing");

		expect(snippet).toHaveLength(199);
		expect(snippet).toBe("z".repeat(199));
	});
});
