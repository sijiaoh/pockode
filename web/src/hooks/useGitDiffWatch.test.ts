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

	// Nothing tries a failed subscribe again on its own, so a spinner left up
	// for it would never end.
	it("reports a subscribe that failed instead of loading forever", async () => {
		mockGitDiffSubscribe.mockRejectedValue(new Error("git diff failed"));

		const { result } = renderHook(() =>
			useGitDiffWatch({ path: "a.ts", staged: false }),
		);

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.error?.message).toBe("git diff failed");
		expect(result.current.data).toBeUndefined();
	});
});

describe("useGitDiffWatch refresh", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGitDiffUnsubscribe.mockResolvedValue(undefined);
	});

	// A refresh after a hunk write must not swap the diff for a spinner: that
	// empties the scroll box and loses the reader's place in the file.
	it("keeps the diff on screen until the new one replaces it", async () => {
		const first = { diff: "@@ a\n", old_content: "a", new_content: "b" };
		const second = { diff: "@@ b\n", old_content: "a", new_content: "c" };
		let answer: (value: unknown) => void = () => {};
		mockGitDiffSubscribe
			.mockResolvedValueOnce({ id: "diff-1", initial: first })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						answer = resolve;
					}),
			);

		const { result } = renderHook(() =>
			useGitDiffWatch({ path: "a.ts", staged: false }),
		);
		await waitFor(() => expect(result.current.data).toEqual(first));
		const before = result.current.snapshot;

		act(() => result.current.refresh());
		await waitFor(() => expect(mockGitDiffSubscribe).toHaveBeenCalledTimes(2));
		expect(result.current.isLoading).toBe(false);
		expect(result.current.data).toEqual(first);

		await act(async () => answer({ id: "diff-2", initial: second }));
		expect(result.current.data).toEqual(second);
		expect(result.current.snapshot).toBe(before + 1);
	});

	// Staging the last hunk refreshes, and moves the page to the other side
	// before that refresh gets to subscribe: the other side is another diff.
	it("shows the loading state for a different diff that overtook a refresh", async () => {
		const first = { diff: "@@ a\n", old_content: "a", new_content: "b" };
		let unsubscribed: () => void = () => {};
		mockGitDiffSubscribe.mockResolvedValue({ id: "diff-1", initial: first });
		mockGitDiffUnsubscribe.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					unsubscribed = resolve;
				}),
		);

		const { result, rerender } = renderHook(
			({ staged }) => useGitDiffWatch({ path: "a.ts", staged }),
			{ initialProps: { staged: false } },
		);
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		act(() => result.current.refresh());
		mockGitDiffSubscribe.mockImplementation(() => new Promise(() => {}));
		rerender({ staged: true });
		await act(async () => unsubscribed());

		await waitFor(() => expect(result.current.isLoading).toBe(true));
	});

	// A write answers a render or more after its press: the refresh it asks
	// for is of the diff on screen then, not the one it was pressed in.
	it("refreshes the diff shown when it is called", async () => {
		mockGitDiffSubscribe.mockResolvedValue({
			id: "diff-1",
			initial: { diff: "@@ a\n", old_content: "a", new_content: "b" },
		});
		const { result, rerender } = renderHook(
			({ hideWhitespace }) =>
				useGitDiffWatch({ path: "a.ts", staged: false, hideWhitespace }),
			{ initialProps: { hideWhitespace: false } },
		);
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		const { refresh } = result.current;
		rerender({ hideWhitespace: true });
		await waitFor(() => expect(mockGitDiffSubscribe).toHaveBeenCalledTimes(2));

		act(() => refresh());
		await waitFor(() => expect(mockGitDiffSubscribe).toHaveBeenCalledTimes(3));
		expect(mockGitDiffSubscribe.mock.calls[2].slice(0, 3)).toEqual([
			"a.ts",
			false,
			true,
		]);
	});

	// A write answering after the page let go of the diff — the file gone
	// from this side — must not open a subscription nothing would close.
	it("does nothing while the watch is disabled", async () => {
		mockGitDiffSubscribe.mockResolvedValue({
			id: "diff-1",
			initial: { diff: "@@ a\n", old_content: "a", new_content: "b" },
		});
		const { result, rerender } = renderHook(
			({ enabled }) =>
				useGitDiffWatch({ path: "a.ts", staged: false, enabled }),
			{ initialProps: { enabled: true } },
		);
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		const { refresh } = result.current;
		rerender({ enabled: false });

		act(() => refresh());
		expect(mockGitDiffSubscribe).toHaveBeenCalledTimes(1);
	});
});
