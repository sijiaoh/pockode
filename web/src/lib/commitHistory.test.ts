import { describe, expect, it } from "vitest";
import type { GitCommit, GitRef } from "../types/git";
import {
	createHistoryGraphState,
	describeCommitRow,
	describeRevertPrompt,
	graphWidth,
	headHistoryFlags,
	laneCap,
	layoutHistoryPage,
	MENU_WIDTH,
	refChips,
} from "./commitHistory";

function commit(
	hash: string,
	parents: string[],
	refs?: GitRef[],
	extra: Partial<GitCommit> = {},
): GitCommit {
	return {
		hash,
		parents,
		subject: `subject ${hash}`,
		author: "a",
		date: "2026-01-01T00:00:00Z",
		...(refs ? { refs } : {}),
		...extra,
	};
}

describe("laneCap", () => {
	// docs/git-history-ui.md#lane-cap: the worked widths.
	it.each([
		[300, MENU_WIDTH.coarse, false, 4],
		[280, MENU_WIDTH.fine, false, 3],
		[400, MENU_WIDTH.fine, true, 8],
		[1200, MENU_WIDTH.fine, false, 4],
		[200, MENU_WIDTH.coarse, false, 1],
	])("gives %ipx (menu %i, expanded %s) %i lanes", (width, menu, expanded, lanes) => {
		expect(laneCap(width, menu, expanded)).toBe(lanes);
	});

	it("leaves the text its 160px on a 300px phone", () => {
		const cap = laneCap(300, MENU_WIDTH.coarse, false);
		expect(300 - 8 - graphWidth(cap + 2, cap) - 8 - MENU_WIDTH.coarse).toBe(
			166,
		);
	});
});

describe("graphWidth", () => {
	it("is as wide as the lanes used, with a slot only when some are hidden", () => {
		expect(graphWidth(1, 4)).toBe(14);
		expect(graphWidth(4, 4)).toBe(56);
		expect(graphWidth(6, 4)).toBe(74);
	});
});

describe("refChips", () => {
	it("folds HEAD into the current branch and the branch's remote into it", () => {
		const chips = refChips([
			{ name: "HEAD", type: "head" },
			{ name: "feature/graph", type: "branch", current: true },
			{ name: "origin/feature/graph", type: "remote" },
			{ name: "v1.2", type: "tag" },
		]);

		expect(chips).toEqual([
			{
				kind: "current",
				name: "feature/graph",
				pushed: true,
				names: ["feature/graph", "origin/feature/graph"],
			},
			{ kind: "tag", name: "v1.2", names: ["v1.2"] },
		]);
	});

	it("orders detached HEAD, local branches, lone remotes, then tags", () => {
		const chips = refChips([
			{ name: "HEAD", type: "head" },
			{ name: "main", type: "branch" },
			{ name: "origin/other", type: "remote" },
			{ name: "v1", type: "tag" },
		]);

		expect(chips.map((c) => `${c.kind}:${c.name}`)).toEqual([
			"head:HEAD",
			"branch:main",
			"remote:origin/other",
			"tag:v1",
		]);
	});

	it("matches a remote to a local branch by the whole name after the remote", () => {
		const chips = refChips([
			{ name: "graph", type: "branch" },
			{ name: "origin/feature/graph", type: "remote" },
		]);

		expect(chips.map((c) => c.kind)).toEqual(["branch", "remote"]);
	});
});

describe("describeCommitRow", () => {
	it("says only what applies", () => {
		expect(describeCommitRow(commit("a1b2c3d4", ["p"]))).toBe(
			"Commit a1b2c3d: subject a1b2c3d4.",
		);
	});

	it("names every ref and the dot's shape in words", () => {
		const text = describeCommitRow(
			commit(
				"a1b2c3d4",
				["p", "q"],
				[
					{ name: "HEAD", type: "head" },
					{ name: "feature/graph", type: "branch", current: true },
					{ name: "origin/feature/graph", type: "remote" },
					{ name: "v1.2", type: "tag" },
				],
				{ unpushed: true },
			),
			{ laneHidden: true },
		);

		expect(text).toBe(
			"Commit a1b2c3d: subject a1b2c3d4. Not pushed. Merge commit. Branches feature/graph, origin/feature/graph. Tag v1.2. On a line not drawn.",
		);
	});
});

describe("layoutHistoryPage", () => {
	const head: GitRef[] = [
		{ name: "HEAD", type: "head" },
		{ name: "topic", type: "branch", current: true },
	];

	it("puts HEAD on lane 0 and the default branch's remote on lane 1", () => {
		const line = ["origin/main"];
		const { rows } = layoutHistoryPage(
			[
				commit("m", ["a"], [{ name: "origin/main", type: "remote" }]),
				commit("h", ["a"], head),
				commit("a", []),
			],
			createHistoryGraphState({ scope: "current", defaultLine: line }),
			line,
		);

		expect(rows.map((r) => [r.hash, r.lane, r.line])).toEqual([
			["m", 1, 1],
			["h", 0, 0],
			["a", 0, 0],
		]);
	});

	// A branch ahead of main: main is on HEAD's line, so no lane waits for it
	// and a side branch merged in takes lane 1 rather than leaving it empty.
	it("keeps no lane for a default branch that is not a line of its own", () => {
		const { rows } = layoutHistoryPage(
			[
				commit("h", ["a", "s"], head),
				commit("s", ["a"]),
				commit("a", [], [{ name: "main", type: "branch" }]),
			],
			createHistoryGraphState({ scope: "current", defaultLine: undefined }),
			undefined,
		);

		expect(rows.map((r) => [r.hash, r.lane])).toEqual([
			["h", 0],
			["s", 1],
			["a", 0],
		]);
	});

	// Only the refs the server named: a fork's branch of the same name is
	// just another line.
	it("lets only the named refs claim lane 1", () => {
		const line = ["main"];
		const { rows } = layoutHistoryPage(
			[
				commit("f", ["a"], [{ name: "fork/main", type: "remote" }]),
				commit("m", ["a"], [{ name: "main", type: "branch" }]),
				commit("h", ["a"], head),
				commit("a", []),
			],
			createHistoryGraphState({ scope: "current", defaultLine: line }),
			line,
		);

		expect(rows.map((r) => [r.hash, r.lane])).toEqual([
			["f", 2],
			["m", 1],
			["h", 0],
			["a", 0],
		]);
	});

	it("follows first parents only in Mainline only", () => {
		const state = createHistoryGraphState({
			scope: "mainline",
			defaultLine: ["main"],
		});
		const { rows } = layoutHistoryPage(
			[commit("h", ["a", "x"], head), commit("a", [])],
			state,
			["main"],
		);

		expect(rows.map((r) => r.lane)).toEqual([0, 0]);
		expect(rows[1].below).toEqual([]);
	});
});

describe("headHistoryFlags", () => {
	const HEAD: GitRef = { name: "HEAD", type: "head" };

	// All branches, date order:
	//   o  other's tip, off HEAD's line
	//   h  HEAD, a merge of m into b
	//   m  merged in
	//   b  first parent
	//   x  only other's
	//   r  root, shared
	it("marks what HEAD reaches through every parent, and nothing above it", () => {
		const commits = [
			commit("o", ["x"]),
			commit("h", ["b", "m"], [HEAD]),
			commit("m", ["r"]),
			commit("b", ["r"]),
			commit("x", ["r"]),
			commit("r", []),
		];
		expect(headHistoryFlags(commits)).toEqual([
			false,
			true,
			true,
			true,
			false,
			true,
		]);
	});

	// An unborn branch lists the others: none is in its history.
	it("marks nothing without a HEAD row", () => {
		expect(headHistoryFlags([commit("a", [])])).toEqual([false]);
	});
});

describe("describeRevertPrompt", () => {
	const HASH = "a1b2c3d4e5f6";
	const AFTER =
		"If it stops on conflicts, resolve them keeping the intent of the revert, then continue. If a conflict cannot be resolved safely, stop and explain it instead of guessing.";

	it("names the commit and the branch, and asks to stop where it does not apply", () => {
		expect(
			describeRevertPrompt(
				{ hash: HASH, subject: "Add lane layout", parents: ["p"] },
				"feature/graph",
			),
		).toBe(
			`Revert commit a1b2c3d "Add lane layout" on feature/graph with git revert. If that commit is not part of feature/graph's history, say so and stop.\n${AFTER}`,
		);
	});

	it("reverts a merge against its first parent", () => {
		expect(
			describeRevertPrompt(
				{ hash: HASH, subject: "Merge x", parents: ["p", "q"] },
				"main",
			),
		).toBe(
			`Revert commit a1b2c3d "Merge x" on main with git revert. It is a merge commit: revert it against its first parent (-m 1), unless the history shows that is wrong. If that commit is not part of main's history, say so and stop.\n${AFTER}`,
		);
	});

	it("speaks of the detached HEAD without a branch", () => {
		const prompt = describeRevertPrompt(
			{ hash: HASH, subject: "S", parents: ["p"] },
			null,
		);
		expect(prompt).toContain("on the detached HEAD with git revert.");
		expect(prompt).toContain("not part of the detached HEAD's history");
	});

	it("does not call an unknown branch detached", () => {
		const prompt = describeRevertPrompt(
			{ hash: HASH, subject: "S", parents: ["p"] },
			undefined,
		);
		expect(prompt).toContain("on the current branch with git revert.");
		expect(prompt).not.toContain("detached");
	});
});
