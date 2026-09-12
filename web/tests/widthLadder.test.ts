import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOTS, repoPath, sourceFiles } from "./sourceScan";

// The ladder has three rungs and two breakpoints: `sm` (640) and `lg` (1024).
// Tailwind's other three defaults are retired in both stylesheets' `@theme`, so
// a stray `md:` compiles to nothing at all — the layout silently keeps whatever
// the smaller rung said, at whatever width the author had in mind. That is the
// quieter half of the same failure `md:` caused in the first place: a shell that
// switched at 768 while every hook switched somewhere else.
//
// Retiring the token is what makes the class inert; this is what makes it loud.
// See docs/responsive-ui.md.

// Lookbehind rather than an explicit set of preceding characters: a rung can be
// stacked behind another variant (`dark:md:hidden`) or follow an interpolation
// (`${base}md:hidden`), and anything that only accepted quotes and whitespace
// would skip exactly those and report a clean scan.
const RETIRED = /(?<![\w-])((?:max-)?(?:md|xl|2xl)):/g;

/** Anything that could be a class list. Cheap and deliberately over-inclusive. */
function stringLiterals(source: string): string[] {
	return source.match(/"[^"\n]*"|`[^`]*`/g) ?? [];
}

function inspect(file: string): string[] {
	const source = readFileSync(file, "utf8");
	return stringLiterals(source).flatMap((literal) =>
		[...literal.matchAll(RETIRED)].map(
			([, rung]) =>
				`${repoPath(file)}\n  \`${rung}:\` is not on the ladder — use \`sm:\` (640) or \`lg:\` (1024)\n  ${literal}`,
		),
	);
}

describe("width ladder", () => {
	it("uses only the two authorized breakpoints", () => {
		expect(ROOTS.flatMap(sourceFiles).flatMap(inspect)).toEqual([]);
	});
});
