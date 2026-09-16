import { describe, expect, it } from "vitest";
import {
	formatFilePath,
	relativeToWorkDir,
	splitNativePath,
	splitPath,
} from "./path";

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

	// Codex reports patches with absolute paths that can sit anywhere, so this
	// branch carries the status header for every out-of-project change.
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

describe("relativeToWorkDir", () => {
	const posixWorkDir = "/Users/me/project";
	const windowsWorkDir = "C:\\Users\\me\\project";

	it("returns the path in Pockode's own slash form, whichever separator it came in", () => {
		expect(
			relativeToWorkDir("/Users/me/project/src/main.go", posixWorkDir),
		).toBe("src/main.go");
		expect(
			relativeToWorkDir("C:\\Users\\me\\project\\src\\main.go", windowsWorkDir),
		).toBe("src/main.go");
	});

	it("handles a file sitting directly in the work directory", () => {
		expect(relativeToWorkDir("/Users/me/project/README.md", posixWorkDir)).toBe(
			"README.md",
		);
	});

	// Compared segment by segment, so a sibling directory whose name starts with
	// the work directory's is not mistaken for something inside it.
	it("is null for anything outside", () => {
		expect(relativeToWorkDir("/etc/hosts", posixWorkDir)).toBeNull();
		expect(
			relativeToWorkDir("/Users/me/project2/src/main.go", posixWorkDir),
		).toBeNull();
	});

	// The prefix matches, but the path leaves again — and an agent's path is
	// whatever the agent wrote.
	it("is null for a path that walks back out", () => {
		expect(
			relativeToWorkDir("/Users/me/project/../secrets/key.pem", posixWorkDir),
		).toBeNull();
	});

	// Not a file the file namespace can serve, so there is nothing to open.
	it("is null for the work directory itself, and with no work directory", () => {
		expect(relativeToWorkDir(posixWorkDir, posixWorkDir)).toBeNull();
		expect(relativeToWorkDir("/Users/me/project/src/main.go", "")).toBeNull();
	});
});
