import { describe, expect, it } from "vitest";
import { changePatches, proposedChange } from "./proposedChange";

describe("proposedChange", () => {
	it("leaves out an edit that changes nothing, which has no hunk to draw", () => {
		const change = proposedChange("MultiEdit", {
			file_path: "/w/a.ts",
			edits: [
				{ old_string: "same", new_string: "same" },
				{ old_string: "a", new_string: "b" },
			],
		});
		if (!change) throw new Error("not a change");

		const patches = changePatches(change) ?? [];
		expect(patches).toHaveLength(1);
		expect(patches[0]).toMatch(/^\+b$/m);
	});
});
