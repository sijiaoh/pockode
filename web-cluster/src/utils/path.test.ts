import { describe, expect, it } from "vitest";
import { baseName, displayPath, splitTail } from "./path";

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

describe("splitTail", () => {
	it("holds the last segment back, separator included", () => {
		expect(splitTail("~/projects/my-app")).toEqual({
			head: "~/projects",
			tail: "/my-app",
		});
		expect(splitTail("C:\\Projects\\App")).toEqual({
			head: "C:\\Projects",
			tail: "\\App",
		});
	});

	it("keeps the whole path in the head when there is no tail to protect", () => {
		expect(splitTail("my-app")).toEqual({ head: "my-app", tail: "" });
		expect(splitTail("/my-app/")).toEqual({ head: "/my-app/", tail: "" });
		expect(splitTail("/my-app")).toEqual({ head: "/my-app", tail: "" });
	});
});

describe("displayPath", () => {
	it("collapses a home directory to ~", () => {
		expect(displayPath("/Users/you/projects/my-app")).toBe("~/projects/my-app");
		expect(displayPath("/home/you/projects/my-app")).toBe("~/projects/my-app");
	});

	it("leaves everything else alone", () => {
		expect(displayPath("/srv/apps/my-app")).toBe("/srv/apps/my-app");
	});
});
