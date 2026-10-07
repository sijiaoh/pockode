import { describe, expect, it } from "vitest";
import {
	findInLines,
	findInText,
	findStatus,
	matchAtOrAfter,
	stepMatch,
} from "./find";

describe("findInLines", () => {
	it("finds every literal match, case-insensitively, in reading order", () => {
		expect(findInLines(["a.b A.B", "x", "a.b"], "a.b")).toEqual([
			{ index: 0, start: 0, end: 3 },
			{ index: 0, start: 4, end: 7 },
			{ index: 2, start: 0, end: 3 },
		]);
	});

	it("loses only the line whose lowercasing changes its length", () => {
		expect(findInLines(["İstanbul fail", "fail"], "fail")).toEqual([
			{ index: 1, start: 0, end: 4 },
		]);
	});

	it("finds nothing for an empty query", () => {
		expect(findInLines(["a"], "")).toEqual([]);
	});
});

describe("findInText", () => {
	it("gives offsets into the whole text, never matching across a line break", () => {
		expect(findInText("ab\ncab", "ab")).toEqual([
			[0, 2],
			[4, 6],
		]);
		expect(findInText("a\nb", "a\nb")).toEqual([]);
	});
});

describe("matchAtOrAfter", () => {
	const matches = findInLines(["x", "ab ab", "", "ab"], "ab");

	it("finds the first match at or after a place", () => {
		expect(matchAtOrAfter(matches, 0)).toBe(0);
		expect(matchAtOrAfter(matches, 1, 1)).toBe(1);
		expect(matchAtOrAfter(matches, 2)).toBe(2);
	});

	it("is -1 past the last match", () => {
		expect(matchAtOrAfter(matches, 4)).toBe(-1);
	});
});

describe("stepMatch", () => {
	it("wraps around at either end", () => {
		expect(stepMatch(2, 3, 1)).toBe(0);
		expect(stepMatch(0, 3, -1)).toBe(2);
		expect(stepMatch(null, 3, -1)).toBe(2);
		expect(stepMatch(null, 0, 1)).toBeNull();
	});
});

describe("findStatus", () => {
	it("says where find is, and that nothing matched", () => {
		expect(findStatus(2, 17)).toEqual({
			shown: "3 / 17",
			spoken: "3 of 17 matches",
		});
		expect(findStatus(null, 0)).toEqual({
			shown: "No matches",
			spoken: "No matches",
		});
		expect(findStatus(null, 1).shown).toBe("– / 1");
	});
});
