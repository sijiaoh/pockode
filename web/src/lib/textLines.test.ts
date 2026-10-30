import { describe, expect, it } from "vitest";
import { fileLineCount } from "./textLines";

describe("fileLineCount", () => {
	it.each([
		["a", 1],
		["a\n", 1],
		// The newline ends line 1; the blank line after it is a row of its own.
		["a\n\n", 2],
		["a\nb", 2],
		["\n", 1],
		["a\r\nb\r\n", 2],
	])("counts %j as %i rows", (text, rows) => {
		expect(fileLineCount(text)).toBe(rows);
	});
});
