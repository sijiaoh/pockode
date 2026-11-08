import { describe, expect, it } from "vitest";
import { isUnder, type OverlayState, parentOf, samePage } from "./overlay";

const inA = (overlay: OverlayState) => ({ worktree: "A", overlay });
const topic = { ref: "topic", remote: false };

describe("page identity", () => {
	// A setting of the page on screen does not make it another page.
	it("ignores a list's query and a diff's side", () => {
		expect(
			samePage(
				inA({ type: "git", segment: "history" }),
				inA({ type: "git", segment: "history", history: { scope: "all" } }),
			),
		).toBe(true);
		expect(
			samePage(
				inA({ type: "diff", path: "a.ts", staged: false }),
				inA({ type: "diff", path: "a.ts", staged: true }),
			),
		).toBe(true);
	});

	// The two go up to different places.
	it("tells a commit opened from a branch from the same one from History", () => {
		expect(
			samePage(
				inA({ type: "commit", hash: "x" }),
				inA({ type: "commit", hash: "x", branch: topic }),
			),
		).toBe(false);
	});

	it("puts every Git page under its own worktree's chat only", () => {
		const file = inA({
			type: "commit-file",
			hash: "x",
			path: "a.ts",
			branch: topic,
		});
		expect(isUnder(file, inA({ type: "branch", ...topic }))).toBe(true);
		expect(isUnder(file, inA({ type: "git", segment: "branches" }))).toBe(true);
		expect(isUnder(file, inA(null))).toBe(true);
		expect(isUnder(file, { worktree: "B", overlay: null })).toBe(false);
		expect(isUnder(file, inA({ type: "git", segment: "history" }))).toBe(false);
	});

	// Up is not Back: a parent commit's parent is the list, whatever child it
	// was opened from.
	it("gives a commit its list or branch as its parent, carrying the query", () => {
		expect(
			parentOf({ type: "commit", hash: "y", history: { scope: "all" } }),
		).toEqual({ type: "git", segment: "history", history: { scope: "all" } });
		expect(parentOf({ type: "commit", hash: "y", branch: topic })).toEqual({
			type: "branch",
			...topic,
		});
	});

	// How a file is drawn, and the line it opened at, are settings of its
	// view; the editor is another page, entered from the view.
	it("tells a file's editor from its view, and nothing else of it", () => {
		expect(
			samePage(
				inA({ type: "file", path: "a.md" }),
				inA({ type: "file", path: "a.md", source: true, line: 3 }),
			),
		).toBe(true);
		expect(
			samePage(
				inA({ type: "file", path: "a.md" }),
				inA({ type: "file", path: "a.md", edit: true }),
			),
		).toBe(false);
		expect(parentOf({ type: "file", path: "a.md", edit: true })).toEqual({
			type: "file",
			path: "a.md",
		});
		expect(parentOf({ type: "file", path: "a.md", line: 3 })).toBeNull();
	});

	// The segment a work detail carries is where its way up returns, not
	// which work it is.
	it("puts a work detail under the segment it carries", () => {
		const work = inA({ type: "work-detail", workId: "w", segment: "closed" });
		expect(
			samePage(
				work,
				inA({ type: "work-detail", workId: "w", segment: "current" }),
			),
		).toBe(true);
		expect(isUnder(work, inA({ type: "work-list", segment: "closed" }))).toBe(
			true,
		);
		expect(isUnder(work, inA({ type: "work-list", segment: "current" }))).toBe(
			false,
		);
		expect(isUnder(work, inA(null))).toBe(true);
	});
});
