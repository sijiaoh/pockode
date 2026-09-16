import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ROOT_STYLESHEETS,
	ROOTS,
	STYLESHEETS,
	sourceFiles,
} from "./sourceScan";

// The scans built on this helper assert that a violation is *absent*, so they
// pass just as happily when they read nothing at all. Asserted per root rather
// than as a total: `src` alone clears any total worth asserting, so a root left
// pointing at a moved or renamed directory would go unnoticed while every scan
// stayed green. (Deleting a root outright is not something this can catch —
// only a reviewer can.)
describe("source scan coverage", () => {
	it.each(ROOTS)("finds source files under %s", (root) => {
		expect(sourceFiles(root).length).toBeGreaterThan(0);
	});
});

// ROOT_STYLESHEETS is a written claim about which stylesheets compile which
// source tree, and the comment on it says a person keeps it true. This is the
// half a test can keep: Tailwind's automatic source detection starts at the
// project directory and never enters node_modules, so the one root that is not
// inside either project — `packages/shared`, reached through a workspace link —
// is compiled only because both stylesheets name it with `@source`. Dropping
// that line breaks nothing loudly: the components still render, missing only
// the classes no other file in that project happens to write.
describe("stylesheet source coverage", () => {
	it.each(
		Object.entries(ROOT_STYLESHEETS).flatMap(([root, sheets]) =>
			sheets.map((sheet) => ({ root, sheet })),
		),
	)("compiles $root into $sheet", ({ root, sheet }) => {
		const path = STYLESHEETS[sheet];
		const project = resolve(process.cwd(), dirname(path), "..");
		const abs = resolve(process.cwd(), root);
		if (abs.startsWith(`${project}/`)) return; // Auto-detected.

		const sources = [
			...readFileSync(resolve(process.cwd(), path), "utf8").matchAll(
				/@source\s+"([^"]+)"/g,
			),
		].map((m) => resolve(process.cwd(), dirname(path), m[1]));
		// An ancestor counts: naming the package rather than its `src` scans the
		// same files and more.
		expect(sources.some((s) => abs === s || abs.startsWith(`${s}/`))).toBe(
			true,
		);
	});
});
