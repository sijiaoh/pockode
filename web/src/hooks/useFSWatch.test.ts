import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFSWatch } from "./useFSWatch";

let mockStatus = "connected";
const mockFsSubscribe = vi.fn();
const mockFsUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) => {
		const state = {
			status: mockStatus,
			actions: {
				fsSubscribe: mockFsSubscribe,
				fsUnsubscribe: mockFsUnsubscribe,
			},
		};
		return selector(state);
	}),
}));

describe("useFSWatch", () => {
	const mockOnChanged = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockStatus = "connected";
		mockFsSubscribe.mockResolvedValue("fs-sub-123");
		mockFsUnsubscribe.mockResolvedValue(undefined);
	});

	it("passes path to fsSubscribe", async () => {
		renderHook(() =>
			useFSWatch({ path: "/test/path", onChanged: mockOnChanged }),
		);

		await waitFor(() => {
			expect(mockFsSubscribe).toHaveBeenCalledWith(
				"/test/path",
				expect.any(Function),
			);
		});
	});

	it("resubscribes when path changes", async () => {
		const { rerender } = renderHook(
			({ path }) => useFSWatch({ path, onChanged: mockOnChanged }),
			{ initialProps: { path: "/path/a" } },
		);

		await waitFor(() => {
			expect(mockFsSubscribe).toHaveBeenCalledTimes(1);
			expect(mockFsSubscribe).toHaveBeenCalledWith(
				"/path/a",
				expect.any(Function),
			);
		});

		rerender({ path: "/path/b" });

		await waitFor(() => {
			expect(mockFsSubscribe).toHaveBeenCalledTimes(2);
			expect(mockFsUnsubscribe).toHaveBeenCalledWith("fs-sub-123");
			expect(mockFsSubscribe).toHaveBeenLastCalledWith(
				"/path/b",
				expect.any(Function),
			);
		});
	});

	it("does not resubscribe when path is the same", async () => {
		const { rerender } = renderHook(
			({ onChanged }) => useFSWatch({ path: "/same/path", onChanged }),
			{ initialProps: { onChanged: mockOnChanged } },
		);

		await waitFor(() => {
			expect(mockFsSubscribe).toHaveBeenCalledTimes(1);
		});

		const newOnChanged = vi.fn();
		rerender({ onChanged: newOnChanged });

		await new Promise((r) => setTimeout(r, 50));
		expect(mockFsSubscribe).toHaveBeenCalledTimes(1);
		expect(mockFsUnsubscribe).not.toHaveBeenCalled();
	});
});
