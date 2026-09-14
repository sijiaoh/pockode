import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classHelpers } from "./classScan";
import { ROOTS, sourceFiles } from "./sourceScan";
import {
	buttonClusters,
	deferredControls,
	hitAreaFault,
	impliedHeight,
	interactiveControls,
	renderCensus,
	spacingFault,
} from "./touchTarget";

// Hit area follows the pointer: 44px where a finger may land, 36px where only a
// mouse can. The rule cannot be checked by rendering, because jsdom applies no
// Tailwind — the button measures 0x0 before and after a fix — so it is checked
// as a property of the source, which also makes it hold for components nobody
// has written yet. See docs/responsive-ui.md.
describe("touch targets", () => {
	const files = ROOTS.flatMap(sourceFiles);
	const helpers = classHelpers(files);

	it("gives every interactive element a 44px hit area on a coarse pointer", () => {
		const faults = files
			.flatMap((f) => interactiveControls(f, helpers))
			.map((c) => [c, hitAreaFault(c)] as const)
			.filter(([, fault]) => fault !== null)
			.map(
				([c, fault]) =>
					`${c.file}:${c.line} <${c.tag}>\n  ${fault}\n  ${c.classes.join("\n  ")}`,
			);
		expect(faults).toEqual([]);
	});

	// The rule reaches a control that wrote a height down; a control whose height
	// is its padding plus its line box is outside it. Those are not exempt, they
	// are deferred — and a deferred population nobody recounts is how this number
	// spent four revisions being the previous one plus one, in a section that
	// restated it four times over. The scan computes the heights, this compares
	// the result against the register in the doc, and a control written into that
	// shape tomorrow turns this red on the commit that writes it.
	it("matches the register in docs/responsive-ui.md", () => {
		const controls = files.flatMap((f) => interactiveControls(f, helpers));
		const doc = readFileSync(
			resolve(process.cwd(), "../docs/responsive-ui.md"),
			"utf8",
		);
		const block = /<!-- census[^>]*-->\s*```text\n([\s\S]*?)```/.exec(doc);
		expect(
			block,
			"docs/responsive-ui.md has no `<!-- census -->` block to compare against",
		).not.toBeNull();
		// Paste the expected side of this diff back into that block.
		expect(block?.[1]).toBe(renderCensus(deferredControls(controls)));
	});

	it("keeps neighbouring controls 8px apart on a coarse pointer", () => {
		const faults = files
			.flatMap(buttonClusters)
			.map((c) => [c, spacingFault(c)] as const)
			.filter(([, fault]) => fault !== null)
			.map(([c, fault]) => `${c.file}:${c.line}\n  ${fault}\n  ${c.classes}`);
		expect(faults).toEqual([]);
	});
});

// The register above is only worth its test if the arithmetic under it is
// right, and the repository exercises a narrow slice of it: every control in
// the census today lands on one of three font sizes with unprefixed padding.
// These are the cases that decide whether a height is trustworthy, written out
// rather than waited for.
describe("implied height", () => {
	it("adds vertical padding to the line box it can read", () => {
		// The example docs/responsive-ui.md gives for this shape.
		expect(impliedHeight("px-3 py-1.5 text-xs")).toEqual({
			fine: 28,
			coarse: 28,
			inherited: false,
		});
	});

	it("falls back to the inherited line box, marked as a bound", () => {
		expect(impliedHeight("p-2")).toEqual({
			fine: 40,
			coarse: 40,
			inherited: true,
		});
	});

	it("lets an explicit leading win over the font size's own", () => {
		expect(impliedHeight("py-2 text-xs leading-5")?.fine).toBe(36);
	});

	it("reads padding behind a pointer gate onto that pointer only", () => {
		expect(impliedHeight("pointer-coarse:py-3 text-sm")).toEqual({
			fine: 20,
			coarse: 44,
			inherited: false,
		});
	});

	it.each([
		"h-9 text-sm",
		"self-stretch text-sm",
		"touch-target text-sm",
	])("says nothing about %s, which the floor already holds to a number", (classes) => {
		expect(impliedHeight(classes)).toBeNull();
	});

	// Not "no font size stated": reading it as that would hand the control the
	// 16px default and quietly publish a height nobody computed.
	it("refuses a font size it cannot turn into pixels", () => {
		expect(impliedHeight("py-1 text-[0.8rem]")).toBeNull();
	});
});
