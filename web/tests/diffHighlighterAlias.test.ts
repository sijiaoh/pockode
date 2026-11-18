import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOTS, repoPath, sourceFiles } from "./sourceScan";

// highlight.js's ~190 grammars used to ride in the entry chunk, through a
// static import in the diff library. Two ways bring them back without any
// test going red elsewhere: a config that drops the alias swapping that
// import out (vite.alias.ts), and app code importing highlight.js's bundles
// itself. A grammar is loaded only by `import()`, as its own chunk.
//
// A scan rather than a build: what it cannot see is a dependency newly
// importing highlight.js whole. Checked by hand with `pnpm run build` when
// adding one that highlights code.

// Read as text: importing a config here would start esbuild under jsdom.
// That the alias resolves to the right module is held where it takes effect,
// in src/lib/diffFallbackHighlighter.test.ts.
describe("the diff highlighter alias", () => {
	it.each([
		"vite.config.ts",
		"vitest.config.ts",
		"vitest.browser.config.ts",
	])("is spread into %s", (file) => {
		const source = readFileSync(file, "utf8");

		expect(source).toMatch(
			/export default defineConfig\(\{\s*\.\.\.diffHighlighterAlias,/,
		);
		// A key of the config's own after the spread would replace the alias's
		// object whole, not add to it.
		expect(source).not.toMatch(/^\t(resolve|optimizeDeps):/m);
	});
});

// A module, not type-only, that loads more than one grammar when imported.
const BUNDLES = [
	/^import\s+(?!type\b)[^;]*?from\s+"highlight\.js(\/lib\/(common|index))?"/m,
	/^import\s+(?!type\b)[^;]*?from\s+"highlight\.js\/lib\/languages\/[^"]+"/m,
	/^import\s+(?!type\b)\{[^}]*\b(all|common)\b[^}]*\}\s*from\s+"lowlight"/m,
	/^import\s+(?!type\b)[^;]*?from\s+"@git-diff-view\/lowlight"/m,
];

describe("highlight.js in app code", () => {
	it("is never imported whole, nor a grammar statically", () => {
		const offenders = ROOTS.flatMap(sourceFiles).filter((file) => {
			const source = readFileSync(file, "utf8");
			return BUNDLES.some((pattern) => pattern.test(source));
		});

		expect(offenders.map(repoPath)).toEqual([]);
	});
});
