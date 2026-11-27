import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useElapsedMs } from "./useElapsedMs";

describe("useElapsedMs", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// The bug this exists for: clocks with intervals of their own changed their
	// seconds at the phase they mounted on, so a row and the tail line read
	// differently for most of every second.
	it("moves every clock on the same tick, whenever each was drawn", () => {
		vi.useFakeTimers();
		const start = Date.now();
		const first = renderHook(() => useElapsedMs(start));

		act(() => {
			vi.advanceTimersByTime(400);
		});
		const second = renderHook(() => useElapsedMs(start));
		expect(second.result.current).toBe(first.result.current);

		for (let i = 0; i < 3; i++) {
			act(() => {
				vi.advanceTimersByTime(300);
			});
			expect(second.result.current).toBe(first.result.current);
		}
		expect(first.result.current).toBe(1000);
	});

	it("ticks every second at every length", () => {
		vi.useFakeTimers();
		const start = Date.now() - 3_600_000;
		const { result } = renderHook(() => useElapsedMs(start));
		expect(result.current).toBe(3_600_000);

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(result.current).toBe(3_601_000);
	});

	it("starts afresh once every clock is gone", () => {
		vi.useFakeTimers();
		const start = Date.now();
		renderHook(() => useElapsedMs(start)).unmount();

		act(() => {
			vi.advanceTimersByTime(5_500);
		});
		const { result } = renderHook(() => useElapsedMs(start));
		expect(result.current).toBe(5_500);
	});
});
