import { describe, expect, it } from "vitest";
import { iconButtonClass } from "../src/components/ui/iconButtonClass";
import { COARSE_FLOOR, FINE_FLOOR } from "./touchTarget";

// touchTarget.test.ts used to check these floors for us: it splices this
// helper's body into every call site and reads the numbers off it. It cannot
// any more. The scan treats `touch-target` as satisfying both floors and stops
// reading there, and the body now contains that word in one branch — so a call
// site taking the *other* branch is waved through on the strength of a class it
// never receives.
//
// That leaves the two branches unguarded from the outside, and they are the
// only place the rung's numbers are written down. Hence these, which read the
// branches directly. Living here rather than beside the source so the floors
// can come from the one file that defines them.
describe("iconButtonClass", () => {
	it("states both floors on the branch that grows its box", () => {
		const grown = iconButtonClass().split(/\s+/);
		expect(grown).toContain(`min-h-[${FINE_FLOOR}px]`);
		expect(grown).toContain(`min-w-[${FINE_FLOOR}px]`);
		expect(grown).toContain(`pointer-coarse:min-h-${COARSE_FLOOR / 4}`);
		expect(grown).toContain(`pointer-coarse:min-w-${COARSE_FLOOR / 4}`);
		// Growing is the default, so a caller that says nothing gets the box that
		// is safe in a row with room to spare.
		expect(iconButtonClass({ busy: true })).toContain("pointer-coarse:min-h-");
	});

	// The box is fixed because something else is measured against its width; the
	// hit area is laid over it instead, which is what `touch-target` is.
	it("keeps the box at the visual rung and overlays the hit area otherwise", () => {
		const fixed = iconButtonClass({ grow: false });
		expect(fixed.split(/\s+/)).toContain(`size-${FINE_FLOOR / 4}`);
		expect(fixed.split(/\s+/)).toContain("touch-target");
		expect(fixed).not.toContain("pointer-coarse:min-");
	});
});
