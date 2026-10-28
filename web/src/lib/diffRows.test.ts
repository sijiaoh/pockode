import { describe, expect, it } from "vitest";
import { parseHunks } from "./diffHunks";
import {
	applyPress,
	buildDiffRows,
	describeRange,
	type GutterLine,
	hunkLineRange,
	type LineRange,
	PREFILL_MAX_ROWS,
	rangeSignature,
	relocateRange,
	resolveRange,
	rowKey,
	selectionCopyText,
	selectionPrefillText,
} from "./diffRows";

const content = (lines: string[]) => `${lines.join("\n")}\n`;
const numbered = (length: number, edits: Record<number, string> = {}) =>
	Array.from({ length }, (_, i) => edits[i + 1] ?? `line ${i + 1}`);

// Ten lines; line 3 replaced, line 8 removed.
const OLD = content(numbered(10));
const NEW = content(numbered(10, { 3: "edit 3" }).filter((_, i) => i !== 7));
const PATCH = [
	"@@ -2,3 +2,3 @@",
	" line 2",
	"-line 3",
	"+edit 3",
	" line 4",
	"@@ -7,3 +7,2 @@ function f() {",
	" line 7",
	"-line 8",
	" line 9",
].join("\n");
const rows = buildDiffRows(parseHunks(PATCH), { old: OLD, new: NEW });

const range = (view: LineRange["view"], anchor: string, focus = anchor) => ({
	view,
	anchor,
	focus,
});
const selected = (r: LineRange) => resolveRange(rows, r) ?? [];

describe("buildDiffRows", () => {
	it("puts the unchanged lines between and around the hunks in their place", () => {
		expect(
			rows.map((row) => `${row.kind[0]}${row.old ?? "-"}:${row.new ?? "-"}`),
		).toEqual([
			"c1:1",
			"c2:2",
			"r3:-",
			"a-:3",
			"c4:4",
			"c5:5",
			"c6:6",
			"c7:7",
			"r8:-",
			"c9:8",
			"c10:9",
		]);
		expect(rows.filter((row) => row.hunk === undefined)).toHaveLength(4);
	});
});

describe("applyPress", () => {
	const line = (key: string, view: GutterLine["view"] = "unified") => ({
		view,
		key,
	});

	it("starts, extends from the anchor, and clears on the only line pressed again", () => {
		const one = applyPress(null, { type: "start", line: line("n2") });
		expect(one).toEqual(range("unified", "n2"));
		const two = applyPress(one, { type: "extend", line: line("n5") });
		expect(two).toEqual(range("unified", "n2", "n5"));
		// A tap one line off is corrected by the next: the far end moves.
		expect(applyPress(two, { type: "extend", line: line("n4") })).toEqual(
			range("unified", "n2", "n4"),
		);
		expect(applyPress(two, { type: "start", line: line("n7") })).toEqual(
			range("unified", "n7"),
		);
		expect(applyPress(one, { type: "extend", line: line("n2") })).toBeNull();
	});

	it("starts again on the other side of split view rather than extending", () => {
		const old = range("old", "o3");
		expect(
			applyPress(old, { type: "extend", line: line("n6", "new") }),
		).toEqual(range("new", "n6"));
	});
});

describe("describeRange", () => {
	it.each([
		{ r: range("unified", "n2", "n5"), label: "lines 2–5", side: "new" },
		{ r: range("unified", "n3"), label: "line 3", side: "new" },
		{ r: range("unified", "o3"), label: "removed line 3", side: "old" },
		{ r: range("old", "o2", "o4"), label: "old lines 2–4", side: "old" },
		{ r: range("old", "o8"), label: "removed line 8", side: "old" },
		// A removed line inside is numbered by the new lines around it.
		{ r: range("unified", "o3", "n4"), label: "lines 3–4", side: "new" },
	])("names $label", ({ r, label, side }) => {
		expect(describeRange(selected(r), r.view)).toMatchObject({ label, side });
	});
});

describe("selectionCopyText", () => {
	it("copies the numbered side verbatim, without markers, gap lines included", () => {
		const r = range("unified", "n2", "n7");
		const s = selected(r);
		expect(
			selectionCopyText(describeRange(s, r.view), s, { old: OLD, new: NEW }),
		).toBe(
			["line 2", "edit 3", "line 4", "line 5", "line 6", "line 7"].join("\n"),
		);
	});

	it("copies the old side for removed lines", () => {
		const r = range("old", "o2", "o4");
		const s = selected(r);
		expect(
			selectionCopyText(describeRange(s, r.view), s, { old: OLD, new: NEW }),
		).toBe("line 2\nline 3\nline 4");
	});
});

describe("selectionPrefillText", () => {
	const prefill = (
		r: LineRange,
		{
			staged = false,
			shown = (_: string): boolean => true,
		}: { staged?: boolean; shown?: (key: string) => boolean } = {},
	) => {
		const s = selected(r);
		return selectionPrefillText({
			path: "src/a.ts",
			selected: s,
			view: r.view,
			description: describeRange(s, r.view),
			staged,
			isShown: (row) => shown(rowKey(row, r.view) ?? ""),
		});
	};

	it("writes the path, range, version and a diff fence, a collapsed gap as one line", () => {
		const text = prefill(range("unified", "n3", "o8"), {
			shown: (key) => !["n5", "n6"].includes(key),
		});
		expect(text).toBe(
			[
				"`src/a.ts`, lines 3–7 (working tree):",
				"",
				"```diff",
				"+edit 3",
				" line 4",
				"… 2 unchanged lines …",
				" line 7",
				"-line 8",
				"```",
			].join("\n"),
		);
	});

	it.each([
		{ r: range("unified", "n2"), staged: false, version: "working tree" },
		{ r: range("unified", "n2"), staged: true, version: "staged" },
		{ r: range("old", "o2"), staged: false, version: "index" },
		{ r: range("old", "o2"), staged: true, version: "HEAD" },
	])("names the $version version", ({ r, staged, version }) => {
		expect(prefill(r, { staged }).split("\n")[0]).toMatch(`(${version}):`);
	});

	it("makes the fence longer than any run of backticks in the code", () => {
		const patch = ["@@ -1 +1 @@", "-a", "+x ```` y"].join("\n");
		const own = buildDiffRows(parseHunks(patch), {
			old: "a\n",
			new: "x ```` y\n",
		});
		const s = resolveRange(own, range("unified", "n1")) ?? [];
		const text = selectionPrefillText({
			path: "a.md",
			selected: s,
			view: "unified",
			description: describeRange(s, "unified"),
			staged: false,
			isShown: () => true,
		});
		expect(text).toContain("\n`````diff\n");
		expect(text.endsWith("\n`````")).toBe(true);
	});

	it("leaves the code out past the row limit", () => {
		const length = PREFILL_MAX_ROWS + 1;
		const patch = [
			`@@ -0,0 +1,${length} @@`,
			...numbered(length).map((l) => `+${l}`),
		].join("\n");
		const own = buildDiffRows(parseHunks(patch), {
			old: "",
			new: content(numbered(length)),
		});
		const s = resolveRange(own, range("unified", "n1", `n${length}`)) ?? [];
		expect(
			selectionPrefillText({
				path: "a.ts",
				selected: s,
				view: "unified",
				description: describeRange(s, "unified"),
				staged: false,
				isShown: () => true,
			}),
		).toBe(`\`a.ts\`, lines 1–${length} (working tree).`);
	});
});

describe("hunkLineRange", () => {
	it("takes the hunk's rows, on the new side in split view unless it has none there", () => {
		expect(hunkLineRange(rows, 0, false)).toEqual(range("unified", "n2", "n4"));
		expect(hunkLineRange(rows, 1, true)).toEqual(range("new", "n7", "n8"));
		const removedOnly = buildDiffRows(
			parseHunks(["@@ -3,2 +2,0 @@", "-a", "-b"].join("\n")),
			{ old: "", new: "" },
		);
		expect(hunkLineRange(removedOnly, 0, true)).toEqual(
			range("old", "o3", "o4"),
		);
	});
});

describe("relocateRange", () => {
	const hold = (rs: typeof rows, r: LineRange) =>
		rangeSignature(resolveRange(rs, r) ?? [], r.view);

	it("lets the selection go when a selected row's text changed", () => {
		const r = range("unified", "n2", "n4");
		const edited = buildDiffRows(
			parseHunks(PATCH.replace("+edit 3", "+edit 3 again")),
			{ old: OLD, new: NEW },
		);
		expect(relocateRange(edited, r, hold(rows, r), true)).toBeNull();
	});

	// On the unstaged side the old numbers are the index's: staging a hunk
	// above moves them, while the lines picked are the same lines.
	it("finds the same rows again when a hunk above moved their old numbers", () => {
		const old = content(numbered(10));
		const now = content(
			numbered(10, { 8: "edit 8" }).filter((_, i) => i !== 1),
		);
		const second = [
			"@@ -7,3 +6,3 @@",
			" line 7",
			"-line 8",
			"+edit 8",
			" line 9",
		];
		const before = buildDiffRows(
			parseHunks(
				["@@ -1,3 +1,2 @@", " line 1", "-line 2", " line 3", ...second].join(
					"\n",
				),
			),
			{ old, new: now },
		);
		const r = range("unified", "o8", "n8");
		expect(describeRange(resolveRange(before, r) ?? [], "unified").label).toBe(
			"lines 7–8",
		);

		// The first hunk staged: the index lost line 2.
		const staged = content(numbered(10).filter((_, i) => i !== 1));
		const after = buildDiffRows(
			parseHunks(second.join("\n").replace("-7,3", "-6,3")),
			{ old: staged, new: now },
		);
		expect(relocateRange(after, r, hold(before, r), true)?.range).toEqual(
			range("unified", "o7", "n8"),
		);
		// Made upwards, the anchor stays the bottom end.
		const up = range("unified", "n8", "o8");
		expect(relocateRange(after, up, hold(before, up), false)?.range).toEqual(
			range("unified", "n8", "o7"),
		);
	});
});

describe("buildDiffRows at the ends of a file's life", () => {
	it("reads an added file and a deleted one as their single hunk", () => {
		const added = buildDiffRows(
			parseHunks(["@@ -0,0 +1,2 @@", "+a", "+b"].join("\n")),
			{ old: "", new: "a\nb\n" },
		);
		expect(added.map((row) => rowKey(row, "unified"))).toEqual(["n1", "n2"]);
		const deleted = buildDiffRows(
			parseHunks(["@@ -1,2 +0,0 @@", "-a", "-b"].join("\n")),
			{ old: "a\nb\n", new: "" },
		);
		expect(deleted.map((row) => rowKey(row, "unified"))).toEqual(["o1", "o2"]);
	});

	// With whitespace hidden the two sides' unchanged lines can differ.
	it("quotes the old text of a gap line on the old side", () => {
		const old = content(numbered(10, { 5: "line\t5" }));
		const own = buildDiffRows(parseHunks(PATCH), { old, new: NEW });
		const s = resolveRange(own, range("old", "o5")) ?? [];
		expect(
			selectionPrefillText({
				path: "a.ts",
				selected: s,
				view: "old",
				description: describeRange(s, "old"),
				staged: false,
				isShown: () => true,
			}),
		).toContain("\n line\t5\n");
	});
});
