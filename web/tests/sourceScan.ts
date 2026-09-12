import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Every front-end source tree, so a rule proven here holds for code nobody has
 * written yet. Relative to the project vitest runs in (`web/`).
 *
 * Lives outside `src` because reading files needs Node types; see
 * responsiveTokens.test.ts for the same reasoning.
 */
export const ROOTS = ["src", "../web-cluster/src", "../packages/shared/src"];

/** Every stylesheet compiled against the ladder. Each declares its own copy. */
export const STYLESHEETS = {
	"web/src/index.css": "src/index.css",
	"web-cluster/src/index.css": "../web-cluster/src/index.css",
} as const;

/**
 * Which stylesheets each scanned root is compiled into.
 *
 * A `pointer-fine:` or `pointer-coarse:` class means what the stylesheet
 * compiling it says it means, and the source scans read it as the rule being
 * satisfied without knowing which stylesheet that is. Both names are also
 * Tailwind 4.1 built-ins — `(pointer: coarse)` and `(pointer: fine)`, the
 * primary pointer and no `hover: hover` — so a stylesheet that has not
 * redeclared them does not drop the class, it silently compiles it to the
 * narrower query the whole rule set exists to keep out of hit-area sizing.
 * `packages/shared` is the sharp edge: it compiles into *both* stylesheets, so
 * one component can be right in web and wrong in web-cluster. Writing the
 * mapping down is what lets responsiveTokens.test.ts hold every root to a
 * stylesheet that redeclares both gates, and makes adding a fourth root a
 * decision rather than an oversight.
 *
 * What it does not do, so nobody reads more into it: this is a written claim
 * about the build, not something read out of it. The test checks the keys
 * against ROOTS and the values against the stylesheets it knows how to read; a
 * line that names the wrong stylesheet would still pass. A person keeps it
 * true.
 */
export const ROOT_STYLESHEETS: Record<string, (keyof typeof STYLESHEETS)[]> = {
	src: ["web/src/index.css"],
	"../web-cluster/src": ["web-cluster/src/index.css"],
	"../packages/shared/src": ["web/src/index.css", "web-cluster/src/index.css"],
};

export function sourceFiles(root: string): string[] {
	const abs = resolve(process.cwd(), root);
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
		}
	};
	walk(abs);
	return out;
}

/** Repo-relative path, so a failure names the file the same way git does. */
export function repoPath(file: string): string {
	return relative(resolve(process.cwd(), ".."), file);
}
