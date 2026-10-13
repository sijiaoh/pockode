import { describe, expect, it } from "vitest";
import { markdownFileBaseDir, resolveMarkdownImage } from "./markdownImage";

const WORK_DIR = "/home/me/repo";

function resolve(src: string, baseDir: string | null = "") {
	return resolveMarkdownImage(src, baseDir, WORK_DIR);
}

describe("resolveMarkdownImage", () => {
	it.each([
		["shots/a.png", "", "shots/a.png"],
		["./img/x.png", "docs", "docs/img/x.png"],
		["../logo.svg", "docs/guide", "docs/logo.svg"],
		["img\\x.png", "docs", "docs/img/x.png"],
	])("reads %s from base %j as the workspace file %s", (src, base, path) => {
		expect(resolve(src, base)).toMatchObject({ kind: "workspace", path });
	});

	it("names the same file however the space in it is written", () => {
		expect(resolve("my%20shot.png?raw=1#top")).toEqual({
			kind: "workspace",
			path: "my shot.png",
			name: "my shot.png",
		});
	});

	it("never reads a path that climbs out of the work directory", () => {
		expect(resolve("../../secret.png", "docs").kind).toBe("outside");
		expect(resolve("..").kind).toBe("outside");
	});

	it("reads an absolute path only when it is under the work directory", () => {
		expect(resolve(`${WORK_DIR}/shots/a.png`)).toMatchObject({
			kind: "workspace",
			path: "shots/a.png",
		});
		expect(resolve("/tmp/a.png")).toEqual({ kind: "outside", name: "a.png" });
		// GitHub's site-root form is indistinguishable from a real absolute path.
		expect(resolve("/docs/a.png").kind).toBe("outside");
		expect(
			resolveMarkdownImage("C:\\repo\\a.png", "", "C:\\repo"),
		).toMatchObject({ kind: "workspace", path: "a.png" });
	});

	it("reads nothing relative to a text outside the work directory", () => {
		expect(resolve("a.png", null)).toEqual({ kind: "outside", name: "a.png" });
		expect(resolve(`${WORK_DIR}/a.png`, null)).toMatchObject({
			kind: "workspace",
			path: "a.png",
		});
	});

	it("takes http(s) and protocol-relative URLs as external images", () => {
		expect(resolve("https://example.com/b/build%20ok.svg")).toEqual({
			kind: "external",
			url: "https://example.com/b/build%20ok.svg",
			name: "build ok.svg",
		});
		expect(resolve("HTTP://example.com/")).toMatchObject({
			kind: "external",
			name: "example.com",
		});
		expect(resolve("//cdn.example.com/x.png")).toMatchObject({
			kind: "external",
			url: "https://cdn.example.com/x.png",
		});
	});

	it.each([
		"data:image/png;base64,AAAA",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"mailto:a@b.c",
		"",
		"#top",
	])("drops %j", (src) => {
		expect(resolve(src).kind).toBe("unsupported");
	});
});

describe("markdownFileBaseDir", () => {
	it.each([
		["README.md", ""],
		["docs/guide/intro.md", "docs/guide/"],
		[`${WORK_DIR}/README.md`, ""],
		[`${WORK_DIR}/docs/intro.md`, "docs/"],
	])("reads the images of %s from %j", (filePath, base) => {
		expect(markdownFileBaseDir(filePath, WORK_DIR)).toBe(base);
	});

	it("takes a Windows path in its native form", () => {
		expect(markdownFileBaseDir("C:\\repo\\docs\\a.md", "C:\\repo")).toBe(
			"docs/",
		);
	});

	it("has no base for a file outside the work directory", () => {
		expect(markdownFileBaseDir("/tmp/notes.md", WORK_DIR)).toBeNull();
	});
});
