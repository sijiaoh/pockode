import { describe, expect, it } from "vitest";
import { parseHunks } from "./diffHunks";

describe("parseHunks", () => {
	it("reads every hunk's ranges and function context, in order", () => {
		const patch = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,2 +1,2 @@",
			"-a",
			"+b",
			" c",
			"@@ -40 +40,2 @@ function load() {",
			" x",
			"+y",
		].join("\n");

		expect(
			parseHunks(patch).map(({ lastRow: _, lines: __, ...hunk }) => hunk),
		).toEqual([
			{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, context: "" },
			{
				oldStart: 40,
				oldCount: 1,
				newStart: 40,
				newCount: 2,
				context: "function load() {",
			},
		]);
	});

	// A removed `-- x` is `--- x` in the patch, an added `++ x` is `+++ x`,
	// and a blank context line can be an empty one (diff.suppressBlankEmpty).
	it("reads a body by its header's counts, not by its prefixes", () => {
		const patch = [
			"@@ -1,3 +1,3 @@",
			"--- note",
			"",
			"+++ added",
			" tail",
		].join("\n");
		const [hunk] = parseHunks(patch);
		expect(hunk.lastRow.unified).toEqual({ side: "new", lineNumber: 3 });
		expect(hunk.lines).toEqual([
			{ kind: "removed", old: 1, text: "-- note" },
			{ kind: "context", old: 2, new: 1, text: "" },
			{ kind: "added", new: 2, text: "++ added" },
			{ kind: "context", old: 3, new: 3, text: "tail" },
		]);
	});

	it.each([
		{
			name: "context",
			body: ["-a", "+b", " c"],
			header: "@@ -1,2 +1,2 @@",
			unified: { side: "new", lineNumber: 2 },
			split: { side: "new", lineNumber: 2 },
		},
		{
			name: "more removed than added",
			body: [" c", "-a", "-b", "+x"],
			header: "@@ -1,3 +1,2 @@",
			unified: { side: "new", lineNumber: 2 },
			split: { side: "old", lineNumber: 3 },
		},
		{
			name: "removals only",
			body: [" c", "-a", "-b"],
			header: "@@ -1,3 +1 @@",
			unified: { side: "old", lineNumber: 3 },
			split: { side: "old", lineNumber: 3 },
		},
		{
			name: "a deleted file, no newline at its end",
			body: ["-a", "-b", "\\ No newline at end of file"],
			header: "@@ -1,2 +0,0 @@",
			unified: { side: "old", lineNumber: 2 },
			split: { side: "old", lineNumber: 2 },
		},
		{
			name: "a new file",
			body: ["+a", "+b"],
			header: "@@ -0,0 +1,2 @@",
			unified: { side: "new", lineNumber: 2 },
			split: { side: "new", lineNumber: 2 },
		},
	])("finds the bottom row of a hunk ending in $name", (c) => {
		const [hunk] = parseHunks([c.header, ...c.body].join("\n"));
		expect(hunk.lastRow).toEqual({ unified: c.unified, split: c.split });
	});

	// git copies the context from the source line. A header the parser skipped
	// would move every later hunk onto the next one's ID.
	it.each([
		["U+2028", "\u2028"],
		["a carriage return", "\r"],
	])("keeps counting past a context holding %s", (_, char) => {
		const patch = [
			`@@ -1 +1 @@ const a = "${char}";`,
			"-a",
			"+b",
			"@@ -9 +9 @@",
			"-c",
			"+d",
		].join("\n");
		expect(parseHunks(patch).map((h) => h.oldStart)).toEqual([1, 9]);
	});
});
