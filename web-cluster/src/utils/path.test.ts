import { describe, expect, it } from "vitest";
import { baseName } from "./path";

describe("baseName", () => {
	it("returns the last segment of a posix path", () => {
		expect(baseName("/Users/you/projects/my-app")).toBe("my-app");
	});

	it("returns the last segment of a windows path", () => {
		expect(baseName("C:\\Projects\\App")).toBe("App");
		expect(baseName("\\\\server\\share\\App")).toBe("App");
	});

	it("ignores a trailing separator", () => {
		expect(baseName("/Users/you/projects/my-app/")).toBe("my-app");
		expect(baseName("C:\\Projects\\App\\")).toBe("App");
	});

	it("returns an empty string when there is no segment", () => {
		expect(baseName("")).toBe("");
		expect(baseName("/")).toBe("");
	});
});
