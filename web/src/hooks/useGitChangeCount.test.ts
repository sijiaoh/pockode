import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitStatus } from "../types/git";
import { useGitChangeCount, useGitChangeLines } from "./useGitChangeCount";

let status: GitStatus | undefined;

vi.mock("./useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));

function countOf(next: GitStatus | undefined): number | undefined {
	status = next;
	return renderHook(() => useGitChangeCount()).result.current;
}

describe("useGitChangeCount", () => {
	it("has no answer before a status has arrived", () => {
		expect(countOf(undefined)).toBeUndefined();
	});

	it("counts a file once when it is both staged and unstaged", () => {
		expect(
			countOf({
				staged: [{ path: "a.ts", status: "M" }],
				unstaged: [
					{ path: "a.ts", status: "M" },
					{ path: "b.ts", status: "?" },
				],
			}),
		).toBe(2);
	});

	it("counts files inside submodules", () => {
		expect(
			countOf({
				staged: [],
				unstaged: [{ path: "a.ts", status: "M" }],
				submodules: {
					vendor: {
						staged: [{ path: "a.ts", status: "M" }],
						unstaged: [],
					},
				},
			}),
		).toBe(2);
	});
});

describe("useGitChangeLines", () => {
	const linesOf = (next: GitStatus | undefined) => {
		status = next;
		return renderHook(() => useGitChangeLines()).result.current;
	};

	it("sums both sides of every file, submodules included", () => {
		expect(
			linesOf({
				staged: [
					{ path: "a.ts", status: "M", lines: { additions: 1, deletions: 1 } },
				],
				unstaged: [
					{ path: "a.ts", status: "M", lines: { additions: 2, deletions: 0 } },
					{ path: "b.png", status: "?", binary: true },
				],
				submodules: {
					vendor: {
						staged: [],
						unstaged: [
							{
								path: "c.ts",
								status: "M",
								lines: { additions: 0, deletions: 4 },
							},
						],
					},
				},
			}),
		).toEqual({ additions: 3, deletions: 5 });
	});

	it("has nothing to say when no file could be counted", () => {
		expect(
			linesOf({
				staged: [],
				unstaged: [{ path: "b.png", status: "?", binary: true }],
			}),
		).toBeNull();
		expect(linesOf(undefined)).toBeNull();
	});
});
