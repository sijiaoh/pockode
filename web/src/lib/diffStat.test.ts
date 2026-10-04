import { createPatch } from "diff";
import { describe, expect, it } from "vitest";
import { diffStat } from "./diffStat";

describe("diffStat", () => {
	it("counts added and removed lines, not context or file headers", () => {
		const patch = createPatch(
			"a.ts",
			"one\ntwo\nthree\n",
			"one\n2\nthree\nfour\n",
		);
		expect(diffStat([patch])).toEqual({ added: 2, removed: 1 });
	});

	it("counts a removed line that looks like a file header", () => {
		const patch = createPatch("a.md", "-- note\nkeep\n", "keep\n");
		expect(diffStat([patch])).toEqual({ added: 0, removed: 1 });
	});

	it("sums across patches and hunks", () => {
		const patch = [
			"--- a/x",
			"+++ b/x",
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"@@ -10,2 +10,3 @@",
			" c",
			"+d",
			" e",
			"\\ No newline at end of file",
		].join("\n");
		expect(diffStat([patch, patch])).toEqual({ added: 4, removed: 2 });
	});
});
