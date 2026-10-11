import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDiffChangedNotification } from "../types/git";
import { useGitDiffWatch } from "./useGitDiffWatch";

const mockGitDiffSubscribe = vi.fn();
const mockGitDiffUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) =>
		selector({
			status: "connected",
			actions: {
				gitDiffSubscribe: mockGitDiffSubscribe,
				gitDiffUnsubscribe: mockGitDiffUnsubscribe,
			},
		}),
	),
}));

describe("useGitDiffWatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGitDiffUnsubscribe.mockResolvedValue(undefined);
	});

	// The withheld form is only useful whole: a card cannot name the size or the
	// limit if the hook passes the three strings along and drops the rest.
	it("keeps every field of a diff withheld as too large", async () => {
		let notify: (params: GitDiffChangedNotification) => void = () => {};
		mockGitDiffSubscribe.mockImplementation(
			async (_path, _staged, _hideWhitespace, callback) => {
				notify = callback;
				return {
					id: "diff-1",
					initial: { diff: "@@\n", old_content: "a", new_content: "b" },
				};
			},
		);

		const { result } = renderHook(() =>
			useGitDiffWatch({ path: "big.json", staged: false }),
		);
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		const tooLarge = {
			diff: "",
			old_content: "",
			new_content: "",
			omitted: "too_large",
			size: 3 * 1024 * 1024,
			mime: "text/plain; charset=utf-8",
			limit: 2 * 1024 * 1024,
		} as const;
		act(() => notify({ id: "diff-1", ...tooLarge }));

		expect(result.current.data).toEqual(tooLarge);
	});
});
