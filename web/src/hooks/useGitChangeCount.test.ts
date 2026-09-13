import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitStatus } from "../types/git";
import { useGitChangeCount } from "./useGitChangeCount";

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
