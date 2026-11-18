import { highlighter as libraryFallback } from "@git-diff-view/react";
import hljs from "highlight.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	highlighter,
	isHljsLanguage,
	loadHljsLanguage,
} from "./diffFallbackHighlighter";
import { getDiffLanguageFromPath } from "./shikiUtils";

/** Every extension highlight.js answered to: its languages' names and aliases. */
function hljsExtensions(): string[] {
	const keys = hljs.listLanguages().flatMap((name) => {
		if (name === "plaintext") return [];
		return [name, ...(hljs.getLanguage(name)?.aliases ?? [])];
	});
	return [...new Set(keys.map((key) => key.toLowerCase()))].filter(
		(key) => !key.includes("."),
	);
}

/** The languages a grammar embeds directly. */
function embeds(name: string): Set<string> {
	const found = new Set<string>();
	const seen = new Set<object>();
	const walk = (mode: unknown) => {
		if (!mode || typeof mode !== "object" || seen.has(mode)) return;
		seen.add(mode);
		const { subLanguage } = mode as { subLanguage?: string | string[] };
		for (const sub of [subLanguage ?? []].flat()) found.add(sub);
		for (const value of Object.values(mode)) {
			if (Array.isArray(value)) value.forEach(walk);
			else walk(value);
		}
	};
	walk(hljs.getLanguage(name));
	return found;
}

/**
 * Every language a grammar needs registered to be drawn as highlight.js drew
 * it: what it embeds, what those embed, and so on.
 */
function embeddedLanguages(name: string): string[] {
	const found = new Set<string>();
	const pending = [...embeds(name)];
	for (let next = pending.pop(); next; next = pending.pop()) {
		if (next === name || found.has(next)) continue;
		found.add(next);
		pending.push(...embeds(next));
	}
	return [...found];
}

describe("the diff library's highlight.js fallback", () => {
	// The aliases in vite.alias.ts are what put this module in the library's
	// place; tests/diffHighlighterAlias.test.ts holds each config to it.
	it("is this module, not the package that registers every grammar", () => {
		expect(libraryFallback).toBe(highlighter);
	});

	// The library used to colour a file by its extension through highlight.js.
	// Shiki now does, and what shiki cannot, this module still does.
	it.each(hljsExtensions())("still has a grammar for .%s", (extension) => {
		const language = getDiffLanguageFromPath(`file.${extension}`);

		expect(language).toBeDefined();
		if (language && isHljsLanguage(language)) {
			// The same language highlight.js read the extension as.
			expect(hljs.getLanguage(language)).toBe(hljs.getLanguage(extension));
		}
	});

	// Each in a module of its own: one shared with other loads would have the
	// grammars they brought in, and hide one this load left out.
	it.each(
		hljs.listLanguages().filter(isHljsLanguage),
	)("loads every language %s embeds along with it", async (language) => {
		vi.resetModules();
		const fresh = await import("./diffFallbackHighlighter");
		await fresh.loadHljsLanguage(language);

		for (const embedded of embeddedLanguages(language)) {
			expect(
				fresh.highlighter.hasRegisteredCurrentLang(embedded),
				`${embedded}, embedded in ${language}`,
			).toBe(true);
		}
	});

	// The package it replaces guessed at a language it did not know.
	it("draws a language it has not loaded as plain text", () => {
		const raw = "if (a) { return 1; }";

		expect(highlighter.getAST(raw, "a.qqq", "qqq")).toEqual({
			type: "root",
			children: [{ type: "text", value: raw }],
		});
	});

	it("draws a file on its ignore list as plain text", async () => {
		await loadHljsLanguage("thrift");
		highlighter.setIgnoreSyntaxHighlightList([/\.gen\.thrift$/]);
		onTestFinished(() => highlighter.setIgnoreSyntaxHighlightList([]));
		const raw = "struct A {}";

		expect(highlighter.getAST(raw, "a.gen.thrift", "thrift")).toEqual({
			type: "root",
			children: [{ type: "text", value: raw }],
		});
		expect(highlighter.getAST(raw, "a.thrift", "thrift")).not.toEqual({
			type: "root",
			children: [{ type: "text", value: raw }],
		});
	});
});
