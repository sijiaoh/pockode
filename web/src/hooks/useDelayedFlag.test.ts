import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "./useDelayedFlag";

describe("useDelayedFlag", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("holds the rising edge for the delay and drops immediately", () => {
		const { result, rerender } = renderHook(
			({ value }) => useDelayedFlag(value, 150),
			{ initialProps: { value: true } },
		);

		expect(result.current).toBe(false);

		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(result.current).toBe(true);

		rerender({ value: false });
		expect(result.current).toBe(false);
	});

	// The wait this times spans two phases (resolving a session, then loading its
	// history). Restarting the delay when the first phase ends would leave the
	// screen blank for two delays in a row — worse than not delaying at all.
	it("does not restart the delay while the flag stays raised", () => {
		const { result, rerender } = renderHook(
			({ value }) => useDelayedFlag(value, 150),
			{ initialProps: { value: true } },
		);

		act(() => {
			vi.advanceTimersByTime(100);
		});
		rerender({ value: true });

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(result.current).toBe(true);
	});
});
