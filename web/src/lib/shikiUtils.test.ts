import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { codeToHtml } from "shiki";
import { describe, expect, it } from "vitest";
import {
	getDiffHighlighterFor,
	getDiffLanguageFromPath,
	getLanguageFromPath,
	isMarkdownFile,
	WrappedPlain,
	wordWrapTransformer,
} from "./shikiUtils";

describe("getLanguageFromPath", () => {
	// A tool result's `file_path` is passed through verbatim from the AI CLI, so
	// on Windows it is backslash-separated.
	it.each([
		["C:\\Users\\me\\project\\src\\main.go", "go"],
		["C:\\Users\\me\\project\\Dockerfile", "docker"],
		["C:\\Users\\me\\project\\.env", "shellscript"],
		["C:\\Users\\me\\project\\.env.local", "shellscript"],
		["C:\\Users\\me\\my.dir\\Makefile", "make"],
	])("resolves %s on Windows", (path, expected) => {
		expect(getLanguageFromPath(path)).toBe(expected);
	});

	it.each([
		["/home/me/project/src/main.go", "go"],
		["/home/me/project/Dockerfile", "docker"],
		["/home/me/project/.env", "shellscript"],
		["/home/me/my.dir/Makefile", "make"],
		// Pockode's own API always spells paths with forward slashes, on every
		// platform, and passes them relative to the work dir.
		["src/components/App.tsx", "tsx"],
	])("resolves %s on POSIX", (path, expected) => {
		expect(getLanguageFromPath(path)).toBe(expected);
	});

	// Extensions no shiki name matches, and files known by name alone.
	it.each([
		["include/util.h", "c"],
		["src/engine.cpp", "cpp"],
		["src/engine.hpp", "cpp"],
		["lib/app.ex", "elixir"],
		["icon.svg", "xml"],
		["fix.patch", "diff"],
		["build.gradle", "groovy"],
		["Gemfile", "ruby"],
		["Containerfile", "docker"],
		["CMakeLists.txt", "cmake"],
	])("resolves %s", (path, expected) => {
		expect(getLanguageFromPath(path)).toBe(expected);
	});

	it("returns undefined for an unknown extension", () => {
		expect(getLanguageFromPath("C:\\Users\\me\\notes.qqq")).toBeUndefined();
	});
});

describe("getDiffHighlighterFor", () => {
	// The diff library hands any language the highlighter says it lacks to its
	// highlight.js fallback: plain text is shiki's to draw.
	it("answers for its plain-text fallback, so highlight.js is never asked", async () => {
		const { highlighter, language } = await getDiffHighlighterFor(undefined);

		expect(highlighter.hasRegisteredCurrentLang(language)).toBe(true);
	});

	it("loads a grammar the adapter does not preload", async () => {
		const { highlighter, language } = await getDiffHighlighterFor("rust");

		expect(language).toBe("rust");
		expect(highlighter.hasRegisteredCurrentLang("rust")).toBe(true);
	});

	it("loads highlight.js's grammar for a language shiki lacks", async () => {
		const { highlighter, language } = await getDiffHighlighterFor("thrift");

		expect(language).toBe("thrift");
		expect(highlighter.name).toBe("lowlight");
		expect(highlighter.hasRegisteredCurrentLang("thrift")).toBe(true);
	});
});

describe("getDiffLanguageFromPath", () => {
	it.each([
		["src/main.rs", "rust"],
		["Dockerfile", "docker"],
		["api/service.thrift", "thrift"],
		["C:\\scripts\\hotkeys.ahk", "autohotkey"],
		["src/App.re", "reasonml"],
	])("resolves %s", (path, expected) => {
		expect(getDiffLanguageFromPath(path)).toBe(expected);
	});

	it("leaves a file nobody has a grammar for to plain text", () => {
		expect(getDiffLanguageFromPath("notes.qqq")).toBeUndefined();
		expect(getDiffLanguageFromPath("LICENSE")).toBeUndefined();
	});
});

describe("isMarkdownFile", () => {
	it("only looks at the extension, so separators do not matter", () => {
		expect(isMarkdownFile("C:\\Users\\me\\README.md")).toBe(true);
		expect(isMarkdownFile("C:\\Users\\me\\docs.md\\main.go")).toBe(false);
	});
});

/**
 * The shape both trees must share — lines, and per line its words and the
 * indent its continuation hangs from — so a block does not reflow when its
 * colours arrive.
 */
function wrapShape(root: ParentNode) {
	return [...root.querySelectorAll(".line")].map((line) => ({
		words: [...line.querySelectorAll(".code-word")].map((w) => w.textContent),
		hang: (line as HTMLElement).style.getPropertyValue("--hang"),
	}));
}

describe("word-wrapped code", () => {
	const command = 'pnpm vitest --reporter=verbose\n  "a b" --x\n';

	it("holds each word together, shiki's colours and all", async () => {
		const html = await codeToHtml(command, {
			lang: "bash",
			theme: "github-light",
			transformers: [wordWrapTransformer],
		});
		const root = document.createElement("div");
		root.innerHTML = html;

		expect(wrapShape(root)).toEqual([
			{ words: ["pnpm", "vitest", "--reporter=verbose"], hang: "" },
			{ words: ['"a', 'b"', "--x"], hang: "4ch" },
		]);
		// Lines are blocks: a newline between them would be a blank line, and
		// the final newline's empty line is dropped as a <pre> would.
		expect(root.querySelector("code")?.textContent).toBe(
			'pnpm vitest --reporter=verbose  "a b" --x',
		);
	});

	it("draws the same shape before shiki answers", () => {
		const root = document.createElement("div");
		root.innerHTML = renderToStaticMarkup(
			createElement(WrappedPlain, { text: command }),
		);
		expect(wrapShape(root)).toEqual([
			{ words: ["pnpm", "vitest", "--reporter=verbose"], hang: "" },
			{ words: ['"a', 'b"', "--x"], hang: "4ch" },
		]);
	});

	// Past the highlight limit the text is withheld from shiki to spare the
	// main thread; a span per word would spend that on the DOM.
	it("leaves an oversized block's lines unsplit", () => {
		const root = document.createElement("div");
		root.innerHTML = renderToStaticMarkup(
			createElement(WrappedPlain, { text: command, words: false }),
		);
		expect(root.querySelectorAll(".line")).toHaveLength(2);
		expect(root.querySelectorAll(".code-word")).toHaveLength(0);
	});
});
