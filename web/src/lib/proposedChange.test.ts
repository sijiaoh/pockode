import { describe, expect, it } from "vitest";
import {
	changePatches,
	changeRowCount,
	notebookCellLabel,
	type ProposedChangeData,
	proposedChange,
	proposedChangeText,
} from "./proposedChange";

const notebook = (input: Record<string, unknown>) => {
	const change = proposedChange("NotebookEdit", {
		notebook_path: "/w/a.ipynb",
		...input,
	});
	if (change?.kind !== "notebook") throw new Error("not a notebook change");
	return change;
};

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

describe("a NotebookEdit's change", () => {
	it("is the cell's new source, read off the input, headed by which cell", () => {
		const change = notebook({
			cell_id: "c1",
			new_source: "x = 1\nprint(x)\n",
			cell_type: "code",
		});
		expect(change.mode).toBe("replace");
		expect(notebookCellLabel(change)).toBe("Cell c1 · code");
		expect(proposedChangeText(change)).toBe("x = 1\nprint(x)\n");
		expect(changeRowCount(change)).toBe(2);
		expect(changePatches(change)).toBeUndefined();
	});

	it.each<[Record<string, unknown>, string]>([
		[
			{ edit_mode: "insert", cell_id: "c1", cell_type: "markdown" },
			"New markdown cell after c1",
		],
		[{ edit_mode: "insert" }, "New cell at the top"],
		[{ edit_mode: "delete", cell_id: "c1" }, "Deleted cell c1"],
	])("names %o as %s", (input, label) => {
		expect(notebookCellLabel(notebook({ new_source: "", ...input }))).toBe(
			label,
		);
	});

	it("has nothing to copy for a delete, whose cell is not in the call", () => {
		const change = notebook({
			edit_mode: "delete",
			cell_id: "c1",
			new_source: "",
		});
		expect(proposedChangeText(change)).toBeUndefined();
		expect(changeRowCount(change)).toBe(0);
	});

	// A half-read cell would claim to know which cell the call wrote.
	it.each<[string, Record<string, unknown>]>([
		["an older CLI's cell_number", { cell_number: 2, new_source: "x" }],
		["no source to write", { cell_id: "c1" }],
		["an unknown mode", { cell_id: "c1", new_source: "x", edit_mode: "move" }],
	])("is no change for %s", (_, input) => {
		const change: ProposedChangeData | null = proposedChange("NotebookEdit", {
			notebook_path: "/w/a.ipynb",
			...input,
		});
		expect(change).toBeNull();
	});
});
