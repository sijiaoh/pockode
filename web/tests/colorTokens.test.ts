import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { declaredNames } from "./css";
import {
	ROOT_STYLESHEETS,
	ROOTS,
	repoPath,
	STYLESHEETS,
	sourceFiles,
} from "./sourceScan";

// A Tailwind colour utility naming a token the stylesheet never declared is
// dropped: the class stays on the element, compiles to nothing, and the element
// inherits whatever colour it was going to have anyway. Nothing goes red and
// nothing looks obviously wrong — `text-th-bg` on an accent-filled button reads
// as muted-on-accent, which is a contrast failure that has to be *noticed*.
//
// It is the same shape of silent failure as a `@source` that does not reach a
// shared component, and it is caught the same way: by reading the source and
// the stylesheet as text, because no amount of rendering in jsdom applies
// Tailwind. The contrast test guards the pairs that exist; this one guards
// against naming a colour that does not.
//
// Both stylesheets, per root, from ROOT_STYLESHEETS: `packages/shared` compiles
// into both, so a token only one of them declares is a class that works in one
// project and silently does nothing in the other.

/** Every Tailwind utility that resolves a `--color-*` token, by its token name. */
const COLOR_UTILITY =
	/\b(?:bg|text|border|ring|outline|divide|fill|stroke|shadow|accent|caret|decoration|placeholder|from|via|to)-(th-[a-z0-9-]+)/g;

/**
 * The colour a utility asks for, with the opacity modifier and any variant
 * prefixes already gone — `hover:bg-th-accent/10` asks for `th-accent`.
 *
 * Border utilities are the one ambiguity worth naming: `border-th-border` is a
 * colour, `border-l-2` is a width, and `border-l-th-warning` is a colour on one
 * side. The pattern above only matches when a `th-` name follows, so widths and
 * styles never reach this.
 */
function tokensIn(source: string): Map<string, number[]> {
	const found = new Map<string, number[]>();
	source.split("\n").forEach((line, i) => {
		for (const [, token] of line.matchAll(COLOR_UTILITY)) {
			found.set(token, [...(found.get(token) ?? []), i + 1]);
		}
	});
	return found;
}

describe("theme colour tokens", () => {
	const declared = new Map(
		Object.entries(STYLESHEETS).map(([name, path]) => [
			name,
			new Set(
				declaredNames(
					readFileSync(resolve(process.cwd(), path), "utf8"),
					"color-",
				).map((n) => n.replace(/^color-/, "")),
			),
		]),
	);

	// The assertion below is that something is *absent*, so it would pass just
	// as happily against a scan that found nothing at all.
	it("finds the colours the app actually uses", () => {
		for (const [name, tokens] of declared) {
			expect(
				tokens.size,
				`${name} declares no --color-th-* tokens`,
			).toBeGreaterThan(0);
		}
		const used = ROOTS.flatMap(sourceFiles).flatMap((file) => [
			...tokensIn(readFileSync(file, "utf8")).keys(),
		]);
		expect(new Set(used).size).toBeGreaterThan(10);
	});

	it("declares every colour the source names", () => {
		const faults: string[] = [];
		for (const root of ROOTS) {
			for (const sheet of ROOT_STYLESHEETS[root]) {
				const tokens = declared.get(sheet);
				if (!tokens) continue;
				for (const file of sourceFiles(root)) {
					for (const [token, lines] of tokensIn(readFileSync(file, "utf8"))) {
						if (tokens.has(token)) continue;
						faults.push(
							`${repoPath(file)} line ${lines[0]}\n  ${token} is not declared in ${sheet}, so the utility naming it compiles to nothing`,
						);
					}
				}
			}
		}
		expect(faults).toEqual([]);
	});
});
