import { resolve } from "node:path";

/**
 * Spread into every config that bundles the app, so the build, the dev server
 * and both test entries draw diffs with the same highlighter.
 *
 * `@git-diff-view/core` imports `@git-diff-view/lowlight` statically, and that
 * module registers all ~190 highlight.js grammars as it loads, which put every
 * one of them in the entry chunk. Shiki colours diffs, so the alias swaps in a
 * module that loads a highlight.js grammar only for a language shiki lacks
 * (src/lib/diffFallbackHighlighter.ts). tests/diffHighlighterAlias.test.ts
 * holds every config to it.
 *
 * Kept out of dependency pre-bundling, which would otherwise copy the module
 * into the library's bundle: the app and the library would each hold an
 * instance, and a grammar the app loaded would be missing from the library's.
 */
export const diffHighlighterAlias = {
	resolve: {
		alias: {
			"@git-diff-view/lowlight": resolve(
				import.meta.dirname,
				"src/lib/diffFallbackHighlighter.ts",
			),
		},
	},
	optimizeDeps: { exclude: ["@git-diff-view/lowlight"] },
};
