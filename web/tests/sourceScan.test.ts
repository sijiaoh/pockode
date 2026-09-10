import { describe, expect, it } from "vitest";
import { ROOTS, sourceFiles } from "./sourceScan";

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
