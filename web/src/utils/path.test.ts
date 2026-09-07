import { describe, expect, it } from "vitest";
import { formatFilePath, splitPath } from "./path";

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

describe("formatFilePath", () => {
	const workDir = "/home/me/project";

	it("shows the directory relative to workDir", () => {
		expect(formatFilePath(`${workDir}/src/lib/a.ts`, workDir)).toBe(
			"a.ts (src/lib)",
		);
	});

	it("drops the directory for a file sitting in workDir", () => {
		expect(formatFilePath(`${workDir}/a.ts`, workDir)).toBe("a.ts");
	});

	// Codex reports patches with absolute paths that can sit anywhere, so this
	// branch carries the status header for every out-of-project change.
	it("shows only the parent directory outside workDir", () => {
		expect(formatFilePath("/var/tmp/scratch/a.ts", workDir)).toBe(
			"a.ts (scratch)",
		);
	});
});
