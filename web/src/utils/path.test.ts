import { describe, expect, it } from "vitest";
import { formatFilePath, splitNativePath, splitPath } from "./path";

describe("splitPath", () => {
	it("splits path with directory", () => {
		expect(splitPath("src/components/Button.tsx")).toEqual({
			fileName: "Button.tsx",
			directory: "src/components/",
		});
	});

	it("returns filename only when no directory", () => {
		expect(splitPath("README.md")).toEqual({
			fileName: "README.md",
			directory: "",
		});
	});
});

describe("splitNativePath", () => {
	it("splits on either separator", () => {
		expect(splitNativePath("/Users/me/project/src/main.go")).toEqual([
			"Users",
			"me",
			"project",
			"src",
			"main.go",
		]);
		expect(splitNativePath("C:\\repo\\src\\main.go")).toEqual([
			"C:",
			"repo",
			"src",
			"main.go",
		]);
	});

	it("drops empty segments", () => {
		expect(splitNativePath("")).toEqual([]);
		expect(splitNativePath("/")).toEqual([]);
		expect(splitNativePath("\\\\server\\share\\file.txt")).toEqual([
			"server",
			"share",
			"file.txt",
		]);
	});
});

describe("formatFilePath", () => {
	const posixWorkDir = "/Users/me/project";
	const windowsWorkDir = "C:\\Users\\me\\project";

	it("shows the relative directory for files inside the work dir", () => {
		expect(
			formatFilePath(
				"/Users/me/project/src/components/Button.tsx",
				posixWorkDir,
			),
		).toBe("Button.tsx (src/components)");
		expect(
			formatFilePath("C:\\Users\\me\\project\\src\\main.go", windowsWorkDir),
		).toBe("main.go (src)");
	});

	it("shows the file name alone at the root of the work dir", () => {
		expect(formatFilePath("/Users/me/project/README.md", posixWorkDir)).toBe(
			"README.md",
		);
		expect(
			formatFilePath("C:\\Users\\me\\project\\README.md", windowsWorkDir),
		).toBe("README.md");
	});

	it("shows only the parent directory for files outside the work dir", () => {
		expect(formatFilePath("/etc/hosts", posixWorkDir)).toBe("hosts (etc)");
		expect(
			formatFilePath(
				"C:\\Windows\\System32\\drivers\\etc\\hosts",
				windowsWorkDir,
			),
		).toBe("hosts (etc)");
	});

	it("does not treat a sibling directory as being inside the work dir", () => {
		expect(formatFilePath("/Users/me/project2/src/main.go", posixWorkDir)).toBe(
			"main.go (src)",
		);
	});

	it("tolerates the two sides spelling separators differently", () => {
		expect(
			formatFilePath(
				"C:\\Users\\me\\project\\src\\main.go",
				"C:/Users/me/project",
			),
		).toBe("main.go (src)");
	});

	it("returns the file name when there is no directory", () => {
		expect(formatFilePath("main.go", posixWorkDir)).toBe("main.go");
		expect(formatFilePath("/main.go", posixWorkDir)).toBe("main.go");
	});

	it("returns the input when there are no segments at all", () => {
		expect(formatFilePath("", posixWorkDir)).toBe("");
		expect(formatFilePath("/", posixWorkDir)).toBe("/");
	});

	it("falls back to the parent directory when the work dir is unknown", () => {
		expect(formatFilePath("/Users/me/project/src/main.go", "")).toBe(
			"main.go (src)",
		);
	});
});
