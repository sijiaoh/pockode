import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BREAKPOINTS, MEDIA_QUERIES } from "@pockode/shared";
import { describe, expect, it } from "vitest";
import { ROOT_STYLESHEETS, ROOTS, STYLESHEETS } from "./sourceScan";
import { COARSE_FLOOR, FINE_FLOOR } from "./touchTarget";

// The ladder and the two pointer gates each have to exist twice: once as a
// value JS can hand to matchMedia, once as something Tailwind can compile.
// Nothing at runtime would notice the two drifting apart — a class would simply
// start switching at a different width than the hook, which is the exact split
// this infrastructure exists to remove. These assertions are what keeps the
// stylesheets derived from packages/shared/src/utils/responsive.ts rather than
// merely resembling it.
//
// Lives outside `src` for the same reason vitest.setup.ts does: reading the
// stylesheet as text needs Node types, which the app project deliberately does
// not have (and Vitest blanks out CSS imports, so `?raw` is not an option).
// Vitest transpiles it either way; a drifted token fails the assertion below
// rather than the type check.
//
// Vitest rewrites import.meta.url, so paths are resolved from the project root
// it runs in instead.

function read(path: string): string {
	return readFileSync(resolve(process.cwd(), path), "utf8");
}

function themeValue(css: string, name: string): string | undefined {
	return new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
}

function customVariant(css: string, name: string): string | undefined {
	return new RegExp(`@custom-variant ${name} \\(@media (.*)\\);`)
		.exec(css)?.[1]
		.trim();
}

describe.each(Object.entries(STYLESHEETS))("%s ladder", (_name, path) => {
	const css = read(path);

	it.each([
		["sm", BREAKPOINTS.sm],
		["lg", BREAKPOINTS.lg],
	])("declares --breakpoint-%s as the shared value", (name, px) => {
		expect(themeValue(css, `breakpoint-${name}`)).toBe(`${px}px`);
	});

	// Left in place, Tailwind's other three rungs are switching points no hook
	// knows about — exactly what put the shell at 768 and its contents at 640.
	it.each(["md", "xl", "2xl"])("retires --breakpoint-%s", (name) => {
		expect(themeValue(css, `breakpoint-${name}`)).toBe("initial");
	});
});

// Both stylesheets, not just web's, and pinned to the shared queries rather
// than merely required to exist. Both names are Tailwind 4.1 built-ins that
// these declarations shadow, so a stylesheet that drops one still compiles the
// class — to `(pointer: coarse)`, the primary pointer, which is the query the
// rules say must never size a hit area. Nothing would fail; the source scans
// read the class as the rule being met either way. packages/shared is compiled
// into both stylesheets, so that component would be right in one and wrong in
// the other.
describe.each(
	Object.entries(STYLESHEETS),
)("%s pointer gates", (_name, path) => {
	const css = read(path);

	it("mirrors the fine-pointer gate", () => {
		expect(customVariant(css, "pointer-fine")).toBe(MEDIA_QUERIES.finePointer);
	});

	it("mirrors the coarse-pointer gate", () => {
		expect(customVariant(css, "pointer-coarse")).toBe(
			MEDIA_QUERIES.anyCoarsePointer,
		);
	});
});

// The two assertions above only cover the source trees that are actually
// compiled by one of these two stylesheets. This is what says every scanned
// root is: a fourth root added to ROOTS without a line in ROOT_STYLESHEETS
// would otherwise be scanned for gate classes nothing had promised to define.
describe("gate coverage", () => {
	it("compiles every scanned root with a stylesheet that defines the gates", () => {
		expect(Object.keys(ROOT_STYLESHEETS).sort()).toEqual([...ROOTS].sort());
		for (const sheets of Object.values(ROOT_STYLESHEETS)) {
			expect(sheets.length).toBeGreaterThan(0);
			for (const sheet of sheets) expect(STYLESHEETS[sheet]).toBeDefined();
		}
	});
});

// `hitAreaFault` treats `touch-target` as clearing both floors and stops
// looking — so every control that reaches the floor through the overlay rests
// on this utility actually declaring them. Nothing at runtime would notice if
// it stopped: the class stays on the element and the scan stays green while the
// hit area quietly shrinks to the box. That is how the code block's copy button
// lost its expanded target — its own unconditional `::after` was replaced by an
// overlay that only existed on a coarse pointer, leaving 26px under a mouse.
describe("web/src/index.css touch-target", () => {
	const css = read(STYLESHEETS["web/src/index.css"]);

	/** The `@utility touch-target { ... }` body, brace-matched. */
	const body = (() => {
		const start = css.indexOf("@utility touch-target");
		// Gone entirely, which the assertions below would otherwise report as a
		// stylesheet that merely forgot a number. (A *rename* still matches here,
		// and is not this test's to catch: the renamed utility would stop being
		// emitted for the `touch-target` class the components carry, which is the
		// general case of a class whose definition does not exist compiling to
		// nothing.)
		if (start < 0) return "";
		const open = css.indexOf("{", start);
		let depth = 0;
		for (let i = open; i < css.length; i++) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}" && --depth === 0) return css.slice(open, i);
		}
		return "";
	})();

	/**
	 * The part of the utility behind the coarse gate, and the part outside it.
	 *
	 * The gate is built from the shared constant rather than spelled again here:
	 * a second copy of the query is the split the rest of this file exists to
	 * prevent.
	 */
	const gate = MEDIA_QUERIES.anyCoarsePointer
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\\?\s+/g, "\\s*");
	const coarseBlock = new RegExp(
		`@media\\s*${gate}\\s*\\{([\\s\\S]*)\\}\\s*$`,
	).exec(body.trim())?.[1];
	const always = coarseBlock ? body.replace(coarseBlock, "") : body;

	it("declares the fine-pointer floor unconditionally", () => {
		expect(always).toMatch(new RegExp(`min-width:\\s*${FINE_FLOOR}px`));
		expect(always).toMatch(new RegExp(`min-height:\\s*${FINE_FLOOR}px`));
	});

	it("raises both axes to the coarse floor behind the coarse gate", () => {
		expect(coarseBlock).toBeDefined();
		expect(coarseBlock).toMatch(new RegExp(`min-width:\\s*${COARSE_FLOOR}px`));
		expect(coarseBlock).toMatch(new RegExp(`min-height:\\s*${COARSE_FLOOR}px`));
	});
});
