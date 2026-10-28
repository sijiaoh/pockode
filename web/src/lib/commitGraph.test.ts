import { describe, expect, it } from "vitest";
import {
	createGraphState,
	foldRow,
	type GraphCommit,
	type GraphEdge,
	type GraphRow,
	layoutCommits,
} from "./commitGraph";

/**
 * `"c b"` reads as commit c with parent b; parents are space-separated. A
 * trailing `@0` or `@0,1` is the lanes the commit claims.
 */
function commits(...specs: string[]): GraphCommit[] {
	return specs.map((spec) => {
		const [names, claims] = spec.split("@");
		const [hash, ...parents] = names.trim().split(" ");
		return claims === undefined
			? { hash, parents }
			: { hash, parents, claims: claims.split(",").map(Number) };
	});
}

function layout(list: GraphCommit[], firstParent = false): GraphRow[] {
	return layoutCommits(list, createGraphState({ firstParent })).rows;
}

function lanesOf(rows: GraphRow[]): Record<string, number> {
	return Object.fromEntries(rows.map((row) => [row.hash, row.lane]));
}

function row(rows: GraphRow[], hash: string): GraphRow {
	const found = rows.find((r) => r.hash === hash);
	if (!found) throw new Error(`no row ${hash}`);
	return found;
}

/** Edges as `from>to`, ignoring lines, for asserting a row's shape. */
function shape(edges: { from: number; to: number }[]): string[] {
	return edges.map((e) => `${e.from}>${e.to}`).sort();
}

/** Each row's bottom edge must meet the next row's top edge, lane for lane and colour for colour. */
function expectContinuous(
	rows: { above: GraphEdge[]; below: GraphEdge[] }[],
): void {
	for (let i = 0; i + 1 < rows.length; i++) {
		const bottom = new Set(rows[i].below.map((e) => `${e.to}:${e.line}`));
		const top = new Set(rows[i + 1].above.map((e) => `${e.from}:${e.line}`));
		expect([...top].sort(), `between rows ${i} and ${i + 1}`).toEqual(
			[...bottom].sort(),
		);
	}
}

// Merges, forks and an octopus merge mixed, in date order: every page split
// of it cuts through some line in flight.
const branchy = commits(
	"m d f",
	"d o",
	"f c",
	"o c e g",
	"e c",
	"g c",
	"c b",
	"b a",
	"a",
);

describe("layoutCommits", () => {
	it("keeps a straight history on one lane and one line", () => {
		const rows = layout(commits("c b", "b a", "a"));

		expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
		expect(new Set(rows.map((r) => r.line)).size).toBe(1);
		expect(shape(rows[0].above)).toEqual([]);
		expect(shape(rows[1].above)).toEqual(["0>0"]);
		expect(shape(rows[2].below)).toEqual([]);
	});

	it("draws a fork as two lanes that meet at their common parent", () => {
		// Two branches off b: c on the left, x on the right.
		const rows = layout(commits("c b", "x b", "b a", "a"));

		expect(lanesOf(rows)).toEqual({ c: 0, x: 1, b: 0, a: 0 });
		expect(row(rows, "x").line).not.toBe(row(rows, "c").line);
		expect(shape(row(rows, "b").above)).toEqual(["0>0", "1>0"]);
		// The right lane is released once its line has ended.
		expect(shape(row(rows, "b").below)).toEqual(["0>0"]);
	});

	it("draws a merge as a second lane joining the merge commit", () => {
		const rows = layout(commits("m b x", "x a", "b a", "a"));

		expect(lanesOf(rows)).toEqual({ m: 0, x: 1, b: 0, a: 0 });
		expect(shape(row(rows, "m").below)).toEqual(["0>0", "0>1"]);
		expect(shape(row(rows, "a").above)).toEqual(["0>0", "1>0"]);
		expect(shape(row(rows, "a").below)).toEqual([]);
	});

	it("joins a merge parent to the lane already heading for it", () => {
		// y's lane already heads for x when m merges it, so m adds no third lane.
		const rows = layout(commits("y x", "m b x", "x a", "b a", "a"));

		expect(lanesOf(rows)).toEqual({ y: 0, m: 1, x: 0, b: 1, a: 0 });
		expect(shape(row(rows, "m").below)).toEqual(["0>0", "1>0", "1>1"]);
	});

	it("keeps a merged-in commit on its own branch's line", () => {
		// m merges x before x's branch tip y shows up; x carries on y's line.
		const rows = layout(commits("m b x", "y x", "x a", "b a", "a"));

		expect(lanesOf(rows)).toEqual({ m: 0, y: 2, x: 2, b: 0, a: 0 });
		expect(row(rows, "x").line).toBe(row(rows, "y").line);
		expect(shape(row(rows, "x").above)).toEqual(["0>0", "1>2", "2>2"]);
	});

	it("gives each parent of an octopus merge a lane of its own", () => {
		const rows = layout(commits("o a b c", "a r", "b r", "c r", "r"));

		expect(lanesOf(rows)).toEqual({ o: 0, a: 0, b: 1, c: 2, r: 0 });
		expect(shape(row(rows, "o").below)).toEqual(["0>0", "0>1", "0>2"]);
		const lines = row(rows, "o").below.map((e) => e.line);
		expect(new Set(lines).size).toBe(3);
		expect(shape(row(rows, "r").above)).toEqual(["0>0", "1>0", "2>0"]);
	});

	it("reuses a released lane instead of widening the graph", () => {
		// y's lane is free again by the time the second branch tip z appears.
		const rows = layout(commits("c b", "y b", "b a", "z a", "a"));

		expect(lanesOf(rows)).toEqual({ c: 0, y: 1, b: 0, z: 1, a: 0 });
		expect(row(rows, "z").line).not.toBe(row(rows, "y").line);
	});

	it("joins each row's lines to the next row's", () => {
		expectContinuous(layout(branchy));
	});

	it("lays out page by page exactly as in one pass", () => {
		const whole = layout(branchy);

		for (let a = 1; a < branchy.length; a++) {
			for (let b = a; b < branchy.length; b++) {
				const first = layoutCommits(branchy.slice(0, a), createGraphState());
				const second = layoutCommits(branchy.slice(a, b), first.state);
				const third = layoutCommits(branchy.slice(b), second.state);
				expect([...first.rows, ...second.rows, ...third.rows]).toEqual(whole);
			}
		}
	});

	it("leaves the state it continues from as it was, so a page can be laid out again", () => {
		const first = layoutCommits(branchy.slice(0, 4), createGraphState());
		const snapshot = structuredClone(first.state);

		const once = layoutCommits(branchy.slice(4), first.state);
		const again = layoutCommits(branchy.slice(4), first.state);

		expect(first.state).toEqual(snapshot);
		expect(again).toEqual(once);
	});

	it("keeps a lane open down to the end for a parent not in the result", () => {
		// Truncated history: b's parent a was never loaded.
		const rows = layout(commits("c b", "b a", "z"));

		expect(shape(row(rows, "b").below)).toEqual(["0>0"]);
		// The lane stays taken, so an unrelated commit goes beside it.
		expect(row(rows, "z").lane).toBe(1);
		expect(shape(row(rows, "z").below)).toEqual(["0>0"]);
	});

	it("follows only first parents in a first-parent log", () => {
		// git log --first-parent still lists each merge's other parents.
		const rows = layout(commits("m2 m1 y", "m1 a x", "a"), true);

		expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
		for (const r of rows) {
			expect(r.below.every((e) => e.from === 0 && e.to === 0)).toBe(true);
		}
		expect(shape(row(rows, "a").below)).toEqual([]);
	});
});

describe("reserved lanes", () => {
	// Lane 0 is HEAD's line, lane 1 the default branch's.
	function reserved(list: GraphCommit[]): GraphRow[] {
		return layoutCommits(list, createGraphState({ reserve: 2 })).rows;
	}

	it("keeps lane 0 empty for HEAD while newer commits of other branches come first", () => {
		const rows = reserved(commits("x w", "h w @0", "w a", "a"));

		expect(lanesOf(rows)).toEqual({ x: 2, h: 0, w: 0, a: 0 });
		expect(row(rows, "h").line).toBe(0);
		expect(shape(row(rows, "x").below)).toEqual(["2>2"]);
		expect(shape(row(rows, "w").above)).toEqual(["0>0", "2>0"]);
	});

	it("puts the default branch on lane 1 when it is ahead of HEAD", () => {
		const rows = reserved(commits("m a @1", "h a @0", "a"));

		expect(lanesOf(rows)).toEqual({ m: 1, h: 0, a: 0 });
		expect(row(rows, "m").line).toBe(1);
		// Their common parent continues HEAD's line.
		expect(row(rows, "a").line).toBe(0);
	});

	it("leaves the default branch on HEAD's line and frees lane 1 for others", () => {
		const rows = reserved(commits("h m @0", "m a @1", "y a", "a"));

		expect(lanesOf(rows)).toEqual({ h: 0, m: 0, y: 1, a: 0 });
		expect(row(rows, "m").line).toBe(0);
	});

	it("frees the default branch's lane when HEAD is on it", () => {
		const rows = reserved(commits("h a @0,1", "y a", "a"));

		expect(lanesOf(rows)).toEqual({ h: 0, y: 1, a: 0 });
	});

	it("moves HEAD into lane 0 from a branch built on it", () => {
		// b is a newer branch whose parent is HEAD.
		const rows = reserved(commits("b h", "h a @0", "a"));

		expect(lanesOf(rows)).toEqual({ b: 2, h: 0, a: 0 });
		expect(shape(row(rows, "h").above)).toEqual(["2>0"]);
		expectContinuous(rows);
	});

	it("gives a lane only to its first claimant", () => {
		// origin/main behind main: both carry the default branch's name.
		const rows = reserved(commits("h m @0", "m o @1", "o a @1", "a"));

		expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0]);
	});

	it("lays out page by page exactly as in one pass", () => {
		const list = commits(
			"x w",
			"m2 w2 @1",
			"h w x2 @0",
			"x2 w",
			"w2 w",
			"w a",
			"a",
		);
		const whole = reserved(list);
		expectContinuous(whole);

		for (let a = 1; a < list.length; a++) {
			const first = layoutCommits(
				list.slice(0, a),
				createGraphState({ reserve: 2 }),
			);
			const second = layoutCommits(list.slice(a), first.state);
			expect([...first.rows, ...second.rows]).toEqual(whole);
		}
	});
});

describe("foldRow", () => {
	// Six branch tips on lanes 0-5 converging at r.
	const wide = layout(
		commits("t0 r", "t1 r", "t2 r", "t3 r", "t4 r", "t5 r", "r"),
	);

	it("leaves a row within the limit as it is", () => {
		const r = row(wide, "t2");
		const folded = foldRow(r, 4);

		expect(folded).toEqual({
			column: 2,
			above: r.above,
			below: r.below,
			hidden: 0,
		});
	});

	it("folds the lanes past the limit into one overflow column", () => {
		const folded = foldRow(row(wide, "t5"), 4);

		expect(folded.column).toBe(4);
		expect(folded.hidden).toBe(2);
		expect(shape(folded.below)).toEqual(["0>0", "1>1", "2>2", "3>3", "4>4"]);
	});

	it("draws lines converging from hidden lanes as coming from the overflow column", () => {
		const folded = foldRow(row(wide, "r"), 4);

		expect(folded.column).toBe(0);
		expect(folded.hidden).toBe(2);
		expect(shape(folded.above)).toEqual(["0>0", "1>0", "2>0", "3>0", "4>0"]);
	});

	it("keeps the overflow column one colour from row to row", () => {
		// t5's lane closes into x's: two hidden lines share the overflow column.
		const rows = layout(
			commits("t0 r", "t1 r", "t2 r", "t3 r", "t4 r", "t5 x", "x r", "r"),
		);

		for (const limit of [1, 2, 4]) {
			expectContinuous(rows.map((r) => foldRow(r, limit)));
		}
	});

	it("folds by the limit it is given, so a wider screen shows more lanes", () => {
		const folded = foldRow(row(wide, "t5"), 8);

		expect(folded.column).toBe(5);
		expect(folded.hidden).toBe(0);
	});
});
