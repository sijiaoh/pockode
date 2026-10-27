import { describe, expect, it } from "vitest";
import type { GitStatus } from "../types/git";
import {
	adjacentChange,
	aggregateCheckState,
	buildChangeTree,
	type ChangedFile,
	checkboxWrite,
	collectChanges,
	filesUnder,
	firstReviewTarget,
	lineStatOf,
	orderChanges,
	sumLines,
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

describe("check states", () => {
	it("aggregates to checked or unchecked only when every file agrees", () => {
		expect(
			aggregateCheckState([file("a", "staged"), file("b", "staged")]),
		).toBe("checked");
		expect(aggregateCheckState([file("a"), file("b")])).toBe("unchecked");
		expect(aggregateCheckState([file("a", "staged"), file("b")])).toBe("mixed");
		expect(aggregateCheckState([file("a", "both")])).toBe("mixed");
	});

	// Mixed goes to checked, never back to unchecked.
	it("stages what is unstaged unless everything is staged already", () => {
		expect(
			checkboxWrite([file("a", "staged"), file("b", "both"), file("c")]),
		).toEqual({ paths: ["b", "c"], staged: false });
		expect(checkboxWrite([file("a", "staged"), file("b", "staged")])).toEqual({
			paths: ["a", "b"],
			staged: true,
		});
	});

	// Restoring the new path alone would leave `old` staged as deleted and
	// `new` untracked: one row split in two.
	it("unstages a rename together with its source", () => {
		const renamed: ChangedFile = {
			path: "sdk/new.ts",
			submodule: true,
			staged: { path: "sdk/new.ts", status: "R", orig_path: "sdk/old.ts" },
		};

		expect(checkboxWrite([renamed])).toEqual({
			paths: ["sdk/new.ts", "sdk/old.ts"],
			staged: true,
		});
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
