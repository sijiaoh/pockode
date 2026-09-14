import { describe, expect, it } from "vitest";
import { iconButtonClass } from "../src/components/ui/iconButtonClass";
import { COARSE_FLOOR, FINE_FLOOR } from "./touchTarget";

// touchTarget.test.ts checks these floors for us at every call site: it splices
// this helper's body in and reads the numbers off it, one class list per branch
// the caller could take. It could not always — it read the two branches as one
// blob, so `touch-target` from the fixed branch waved through every caller of
// the grown one, on a class only half of them receive.
//
// What is left here is what the scan still cannot say. `touch-target` clears
// both floors and it stops reading, so the fixed branch's `size-9` — the visual
// rung, not the hit area — is checked by nobody else. And which branch a call
// site takes is decided by an argument the scan does not evaluate, so the
// default is not readable there either. Living here rather than beside the
// source so the floors can come from the one file that defines them.
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
