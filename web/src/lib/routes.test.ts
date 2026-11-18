import { describe, expect, it } from "vitest";
import { startPathOf } from "./routes";

describe("startPathOf", () => {
	it.each([
		["/unstaged/a.txt", "/"],
		["/commit/abc/diff/a.txt", "/"],
		["/", "/"],
		["/w/feature-x/staged/a.txt", "/w/feature-x/"],
		["/w/feature-x", "/w/feature-x/"],
		["/w/", "/"],
	])("leaves %s for %s", (from, to) => {
		expect(startPathOf(from)).toBe(to);
	});
});
