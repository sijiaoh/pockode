import { describe, expect, it } from "vitest";
import { ROOTS, sourceFiles } from "./sourceScan";
import {
	buttonClusters,
	classHelpers,
	hitAreaFault,
	interactiveControls,
	spacingFault,
} from "./touchTarget";

// Hit area follows the pointer: 44px where a finger may land, 36px where only a
// mouse can. The rule cannot be checked by rendering, because jsdom applies no
// Tailwind — the button measures 0x0 before and after a fix — so it is checked
// as a property of the source, which also makes it hold for components nobody
// has written yet. See docs/responsive-ui.md.
describe("touch targets", () => {
	it("gives every interactive element a 44px hit area on a coarse pointer", () => {
		const files = ROOTS.flatMap(sourceFiles);
		const helpers = classHelpers(files);
		const faults = files
			.flatMap((f) => interactiveControls(f, helpers))
			.map((c) => [c, hitAreaFault(c)] as const)
			.filter(([, fault]) => fault !== null)
			.map(
				([c, fault]) =>
					`${c.file}:${c.line} <${c.tag}>\n  ${fault}\n  ${c.classes}`,
			);
		expect(faults).toEqual([]);
	});

	it("keeps neighbouring controls 8px apart on a coarse pointer", () => {
		const faults = ROOTS.flatMap(sourceFiles)
			.flatMap(buttonClusters)
			.map((c) => [c, spacingFault(c)] as const)
			.filter(([, fault]) => fault !== null)
			.map(([c, fault]) => `${c.file}:${c.line}\n  ${fault}\n  ${c.classes}`);
		expect(faults).toEqual([]);
	});
});
