import { describe, expect, it } from "vitest";
import type { GitStatus } from "../types/git";
import {
	adjacentChange,
	buildChangeTree,
	type ChangedFile,
	changeKindOf,
	collectChanges,
	filesUnder,
	firstReviewTarget,
	groupChanges,
	lineStatOf,
	orderChanges,
	reviewSideOf,
	stagesOnlyWhole,
	sumLines,
	unstagePaths,
} from "./gitChanges";

const file = (
	path: string,
	side: "staged" | "unstaged" | "both" = "unstaged",
) =>
	({
		path,
		submodule: false,
		...(side !== "unstaged" && { staged: { path, status: "M" } }),
		...(side !== "staged" && { unstaged: { path, status: "M" } }),
	}) as ChangedFile;

const paths = (files: ChangedFile[]) => files.map((f) => f.path);

describe("collectChanges", () => {
	it("merges a file's two sides into one record, submodules prefixed", () => {
		const status: GitStatus = {
			staged: [{ path: "new.ts", status: "R", orig_path: "old.ts" }],
			unstaged: [{ path: "new.ts", status: "M" }],
			submodules: {
				sdk: {
					staged: [{ path: "b.ts", status: "R", orig_path: "a.ts" }],
					unstaged: [],
				},
			},
		};

		const [root, sub] = collectChanges(status);

		expect(root.staged?.status).toBe("R");
		expect(root.unstaged?.status).toBe("M");
		expect(root.submodule).toBe(false);
		expect(sub).toMatchObject({ path: "sdk/b.ts", submodule: true });
		expect(sub.staged?.orig_path).toBe("sdk/a.ts");
	});
});

describe("conflicts", () => {
	const conflicted: GitStatus = {
		staged: [
			{ path: "both.ts", status: "U" },
			{ path: "gone.ts", status: "D" },
			{ path: "theirs.ts", status: "U" },
		],
		unstaged: [
			{ path: "both.ts", status: "U" },
			{ path: "gone.ts", status: "D" },
			{ path: "theirs.ts", status: "D" },
			{ path: "plain.ts", status: "M" },
		],
		conflicted: ["both.ts", "gone.ts", "theirs.ts"],
		submodules: {
			sdk: {
				staged: [{ path: "x.ts", status: "A" }],
				unstaged: [{ path: "x.ts", status: "A" }],
				conflicted: ["x.ts"],
			},
		},
	};
	const byPath = () =>
		new Map(collectChanges(conflicted).map((f) => [f.path, f]));

	// Drawn as two sides a conflict would read as partly staged, and its
	// stage button would stage the markers as the resolution.
	it("makes one record per conflicted path, with no sides", () => {
		const files = byPath();

		expect(files.get("both.ts")).toEqual({
			path: "both.ts",
			submodule: false,
			conflict: "content",
		});
		expect(files.get("gone.ts")?.conflict).toBe("deleted-both");
		expect(files.get("theirs.ts")?.conflict).toBe("deleted-one-side");
		expect(files.get("sdk/x.ts")).toMatchObject({
			submodule: true,
			conflict: "content",
		});
		expect(files.get("plain.ts")?.conflict).toBeUndefined();
	});

	it("opens a conflict on the working tree, deleted only when both deleted it", () => {
		const files = byPath();
		const both = files.get("both.ts") as ChangedFile;

		expect(reviewSideOf(both, true)).toBe(false);
		expect(changeKindOf(both)).toBe("modified");
		expect(changeKindOf(files.get("theirs.ts") as ChangedFile)).toBe(
			"modified",
		);
		expect(changeKindOf(files.get("gone.ts") as ChangedFile)).toBe("deleted");
	});
});

describe("groupChanges", () => {
	const status: GitStatus = {
		staged: [
			{ path: "both.ts", status: "M", lines: { additions: 1, deletions: 0 } },
			{ path: "new.ts", status: "R", orig_path: "old.ts" },
			{ path: "ad.ts", status: "A" },
			{ path: "merge.go", status: "U" },
		],
		unstaged: [
			{ path: "both.ts", status: "M", lines: { additions: 0, deletions: 2 } },
			{ path: "ad.ts", status: "D" },
			{ path: "merge.go", status: "U" },
			{ path: "notes.txt", status: "?" },
		],
		conflicted: ["merge.go"],
	};
	const groups = () =>
		groupChanges(orderChanges(collectChanges(status), "flat"));

	it("puts a partly staged file in both groups, each row with its own side", () => {
		const { unstaged, staged } = groups();
		const [unstagedBoth] = unstaged.filter((f) => f.path === "both.ts");
		const [stagedBoth] = staged.filter((f) => f.path === "both.ts");

		expect(lineStatOf(unstagedBoth).lines).toEqual({
			additions: 0,
			deletions: 2,
		});
		expect(lineStatOf(stagedBoth).lines).toEqual({
			additions: 1,
			deletions: 0,
		});
		expect(unstagedBoth.staged).toBeUndefined();
		expect(stagedBoth.unstaged).toBeUndefined();
	});

	it("puts a conflict in conflicts alone, and keeps each group in order", () => {
		const { conflicts, unstaged, staged } = groups();

		expect(paths(conflicts)).toEqual(["merge.go"]);
		expect(paths(unstaged)).toEqual(["ad.ts", "both.ts", "notes.txt"]);
		expect(paths(staged)).toEqual(["ad.ts", "both.ts", "new.ts"]);
	});

	// Added in the index, deleted from the working tree: each row says its side.
	it("describes an added-then-deleted file by the side each row shows", () => {
		const { unstaged, staged } = groups();
		const side = (rows: ChangedFile[]) =>
			rows.find((f) => f.path === "ad.ts") as ChangedFile;

		expect(changeKindOf(side(staged))).toBe("added");
		expect(changeKindOf(side(unstaged))).toBe("deleted");
	});

	// Restoring the new path alone would leave `old` staged as deleted and
	// `new` untracked: one row split in two.
	it("keeps a staged rename's source, so unstaging it takes both paths", () => {
		const renamed = groups().staged.find(
			(f) => f.path === "new.ts",
		) as ChangedFile;

		expect(changeKindOf(renamed)).toBe("renamed");
		expect(unstagePaths(renamed)).toEqual(["new.ts", "old.ts"]);
	});
});

describe("line counts", () => {
	it("sums the two sides, and says binary only when nothing was counted", () => {
		const both: ChangedFile = {
			path: "a",
			submodule: false,
			staged: { path: "a", status: "M", lines: { additions: 1, deletions: 2 } },
			unstaged: {
				path: "a",
				status: "M",
				lines: { additions: 3, deletions: 0 },
			},
		};
		const binary: ChangedFile = {
			path: "b",
			submodule: false,
			unstaged: { path: "b", status: "M", binary: true },
		};

		expect(lineStatOf(both)).toEqual({
			lines: { additions: 4, deletions: 2 },
			binary: false,
		});
		expect(lineStatOf(binary)).toEqual({ lines: null, binary: true });
		expect(sumLines([both, binary])).toEqual({ additions: 4, deletions: 2 });
		expect(sumLines([binary])).toBeNull();
	});
});

describe("firstReviewTarget", () => {
	const files = [
		file("web/z.ts", "staged"),
		file("b.ts", "both"),
		file("a/c.ts"),
	];

	it("starts at the first file the list draws, in the view the list is in", () => {
		expect(firstReviewTarget(files, "flat")?.path).toBe("a/c.ts");
		expect(firstReviewTarget(files.slice(0, 2), "flat")?.path).toBe("b.ts");
		expect(firstReviewTarget(files.slice(0, 2), "tree")?.path).toBe("web/z.ts");
	});

	it("opens the side the review would open from the list", () => {
		expect(firstReviewTarget([file("b.ts", "both")], "flat")).toEqual({
			path: "b.ts",
			staged: false,
		});
		expect(firstReviewTarget([file("b.ts", "staged")], "flat")).toEqual({
			path: "b.ts",
			staged: true,
		});
	});

	it("has nowhere to start on a clean tree", () => {
		expect(firstReviewTarget([], "tree")).toBeNull();
	});
});

describe("order", () => {
	const files = [
		file("web/z.ts"),
		file("README.md"),
		file("web/src/a.ts"),
		file("a.txt"),
		file("Web.md"),
		file("a/b.ts"),
	];

	// `/` first keeps a folder's files together in the flat list.
	it("sorts flat by full path, case-insensitively, `/` before anything", () => {
		expect(paths(orderChanges(files, "flat"))).toEqual([
			"a/b.ts",
			"a.txt",
			"README.md",
			"web/src/a.ts",
			"web/z.ts",
			"Web.md",
		]);
	});

	it("sorts the tree folders first at every level", () => {
		expect(paths(orderChanges(files, "tree"))).toEqual([
			"a/b.ts",
			"web/src/a.ts",
			"web/z.ts",
			"a.txt",
			"README.md",
			"Web.md",
		]);
	});

	it("is the order the tree draws", () => {
		expect(paths(filesUnder(buildChangeTree(files)))).toEqual(
			paths(orderChanges(files, "tree")),
		);
	});

	// A compacted row is named `src/lib`, and `/` sorts after `-` as a
	// character; the row still stands at `src`'s place.
	it("draws a compacted folder where its first folder sorts", () => {
		const compacted = [file("src-old/b.ts"), file("src/lib/a.ts")];

		expect(paths(filesUnder(buildChangeTree(compacted)))).toEqual(
			paths(orderChanges(compacted, "tree")),
		);
		expect(paths(orderChanges(compacted, "tree"))).toEqual([
			"src/lib/a.ts",
			"src-old/b.ts",
		]);
	});

	// A deleted file `a` beside a new folder `a/`: the tree draws the folder
	// first, and an order that disagreed would also stop being transitive.
	it("puts a folder before a file of the same name", () => {
		const clash = [file("a"), file("a/b"), file("b/c")];

		expect(paths(orderChanges(clash, "tree"))).toEqual(["a/b", "b/c", "a"]);
		expect(paths(filesUnder(buildChangeTree(clash)))).toEqual([
			"a/b",
			"b/c",
			"a",
		]);
		expect(adjacentChange(clash, "tree", "a", 1)).toBeNull();
	});

	// By position, not by index: the file on screen may have left the list.
	it("finds the neighbour of a path that is no longer in the list", () => {
		const list = [file("a.ts"), file("c.ts")];

		expect(adjacentChange(list, "flat", "b.ts", 1)?.path).toBe("c.ts");
		expect(adjacentChange(list, "flat", "b.ts", -1)?.path).toBe("a.ts");
		expect(adjacentChange(list, "flat", "c.ts", 1)).toBeNull();
		expect(adjacentChange(list, "flat", "a.ts", -1)).toBeNull();
	});
});

describe("buildChangeTree", () => {
	it("compacts single-child folder chains into one row", () => {
		const tree = buildChangeTree([
			file("web/src/components/A.tsx"),
			file("web/src/components/B.tsx"),
			file("web/index.html"),
		]);

		const [web] = tree.folders;
		expect(web.name).toBe("web");
		expect(web.folders[0]).toMatchObject({
			name: "src/components",
			path: "web/src/components",
		});
		expect(paths(web.files)).toEqual(["web/index.html"]);
	});
});

describe("stagesOnlyWhole", () => {
	const sides = (staged?: string, unstaged?: string, binary = false) =>
		({
			path: "a",
			submodule: false,
			...(staged && { staged: { path: "a", status: staged } }),
			...(unstaged && {
				unstaged: { path: "a", status: unstaged, ...(binary && { binary }) },
			}),
		}) as ChangedFile;

	it.each([
		["binary", sides(undefined, "M", true), true],
		["turned into a symlink", sides(undefined, "T"), true],
		["modified", sides(undefined, "M"), false],
		["added, then edited", sides("A", "M"), false],
	])("%s", (_, file, expected) => {
		expect(stagesOnlyWhole(file, false)).toBe(expected);
	});

	// Read through collectChanges, which is what turns git's letters into a
	// conflict record: the letters themselves never reach a caller.
	it.each([
		["conflicted", "U", "U"],
		["added by both", "A", "A"],
		["deleted by both", "D", "D"],
	] as const)("%s", (_, staged, unstaged) => {
		const [conflicted] = collectChanges({
			staged: [{ path: "a", status: staged }],
			unstaged: [{ path: "a", status: unstaged }],
			conflicted: ["a"],
		} as GitStatus);
		expect(stagesOnlyWhole(conflicted, false)).toBe(true);
		expect(stagesOnlyWhole(conflicted, true)).toBe(true);
	});
});
